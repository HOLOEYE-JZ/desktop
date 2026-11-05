import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { SEND_TO_NAME, windowsRegistrationKeys } from '../src/main/features/os-rules';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'dist', 'main.mjs');

export const APP_ORIGIN = 'https://app.bulwark.localhost';
export const STALWARTS = [
  { label: '1.0', url: 'https://stalwart-1.internal.bulwarkmail.org' },
  { label: '0.16', url: 'https://stalwart.internal.bulwarkmail.org' },
];
export const ACCOUNT = process.env.BULWARK_TEST_ACCOUNT ?? 'ent-alice@example.org';
export const ENT_PASSWORD = process.env.IT_ENT_PASSWORD ?? '';
export const SCREENSHOTS = process.env.BULWARK_SCREENSHOTS ?? path.join(tmpdir(), 'bulwark-screenshots');

export function tempProfile(name: string): string {
  // Short, as Cache API fails past MAX_PATH under a long userData path.
  const dir = mkdtempSync(path.join(tmpdir(), `bw-${name}-`));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeProfile(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // A file still held by a process that is going away: it's in the temp folder.
  }
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
}

export async function launch(profile: string, ...args: string[]): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  // A warm spare is one more window, 8 s after the main one shows. Tests that want it ask.
  const spare = args.includes('--bulwark-test-spare') ? [] : ['--bulwark-no-spare'];
  // BULWARK_TEST_WEBMAIL: a webmail build of this branch, instead of ./webmail.
  const server = process.env.BULWARK_TEST_WEBMAIL ? [`--bulwark-server-dir=${process.env.BULWARK_TEST_WEBMAIL}`] : [];
  return electron.launch({
    args: [MAIN, `--bulwark-user-data=${profile}`, '--lang=en-US', ...spare, ...server, ...args],
    cwd: ROOT,
    env,
  });
}

/**
 * The window the user sees. Not firstWindow(): a window whose page can't sit under the
 * window's controls is rebuilt once with a native frame before it's shown.
 */
export async function shownPage(app: ElectronApplication): Promise<Page> {
  const settled = () =>
    app.evaluate(({ BrowserWindow }) => {
      const shown = BrowserWindow.getAllWindows().filter((w) => w.isVisible() && !w.webContents.isLoading());
      return shown.length ? shown.map((w) => w.id).join() : null;
    });
  // Past the rebuild: the same window still there a moment after it finished loading.
  await expect
    .poll(
      async () => {
        const first = await settled();
        if (!first) return false;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return (await settled()) === first;
      },
      { timeout: 120_000, intervals: [200] },
    )
    .toBe(true);
  const page = app.windows().filter((candidate) => !candidate.isClosed()).at(-1);
  if (!page) throw new Error('no window');
  await page.waitForLoadState('domcontentloaded');
  return page;
}

export async function launchStandalone(profile: string, ...args: string[]): Promise<Launched> {
  const app = await launch(profile, '--standalone', ...args);
  return { app, page: await shownPage(app) };
}

/** The server's port, as Chromium was told it. */
export async function serverPort(app: ElectronApplication): Promise<number> {
  const rule = await app.evaluate(({ app: electronApp }) => electronApp.commandLine.getSwitchValue('host-resolver-rules'));
  const port = /127\.0\.0\.1:(\d+)/.exec(rule)?.[1];
  if (!port) throw new Error(`no port in ${rule}`);
  return Number(port);
}

/** A plain https client: right port and TLS name, not the app's session. */
export function plainRequest(
  port: number,
  pathName: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port, path: pathName, servername: 'app.bulwark.localhost', rejectUnauthorized: false, headers: { host: 'app.bulwark.localhost', ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Records what would have gone to the system browser, and answers every native prompt with its first button. */
export async function fakeOsIntegration(app: ElectronApplication, response = 0): Promise<void> {
  await app.evaluate(({ shell, dialog }, answer) => {
    const g = globalThis as unknown as { __opened: string[]; __prompts: unknown[] };
    g.__opened = [];
    g.__prompts = [];
    // The app's own prompt windows come here too (src/main/message-box.ts).
    (globalThis as unknown as { __bulwarkNativePrompts: boolean }).__bulwarkNativePrompts = true;
    shell.openExternal = async (url: string) => {
      g.__opened.push(url);
    };
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.__prompts.push(args[args.length - 1]);
      return { response: answer, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    dialog.showMessageBoxSync = ((...args: unknown[]) => {
      g.__prompts.push(args[args.length - 1]);
      return answer;
    }) as typeof dialog.showMessageBoxSync;
  }, response);
}

export function opened(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
}

export function prompts(app: ElectronApplication): Promise<{ message: string; detail: string }[]> {
  return app.evaluate(() => (globalThis as unknown as { __prompts: { message: string; detail: string }[] }).__prompts);
}

export async function waitForLogin(page: Page): Promise<void> {
  await page.locator('#username').waitFor({ state: 'visible', timeout: 90_000 });
}

/**
 * The sign-in page asks for the email address first and looks up its server; the
 * server field opens only when nothing is found (the test domains have no JMAP
 * records), or behind "Change" when something was.
 */
export async function fillServer(page: Page, serverUrl: string, username = ACCOUNT): Promise<void> {
  const field = page.locator('#jmap-endpoint');
  if (!(await field.isVisible())) {
    await page.fill('#username', username);
    const change = page.getByTestId('login-server-change');
    await expect(field.or(change)).toBeVisible({ timeout: 30_000 });
    if (!(await field.isVisible())) await change.click();
  }
  await field.fill(serverUrl);
}

export async function fillLogin(page: Page, serverUrl: string, username: string, password: string): Promise<void> {
  await waitForLogin(page);
  await fillServer(page, serverUrl, username);
  await page.fill('#username', username);
  await page.fill('#password', password);
}

export async function signIn(page: Page, serverUrl: string, username = ACCOUNT, password = ENT_PASSWORD): Promise<void> {
  await fillLogin(page, serverUrl, username, password);
  await page.keyboard.press('Enter');
  await expectMailShown(page);
}

export async function expectMailShown(page: Page): Promise<void> {
  // The folder list is there only once a session has its mailboxes.
  await expect(page.getByRole('navigation').or(page.locator('[data-role="inbox"]')).first()).toBeVisible({ timeout: 90_000 });
  await expect(page).not.toHaveURL(/\/login/, { timeout: 60_000 });
  await expect(page.locator('body')).toContainText(/inbox/i, { timeout: 60_000 });
}

export function requireAccount(): void {
  if (!ENT_PASSWORD) throw new Error("Set IT_ENT_PASSWORD to the test account's password");
}

/**
 * The page an app dialog holding `selector` is drawn in. With a webmail that opens its
 * dialogs as windows of their own (src/main/dialog-surfaces.ts) that is an about:blank
 * window; an older one draws them over `page`.
 */
export async function dialogHost(app: ElectronApplication, page: Page, selector: string, timeout = 30_000): Promise<Page> {
  let found: Page | null = null;
  await expect
    .poll(
      async () => {
        const candidates = [...app.windows().filter((p) => !p.isClosed() && p.url() === 'about:blank').reverse(), page];
        for (const candidate of candidates) {
          if ((await candidate.locator(selector).count().catch(() => 0)) > 0) {
            found = candidate;
            return true;
          }
        }
        return false;
      },
      { timeout, intervals: [100, 250, 500] },
    )
    .toBe(true);
  return found!;
}

function reg(...args: string[]): { ok: boolean; out: string } {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, out: result.stdout ?? '' };
}

/**
 * The user's real Bulwark registration under HKCU, as text, read only: what Default apps, the
 * mail links, the file types, Open with, Send to, start at login and the toast activator point
 * at. A package a test starts must leave it as it found it.
 */
export function realRegistrationSnapshot(): string {
  if (process.platform !== 'win32') return '';
  const { keys, values } = windowsRegistrationKeys('Bulwark.exe');
  const lines: string[] = [];
  for (const key of [...keys, 'Software\\Classes\\CLSID\\{7B1E4F2A-93C6-4D0E-A5B8-2F6C1D9E3A47}']) {
    const answer = reg('query', `HKCU\\${key}`, '/s');
    lines.push(`${key}: ${answer.ok ? answer.out.trim() : 'none'}`);
  }
  for (const value of [...values, { key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'Bulwark' }, { key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run', name: 'Bulwark' }]) {
    const answer = reg('query', `HKCU\\${value.key}`, '/v', value.name);
    lines.push(`${value.key} ${value.name}: ${answer.ok ? answer.out.trim() : 'none'}`);
  }
  const link = path.join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'SendTo', `${SEND_TO_NAME}.lnk`);
  lines.push(`Send to: ${existsSync(link) ? statSync(link).mtimeMs : 'none'}`);
  return lines.join('\n');
}

/** A development Electron, never an installed Bulwark.exe. */
export const DEV_ELECTRON = /\\electron\\dist\\electron\.exe/i;

/**
 * Whether the mail registration under HKCU is a development run's. On a machine with Bulwark
 * installed the same keys are the real app's, and a test must leave them alone.
 */
export function devRegistrationInHkcu(): boolean {
  const command = reg('query', 'HKCU\\Software\\Classes\\Bulwark.Url.mailto\\shell\\open\\command', '/ve');
  if (command.ok) return DEV_ELECTRON.test(command.out);
  const icon = reg('query', 'HKCU\\Software\\Bulwark\\Capabilities', '/v', 'ApplicationIcon');
  return icon.ok && DEV_ELECTRON.test(icon.out);
}

/** What a run may leave without this: the keys and the shortcut Electron makes on a toast. */
export function removeOsTraces(): void {
  if (process.platform !== 'win32') return;
  reg('delete', 'HKCU\\Software\\Classes\\CLSID\\{C2D85A16-4E7B-4F39-8A10-6B3E9F72D154}', '/f');
  // Only a development run's: an installed Bulwark's registration is the user's.
  if (devRegistrationInHkcu()) {
    for (const key of ['Software\\Bulwark', 'Software\\Classes\\bulwark', 'Software\\Classes\\Bulwark.Url.mailto', 'Software\\Classes\\Bulwark.Url.webcal', 'Software\\Classes\\Bulwark.File.eml', 'Software\\Classes\\Bulwark.File.ics', 'Software\\Classes\\Bulwark.File.vcf']) {
      reg('delete', `HKCU\\${key}`, '/f');
    }
    reg('delete', 'HKCU\\Software\\RegisteredApplications', '/v', 'Bulwark', '/f');
  }
  reg('delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Bulwark Dev', '/f');
  reg('delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run', '/v', 'Bulwark Dev', '/f');
  for (const name of ['Electron.lnk', 'Bulwark.lnk']) {
    const lnk = path.join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', name);
    if (existsSync(lnk)) {
      // Only ours: it points at this development Electron.
      const target = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}').TargetPath`], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
      if (/electron\\dist\\electron\.exe/i.test(target)) spawnSync('powershell.exe', ['-NoProfile', '-Command', `Remove-Item -LiteralPath '${lnk}'`], { windowsHide: true });
    }
  }
}
