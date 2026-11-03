/**
 * The disk work of a local import, in a utilityProcess of its own. Whatever is on the disk
 * can take forever: a network path in profiles.ini that doesn't answer, a folder with a
 * million messages, an sqlite file built to hang. Here that stops nothing but this process,
 * and import-worker-client.ts kills it at its timeout. Main never touches those files
 * synchronously.
 */

import { countContactsWith, loadSqlite, readVCards } from './import-books';
import { prepareFile, type ConfirmedFile, type PreparedFile, type ValidationFailure } from './import-files';
import { scanForMailData, thunderbirdRunning, type ScanEnv, type ScanResult } from './import-scan';

export type ScannedBook = ScanResult['books'][number] & { contacts: number };
export type WorkerScan = Omit<ScanResult, 'books'> & { books: ScannedBook[]; thunderbirdRunning: boolean };

export type WorkerRequest =
  | { op: 'scan'; env: ScanEnv; hangAfterFirstProfile?: boolean }
  | { op: 'prepare'; files: ConfirmedFile[]; books: string[]; profiles: string[]; platform: NodeJS.Platform };

export type PrepareAnswer = { failure: ValidationFailure } | { prepared: PreparedFile };

export type WorkerMessage =
  | { type: 'partial'; scan: WorkerScan; onlyNetworkLeft: boolean }
  | { type: 'scan'; scan: WorkerScan }
  | { type: 'prepared'; files: PrepareAnswer[]; contacts: string[]; refusedBooks: string[]; thunderbirdRunning: boolean };

function send(message: WorkerMessage): void {
  process.parentPort.postMessage(message);
}

/**
 * Everything here until the last send is synchronous on purpose. The scan's calls block this
 * thread for as long as a path doesn't answer, so a promise would never get its turn, and
 * what's been found so far has to be out before that happens.
 */
async function scan(env: ScanEnv, hang: boolean | undefined): Promise<void> {
  const sqlite = await loadSqlite().catch(() => null);
  const counted = new Map<string, number>();
  const view = (found: ScanResult): WorkerScan => {
    const books: ScannedBook[] = [];
    for (const book of found.books) {
      if (!counted.has(book.path)) {
        let contacts = 0;
        try {
          if (sqlite) contacts = countContactsWith(sqlite, book.path);
        } catch {
          // A locked file, or not an address book.
        }
        counted.set(book.path, contacts);
      }
      const contacts = counted.get(book.path);
      if (contacts) books.push({ ...book, contacts });
    }
    return { ...found, books, thunderbirdRunning: found.running };
  };
  const found = scanForMailData(env, (soFar, onlyNetworkLeft) => {
    send({ type: 'partial', scan: view(soFar), onlyNetworkLeft });
    // A test's stand-in for a path that never answers: this thread stops, as it would on one.
    if (hang) for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  });
  send({ type: 'scan', scan: view(found) });
}

async function prepare(request: Extract<WorkerRequest, { op: 'prepare' }>): Promise<void> {
  const files: PrepareAnswer[] = [];
  for (const file of request.files) files.push(await prepareFile(file));
  const contacts: string[] = [];
  const refusedBooks: string[] = [];
  for (const book of request.books) {
    try {
      contacts.push(...(await readVCards(book)));
    } catch {
      refusedBooks.push(book);
    }
  }
  send({ type: 'prepared', files, contacts, refusedBooks, thunderbirdRunning: await thunderbirdRunning(request.profiles, request.platform) });
}

process.parentPort.once('message', (event: { data: WorkerRequest }) => {
  const request = event.data;
  const done = request.op === 'scan' ? scan(request.env, request.hangAfterFirstProfile) : prepare(request);
  done.then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
});
