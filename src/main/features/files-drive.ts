/**
 * The Files drive on Windows (files/drive-controller.ts), wired to the bridge's `files.drive`
 * channels, the policies and the wipe.
 *
 * Only the main window's page may use these: a same-origin plugin frame reaches the bridge
 * through `parent`, and so do pop-outs, and none of them runs the sync engine. Turning the
 * drive on for the first time and choosing a letter take a real click, as main saw it.
 *
 * The folders live in `%USERPROFILE%\Bulwark Files\<address>`, where people look for them and
 * where OneDrive keeps its own. Not in the profile's AppData: Explorer's search and backup
 * tools skip that.
 */

import { writeFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, type WebContents } from 'electron';
import { CHANNEL, type FilesDriveState, type FilesFetchRequest, type OsCommand } from '../../shared/bridge';
import { appLockGate } from '../app-lock-gate';
import { DriveController, type DrivePolicy, type StoredDrive } from '../files/drive-controller';
import { substLetters } from '../files/drive-letter';
import { DRIVE_FOLDER, DRIVE_PROVIDER } from '../files/drive-places';
import { setDriveHooks } from '../files/drive-hooks';
import { filesRegistry } from '../files/registry';
import { native } from '../native';
import { takeUserGesture, watchUserGestures } from '../user-gesture';
import { forgetRootState } from './files-folders';
import { addWipeStep } from './local-wipe';
import { policies } from './policies';
import type { Feature, FeatureContext } from '.';

// Set by build.mjs.
declare const __BULWARK_TEST_BUILD__: boolean;

/** Windows 10 1809: where StorageProviderSyncRootManager and the placeholder calls are complete. */
const FIRST_BUILD = 17763;

function testArgument(name: string): string | null {
  if (!__BULWARK_TEST_BUILD__) return null;
  const prefix = `--bulwark-test-files-${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

/**
 * The app's icon as a PNG Explorer can read, next to the drive's state. Explorer can't read
 * inside app.asar, so it's written to the profile once per start.
 */
async function statusIcon(): Promise<string | null> {
  try {
    const image = await app.getFileIcon(process.execPath, { size: 'large' });
    if (image.isEmpty()) return null;
    const file = path.join(app.getPath('userData'), 'files-drive-status.png');
    writeFileSync(file, image.toPNG());
    return pathToFileURL(file).href;
  } catch {
    return null;
  }
}

function windowsBuild(): number {
  return Number(release().split('.')[2] ?? 0);
}

export function drivePolicy(): DrivePolicy {
  const { FilesDriveEnabled, FilesDriveLetter } = policies.snapshot;
  return { forcedOff: FilesDriveEnabled.value === false, letter: FilesDriveLetter.locked ? FilesDriveLetter.value ?? 'none' : null };
}

let controller: DriveController | null = null;

/** The drive's controller, made once: the wipe can come before the feature starts. */
function driveController(ctx?: Pick<FeatureContext, 'state' | 'windows' | 'showMain'>): DriveController | null {
  if (process.platform !== 'win32') return null;
  if (controller) return controller;
  const helper = native().files;
  const state = ctx?.state;
  let detached: StoredDrive = {};
  const mainContents = (): WebContents | null => {
    const window = ctx?.windows.mainWindow();
    return window && !window.isDestroyed() ? window.webContents : null;
  };
  controller = new DriveController({
    native: helper,
    supported: windowsBuild() >= FIRST_BUILD,
    provider: testArgument('provider') ?? DRIVE_PROVIDER,
    base: testArgument('drive-dir') ?? path.join(homedir(), DRIVE_FOLDER),
    profile: app.getPath('userData'),
    icon: `${process.execPath},0`,
    version: app.getVersion(),
    store: {
      read: () => (state ? state.data.filesDrive ?? {} : detached),
      write: (next) => {
        if (!state) {
          detached = next;
          return;
        }
        state.data.filesDrive = next;
        state.save();
      },
    },
    policy: drivePolicy,
    page: {
      fetch: (request: FilesFetchRequest) => {
        // A locked app hands out nothing, not even to Explorer.
        if (appLockGate.locked) return 'denied';
        const contents = mainContents();
        if (!contents || contents.isLoading() || contents.isCrashed()) return 'not-running';
        contents.send(CHANNEL.filesDriveFetch, request);
        return true;
      },
      fetchCancelled: (fetchId) => mainContents()?.send(CHANNEL.filesDriveFetchCancel, fetchId),
      stateChanged: (next: FilesDriveState) => mainContents()?.send(CHANNEL.filesDriveStateChanged, next),
    },
    status: {
      icon: statusIcon,
      // The status line in Explorer: Settings > Files on this computer, in the main window.
      opened: () => {
        ctx?.showMain();
        const command: OsCommand = { type: 'navigate', target: 'settings/files_sync' };
        mainContents()?.send(CHANNEL.osCommand, command);
      },
    },
    registry: filesRegistry,
    forgetState: forgetRootState,
    letters: helper && testArgument('letters') !== 'off' ? substLetters(() => helper.filesUsedDriveLetters()) : null,
    ...(testArgument('fetch-timeout') ? { fetchFirstAnswerMs: Number(testArgument('fetch-timeout')), fetchIdleMs: Number(testArgument('fetch-timeout')) } : {}),
  });
  return controller;
}

/** A wipe before the feature started had no profile to clear the wishes from. */
let wipedEarly = false;

// Whatever the mode, and before the feature's setup: a wipe at the start comes first.
addWipeStep(async () => {
  if (!controller) wipedEarly = true;
  await driveController()?.wipe();
});

/** For the folders feature: where the drive keeps its folders, which no folder pair may touch. */
export function driveParentFolders(): string[] {
  return driveController()?.parentFolders() ?? [];
}

/** For the folders feature: `removeRoot` on a drive root. */
export async function driveRemoveRoot(root: { account: string }): Promise<void> {
  await driveController()?.disable(root.account, 'user');
}

export const filesDriveFeature: Feature = {
  name: 'files-drive',
  modes: ['standalone', 'instance'],
  setup(ctx) {
    if (process.platform !== 'win32') return;
    // Made before any wipe step ran with no state: from here on it writes the profile's.
    controller = null;
    if (wipedEarly) {
      delete ctx.state.data.filesDrive;
      ctx.state.save();
    }
    const drive = driveController(ctx)!;
    setDriveHooks({ removeRoot: driveRemoveRoot, parentFolders: driveParentFolders });

    const isMain = (window: BrowserWindow | null): boolean => !!window && window === ctx.windows.mainWindow();
    const fromMain = (window: BrowserWindow | null): void => {
      if (!isMain(window)) throw new Error('Not allowed');
    };
    const clickedNow = (contents: WebContents, clicked: unknown) => () => clicked === true && takeUserGesture(contents);

    app.on('browser-window-created', (_event, window) => watchUserGestures(window.webContents));
    for (const window of BrowserWindow.getAllWindows()) watchUserGestures(window.webContents);

    ctx.handle(CHANNEL.filesDriveState, (_event, window) => {
      fromMain(window);
      return drive.state();
    });
    ctx.handle(CHANNEL.filesDriveEnable, (event, window, account, label, clicked) => {
      fromMain(window);
      return drive.enable(account, label, clickedNow(event.sender, clicked));
    });
    ctx.handle(CHANNEL.filesDriveDisable, (_event, window, account, reason) => {
      fromMain(window);
      return drive.disable(account, reason);
    });
    ctx.handle(CHANNEL.filesDrivePlace, (_event, window, rootId, entries) => {
      fromMain(window);
      return drive.place(rootId, entries);
    });
    ctx.handle(CHANNEL.filesDriveUpdate, (_event, window, rootId, relative, meta, expect) => {
      fromMain(window);
      return drive.update(rootId, relative, meta, expect);
    });
    ctx.handle(CHANNEL.filesDriveMarkInSync, (_event, window, rootId, relative, identity, expect) => {
      fromMain(window);
      return drive.markInSync(rootId, relative, identity, expect);
    });
    ctx.handle(CHANNEL.filesDriveSupply, (_event, window, fetchId, offset, data) => {
      fromMain(window);
      return drive.supply(fetchId, offset, data);
    });
    ctx.on(CHANNEL.filesDriveFail, (_event, window, fetchId, error) => {
      if (isMain(window)) drive.failFetch(fetchId, error);
    });
    ctx.handle(CHANNEL.filesDriveSetLetter, (event, window, letter, clicked) => {
      fromMain(window);
      return drive.setLetter(letter, clickedNow(event.sender, clicked));
    });
    ctx.on(CHANNEL.filesDriveStatus, (_event, window, account, status) => {
      if (isMain(window)) drive.setStatus(account, status);
    });

    let before = drivePolicy();
    policies.on('changed', () => {
      const now = drivePolicy();
      if (now.forcedOff === before.forcedOff && now.letter === before.letter) return;
      before = now;
      void drive.policyChanged();
    });
    app.on('will-quit', () => drive.shutdown());
    void drive.startUp();

    if (__BULWARK_TEST_BUILD__) (globalThis as unknown as { __bulwarkFilesDrive: DriveController }).__bulwarkFilesDrive = drive;
  },
};
