/**
 * Import of local mail data: Thunderbird profiles and Outlook PST files.
 *
 * A privileged plugin's frame is same-origin and can reach parent.bulwarkDesktop, and its
 * calls look like the main frame's, so the webmail's UI is no boundary. Here in main:
 * - Looking is a native question. Without a yes, nothing on the disk is touched.
 * - The page only ever gets opaque handles, and can't name a path.
 * - Reading is a second native question that lists the real paths. Only then do bytes go
 *   anywhere, and only for those files (import-files.ts).
 * - An interrupted job comes back only through a third native question.
 *
 * The list of confirmed paths stays in the state file so an import can go on after a
 * restart: an import under a server's upload limit can take days.
 */

import { randomBytes } from 'node:crypto';
import { app, BrowserWindow, dialog, protocol } from 'electron';
import {
  CHANNEL,
  type LocalImportFile,
  type LocalImportGrantResult,
  type LocalImportResumeResult,
  type LocalImportScanResult,
} from '../../shared/bridge';
import { countContacts, readVCards } from '../import-books';
import { IMPORT_SCHEME, ImportGrants, validateConfirmed, validateContent, type ConfirmedFile } from '../import-files';
import { scanForMailData, thunderbirdRunning, type FoundBook, type FoundFile, type ScanEnv } from '../import-scan';
import type { StoredImportJob } from '../state';
import { strings } from '../strings';
import type { Feature } from './index';

/** A job not touched for this long is forgotten: the file has likely changed or been forgotten. */
const JOB_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
/** After a no, a page asking again gets a no without a dialog, so it can't nag. */
const QUIET_AFTER_NO_MS = 5000;
const NAMES_IN_PROMPT = 12;

/** Before `ready`, or the scheme isn't privileged. bypassCSP: an instance's own CSP has no reason to name it. */
export function registerImportScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: IMPORT_SCHEME, privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } },
  ]);
}

function scanEnv(): ScanEnv {
  return {
    platform: process.platform,
    home: app.getPath('home'),
    appData: app.getPath('appData'),
    localAppData: process.env.LOCALAPPDATA,
    documents: app.getPath('documents'),
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function pathList(paths: string[]): string {
  const shown = paths.slice(0, NAMES_IN_PROMPT).join('\n');
  const more = paths.length - NAMES_IN_PROMPT;
  return more > 0 ? `${shown}\n${strings().importMore(more)}` : shown;
}

async function ask(window: BrowserWindow | null, options: Electron.MessageBoxOptions): Promise<number> {
  const parent = window && !window.isDestroyed() ? window : null;
  const { response } = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
  return response;
}

function toConfirmed(file: FoundFile): ConfirmedFile {
  return { path: file.path, root: file.root, kind: file.kind, name: file.name, folder: file.folder };
}

export const importFeature: Feature = {
  name: 'import',
  modes: ['standalone', 'instance'],
  setup(ctx) {
    const grants = new ImportGrants(ctx.origin);
    ctx.session.protocol.handle(IMPORT_SCHEME, (request) => grants.serve(request));

    // What the last scan found, by opaque handle. A new scan replaces it.
    let candidates = new Map<string, FoundFile>();
    let bookHandles = new Map<string, FoundBook>();
    let profiles: string[] = [];
    let asking = false;
    let noUntil = 0;

    const stored = () => (ctx.state.data.importJobs ?? []).filter((job) => job.origin === ctx.origin);
    const saveJobs = (jobs: StoredImportJob[]) => {
      ctx.state.data.importJobs = [...(ctx.state.data.importJobs ?? []).filter((job) => job.origin !== ctx.origin), ...jobs];
      // At once: a kill right after confirming must not lose the job.
      ctx.state.save();
    };
    saveJobs(stored().filter((job) => Date.now() - job.touchedAt < JOB_MAX_AGE_MS));

    /** One dialog at a time, and quiet for a moment after a no. */
    const question = async <T>(busy: T, declined: T, run: () => Promise<T>): Promise<T> => {
      if (asking) return busy;
      if (Date.now() < noUntil) return declined;
      asking = true;
      try {
        const answer = await run();
        if (answer === declined) noUntil = Date.now() + QUIET_AFTER_NO_MS;
        return answer;
      } finally {
        asking = false;
      }
    };

    const host = new URL(ctx.origin).host;

    ctx.handle(CHANNEL.localImportScan, (_event, window): Promise<LocalImportScanResult> => {
      const busy: LocalImportScanResult = { ok: false, reason: 'busy' };
      const declined: LocalImportScanResult = { ok: false, reason: 'declined' };
      return question(busy, declined, async () => {
        const text = strings();
        const response = await ask(window, {
          type: 'question',
          message: text.importScanTitle(host),
          detail: text.importScanDetail,
          buttons: [text.importScanAllow, text.importDeny],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (response !== 0) return declined;
        const found = scanForMailData(scanEnv());
        candidates = new Map(found.files.map((file) => [randomBytes(16).toString('base64url'), file]));
        profiles = found.profiles;
        const books = await Promise.all(
          found.books.map(async (book) => {
            try {
              return { book, contacts: await countContacts(book.path) };
            } catch {
              // No node:sqlite here, a locked file, or not an address book.
              return null;
            }
          }),
        );
        const usable = books.filter((entry): entry is { book: FoundBook; contacts: number } => !!entry && entry.contacts > 0);
        const bookEntries = usable.map((entry) => ({ handle: randomBytes(16).toString('base64url'), ...entry }));
        bookHandles = new Map(bookEntries.map((entry) => [entry.handle, entry.book]));
        return {
          ok: true,
          candidates: [...candidates].map(([handle, file]) => ({
            handle,
            app: file.app,
            kind: file.kind,
            group: file.group,
            account: file.account,
            folder: file.folder,
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
            messages: file.messages,
          })),
          books: bookEntries.map((entry) => ({ handle: entry.handle, group: entry.book.group, name: entry.book.name, contacts: entry.contacts })),
          refused: found.refused,
          calendars: found.calendars,
          thunderbirdRunning: await thunderbirdRunning(profiles),
        };
      });
    });

    /** The files that pass, as grants of a job. What doesn't pass is named. */
    const openJob = async (jobId: string, files: ConfirmedFile[]): Promise<{ granted: LocalImportFile[]; refused: string[] }> => {
      const granted: LocalImportFile[] = [];
      const refused: string[] = [];
      for (const file of files) {
        const failure = validateConfirmed(file) ?? (await validateContent(file));
        if (failure) refused.push(file.name);
        else granted.push(grants.add(jobId, file));
      }
      return { granted, refused };
    };

    ctx.handle(CHANNEL.localImportGrant, (_event, window, handles): Promise<LocalImportGrantResult> => {
      const busy: LocalImportGrantResult = { ok: false, reason: 'busy' };
      const declined: LocalImportGrantResult = { ok: false, reason: 'declined' };
      const invalid: LocalImportGrantResult = { ok: false, reason: 'invalid' };
      // Only handles the last scan handed out mean anything. Anything else, a path included, is refused here.
      if (!Array.isArray(handles) || handles.length === 0) return Promise.resolve(invalid);
      if (handles.some((handle) => typeof handle !== 'string' || (!candidates.has(handle) && !bookHandles.has(handle)))) return Promise.resolve(invalid);
      const wanted = handles as string[];
      return question(busy, declined, async () => {
        const text = strings();
        const files = wanted.flatMap((handle) => candidates.get(handle) ?? []);
        const books = wanted.flatMap((handle) => bookHandles.get(handle) ?? []);
        const confirmed = files.map(toConfirmed);
        // Before asking, so the dialog doesn't list what can't be read.
        const usable: ConfirmedFile[] = [];
        const refused: string[] = [];
        for (const file of confirmed) {
          if (validateConfirmed(file) ?? (await validateContent(file))) refused.push(file.name);
          else usable.push(file);
        }
        if (usable.length === 0 && books.length === 0) return { ok: false, reason: 'invalid', refused };
        const size = files.filter((file) => !refused.includes(file.name)).reduce((total, file) => total + file.size, 0);
        const response = await ask(window, {
          type: 'question',
          message: text.importReadTitle(host, usable.length + books.length),
          detail: `${text.importReadDetail(formatBytes(size))}\n\n${pathList([...usable.map((file) => file.path), ...books.map((book) => book.path)])}`,
          buttons: [text.allow, text.importDeny],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (response !== 0) return declined;
        const jobId = randomBytes(16).toString('base64url');
        const { granted, refused: late } = await openJob(jobId, usable);
        const contacts: string[] = [];
        for (const book of books) {
          // The address book only ever comes from the file main found.
          if (validateConfirmed({ path: book.path, root: book.root, kind: 'mbox', name: book.name, folder: [] })) {
            refused.push(book.name);
            continue;
          }
          try {
            contacts.push(...(await readVCards(book.path)));
          } catch {
            refused.push(book.name);
          }
        }
        if (granted.length > 0) {
          saveJobs([...stored(), { id: jobId, origin: ctx.origin, touchedAt: Date.now(), profiles, files: usable.filter((file) => !late.includes(file.name)) }]);
        }
        return { ok: true, jobId, files: granted, contacts, refused: [...refused, ...late], thunderbirdRunning: await thunderbirdRunning(profiles) };
      });
    });

    ctx.handle(CHANNEL.localImportResume, (_event, window, jobId): Promise<LocalImportResumeResult> => {
      const job = stored().find((entry) => entry.id === jobId);
      if (!job) return Promise.resolve({ ok: false, reason: 'unknown' });
      const busy: LocalImportResumeResult = { ok: false, reason: 'busy' };
      const later: LocalImportResumeResult = { ok: false, reason: 'later' };
      return question(busy, later, async () => {
        const text = strings();
        const response = await ask(window, {
          type: 'question',
          message: text.importResumeTitle(host),
          detail: `${text.importResumeDetail}\n\n${pathList(job.files.map((file) => file.path))}`,
          buttons: [text.importResumeContinue, text.importResumeLater, text.importResumeStop],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (response === 2) {
          await grants.release(job.id);
          saveJobs(stored().filter((entry) => entry.id !== job.id));
          return { ok: false, reason: 'stopped' };
        }
        if (response !== 0) return later;
        await grants.release(job.id);
        const { granted, refused } = await openJob(job.id, job.files);
        if (granted.length === 0) return { ok: false, reason: 'invalid', refused };
        job.touchedAt = Date.now();
        saveJobs(stored());
        return { ok: true, jobId: job.id, files: granted, contacts: [], refused, thunderbirdRunning: await thunderbirdRunning(job.profiles) };
      });
    });

    // These only narrow, so any page may call them and none gains by it.
    ctx.handle(CHANNEL.localImportRelease, async (_event, _window, jobId) => {
      if (typeof jobId !== 'string') return;
      await grants.release(jobId);
      saveJobs(stored().filter((job) => job.id !== jobId));
    });
    ctx.handle(CHANNEL.localImportReleaseAll, async () => {
      await Promise.all(stored().map((job) => grants.release(job.id)));
      candidates = new Map();
      bookHandles = new Map();
      saveJobs([]);
    });
  },
};
