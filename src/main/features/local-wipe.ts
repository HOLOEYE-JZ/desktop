/**
 * Deleting what the app keeps on this device, by main, for every partition: the
 * standalone profile and each Bulwark server's. A page only sees its own partition, so
 * a wipe that ran in a page would leave the others, and a same-origin plugin could
 * say it was done without doing it. So no renderer takes part and none decides.
 *
 * `runLocalWipe` is what the remote wipe plugs into: call it with a reason, and add
 * anything it should also delete with `addWipeStep`. Only main's own code can reach
 * either: nothing here is on the bridge.
 */

import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, session as electronSession, type Session } from 'electron';
import type { StateFile } from '../state';

export type WipeReason = 'policy-nonce' | 'remote';

export type WipeStep = (session: Session, partition: string, reason: WipeReason) => Promise<void>;

const steps = new Set<WipeStep>();

export function addWipeStep(step: WipeStep): () => void {
  steps.add(step);
  return () => steps.delete(step);
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

async function leaveWindows(): Promise<void> {
  await Promise.all(
    BrowserWindow.getAllWindows().map(async (window) => {
      if (window.isDestroyed()) return;
      // A page holds its database open, and an open file can't be deleted.
      await window.webContents.loadURL('about:blank').catch(() => {});
    }),
  );
}

export interface WipeResult {
  partitions: string[];
  failed: string[];
}

/**
 * Everything, the HTTP cache too: it held whatever the mail server sent before a page asked
 * for `no-store`, attachments and whole messages among it. Sign-ins go too: the keys and the
 * account list do, and a cookie with no account would only confuse the start-up. So do the
 * mail servers this profile has used: a device told to remove everything doesn't keep their
 * names. Done means every partition finished: on any failure the caller asks again next time.
 */
export async function runLocalWipe(reason: WipeReason, userData: string, state: StateFile): Promise<WipeResult> {
  await leaveWindows();
  // The windows to bring back name drafts and messages. A wipe at the start comes before any window manager.
  delete state.data.session;
  delete state.data.restoreAttempts;
  state.data.corsOrigins = [];
  state.data.approvedServers = [];
  state.save();
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
