import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT, ENT_PASSWORD, expectMailShown, fakeOsIntegration, launchStandalone, removeProfile, requireAccount, SCREENSHOTS, signIn, STALWARTS, tempProfile } from './helpers';
import { clickMenuItem } from './native-helpers';

/**
 * A document opened from Files in its own program goes back into Files when the program
 * saves: "Save to Files" puts the new bytes into the same node (same id). After that first
 * choice each later save goes back by itself, with a toast and no card, and when the node
 * changed on the server meanwhile the card comes back with Keep both. Real server, webmail
 * build of the matching branch, `shell.openPath` only records; the test is the program and
 * saves the file itself.
 *
 *   BULWARK_TEST_WEBMAIL=<dir> BULWARK_TEST_ACCOUNT=<account> IT_ENT_PASSWORD=<its password> npx playwright test test/save-to-files.spec.ts
 */

const CORE = 'urn:ietf:params:jmap:core';
const FILENODE = 'urn:ietf:params:jmap:filenode';
/** An empty zip: the end record alone, so the shell takes the file as whole. */
const EMPTY_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
const zipWith = (text: string) => Buffer.concat([Buffer.from(text), EMPTY_ZIP]);

interface FileNode { id: string; name: string; parentId: string | null; blobId: string | null; size?: number }

function call(url: string, method: string, body?: Buffer | string, type = 'application/json'): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method,
      rejectUnauthorized: false,
      headers: { Authorization: `Basic ${Buffer.from(`${ACCOUNT}:${ENT_PASSWORD}`).toString('base64')}`, 'Content-Type': type },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`${res.statusCode} from ${url}`));
        else resolve(text);
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function files(server: string) {
  const session = JSON.parse(await call(`${server}/jmap/session`, 'GET')) as { apiUrl: string; uploadUrl: string; primaryAccounts: Record<string, string> };
  const accountId = session.primaryAccounts[FILENODE] ?? session.primaryAccounts['urn:ietf:params:jmap:mail'];
  const api = async (calls: unknown[]) => {
    const body = JSON.stringify({ using: [CORE, FILENODE], methodCalls: calls });
    return (JSON.parse(await call(new URL(session.apiUrl, server).toString(), 'POST', body)) as { methodResponses: unknown[][] }).methodResponses;
  };
  const upload = async (bytes: Buffer): Promise<string> => {
    const url = new URL(session.uploadUrl.replace('{accountId}', encodeURIComponent(accountId)), server).toString();
    return (JSON.parse(await call(url, 'POST', bytes, 'application/octet-stream')) as { blobId: string }).blobId;
  };
  const all = async (): Promise<FileNode[]> => {
    const [[, answer]] = await api([['FileNode/get', { accountId, ids: null }, '0']]);
    return (answer as { list: FileNode[] }).list;
  };
  return { accountId, api, upload, all };
}

const pageOf = (app: ElectronApplication): Page => {
  const page = app.windows().filter((candidate) => !candidate.isClosed()).at(-1);
  if (!page) throw new Error('no window');
  return page;
};

async function fakeOpener(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __openedFiles: string[] };
    g.__openedFiles = [];
    shell.openPath = async (file: string) => {
      g.__openedFiles.push(file);
      return '';
    };
  });
}

const openedFiles = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { __openedFiles: string[] }).__openedFiles);

for (const server of STALWARTS) {
  test.describe(`on Stalwart ${server.label}`, () => {
    test.beforeAll(() => requireAccount());

    let profile: string;
    let app: ElectronApplication;
    let page: Page;
    const RUN = Date.now().toString(36);
    const prefix = `UXP2-save ${RUN}`;
    const name = `${prefix}.xlsx`;

    test.beforeAll(async () => {
      profile = tempProfile('savefiles');
      const started = await launchStandalone(profile);
      app = started.app;
      page = started.page;
      await fakeOpener(app);
      await fakeOsIntegration(app);
      await signIn(page, server.url);
      await expectMailShown(page);
    });

    test.afterAll(async () => {
      await app?.close().catch(() => {});
      const f = await files(server.url).catch(() => null);
      if (f) {
        const ours = (await f.all()).filter((node) => node.name.startsWith(prefix)).map((node) => node.id);
        if (ours.length) await f.api([['FileNode/set', { accountId: f.accountId, destroy: ours }, 'd']]).catch(() => {});
      }
      removeProfile(profile);
    });

    test('Save to Files updates the same file, later saves go there by themselves, and a change on the server meanwhile offers Keep both', async () => {
      const f = await files(server.url);
      const blobId = await f.upload(EMPTY_ZIP);
      const [[, created]] = await f.api([['FileNode/set', { accountId: f.accountId, create: { n: { parentId: null, name, blobId, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } } }, 'c']]);
      const nodeId = (created as { created?: Record<string, { id: string }> }).created?.n.id;
      expect(nodeId, JSON.stringify(created)).toBeTruthy();

      await clickMenuItem(app, 'go.files');
      const row = page.getByText(name, { exact: true }).first();
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.dblclick();
      const open = page.getByRole('button', { name: 'Open in default app' });
      await expect(open).toBeVisible({ timeout: 30_000 });
      await open.click();
      await expect.poll(async () => (await openedFiles(app)).length, { timeout: 30_000 }).toBe(1);
      const file = (await openedFiles(app))[0];
      expect(readFileSync(file).equals(EMPTY_ZIP)).toBe(true);
      // The pane goes once the program has it (pim-p2-18).
      await expect(open).toHaveCount(0, { timeout: 10_000 });

      // Saved in the program: Save to Files comes first and writes into the same node.
      const first = zipWith('first edit ');
      writeFileSync(file, first);
      const offer = pageOf(app).locator('[data-testid="edited-file"]');
      await expect(offer).toBeVisible({ timeout: 30_000 });
      // The card's actions; the X beside the name only hides it until the next save (pim-p3-6).
      const actions = async () => (await offer.locator('button').allInnerTexts()).map((text) => text.trim()).filter(Boolean);
      await expect.poll(actions, { timeout: 30_000 }).toEqual(['Save to Files', 'Attach to a new message', 'Save a copy…', 'Discard edits…']);
      // In the toast corner, not over the middle of the file list.
      const box = (await pageOf(app).locator('[data-testid="edited-files"]').boundingBox())!;
      const width = await pageOf(app).evaluate(() => window.innerWidth);
      expect(box.x + box.width).toBeGreaterThan(width - 40);
      await page.screenshot({ path: path.join(SCREENSHOTS, `pim-p3-fix-6-save-offer-${server.label}.png`) });
      await offer.getByRole('button', { name: 'Save to Files' }).click();
      const toasts = page.getByRole('region', { name: 'Notifications' });
      await expect(toasts.getByText(`${name} saved to Files. Later saves from its program go there on their own.`)).toBeVisible({ timeout: 30_000 });
      // By size: Stalwart 1.0 stores an upload under a blob id of its own.
      await expect.poll(async () => (await f.all()).find((n) => n.id === nodeId)?.size ?? null, { timeout: 30_000 }).toBe(first.length);
      expect((await f.all()).filter((n) => n.name.startsWith(prefix))).toHaveLength(1);
      await expect(offer).toHaveCount(0, { timeout: 30_000 });

      // The program saves again: into the same file, by itself, with no card and no false
      // conflict (pim-p3-1), and once more.
      for (const text of ['second edit ', 'third edit, a bit longer ']) {
        const bytes = zipWith(text);
        writeFileSync(file, bytes);
        await expect.poll(async () => (await f.all()).find((n) => n.id === nodeId)?.size ?? null, { timeout: 30_000 }).toBe(bytes.length);
        await expect(toasts.getByText(`${name} saved to Files.`, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
        await expect(offer).toHaveCount(0);
        expect((await f.all()).filter((n) => n.name.startsWith(prefix))).toHaveLength(1);
      }
      await page.screenshot({ path: path.join(SCREENSHOTS, `pim-p3-fix-1-second-save-${server.label}.png`) });

      // Someone changes it in Files, then the program saves again: the card comes back with Keep both.
      const theirs = zipWith('changed on the server ');
      const theirBlob = await f.upload(theirs);
      await f.api([['FileNode/set', { accountId: f.accountId, update: { [nodeId!]: { blobId: theirBlob } } }, 'u']]);
      const second = zipWith('fourth edit, longer than the others ');
      writeFileSync(file, second);
      await expect(offer).toBeVisible({ timeout: 30_000 });
      await expect(offer.locator('[data-testid="edited-file-conflict"]')).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: path.join(SCREENSHOTS, `pim-p3-fix-1-conflict-${server.label}.png`) });
      await offer.getByRole('button', { name: 'Keep both' }).click();
      await expect.poll(async () => (await f.all()).filter((n) => n.name.startsWith(prefix)).length, { timeout: 30_000 }).toBe(2);
      const after = (await f.all()).filter((n) => n.name.startsWith(prefix));
      const original = after.find((n) => n.id === nodeId)!;
      const copy = after.find((n) => n.id !== nodeId)!;
      expect(original.size).toBe(theirs.length);
      expect(copy.size).toBe(second.length);
      expect(copy.parentId).toBe(original.parentId);
    });
  });
}
