import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { helperFile, loadHelperModule, type NativeFilesModule } from '../src/main/native-loader';
import { APP_ORIGIN, dialogHost, launchStandalone, removeProfile, signIn, tempProfile } from './helpers';

/**
 * Files on this computer end to end: the real webmail's sync engine in the main window, the
 * shell's disk side and the Windows drive, against a real JMAP server with Files. Needs a
 * webmail build with the engine in ./webmail and a throwaway account with Files.
 *
 *   IT_FILES_SERVER=https://... IT_FILES_USER=someone@example.org IT_FILES_PASSWORD=... \
 *     npx playwright test test/files-sync-real.spec.ts
 *
 * The folder picker and the OS trash are stood in for. The drive is a test one
 * (`Bulwark Test <pid>` in a temp folder) and goes in `afterAll`, with the Files folder the
 * test made on the server.
 */

const SERVER = process.env.IT_FILES_SERVER ?? '';
const USER = process.env.IT_FILES_USER ?? '';
const PASSWORD = process.env.IT_FILES_PASSWORD ?? '';
const RUN = `E2E-${Date.now().toString(36)}`;
const PROVIDER = `Bulwark Test ${process.pid}`;
const BASE = path.join(tmpdir(), `bulwark-files-test-${process.pid}`);
const LOCAL = path.join(BASE, 'local');
const ROOT = path.resolve(import.meta.dirname, '..');
const SEED = 'Grüße aus der Datei.txt';
const SEED_TEXT = `seeded ${RUN}\n`;

test.skip(process.platform !== 'win32' || !SERVER || !PASSWORD, 'Windows, and a server with a test account');
test.describe.configure({ mode: 'serial' });

interface Node { id: string; parentId: string | null; name: string; blobId?: string | null }

const auth = () => `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
let session: { apiUrl: string; uploadUrl: string; downloadUrl: string; primaryAccounts: Record<string, string> } | null = null;

async function jmap(calls: [string, Record<string, unknown>, string][]): Promise<[string, Record<string, unknown>, string][]> {
  if (!session) {
    const response = await fetch(`${SERVER}/jmap/session`, { headers: { Authorization: auth() } });
    if (response.status !== 200) throw new Error(`session ${response.status}: is the account there?`);
    session = await response.json();
  }
  const accountId = session!.primaryAccounts['urn:ietf:params:jmap:filenode'];
  const response = await fetch(new URL(session!.apiUrl, SERVER).toString(), {
    method: 'POST',
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:filenode'],
      methodCalls: calls.map(([name, args, id]) => [name, { accountId, ...args }, id]),
    }),
  });
  return ((await response.json()) as { methodResponses: [string, Record<string, unknown>, string][] }).methodResponses;
}

async function nodes(): Promise<Node[]> {
  const [[, result]] = await jmap([['FileNode/get', { ids: null, properties: ['id', 'parentId', 'name', 'blobId'] }, 'g']]);
  return result.list as Node[];
}

/** A folder or a file, in whichever draft the server speaks: 1.0 wants `@type`, 0.16 refuses it. */
async function create(props: { name: string; parentId: string | null; blobId?: string; type?: string }): Promise<string> {
  const base: Record<string, unknown> = { name: props.name, ...(props.parentId ? { parentId: props.parentId } : {}) };
  const draft = props.blobId ? { ...base, '@type': 'File', blobId: props.blobId, mediaType: props.type } : { ...base, '@type': 'Directory' };
  const old = props.blobId ? { ...base, blobId: props.blobId, type: props.type } : base;
  for (const attempt of [draft, old]) {
    const [[, result]] = await jmap([['FileNode/set', { create: { n: attempt } }, 's']]);
    const made = (result.created as Record<string, { id: string }> | undefined)?.n;
    if (made) return made.id;
  }
  throw new Error(`could not create ${props.name}`);
}

async function upload(data: Buffer): Promise<string> {
  const accountId = session!.primaryAccounts['urn:ietf:params:jmap:filenode'];
  const url = new URL(session!.uploadUrl.replace('{accountId}', encodeURIComponent(accountId)), SERVER).toString();
  const response = await fetch(url, { method: 'POST', headers: { Authorization: auth(), 'Content-Type': 'text/plain' }, body: new Uint8Array(data) });
  return ((await response.json()) as { blobId: string }).blobId;
}

async function download(blobId: string): Promise<string> {
  const accountId = session!.primaryAccounts['urn:ietf:params:jmap:filenode'];
  const url = session!.downloadUrl.replace('{accountId}', encodeURIComponent(accountId)).replace('{blobId}', blobId).replace('{name}', 'f').replace('{type}', 'text/plain');
  return (await fetch(new URL(url, SERVER).toString(), { headers: { Authorization: auth() } })).text();
}

const helper = (): NativeFilesModule => {
  const loaded = loadHelperModule(helperFile({ packaged: false, mainDir: path.join(ROOT, 'dist'), platform: process.platform, arch: process.arch }));
  if (!loaded?.filesDriveRoots) throw new Error('run npm run build:native');
  return loaded as unknown as NativeFilesModule;
};
const ourRoots = async () => (await helper().filesDriveRoots()).filter((root) => root.id.startsWith(`${PROVIDER}!`));

function readElsewhere(file: string): Promise<string> {
  const code = `try { process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8')) } catch (e) { process.stdout.write('ERR ' + e.code) }`;
  return new Promise((resolve) => execFile(process.execPath, ['-e', code, file], { timeout: 90_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (_error, stdout) => resolve(String(stdout))));
}

let profile: string;
let app: ElectronApplication;
let page: Page;
let folderId: string;

/** The placeholder state as main, the connected provider, sees it. */
const placeholder = (file: string) => app.evaluate((_electron, absolute) =>
  (globalThis as unknown as { __bulwarkFilesDrive: { placeholderState: (p: string) => unknown } }).__bulwarkFilesDrive.placeholderState(absolute), file);

test.beforeAll(async () => {
  mkdirSync(LOCAL, { recursive: true });
  // The Files side first: a folder of this run's own, with one file in it.
  folderId = await create({ name: RUN, parentId: null });
  await create({ name: SEED, parentId: folderId, blobId: await upload(Buffer.from(SEED_TEXT)), type: 'text/plain' });
  profile = tempProfile('files-real');
  ({ app, page } = await launchStandalone(profile, `--bulwark-test-files-provider=${PROVIDER}`, `--bulwark-test-files-drive-dir=${path.join(BASE, 'drive')}`, '--bulwark-test-files-letters=off'));
  await app.evaluate(({ dialog, shell }, local) => {
    const fs = process.getBuiltinModule('node:fs');
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [local] })) as typeof dialog.showOpenDialog;
    shell.trashItem = async (file: string) => fs.rmSync(file, { recursive: true, force: true });
    shell.showItemInFolder = () => {};
  }, LOCAL);
  await signIn(page, SERVER, USER, PASSWORD);
});

test.afterAll(async () => {
  await app?.evaluate(async (_electron, user) => {
    const drive = (globalThis as unknown as { __bulwarkFilesDrive?: { disable: (account: string, reason: string) => Promise<void>; state: () => { wanted: string[] } } }).__bulwarkFilesDrive;
    for (const account of drive?.state().wanted ?? []) await drive?.disable(account, 'user');
    void user;
  }, USER).catch(() => {});
  await app?.close().catch(() => {});
  for (const root of await ourRoots().catch(() => [])) await helper().filesDriveUnregister(root.id).catch(() => {});
  if (folderId) {
    const all = await nodes().catch(() => [] as Node[]);
    const trash = all.find((node) => node.parentId === null && node.name === '.Trash');
    // The run's folder, and anything of this run the engine put in Files' trash.
    const mine = all.filter((node) => node.id === folderId || (trash && node.parentId === trash.id && node.name.includes(RUN)));
    if (mine.length) await jmap([['FileNode/set', { destroy: mine.map((node) => node.id), onDestroyRemoveChildren: true }, 'd']]).catch(() => {});
  }
  rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  if (profile) removeProfile(profile);
  expect(await ourRoots()).toEqual([]);
});

async function openFilesOnThisComputer(): Promise<void> {
  await page.goto(`${APP_ORIGIN}/settings/files_sync`);
  await expect(page.getByTestId('files-sync-settings')).toBeVisible({ timeout: 60_000 });
}

test('a synced folder gets the Files folder, and both directions follow within seconds', async () => {
  await openFilesOnThisComputer();
  await page.getByTestId('files-sync-add-folder').click();
  // A window of its own (dialog-surfaces.ts), or over the page with an older webmail.
  const picker = (await dialogHost(app, page, '[role="dialog"]')).getByRole('dialog');
  await picker.getByText(RUN, { exact: true }).click();
  await picker.getByRole('button', { name: /Choose folder on this computer/ }).click();

  // Files to this computer.
  await expect.poll(() => existsSync(path.join(LOCAL, SEED)) && readFileSync(path.join(LOCAL, SEED), 'utf8'), { timeout: 60_000 }).toBe(SEED_TEXT);

  // This computer to Files.
  writeFileSync(path.join(LOCAL, `local ${RUN}.txt`), 'made here\n');
  await expect.poll(async () => {
    const found = (await nodes()).find((node) => node.parentId === folderId && node.name === `local ${RUN}.txt`);
    return found?.blobId ? download(found.blobId) : null;
  }, { timeout: 60_000 }).toBe('made here\n');

  // A change in Files elsewhere: push brings it.
  await create({ name: 'from elsewhere.txt', parentId: folderId, blobId: await upload(Buffer.from('elsewhere\n')), type: 'text/plain' });
  await expect.poll(() => existsSync(path.join(LOCAL, 'from elsewhere.txt')), { timeout: 30_000 }).toBe(true);

  // A delete here goes to Files' trash, not for good.
  rmSync(path.join(LOCAL, 'from elsewhere.txt'));
  await expect.poll(async () => (await nodes()).some((node) => node.parentId === folderId && node.name === 'from elsewhere.txt'), { timeout: 60_000 }).toBe(false);
  expect((await nodes()).some((node) => node.name === 'from elsewhere.txt')).toBe(true);

  await expect(page.getByTestId('files-sync-activity')).toContainText(`local ${RUN}.txt`);
});

test('the drive shows every Files folder as placeholders, and opening a file fetches it through the page', async () => {
  await openFilesOnThisComputer();
  await page.getByTestId('files-sync-settings').getByRole('switch').first().click();
  await expect.poll(async () => (await ourRoots()).length, { timeout: 30_000 }).toBe(1);
  // Windows' list of sync roots sometimes has no path yet: the folder is the drive's own naming.
  const dir = path.join(BASE, 'drive', USER);
  await expect.poll(() => existsSync(path.join(dir, RUN, SEED)), { timeout: 60_000 }).toBe(true).catch(async (error) => {
    const listing = existsSync(dir) ? readdirSync(dir) : 'no folder';
    const shown = await page.getByTestId('files-sync-settings').innerText().catch(() => '');
    throw new Error(`${(error as Error).message}\nin ${dir}: ${JSON.stringify(listing)}\nsettings: ${shown.slice(0, 1500)}`);
  });
  // Nothing fetched yet: a placeholder only. Asked of main, the provider: another process sees placeholders disguised as plain files.
  expect(await placeholder(path.join(dir, RUN, SEED))).toMatchObject({ identity: expect.any(String), hydrated: false });
  expect(await readElsewhere(path.join(dir, RUN, SEED))).toBe(SEED_TEXT);
  expect(await placeholder(path.join(dir, RUN, SEED))).toMatchObject({ hydrated: true, inSync: true });
  expect(readdirSync(dir)).toContain(RUN);

  // A file made in Explorer goes up.
  writeFileSync(path.join(dir, RUN, `drive ${RUN}.txt`), 'from the drive\n');
  await expect.poll(async () => {
    const found = (await nodes()).find((node) => node.parentId === folderId && node.name === `drive ${RUN}.txt`);
    return found?.blobId ? download(found.blobId) : null;
  }, { timeout: 60_000 }).toBe('from the drive\n');

  // Turned off: the sync root and its folder go.
  await page.getByTestId('files-sync-settings').getByRole('switch').first().click();
  await expect.poll(async () => (await ourRoots()).length, { timeout: 30_000 }).toBe(0);
  expect(existsSync(dir)).toBe(false);
});
