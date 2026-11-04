/**
 * Deleting what the app keeps on this device, by main, for every partition: the
 * standalone profile and each Bulwark server's. A page only sees its own partition, so
 * a wipe that ran in a page would leave the others, and a same-origin plugin could
 * say it was done without doing it. So no renderer takes part and none decides.
 *
 * `runLocalWipe` is what a policy's wipe calls, and what's added with `addWipeStep` goes with it.
 * A remote wipe and a wipe from settings run in the page, which holds the account list and the
 * instance's answer. At their end they call `wipeForPage`, handed to the page through `claim`, so
 * not to a frame. That runs the same steps and answers what failed, because a remote wipe mustn't be
 * reported as done with a step undone. Then `finishWipeForPage` restarts, once the page has told
 * the instance. One account of several: only what's that account's, and no restart.
 *
 * A wipe with windows open ends in a restart, so whoever's there lands on a clean first
 * screen. A wipe at the start, before any window, goes on into that same start: there's
 * nothing to leave behind, and a step that failed mustn't restart the app for ever. It
 * runs again at the next start.
 */

import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, session as electronSession, type Session } from 'electron';
import type { StateFile } from '../state';

export type WipeReason = 'policy-nonce' | 'remote' | 'settings';

export type WipeStep = (session: Session, partition: string, reason: WipeReason) => Promise<void>;

const steps = new Set<WipeStep>();
/** The steps that also go for one account of several: what can't be told apart, and costs little. */
const accountSteps = new Set<WipeStep>();

/** How long a page gets to go. A hung one is destroyed with the rest at the restart. */
const LEAVE_MS = 5_000;

let restartApp: (() => void) | null = null;
let wiping = false;

/** The app's own restart: src/main/index.ts. */
export function restartAfterWipe(restart: () => void): void {
  restartApp = restart;
}

/** A page's "leave this site?" has nobody to ask and nothing to keep: windows.ts goes by this. */
export function wipeUnderWay(): boolean {
  return wiping;
}

export function addWipeStep(step: WipeStep, { perAccount = false } = {}): () => void {
  steps.add(step);
  if (perAccount) accountSteps.add(step);
  return () => {
    steps.delete(step);
    accountSteps.delete(step);
  };
}

/**
 * What the app noted as it opened each partition. The folder on disk can't stand in for
 * that: Electron lowercases its name, and opening a session under the lowercase name while
 * another has the same folder open hangs both.
 */
export function knownPartitions(state: StateFile): string[] {
  return [...(state.data.partitions ?? [])];
}

/** Partition folders nobody noted, from a profile older than the notes. Absolute paths. */
export function unnotedPartitionFolders(userData: string, state: StateFile): string[] {
  const noted = new Set(knownPartitions(state).map((partition) => partition.replace(/^persist:/, '').toLowerCase()));
  const root = path.join(userData, 'Partitions');
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !noted.has(entry.name.toLowerCase()))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

export function notePartition(state: StateFile, partition: string): void {
  const known = state.data.partitions ?? [];
  if (known.includes(partition)) return;
  state.data.partitions = [...known, partition];
  state.save();
}

async function leaveWindows(): Promise<boolean> {
  const windows = BrowserWindow.getAllWindows();
  await Promise.all(
    windows.map(async (window) => {
      if (window.isDestroyed()) return;
      // A page holds its database open, and an open file can't be deleted.
      await Promise.race([
        window.webContents.loadURL('about:blank').catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, LEAVE_MS)),
      ]);
    }),
  );
  return windows.length > 0;
}

/**
 * After the caller has written down what's done: its `await` goes first. Destroyed, not
 * closed: a close would ask pages that are gone, and there's nothing left to save.
 */
function restartSoon(): void {
  setImmediate(() => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
    restartApp?.();
  });
}

export interface WipeResult {
  partitions: string[];
  failed: string[];
}

function forgetServersAndWindows(state: StateFile): void {
  // The windows to bring back name drafts and messages. A wipe at the start comes before any window manager.
  delete state.data.session;
  delete state.data.restoreAttempts;
  // Which servers this device signed in to through the browser.
  delete state.data.signInPorts;
  state.data.corsOrigins = [];
  state.data.approvedServers = [];
  state.save();
}

/** How long a page gets after main's steps, to tell the instance. It may have gone by then. */
const FINISH_WAIT_MS = 20_000;
let finishWaiting: ReturnType<typeof setTimeout> | null = null;

/** What the page can't do. It stands on its own partition, and that goes in `finishWipeForPage`. Answers what failed. */
export async function wipeForPage({ reason, account }: { reason: 'remote' | 'settings'; account: string | null }, sender: Session, userData: string, state: StateFile): Promise<string[]> {
  const failed: string[] = [];
  if (account !== null) {
    try {
      await sender.clearCache();
      for (const step of accountSteps) await step(sender, '', reason);
    } catch (error) {
      console.error('Wiping an account failed:', error);
      failed.push('account');
    }
    return failed;
  }
  wiping = true;
  forgetServersAndWindows(state);
  for (const folder of unnotedPartitionFolders(userData, state)) {
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      console.error(`Wiping ${folder} failed:`, error);
      failed.push(path.basename(folder));
    }
  }
  const partitions = knownPartitions(state);
  for (const partition of partitions) {
    const session = electronSession.fromPartition(partition);
    try {
      if (session !== sender) await session.clearStorageData();
      await session.clearCache();
      await session.clearAuthCache();
    } catch (error) {
      console.error(`Wiping ${partition} failed:`, error);
      failed.push(partition);
    }
  }
  try {
    await sender.clearCache();
  } catch (error) {
    console.error('Clearing the cache failed:', error);
    failed.push('cache');
  }
  // Once, not per partition: none of them looks at which it's given, and a step that throws names what's left.
  for (const step of steps) {
    try {
      await step(sender, partitions[0] ?? '', reason);
    } catch (error) {
      console.error('A wipe step failed:', error);
      failed.push((error as Error)?.message || 'step');
    }
  }
  state.save();
  if (failed.length > 0) {
    wiping = false;
    return failed;
  }
  // A page that goes before it gets to finish: the next start would stop here anyway.
  finishWaiting = setTimeout(() => void finishWipeForPage(sender, true), FINISH_WAIT_MS);
  return failed;
}

/**
 * The partition the page stood on, and the restart. Only after a `wipeForPage` that went through.
 * `keepLocalStorage`: the instance hasn't heard yet, and all that says who to tell is there. The
 * page took the rest of it out already.
 */
export async function finishWipeForPage(sender: Session, keepLocalStorage: boolean): Promise<void> {
  if (!finishWaiting) return;
  clearTimeout(finishWaiting);
  finishWaiting = null;
  await leaveWindows();
  try {
    await sender.clearStorageData(keepLocalStorage
      ? { storages: ['cookies', 'filesystem', 'indexdb', 'shadercache', 'serviceworkers', 'cachestorage'] }
      : undefined);
  } catch (error) {
    console.error('Clearing the page\'s storage failed:', error);
  }
  restartSoon();
}

/**
 * Everything, the HTTP cache too: it held whatever the mail server sent before a page asked
 * for `no-store`, attachments and whole messages among it. Sign-ins go too: the keys and the
 * account list do, and a cookie with no account would only confuse the start-up. So do the
 * mail servers this profile has used: a device told to remove everything doesn't keep their
 * names. Done means every partition finished: on any failure the caller asks again next time.
 */
export async function runLocalWipe(reason: WipeReason, userData: string, state: StateFile): Promise<WipeResult> {
  wiping = true;
  const hadWindows = await leaveWindows();
  forgetServersAndWindows(state);
  const partitions = knownPartitions(state);
  const failed: string[] = [];
  // No session has these open, and none may: see knownPartitions.
  for (const folder of unnotedPartitionFolders(userData, state)) {
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      console.error(`Wiping ${folder} failed:`, error);
      failed.push(folder);
    }
  }
  for (const partition of partitions) {
    try {
      const session = electronSession.fromPartition(partition);
      await session.clearStorageData();
      await session.clearCache();
      await session.clearAuthCache();
      for (const step of steps) await step(session, partition, reason);
    } catch (error) {
      console.error(`Wiping ${partition} failed:`, error);
      failed.push(partition);
    }
  }
  state.save();
  if (hadWindows) restartSoon();
  else wiping = false;
  return { partitions, failed };
}

/**
 * OfflineEnabled forced off, for the partitions no page is using: each page clears its
 * own account by account, and the others would otherwise keep their mail until someone
 * opens them. The store's files only: S/MIME keys and plugin data have nothing to do
 * with it, and a store key with no file is already understood as gone.
 */
export async function clearStoreFiles(userData: string, state: StateFile, except: readonly Session[] = []): Promise<string[]> {
  const failed: string[] = [];
  for (const folder of unnotedPartitionFolders(userData, state)) {
    try {
      rmSync(path.join(folder, 'File System'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      console.error(`Clearing ${folder} failed:`, error);
      failed.push(folder);
    }
  }
  for (const partition of knownPartitions(state)) {
    try {
      const session = electronSession.fromPartition(partition);
      if (except.includes(session)) continue;
      await session.clearStorageData({ storages: ['filesystem'] });
    } catch (error) {
      console.error(`Clearing ${partition} failed:`, error);
      failed.push(partition);
    }
  }
  return failed;
}
