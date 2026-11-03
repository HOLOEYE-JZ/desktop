import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'dist', 'main.mjs');

export const APP_ORIGIN = 'https://app.bulwark.localhost';
export const STALWARTS = [
  { label: '1.0', url: 'https://stalwart-1.internal.bulwarkmail.org' },
  { label: '0.16', url: 'https://stalwart.internal.bulwarkmail.org' },
];
export const ACCOUNT = process.env.BULWARK_TEST_ACCOUNT ?? 'ent-alice@example.org';
export const ENT_PASSWORD = process.env.IT_ENT_PASSWORD ?? '';
export const SCREENSHOTS = 'C:\\Users\\info\\Downloads\\jmap-webmail\\local-data\\desktop-offline-screenshots';

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

export async function fillLogin(page: Page, serverUrl: string, username: string, password: string): Promise<void> {
  await waitForLogin(page);
  await page.fill('#jmap-endpoint', serverUrl);
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
