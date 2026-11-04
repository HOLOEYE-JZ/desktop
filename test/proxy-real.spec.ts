// A real sign-in through /__jmap: Stalwart behind a small http relay, as a LAN server would be
// without TLS, and straight over https. What the proxy's header allowlist can break shows up here:
// the session, mail with an inline image, upload, download and the push stream.
//
//   BULWARK_TEST_WEBMAIL=<dir> BULWARK_TEST_ACCOUNT=<account> IT_ENT_PASSWORD=<password> npx playwright test test/proxy-real.spec.ts
import { createServer, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { ACCOUNT, ENT_PASSWORD, fakeOsIntegration, launchStandalone, prompts, removeProfile, requireAccount, signIn, STALWARTS, tempProfile } from './helpers';

const server = STALWARTS[0].url;
const target = new URL(server);
const basic = () => `Basic ${Buffer.from(`${ACCOUNT}:${ENT_PASSWORD}`).toString('base64')}`;
const DOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMK/gAAAABJRU5ErkJggg==';

async function session() {
  return (await fetch(`${server}/.well-known/jmap`, { headers: { Authorization: basic() } })).json() as Promise<{ apiUrl: string; uploadUrl: string; downloadUrl: string; eventSourceUrl: string; primaryAccounts: Record<string, string> }>;
}

async function jmap(calls: unknown[]) {
  const { apiUrl } = await session();
  const answer = await fetch(apiUrl, {
    method: 'POST',
    headers: { Authorization: basic(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: calls }),
  });
  return (await answer.json()).methodResponses as [string, Record<string, any>, string][];
}

/** A message with a cid: picture in a tall HTML body, in the inbox, straight on the server. */
async function seedMail(subject: string): Promise<string> {
  const { uploadUrl, primaryAccounts } = await session();
  const accountId = primaryAccounts['urn:ietf:params:jmap:mail'];
  const raw = [
    `From: Probe <${ACCOUNT}>`,
    `To: ${ACCOUNT}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}@probe.example.org>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary=rel',
    '',
    '--rel',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Probe</p><img src="cid:dot@probe" width="40" height="40" alt="dot"><p><a href="https://example.com/proxy-probe">a link</a></p><div style="height:1500px">tall</div><p>end</p>',
    '--rel',
    'Content-Type: image/png; name=dot.png',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <dot@probe>',
    'Content-Disposition: inline; filename=dot.png',
    '',
    DOT,
    '--rel--',
    '',
  ].join('\r\n');
  const uploaded = await (await fetch(uploadUrl.replace('{accountId}', accountId), { method: 'POST', headers: { Authorization: basic(), 'Content-Type': 'message/rfc822' }, body: raw })).json() as { blobId: string };
  const [[, mailboxes]] = await jmap([['Mailbox/query', { accountId, filter: { role: 'inbox' } }, 'm']]);
  const [[, imported]] = await jmap([['Email/import', { accountId, emails: { one: { blobId: uploaded.blobId, mailboxIds: { [mailboxes.ids[0]]: true }, keywords: {} } } }, 'i']]);
  return imported.created.one.id as string;
}

async function removeMail(id: string): Promise<void> {
  const { primaryAccounts } = await session();
  await jmap([['Email/set', { accountId: primaryAccounts['urn:ietf:params:jmap:mail'], destroy: [id] }, 'd']]);
}

/** Opens the message and reads its frame. */
async function readBody(page: Page, subject: string) {
  await page.getByText(subject).first().click();
  const frameElement = page.locator('iframe[srcdoc]').first();
  await frameElement.waitFor({ state: 'visible', timeout: 60_000 });
  const frame = await (await frameElement.elementHandle())!.contentFrame();
  await expect.poll(() => frame!.evaluate(() => document.querySelector('img')?.naturalWidth ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await frameElement.boundingBox())?.height ?? 0, { timeout: 30_000 }).toBeGreaterThan(1500);
}

test.describe('through an http relay', () => {
  let relay: Server;
  let relayUrl = '';
  let mailId = '';
  const subject = `Proxy probe ${Date.now()}`;

  test.beforeAll(async () => {
    requireAccount();
    mailId = await seedMail(subject);
    relay = createServer((req, res) => {
      const upstream = httpsRequest(
        { host: target.hostname, port: 443, path: req.url, method: req.method, headers: { ...req.headers, host: target.hostname } },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    relay.close();
    relay.closeAllConnections();
    await removeMail(mailId);
  });

  test('sign-in, mail, upload, download and push all work', async () => {
    const profile = tempProfile('proxy-real');
    const { app, page } = await launchStandalone(profile);
    await fakeOsIntegration(app, 0);
    const answers: { url: string; status: number; text?: string }[] = [];
    page.on('response', (response) => {
      if (!response.url().includes('/__jmap/')) return;
      const answer: { url: string; status: number; text?: string } = { url: response.url(), status: response.status() };
      answers.push(answer);
      if (answer.status >= 400) void response.text().then((text) => { answer.text = text; }).catch(() => { answer.text = ''; });
    });
    // The route's own refusals. The server's front may answer an error of its own, and that passes through.
    const refusals = async () => {
      await expect.poll(() => answers.filter((answer) => answer.status >= 400 && answer.text === undefined).length).toBe(0);
      return answers.filter((answer) => /not been approved|Not available here|redirected|could not be reached/.test(answer.text ?? ''));
    };
    try {
      await signIn(page, relayUrl);
      expect((await prompts(app))[0].message).toMatch(/encryption/i);
      expect(answers.length).toBeGreaterThan(0);
      expect(await refusals()).toEqual([]);

      await readBody(page, subject);

      const { primaryAccounts, uploadUrl, downloadUrl, eventSourceUrl } = await session();
      const accountId = primaryAccounts['urn:ietf:params:jmap:mail'];
      const onProxy = (url: string) => `/__jmap/${Buffer.from(relayUrl).toString('base64url')}${new URL(url.replace(/\{[^}]+\}/g, 'x')).pathname}`;
      const bytes = await page.evaluate(async ({ uploadPath, downloadPath, authorization, account }) => {
        const body = new Uint8Array(70_000).map((_, n) => n % 251);
        const up = await fetch(uploadPath.replace('/x/', `/${account}/`), { method: 'POST', headers: { authorization, 'content-type': 'application/octet-stream' }, body });
        const uploaded = await up.json() as { blobId: string };
        const download = downloadPath.split('/x/')[0];
        const down = await fetch(`${download}/${account}/${uploaded.blobId}/probe.bin?accept=application/octet-stream`, { headers: { authorization } });
        const back = new Uint8Array(await down.arrayBuffer());
        return { upType: up.headers.get('content-type'), status: down.status, same: back.length === body.length && back.every((value, n) => value === body[n]) };
      }, { uploadPath: onProxy(uploadUrl), downloadPath: onProxy(downloadUrl), authorization: basic(), account: accountId });
      expect(bytes.upType).toMatch(/json/);
      expect(bytes.status).toBe(200);
      expect(bytes.same).toBe(true);

      const pushed = await page.evaluate(async ({ path, authorization }) => {
        const stop = new AbortController();
        const response = await fetch(`${path}?types=*&closeafter=no&ping=1`, { headers: { authorization, accept: 'text/event-stream' }, signal: stop.signal });
        const { value } = await response.body!.getReader().read();
        stop.abort();
        return { status: response.status, text: new TextDecoder().decode(value) };
      }, { path: onProxy(eventSourceUrl).replace(/\/$/, ''), authorization: basic() });
      expect(pushed.status).toBe(200);
      expect(pushed.text).toMatch(/event:|data:/);

      await page.reload();
      await expect(page).not.toHaveURL(/\/login/, { timeout: 60_000 });
      await expect(page.getByText(subject).first()).toBeVisible({ timeout: 60_000 });
      expect(await refusals()).toEqual([]);
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
    }
  });
});

test('straight over https, the same mail reads the same', async () => {
  requireAccount();
  const subject = `Proxy probe https ${Date.now()}`;
  const mailId = await seedMail(subject);
  const profile = tempProfile('proxy-real-s');
  const { app, page } = await launchStandalone(profile);
  await fakeOsIntegration(app, 0);
  try {
    await signIn(page, server);
    await readBody(page, subject);
  } finally {
    await app.close().catch(() => {});
    removeProfile(profile);
    await removeMail(mailId);
  }
});
