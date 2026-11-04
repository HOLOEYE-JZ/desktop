import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT, ENT_PASSWORD, fakeOsIntegration, launchStandalone, removeProfile, requireAccount, signIn, STALWARTS, tempProfile } from './helpers';

/**
 * What's on the disk, read as bytes, on the real app against a real server. The HTTP cache is on the
 * list here because a page can't look at it, and that's where whole messages used to sit in the
 * clear. Needs a webmail build of this version.
 *
 *   BULWARK_TEST_ACCOUNT=<throwaway account> IT_ENT_PASSWORD=<its password> npx playwright test test/raw-bytes.spec.ts
 */

const { url: SERVER } = STALWARTS[0];

async function seed(subject: string): Promise<void> {
  const auth = `Basic ${Buffer.from(`${ACCOUNT}:${ENT_PASSWORD}`).toString('base64')}`;
  const session = await (await fetch(`${SERVER}/jmap/session`, { headers: { Authorization: auth } })).json() as { apiUrl: string; primaryAccounts: Record<string, string> };
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
  const call = async (methodCalls: unknown[]) => (await (await fetch(new URL(session.apiUrl, SERVER), {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls }),
  })).json() as { methodResponses: [string, Record<string, unknown>, string][] }).methodResponses;
  const boxes = await call([['Mailbox/get', { accountId, properties: ['role'] }, '0']]);
  const inbox = (boxes[0][1].list as { id: string; role: string }[]).find((box) => box.role === 'inbox')!.id;
  await call([['Email/set', { accountId, create: { m: {
    mailboxIds: { [inbox]: true },
    subject,
    from: [{ email: ACCOUNT }],
    to: [{ email: ACCOUNT }],
    textBody: [{ partId: 'b', type: 'text/plain' }],
    bodyValues: { b: { value: `BODY-${subject}` } },
  } } }, '0']]);
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : entry.isFile() ? [full] : [];
  });
}

function holding(profile: string, text: string): string[] {
  const needles = [Buffer.from(text, 'latin1'), Buffer.from(text, 'utf16le')];
  return files(profile)
    .filter((file) => statSync(file).size < 300 * 1024 * 1024 && needles.some((needle) => readFileSync(file).includes(needle)))
    .map((file) => path.relative(profile, file));
}

const records = (page: Page) => page.evaluate(() => new Promise<{ layers: string[]; rekey?: boolean }[]>((resolve, reject) => {
  const open = indexedDB.open('bulwark-store');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const request = open.result.transaction('accounts').objectStore('accounts').getAll();
    request.onsuccess = () => {
      open.result.close();
      resolve(request.result);
    };
  };
}));

async function storeHas(page: Page, subject: string): Promise<boolean> {
  return page.evaluate(async (mark) => {
    const account = JSON.parse(localStorage.getItem('bulwark-offline-accounts') ?? '[]')[0];
    const channel = new BroadcastChannel('bulwark-store-rpc');
    const id = crypto.randomUUID();
    const reply = await new Promise<string>((resolve) => {
      setTimeout(() => resolve(''), 8000);
      channel.onmessage = (event) => {
        if (event.data?.kind === 'reply' && event.data.id === id) resolve(JSON.stringify(event.data));
      };
      channel.postMessage({ kind: 'rpc', id, from: 'spec', method: 'answer', params: { account, calls: [
        ['Email/query', { filter: { text: mark }, limit: 1 }, 'q'],
        ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject'] }, 'g'],
      ] } });
    });
    channel.close();
    return reply.includes(`"subject":"${mark}"`);
  }, subject);
}

test.describe('the bytes on disk', () => {
  test.setTimeout(8 * 60_000);
  let profile: string;
  let app: ElectronApplication;

  test.beforeEach(() => {
    requireAccount();
    profile = tempProfile('raw');
  });

  test.afterEach(async () => {
    await app?.close().catch(() => undefined);
    removeProfile(profile);
  });

  test('hold no mail in the clear with nothing set up, the key takes the OS, and a wipe from settings finishes', async () => {
    const subject = `rawbytes${Date.now().toString(36)}`;
    await seed(subject);
    const started = await launchStandalone(profile);
    app = started.app;
    await fakeOsIntegration(app);
    await signIn(started.page, SERVER);
    await expect.poll(() => records(started.page).catch(() => []), { timeout: 60_000 }).toEqual([expect.objectContaining({ layers: ['safeStorage'] })]);
    await expect.poll(() => storeHas(started.page, subject).catch(() => false), { timeout: 120_000, intervals: [3000] }).toBe(true);
    // Time for what a sync fetches behind that, the raw message among it.
    await started.page.waitForTimeout(10_000);

    await started.page.goto(new URL('/settings/backup/offline', started.page.url()).href);
    await started.page.getByTestId('wipe-device-button').waitFor({ state: 'visible', timeout: 30_000 });

    const seen = holding(profile, subject);
    expect(seen).toEqual([]);
    expect(holding(profile, ENT_PASSWORD)).toEqual([]);

    await started.page.getByTestId('wipe-device-button').click();
    await started.page.getByTestId('wipe-device-details').waitFor({ state: 'visible' });
    await started.page.waitForTimeout(2500);
    await started.page.getByRole('button', { name: 'Remove everything', exact: true }).click();
    // Electron never answers getNotifications(): this used to wait for good.
    await started.page.locator('#username').waitFor({ state: 'visible', timeout: 60_000 });
    const left = await started.page.evaluate(async () => ({
      databases: (await indexedDB.databases()).map((database) => database.name),
      pending: localStorage.getItem('bulwark-wipe-pending'),
    }));
    expect(left.databases).not.toContain('bulwark-store');
    expect(left.pending).toBeNull();
  });
});
