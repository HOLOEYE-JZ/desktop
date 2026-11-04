/**
 * Files on this computer, main's side of the disk: folders the user picked to keep the same as
 * a Files folder, and every disk call of the page's sync engine, for those and for the drive's
 * roots (features/files-drive.ts registers those). The engine is the page's
 * (lib/files-sync in the webmail) and decides what to sync; main only does what the page can't.
 *
 * Who may call: a same-origin plugin frame can reach the bridge through `parent` (ipc.ts), so
 * - only the main window's page is answered, and the page takes the controls once, first;
 * - adding a folder takes a real click, spent as it's used, and the user's pick in the OS's
 *   own folder picker. Nothing else outlasts the run;
 * - every path is resolved inside its root, and a link or junction on the way is refused, so
 *   no call reaches past the folders the user picked;
 * - while the app is locked nothing is listed, read or written.
 *
 * What stays: the folders the user picked, in a private folder of the app's with the engine's
 * own record of each root. A folder taken away (by the user, the policy, a wipe) keeps every
 * file in it: they were the user's. Only main's own temporary files there go.
 */

import { rmSync } from 'node:fs';
import { lstat, realpath, statfs } from 'node:fs/promises';
import path from 'node:path';
import { app, dialog, shell, type BrowserWindow, type WebContents } from 'electron';
import { CHANNEL, type FilesChangeEvent, type FilesLocalEntry, type FilesResult, type FilesRoot } from '../../shared/bridge';
import { effectivePolicyValue } from '../../shared/policy-schema';
import { appLockGate } from '../app-lock-gate';
import { entryOf, errorOf, fail, FilesDisk, ok } from '../files/disk';
import { driveHooks } from '../files/drive-hooks';
import { isNetworkFsType, isNetworkPath, overlapReason, systemFolders } from '../files/paths';
import { FILES_SCHEME, FilesReadGrants } from '../files/read-grants';
import { filesRegistry, type RegisteredRoot } from '../files/registry';
import { FolderRoots } from '../files/folder-roots';
import { FolderRootStore, MAX_STATE_CHARS, validRootId } from '../files/store';
import { RootWatcher } from '../files/watcher';
import { isInstalledBuild } from '../installed';
import { fill, strings } from '../strings';
import { takeUserGesture, watchUserGestures } from '../user-gesture';
import { addWipeStep } from './local-wipe';
import { makeRootPrivate } from './os-edit';
import { policies } from './policies';
import type { Feature } from './index';

declare const __BULWARK_TEST_BUILD__: boolean;

/** A write nobody touched for this long: the page that started it is gone. */
const IDLE_WRITE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
const MAX_ACCOUNT = 512;
const MAX_LABEL = 1024;

/**
 * Local, not the roaming profile a packaged Windows app's userData is in, as with the edited
 * attachments (os-edit.ts): the list names folders on this machine, and the engine's record
 * describes what's in them. Carried to another machine, both would describe the wrong disk.
 */
export function filesDataFolder(): string {
  const local = process.env.LOCALAPPDATA;
  if (process.platform === 'win32' && isInstalledBuild() && local) return path.join(local, 'Bulwark', 'files-sync');
  return path.join(app.getPath('userData'), 'files-sync');
}

/** `FilesFolderSyncEnabled`: on unless forced off. */
export function folderSyncAllowed(): boolean {
  return effectivePolicyValue(policies.snapshot.FilesFolderSyncEnabled, undefined) !== false;
}

let running: { wipe: (account: string | null) => Promise<void>; forgetState: (rootId: string) => Promise<void> } | null = null;

// At load, not in setup: a policy's wipe at the start of a launch comes before any feature.
// The folders and the files in them stay; what the app knew about them goes.
addWipeStep(async (_session, _partition, _reason, account) => {
  if (running) await running.wipe(account);
  else if (account === null) rmSync(filesDataFolder(), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}, { perAccount: true });

/** For the drive, when its root goes for good: the engine's record of it goes too. */
export async function forgetRootState(rootId: string): Promise<void> {
  if (validRootId(rootId)) await running?.forgetState(rootId);
}

async function realOr(folder: string): Promise<string> {
  try {
    return await realpath(folder);
  } catch {
    return folder;
  }
}

export const filesFoldersFeature: Feature = {
  name: 'files-folders',
  modes: ['standalone', 'instance'],
  setup(ctx) {
    const { windows, origin } = ctx;
    const platform = process.platform;
    const store = new FolderRootStore(filesDataFolder(), makeRootPrivate);
    const disk = new FilesDisk({ rootOf: (id) => filesRegistry.get(id), trash: (absolute) => shell.trashItem(absolute) });

    const grants = new FilesReadGrants(origin, async (rootId, relative) => {
      const root = appLockGate.locked ? null : filesRegistry.get(rootId);
      if (!root) return null;
      const found = await disk.resolve(root, relative);
      if (!found.ok || !found.value.stats?.isFile() || root.contentAbsent?.(found.value.absolute)) return null;
      return found.value.absolute;
    });
    ctx.session.protocol.handle(FILES_SCHEME, (request) => grants.serve(request));

    // What the page hears. Only the main window's page runs the engine.
    const send = (rootId: string, paths: string[] | null) => {
      if (appLockGate.locked) return;
      const main = windows.mainWindow();
      if (!main || main.isDestroyed()) return;
      const event: FilesChangeEvent = { rootId, paths };
      try {
        main.webContents.send(CHANNEL.filesChanged, event);
      } catch {
        // Going away: the next page scans when it starts.
      }
    };

    const watchers = new Map<string, RootWatcher>();
    const cleaned = new Set<string>();
    const cleanOnce = (entry: RegisteredRoot) => {
      if (cleaned.has(entry.root.id)) return;
      cleaned.add(entry.root.id);
      void disk.cleanTemps(entry).then((removed) => {
        if (removed < 0) cleaned.delete(entry.root.id);
      }, () => cleaned.delete(entry.root.id));
    };
    // A root that's new, back from a pause or back from an error starts with "scan it all":
    // that's also how the page learns of a root it doesn't know yet.
    const reconcile = () => {
      const live = new Map(filesRegistry.list().filter((entry) => !entry.root.paused).map((entry) => [entry.root.id, entry]));
      for (const [id, watcher] of watchers) {
        if (live.has(id)) continue;
        watcher.stop();
        watchers.delete(id);
      }
      for (const [id, entry] of live) {
        if (watchers.has(id)) continue;
        const watcher = new RootWatcher(entry.dir, (paths) => send(id, paths));
        watchers.set(id, watcher);
        watcher.start(true);
        cleanOnce(entry);
      }
    };
    filesRegistry.onChange(reconcile);

    const folders = new FolderRoots({ store, registry: filesRegistry, disk, grants, origin, allowed: folderSyncAllowed });
    // Every call waits for this: a page asking early must not hear "no folders".
    const loaded = folders.load().catch((error: unknown) => console.error('Could not read the synced folders:', error));

    // Off removes what's there, as OpenWithEnabled does: the folders stop syncing, and their files stay.
    policies.on('changed', () => {
      void loaded.then(() => folders.applyPolicy()).catch((error: unknown) => console.error('Could not stop the synced folders:', error));
    });

    running = {
      wipe: async (account) => {
        await loaded;
        await folders.wipe(account);
      },
      forgetState: (rootId) => store.removeState(rootId),
    };

    // Locked: nothing to read or write. Unlocked: whatever changed meanwhile is "scan it all".
    appLockGate.on('locked', (locked) => {
      if (locked) {
        grants.revokeAll();
        void disk.abortWrites();
        return;
      }
      for (const id of watchers.keys()) send(id, null);
    });

    // A page that goes leaves no write open and no read URL behind.
    const dropPageState = () => {
      grants.revokeAll();
      void disk.abortWrites();
    };
    const followed = new WeakSet<WebContents>();
    const follow = (window: BrowserWindow) => {
      const contents = window.webContents;
      watchUserGestures(contents);
      if (followed.has(contents)) return;
      followed.add(contents);
      const wasMain = () => {
        const main = windows.mainWindow();
        return !main || main === window;
      };
      contents.on('did-navigate', () => {
        if (wasMain()) dropPageState();
      });
      contents.on('render-process-gone', () => {
        if (wasMain()) dropPageState();
      });
      contents.once('destroyed', () => {
        if (wasMain()) dropPageState();
      });
    };
    app.on('web-contents-created', (_event, contents) => watchUserGestures(contents));
    windows.on('created', ({ window, type }) => {
      watchUserGestures(window.webContents);
      if (type === 'main') follow(window);
    });

    /** Only the main window's page. Anything else is refused outright, as ipc.ts refuses a frame. */
    const fromMain = (window: BrowserWindow | null) => {
      const main = windows.mainWindow();
      if (!window || !main || window !== main) throw new Error('Not allowed: files calls come from the main window');
    };
    const rootFor = async (window: BrowserWindow | null, id: unknown): Promise<RegisteredRoot | null> => {
      fromMain(window);
      await loaded;
      return appLockGate.locked ? null : filesRegistry.get(id);
    };

    const pickFolder = async (window: BrowserWindow, remoteLabel: string): Promise<string | null> => {
      const text = strings();
      const answer = await dialog.showOpenDialog(window, {
        title: fill(text.filesPickFolderTitle, { folder: remoteLabel || '/' }),
        buttonLabel: text.filesPickFolderButton,
        properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
      });
      return answer.canceled ? null : answer.filePaths[0] ?? null;
    };

    const overlapRules = async () => {
      const home = await realOr(app.getPath('home'));
      const own = [app.getPath('userData'), path.dirname(filesDataFolder()), path.dirname(process.execPath), app.getAppPath(), ...(driveHooks().parentFolders?.() ?? [])];
      // The whole app bundle on macOS, not only the folder the executable is in.
      if (platform === 'darwin') own.push(path.resolve(process.execPath, '..', '..', '..'));
      const { system, noContain } = systemFolders(platform, process.env, home);
      return {
        platform,
        home,
        appFolders: await Promise.all(own.map(realOr)),
        system: await Promise.all(system.map(realOr)),
        noContain: await Promise.all(noContain.map(realOr)),
        roots: filesRegistry.list().map((entry) => entry.dir),
      };
    };

    const addPicked = async (picked: string, request: { account: string; remoteId: string | null; remoteLabel: string }): Promise<FilesResult<FilesRoot>> => {
      let dir: string;
      try {
        dir = await realpath(picked);
        if (!(await lstat(dir)).isDirectory()) return fail('missing');
      } catch (error) {
        return fail(errorOf(error));
      }
      if (isNetworkPath(dir, platform)) return fail('overlap');
      if (platform === 'linux') {
        const type = await statfs(dir).then((facts) => Number(facts.type), () => 0);
        if (isNetworkFsType(type, platform)) return fail('overlap');
      }
      const reason = overlapReason(dir, await overlapRules());
      if (reason) {
        console.warn(`A folder to sync was refused (${reason})`);
        return fail('overlap');
      }
      try {
        return ok(await folders.add(dir, request));
      } catch (error) {
        console.error('Could not keep a synced folder:', error);
        return fail('failed');
      }
    };

    let picking = false;
    ctx.handle(CHANNEL.filesAddFolder, async (event, window, request, clicked) => {
      fromMain(window);
      await loaded;
      const { account, remoteId, remoteLabel } = (request ?? {}) as { account?: unknown; remoteId?: unknown; remoteLabel?: unknown };
      const valid = typeof account === 'string' && account.length > 0 && account.length <= MAX_ACCOUNT
        && (remoteId === null || (typeof remoteId === 'string' && remoteId.length > 0 && remoteId.length <= MAX_ACCOUNT))
        && typeof remoteLabel === 'string' && remoteLabel.length <= MAX_LABEL;
      if (!valid) return fail('failed');
      if (!folderSyncAllowed()) return fail('policy');
      if (appLockGate.locked) return fail('inactive');
      // Spent whatever comes next: one click is one picker.
      const gesture = takeUserGesture(event.sender);
      if (clicked !== true || !gesture) return fail('gesture');
      if (picking) return fail('busy');
      picking = true;
      try {
        const picked = await pickFolder(window!, remoteLabel);
        if (!picked) return fail('cancelled');
        // The picker can stay open for a long time.
        if (!folderSyncAllowed()) return fail('policy');
        if (appLockGate.locked) return fail('inactive');
        return await addPicked(picked, { account, remoteId, remoteLabel });
      } finally {
        picking = false;
      }
    });

    ctx.handle(CHANNEL.filesRoots, async (_event, window) => {
      fromMain(window);
      await loaded;
      return appLockGate.locked ? [] : filesRegistry.list().map((entry) => entry.root);
    });

    ctx.handle(CHANNEL.filesRemoveRoot, async (_event, window, rootId) => {
      fromMain(window);
      await loaded;
      const entry = filesRegistry.get(rootId);
      if (!entry) return;
      if (entry.root.kind === 'folder') {
        await folders.remove([entry.root.id]);
        return;
      }
      const remove = driveHooks().removeRoot;
      if (!remove) return;
      await remove(entry.root);
      grants.revokeRoot(entry.root.id);
      await disk.abortWrites((id) => id === entry.root.id);
      if (!filesRegistry.get(entry.root.id)) await store.removeState(entry.root.id);
    });

    ctx.handle(CHANNEL.filesSetPaused, async (_event, window, rootId, paused) => {
      fromMain(window);
      await loaded;
      if (typeof paused === 'boolean' && filesRegistry.get(rootId)) await folders.setPaused(rootId as string, paused);
    });

    ctx.handle(CHANNEL.filesScan, async (_event, window, rootId, under) => {
      const root = await rootFor(window, rootId);
      return root ? disk.scan(root, under ?? '') : fail('inactive');
    });

    ctx.handle(CHANNEL.filesStat, async (_event, window, rootId, relative) => {
      const root = await rootFor(window, rootId);
      return root ? disk.stat(root, relative) : fail('inactive');
    });

    ctx.handle(CHANNEL.filesOpenRead, async (_event, window, rootId, relative): Promise<FilesResult<{ url: string; entry: FilesLocalEntry }>> => {
      const root = await rootFor(window, rootId);
      if (!root) return fail('inactive');
      const found = await disk.resolve(root, relative);
      if (!found.ok) return found;
      const { stats, absolute, parts } = found.value;
      if (!stats) return fail('missing');
      if (!stats.isFile()) return fail('unsupported');
      // Reading it would ask the page for the very bytes it wants.
      if (root.contentAbsent?.(absolute)) return fail('unsupported');
      const entry = entryOf(parts.join('/'), stats, root.placeholderState?.(absolute) ?? undefined);
      return ok({ url: grants.add(root.root.id, entry), entry });
    });

    ctx.handle(CHANNEL.filesBeginWrite, async (_event, window, rootId, relative, options) => {
      const root = await rootFor(window, rootId);
      return root ? disk.beginWrite(root, relative, options) : fail('inactive');
    });
    ctx.handle(CHANNEL.filesWriteChunk, async (_event, window, writeId, data) => {
      fromMain(window);
      if (appLockGate.locked) return fail('inactive');
      return disk.writeChunk(writeId, data);
    });
    ctx.handle(CHANNEL.filesCommitWrite, async (_event, window, writeId) => {
      fromMain(window);
      if (appLockGate.locked) {
        await disk.abortWrite(writeId);
        return fail('inactive');
      }
      return disk.commitWrite(writeId);
    });
    ctx.handle(CHANNEL.filesAbortWrite, async (_event, window, writeId) => {
      fromMain(window);
      await disk.abortWrite(writeId);
    });

    ctx.handle(CHANNEL.filesMkdir, async (_event, window, rootId, relative) => {
      const root = await rootFor(window, rootId);
      return root ? disk.mkdir(root, relative) : fail('inactive');
    });
    ctx.handle(CHANNEL.filesMove, async (_event, window, rootId, from, to, expect) => {
      const root = await rootFor(window, rootId);
      return root ? disk.move(root, from, to, expect) : fail('inactive');
    });
    ctx.handle(CHANNEL.filesRemove, async (_event, window, rootId, relative, expect) => {
      const root = await rootFor(window, rootId);
      return root ? disk.remove(root, relative, expect) : fail('inactive');
    });

    // A rejection, not null, while locked: null would read as "never synced", and a first sync
    // over a full folder is all conflicts.
    ctx.handle(CHANNEL.filesLoadState, async (_event, window, rootId) => {
      fromMain(window);
      await loaded;
      if (appLockGate.locked) throw new Error('Locked');
      if (!validRootId(rootId) || !filesRegistry.get(rootId)) return null;
      return store.loadState(rootId);
    });
    ctx.handle(CHANNEL.filesSaveState, async (_event, window, rootId, state) => {
      fromMain(window);
      await loaded;
      if (appLockGate.locked) throw new Error('Locked');
      if (!validRootId(rootId) || !filesRegistry.get(rootId)) throw new Error('No such root');
      if (typeof state !== 'string' || state.length > MAX_STATE_CHARS) throw new Error('Not a state');
      await store.saveState(rootId, state);
    });

    ctx.handle(CHANNEL.filesShowInFolder, async (_event, window, rootId, relative) => {
      const root = await rootFor(window, rootId);
      if (!root) return false;
      const found = await disk.resolve(root, relative ?? '', true);
      if (!found.ok || !found.value.stats) return false;
      // The root itself opens; anything in it is shown selected in its folder.
      if (found.value.parts.length === 0) return (await shell.openPath(found.value.absolute)) === '';
      shell.showItemInFolder(found.value.absolute);
      return true;
    });

    const sweep = setInterval(() => {
      void disk.abortIdle(IDLE_WRITE_MS);
      grants.sweep();
      for (const entry of filesRegistry.list()) if (!entry.root.paused) cleanOnce(entry);
    }, SWEEP_MS);
    sweep.unref?.();

    app.on('will-quit', () => {
      clearInterval(sweep);
      for (const watcher of watchers.values()) watcher.stop();
      // The temporary files go now, or at the next start.
      void disk.abortWrites();
    });

    if (__BULWARK_TEST_BUILD__) {
      (globalThis as unknown as { __bulwarkFiles: unknown }).__bulwarkFiles = { disk, store, grants, watchers, folders, registry: filesRegistry, loaded };
    }
  },
};
