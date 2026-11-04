import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { generateCertificate } from '../src/main/cert';
import { removeProfile, shownPage, tempProfile } from './helpers';
import { TestCerts, type TestCert } from './test-certs';

/**
 * Client certificates and the Windows sign-in on the real app, against local servers, with
 * throwaway certificates in CurrentUser\My, removed at the end and checked by thumbprint.
 *
 * The picker is never on any screen: test/support/answer-prompts.cjs takes every native prompt
 * from before main starts. Servers below never send an NTLM or Negotiate challenge, so only
 * the first message of a sign-in comes here, which holds no answer to anything. Its content
 * isn't kept or printed.
 *
 * Hosts are under `.localhost`, which Chromium resolves to this machine.
 */

test.skip(process.platform !== 'win32', 'creates certificates in CurrentUser\\My, and policies are registry keys');
test.setTimeout(240_000);

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'dist', 'main.mjs');
const HOOK = path.join(ROOT, 'test', 'support', 'answer-prompts.cjs');

const SOFTWARE_KEY = "-KeyAlgorithm RSA -KeyLength 2048 -Provider 'Microsoft Software Key Storage Provider' -KeyExportPolicy NonExportable";
const CLIENT_USE = "-KeyUsage DigitalSignature -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.2')";

const POLICY_BASE = 'HKCU\\Software\\BulwarkTest';
const POLICY_ROOT = `${POLICY_BASE}\\Policies\\d5-${process.pid}`;
let policyRun = 0;

function reg(...args: string[]): void {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`reg ${args.join(' ')}: ${result.stderr}`);
}

function freshPolicies(values: Record<string, string> = {}): string {
  policyRun += 1;
  const root = `${POLICY_ROOT}\\run${policyRun}`;
  reg('add', `${root}\\Machine`, '/f');
  for (const [name, value] of Object.entries(values)) setPolicy(root, name, value);
  return root;
}

function setPolicy(root: string, name: string, value: string): void {
  reg('add', `${root}\\Machine`, '/v', name, '/t', 'REG_SZ', '/d', value, '/f');
}

/** A list policy: numbered values under a key of its name. */
function setRules(root: string, rules: unknown[]): void {
  reg('add', `${root}\\Machine\\AutoSelectCertificateForUrls`, '/f');
  for (const [index, rule] of rules.entries()) reg('add', `${root}\\Machine\\AutoSelectCertificateForUrls`, '/v', String(index + 1), '/t', 'REG_SZ', '/d', JSON.stringify(rule), '/f');
}

function removePolicy(root: string, name: string): void {
  reg('delete', `${root}\\Machine`, '/v', name, '/f');
}

const tls = generateCertificate('localhost');

let certs: TestCerts;
let caPem = '';
let caName = '';
let alice: TestCert;
let carol: TestCert;
const closers: (() => void)[] = [];

/** What a server saw. */
interface Hit {
  path: string;
  /** The common name of the certificate on the connection. */
  certificate: string | null;
  cookie: string;
}

interface CertServer {
  origin: string;
  host: string;
  hits: Hit[];
  sockets: Hit[];
  certificates: () => (string | null)[];
  of: (pathname: string) => Hit[];
}

function shortName(subject: string): string {
  return subject.replace(/^CN=/, '');
}

function commonName(socket: unknown): string | null {
  const name = (socket as TLSSocket).getPeerCertificate().subject?.CN;
  return typeof name === 'string' ? name : null;
}

async function certServer(name: string, options: { required?: boolean; plain?: boolean } = {}): Promise<CertServer> {
  const hits: Hit[] = [];
  const sockets: Hit[] = [];
  const server: HttpsServer = createHttpsServer(
    {
      key: tls.keyPem,
      cert: tls.certPem,
      ...(options.plain ? {} : { ca: [caPem], requestCert: true, rejectUnauthorized: !!options.required }),
    },
    (req, res) => {
      hits.push({ path: req.url ?? '', certificate: commonName(req.socket), cookie: req.headers.cookie ?? '' });
      // Never answered: in flight for as long as a test wants.
      if (req.url?.startsWith('/hang')) {
        req.resume();
        return;
      }
      res.setHeader('access-control-allow-origin', '*');
      if (req.url === '/set-old') res.setHeader('set-cookie', 'd5old=1; Secure; Path=/');
      else res.setHeader('set-cookie', ['d5=kept; Secure; Path=/; Max-Age=3600', 'd5session=1; Secure; Path=/; HttpOnly', '__Host-d5session=1; Secure; Path=/', `d5shared=1; Secure; Path=/; Domain=${name}.localhost`]);
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><title>${name}</title><p id="here">${name}</p>`);
    },
  );
  server.on('upgrade', (req, socket) => {
    hits.push({ path: req.url ?? '', certificate: commonName(socket), cookie: '' });
    socket.destroy();
  });
  server.on('secureConnection', (socket) => {
    sockets.push({ path: '', certificate: commonName(socket), cookie: '' });
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const host = `${name}.localhost:${(server.address() as AddressInfo).port}`;
  return {
    origin: `https://${host}`,
    host,
    hits,
    sockets,
    certificates: () => hits.map((hit) => hit.certificate),
    of: (pathname) => hits.filter((hit) => hit.path === pathname),
  };
}

/**
 * Says 401 with the given scheme until it's answered, and then counts that connection as signed
 * in, as IIS does. Never sends a challenge: a first message is all that comes here.
 */
interface SignInServer {
  port: number;
  url: (host: string, pathname: string) => string;
  ws: (host: string, pathname: string) => string;
  answered: (pathname: string) => string | null;
  asked: (pathname: string) => boolean;
  onSignedInConnection: (pathname: string) => boolean;
}

async function signInServer(scheme: string): Promise<SignInServer> {
  const asked = new Set<string>();
  const answers = new Map<string, string>();
  const onSignedIn = new Set<string>();
  const signedInSockets = new WeakSet<object>();
  const server: HttpServer = createHttpServer((req, res) => {
    const pathname = req.url ?? '';
    asked.add(pathname);
    res.setHeader('access-control-allow-origin', '*');
    const auth = req.headers.authorization;
    if (auth) {
      // The scheme only. A first message says who and on what machine, so it isn't kept.
      answers.set(pathname, auth.split(' ')[0]);
      signedInSockets.add(req.socket);
      res.end('in');
      return;
    }
    if (signedInSockets.has(req.socket)) {
      onSignedIn.add(pathname);
      res.end('still in');
      return;
    }
    res.statusCode = 401;
    res.setHeader('www-authenticate', scheme);
    res.end('sign in');
  });
  server.on('upgrade', (req, socket) => {
    const pathname = req.url ?? '';
    asked.add(pathname);
    const auth = req.headers.authorization;
    if (auth) answers.set(pathname, auth.split(' ')[0]);
    socket.end(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: ${scheme}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: (host, pathname) => `http://${host}:${port}${pathname}`,
    ws: (host, pathname) => `ws://${host}:${port}${pathname}`,
    answered: (pathname) => answers.get(pathname) ?? null,
    asked: (pathname) => asked.has(pathname),
    onSignedInConnection: (pathname) => onSignedIn.has(pathname),
  };
}

test.beforeAll(() => {
  certs = new TestCerts();
  const ca = certs.create({ name: 'D5 client CA', args: `${SOFTWARE_KEY} -KeyUsage CertSign,DigitalSignature -TextExtension @('2.5.29.19={text}CA=true')` });
  caPem = certs.exportPem(ca.thumbprint);
  caName = shortName(ca.subject);
  alice = certs.create({ name: 'D5 Alice', args: certs.signedArgs(ca, `${SOFTWARE_KEY} ${CLIENT_USE}`) });
  carol = certs.create({ name: 'D5 Carol', args: certs.signedArgs(ca, `${SOFTWARE_KEY} ${CLIENT_USE}`) });
  // The CA's key has done its work. Only the two leaves stay, and they're all a server can ask for.
  certs.remove(ca.thumbprint);
});

test.afterAll(() => {
  for (const close of closers) close();
  // Only this run's own key. reg.exe names the hive in full, so a check for `HKCU\\...` in
  // its answer never matched and this took every other run's key with it.
  spawnSync('reg.exe', ['delete', POLICY_ROOT, '/f'], { windowsHide: true });
  certs.finish();
});

interface Started {
  app: ElectronApplication;
  page: Page;
  profile: string;
}
const running: Started[] = [];

/** Esc on every prompt, unless told otherwise. `answer` is what a click would have returned. */
async function start(instance: string, options: { profile?: string; policies?: string; answer?: { response: number; checkboxChecked?: boolean }; standalone?: boolean } = {}): Promise<Started> {
  const profile = options.profile ?? tempProfile('d5');
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
  env.BULWARK_TEST_PROMPT_ANSWER = JSON.stringify(options.answer ?? { response: -1 });
  const app = await electron.launch({
    args: [
      '-r',
      HOOK,
      MAIN,
      `--bulwark-user-data=${profile}`,
      '--lang=en-US',
      '--bulwark-no-spare',
      // Not with --ignore-certificate-errors: the test of the pin would pass whatever it did.
      ...(options.standalone ? ['--standalone'] : [`--instance=${instance}`, '--ignore-certificate-errors']),
      '--bulwark-test-policy-poll=250',
      ...(options.policies ? [`--bulwark-test-policy-root=${options.policies}`] : []),
    ],
    cwd: ROOT,
    env,
  });
  const page = await shownPage(app);
  const started = { app, page, profile };
  running.push(started);
  return started;
}

async function stop(started: Started, keepProfile = false): Promise<void> {
  const closed = started.app.close().catch(() => {});
  const late = await Promise.race([closed.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 30_000))]);
  if (late) {
    console.log('the app did not close in 30 s');
    started.app.process().kill();
  }
  running.splice(running.indexOf(started), 1);
  if (!keepProfile) removeProfile(started.profile);
}

test.afterEach(async () => {
  for (const started of [...running]) await stop(started);
});

interface Prompt {
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
  checkboxLabel?: string;
  ticked: boolean;
  closedBySignal: boolean;
}

const promptsOf = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __prompts: Prompt[] }).__prompts);
const setAnswer = (app: ElectronApplication, answer: { response?: number; checkboxChecked?: boolean; hold?: boolean; ignoreSignal?: boolean }) =>
  app.evaluate((_electron, value) => {
    (globalThis as unknown as { __answer: unknown }).__answer = value;
  }, answer);

/** As if the window went there itself: what navigation.ts had let through. */
const goTo = (app: ElectronApplication, url: string) =>
  app.evaluate(async ({ BrowserWindow }, target) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible())!;
    return window.webContents.loadURL(target).then(
      () => 'loaded',
      (error: { code?: string }) => error.code ?? 'failed',
    );
  }, url);

/** The same, for a request that may stay open: nothing waits for it. */
const startGoing = (app: ElectronApplication, url: string) =>
  app.evaluate(({ BrowserWindow }, target) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible())!;
    void window.webContents.loadURL(target).catch(() => {});
  }, url);

/** What the webmail renders mail in, and the markers that show it ran. */
const mailFrame = (page: Page, html: string) =>
  page.evaluate((body) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.srcdoc = body;
    document.body.append(frame);
  }, html);

/** What the webmail runs plugins in. */
const pluginFrame = (page: Page, script: string) =>
  page.evaluate((code) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.srcdoc = `<script>${code}</scr` + 'ipt>';
    document.body.append(frame);
  }, script);

const stateOf = (profile: string) => {
  const file = path.join(profile, 'shell-state.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { certificateChoices?: Record<string, { fingerprint: string; account?: string }> }) : {};
};

const settled = (ms = 800) => new Promise((resolve) => setTimeout(resolve, ms));

type CertificatesBridge = { clearChoices(scope: { account?: string; last?: boolean }): Promise<void>; setAccount(account: string | null): Promise<void>; onConnectionsReset(listener: () => void): () => void };
const certificates = () => (window as unknown as { bulwarkDesktop: { certificates: CertificatesBridge } }).bulwarkDesktop.certificates;
const lastSignOut = (page: Page) => page.evaluate(`(${certificates})().clearChoices({ last: true })`);
const signOutOf = (page: Page, account: string) => page.evaluate(`(${certificates})().clearChoices({ account: ${JSON.stringify(account)} })`);
const activeAccount = (page: Page, account: string) => page.evaluate(`(${certificates})().setAccount(${JSON.stringify(account)})`);
const networkPid = (app: ElectronApplication) => app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().find((metric) => metric.serviceName?.includes('network'))?.pid);
const shownPageNow = (app: ElectronApplication) => app.windows().filter((candidate) => !candidate.isClosed()).at(-1)!;

test.describe('the picker', () => {
  test('names the server, and Esc sends nothing', async () => {
    const server = await certServer('picker');
    const { app } = await start(`${server.origin}/`);
    await expect.poll(() => server.hits.length).toBeGreaterThan(0);
    const [prompt, ...rest] = await promptsOf(app);
    expect(rest, 'one question for all the requests').toEqual([]);
    expect(prompt.message).toBe(`${server.host} asks for a certificate`);
    expect(prompt.detail.split('\n')[0]).toBe(`Server: ${server.host}`);
    expect(prompt.buttons.at(-1)).toBe("Don't send a certificate");
    expect(prompt.defaultId).toBe(prompt.buttons.length - 1);
    expect(prompt.cancelId).toBe(prompt.buttons.length - 1);
    expect(prompt.noLink).toBe(false);
    expect(prompt.ticked).toBe(false);
    expect(prompt.checkboxLabel).toBe(`Remember this for ${server.host}`);
    const names = prompt.buttons.slice(0, -1).map((row) => row.split('\n')[0]);
    expect(names.sort()).toEqual([shortName(alice.subject), shortName(carol.subject)].sort());
    expect(prompt.buttons[0].split('\n')[1]).toContain(`Issued by ${caName}, valid until`);
    expect(server.certificates().every((name) => name === null), 'no certificate went out').toBe(true);
  });

  test('a pick goes to that server, and only a tick survives a restart', async () => {
    const server = await certServer('pick');
    const first = await start(`${server.origin}/`, { answer: { response: 0 } });
    await expect.poll(() => server.hits.length).toBeGreaterThan(0);
    const [prompt] = await promptsOf(first.app);
    const picked = prompt.buttons[0].split('\n')[0];
    expect(server.certificates()[0]).toBe(picked);
    expect(stateOf(first.profile).certificateChoices).toBeUndefined();
    await stop(first, true);

    const second = await start(`${server.origin}/`, { profile: first.profile, answer: { response: 1, checkboxChecked: true } });
    await expect.poll(() => server.hits.length).toBeGreaterThan(1);
    const [again] = await promptsOf(second.app);
    expect(again, 'no tick last time: asked again').toBeTruthy();
    const chosen = again.buttons[1].split('\n')[0];
    expect(server.hits.at(-1)?.certificate).toBe(chosen);
    await expect.poll(() => Object.keys(stateOf(second.profile).certificateChoices ?? {})).toEqual([server.host]);
    expect(Object.values(stateOf(second.profile).certificateChoices ?? {})[0].fingerprint).toMatch(/^sha256\//);
    await stop(second, true);

    const count = server.hits.length;
    const third = await start(`${server.origin}/`, { profile: first.profile });
    await expect.poll(() => server.hits.length).toBeGreaterThan(count);
    expect(await promptsOf(third.app), 'ticked: not asked').toEqual([]);
    expect(server.hits.at(-1)?.certificate).toBe(chosen);

    // Remembered for this host and port: another port is another origin.
    const elsewhere = await certServer('pick');
    expect(elsewhere.host).not.toBe(server.host);
    await goTo(third.app, `${elsewhere.origin}/`);
    expect((await promptsOf(third.app)).map((asked) => asked.message)).toEqual([`${elsewhere.host} asks for a certificate`]);
    expect(elsewhere.certificates().every((name) => name === null), 'Esc there').toBe(true);
  });

  test('a page can reword it through its labels, but not take the server out of it', async () => {
    const own = await certServer('labels', { plain: true });
    const target = await certServer('labelled');
    const { app, page } = await start(`${own.origin}/`);
    await page.evaluate(() => {
      const shell = (window as unknown as { bulwarkDesktop: { shell: { setLanguages(update: unknown): void } } }).bulwarkDesktop.shell;
      shell.setLanguages({ ui: 'en', composer: [], labels: { certificateTitle: 'Your bank asks for a certificate', certificateRemember: 'Remember', certificateDetail: 'This is safe.', certificateNone: 'Later' } });
    });
    await settled(300);
    await goTo(app, `${target.origin}/`);
    const [prompt] = await promptsOf(app);
    expect(prompt.message, 'no {host}: refused').toBe(`${target.host} asks for a certificate`);
    expect(prompt.checkboxLabel, 'no {host}: refused').toBe(`Remember this for ${target.host}`);
    expect(prompt.detail.split('\n')[0], 'main\'s own line').toBe(`Server: ${target.host}`);
    expect(prompt.detail, 'an ordinary label still counts').toContain('This is safe.');
    expect(prompt.buttons.at(-1)).toBe('Later');
  });

  test('a server that insists: refused, then the choice still works', async () => {
    const server = await certServer('insists', { required: true });
    const { app, page } = await start(`${server.origin}/`, { answer: { response: 0 } });
    await expect.poll(() => server.hits.length).toBeGreaterThan(0);
    expect(server.certificates()[0]).toBeTruthy();
    await expect(page.locator('#here')).toHaveText('insists');
    expect(await promptsOf(app)).toHaveLength(1);
  });
});

test.describe('AutoSelectCertificateForUrls', () => {
  test('a rule that fits one certificate sends it without a question', async () => {
    const server = await certServer('ruled');
    const root = freshPolicies();
    setRules(root, [{ pattern: `https://${server.host}`, filter: { SUBJECT: { CN: shortName(alice.subject) }, ISSUER: { CN: caName } } }]);
    const { app } = await start(`${server.origin}/`, { policies: root });
    await expect.poll(() => server.hits.length).toBeGreaterThan(0);
    expect(server.hits[0].certificate).toBe(shortName(alice.subject));
    expect(await promptsOf(app)).toEqual([]);
  });

  test('a rule taken away stops at once, though Chromium was already given the certificate', async () => {
    const server = await certServer('ruled-gone');
    const root = freshPolicies();
    setRules(root, [{ pattern: `https://${server.host}`, filter: { SUBJECT: { CN: shortName(alice.subject) } } }]);
    const { app } = await start(`${server.origin}/`, { policies: root });
    await expect.poll(() => server.hits[0]?.certificate).toBe(shortName(alice.subject));
    reg('delete', `${root}\\Machine\\AutoSelectCertificateForUrls`, '/f');
    await expect
      .poll(
        async () => {
          await goTo(app, `${server.origin}/after`);
          return (await promptsOf(app)).length;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    await expect.poll(() => server.hits.at(-1)?.certificate, 'Esc: nothing goes').toBeNull();
  });

  test('a rule that fits two offers those two, and one that fits none or names another site changes nothing', async () => {
    const two = await certServer('rule-two');
    const none = await certServer('rule-none');
    const other = await certServer('rule-other');
    const root = freshPolicies();
    setRules(root, [
      { pattern: `https://${two.host}`, filter: { ISSUER: { CN: caName } } },
      { pattern: `https://${none.host}`, filter: { ISSUER: { CN: 'Nobody' } } },
    ]);
    const { app } = await start(`${two.origin}/`, { policies: root });
    await expect.poll(() => two.hits.length).toBeGreaterThan(0);
    await goTo(app, `${none.origin}/`);
    await goTo(app, `${other.origin}/`);
    const asked = await promptsOf(app);
    expect(asked.map((prompt) => prompt.message)).toEqual([two.host, none.host, other.host].map((host) => `${host} asks for a certificate`));
    expect(asked[0].buttons).toHaveLength(3);
    expect(two.certificates().every((name) => name === null)).toBe(true);
    expect(none.certificates().every((name) => name === null)).toBe(true);
    expect(other.certificates().every((name) => name === null)).toBe(true);
  });
});

test.describe('what a mail frame or plugin can trigger', () => {
  test('on a server nobody has asked yet: no question, no certificate, and a real sign-in still gets asked', async () => {
    const own = await certServer('own', { plain: true });
    const target = await certServer('target');
    const marker = await certServer('marker', { plain: true });
    const { app, page } = await start(`${own.origin}/`, { answer: { response: 0 } });
    expect(await promptsOf(app)).toEqual([]);

    await mailFrame(page, `<img src="${target.origin}/mail.png"><img src="${marker.origin}/mail-ran.png">`);
    await pluginFrame(page, `fetch("${target.origin}/plugin-fetch",{mode:"no-cors",credentials:"include"}).catch(()=>{});try{new WebSocket("${target.origin.replace('https', 'wss')}/plugin-ws")}catch{};fetch("${marker.origin}/plugin-ran",{mode:"no-cors"}).catch(()=>{});`);
    await expect.poll(() => marker.hits.map((hit) => hit.path).sort()).toEqual(['/mail-ran.png', '/plugin-ran']);
    await settled();
    expect(await promptsOf(app), 'no frame brings up a question').toEqual([]);
    expect(target.hits.filter((hit) => hit.certificate), 'no certificate').toEqual([]);

    // Nothing was left behind for the host: this used to stay "none" until a restart.
    expect(await goTo(app, `${target.origin}/signin`)).toBe('loaded');
    expect((await promptsOf(app)).map((prompt) => prompt.message)).toEqual([`${target.host} asks for a certificate`]);
    expect(target.of('/signin')[0]?.certificate).toBeTruthy();
  });

  test('on a server that holds a certificate: nothing gets through, on any route', async () => {
    const own = await certServer('own2');
    const marker = await certServer('marker2', { plain: true });
    const { app, page } = await start(`${own.origin}/`, { answer: { response: 0 } });
    await expect.poll(() => own.hits.length).toBeGreaterThan(0);
    const held = own.hits[0].certificate;
    expect(held).toBeTruthy();

    // A second server, signed in to by navigating there and coming back.
    const target = await certServer('held');
    await goTo(app, `${target.origin}/signin`);
    expect(target.of('/signin')[0]?.certificate).toBeTruthy();
    await goTo(app, `${own.origin}/back`);
    const before = target.hits.length;
    const socketsBefore = target.sockets.length;

    await mailFrame(page, `<img src="${target.origin}/mail.png"><iframe src="${target.origin}/mail-frame"></iframe><img src="${marker.origin}/mail-ran.png">`);
    const framed = app.windows().find((candidate) => candidate.url().startsWith(own.origin))!;
    await pluginFrame(framed, `fetch("${target.origin}/plugin-fetch",{mode:"no-cors",credentials:"include"}).catch(()=>{});try{new WebSocket("${target.origin.replace('https', 'wss')}/plugin-ws")}catch{};fetch("${marker.origin}/plugin-ran",{mode:"no-cors"}).catch(()=>{});`);
    await framed.evaluate((url) => fetch(`${url}/page-fetch`, { credentials: 'include', mode: 'no-cors' }).catch(() => {}), target.origin);
    await expect.poll(() => marker.hits.map((hit) => hit.path).sort()).toEqual(['/mail-ran.png', '/plugin-ran']);
    await settled();
    expect(target.hits.slice(before).map((hit) => hit.path), 'not one reached it').toEqual([]);
    expect(target.sockets.length, 'nor opened a connection').toBe(socketsBefore);

    // The app's own server is one party: a plugin lives there, and it holds the certificate already.
    await pluginFrame(framed, `fetch("${own.origin}/own-from-frame",{mode:"no-cors"}).catch(()=>{});`);
    await expect.poll(() => own.of('/own-from-frame').length).toBe(1);
    expect(own.of('/own-from-frame')[0].certificate).toBe(held);
  });

  test('a page\'s own request for another origin gets no question and no certificate', async () => {
    const own = await certServer('own3', { plain: true });
    const other = await certServer('another');
    const rule = await certServer('listed');
    const root = freshPolicies();
    setRules(root, [{ pattern: `https://${rule.host}`, filter: { SUBJECT: { CN: shortName(carol.subject) } } }]);
    const { app, page } = await start(`${own.origin}/`, { policies: root, answer: { response: 0 } });
    await page.evaluate((url) => fetch(`${url}/from-page`, { credentials: 'include', mode: 'no-cors' }).catch(() => {}), other.origin);
    await expect.poll(() => other.hits.length).toBeGreaterThan(0);
    expect(other.certificates()).toEqual([null]);
    expect(await promptsOf(app)).toEqual([]);

    // A server a rule names is the app's business from its own page, and nobody else's.
    await page.evaluate((url) => fetch(`${url}/listed-from-page`, { mode: 'no-cors' }).catch(() => {}), rule.origin);
    await expect.poll(() => rule.of('/listed-from-page').length).toBe(1);
    expect(rule.of('/listed-from-page')[0].certificate).toBe(shortName(carol.subject));
    const before = rule.hits.length;
    await mailFrame(page, `<img src="${rule.origin}/listed-from-mail.png">`);
    await settled();
    expect(rule.hits.length).toBe(before);
  });
});

test.describe('a page reaching other servers by a rule', () => {
  test('a wildcard rule asks once per host for the page\'s own request, and a window going there stays silent', async () => {
    const own = await certServer('own6', { plain: true });
    const first = await certServer('one.wild');
    const window2 = await certServer('two.wild');
    const root = freshPolicies();
    // A rule's port is part of its host, so one per server.
    setRules(root, [
      { pattern: `https://[*.]wild.localhost:${first.host.split(':')[1]}`, filter: { SUBJECT: { CN: shortName(alice.subject) } } },
      { pattern: `https://[*.]wild.localhost:${window2.host.split(':')[1]}`, filter: { SUBJECT: { CN: shortName(alice.subject) } } },
    ]);
    const { app, page } = await start(`${own.origin}/`, { policies: root, answer: { response: 0 } });
    await page.evaluate((url) => fetch(`${url}/from-page`, { mode: 'no-cors' }).catch(() => {}), first.origin);
    await expect.poll(() => first.of('/from-page').length).toBe(1);
    const asked = await promptsOf(app);
    expect(asked.map((prompt) => prompt.message)).toEqual([`${first.host} asks for a certificate`]);
    expect(asked[0].checkboxLabel, 'nothing to remember: it\'s for this run').toBeUndefined();
    expect(first.of('/from-page')[0].certificate).toBe(shortName(alice.subject));

    await goTo(app, `${window2.origin}/window`);
    expect(window2.of('/window')[0].certificate, 'a window going there').toBe(shortName(alice.subject));
    expect(await promptsOf(app), 'silently').toHaveLength(1);
  });

  test('a wildcard rule\'s question answered no sends nothing', async () => {
    const own = await certServer('own7', { plain: true });
    const target = await certServer('no.wild');
    const root = freshPolicies();
    setRules(root, [{ pattern: `https://[*.]wild.localhost:${target.host.split(':')[1]}`, filter: { SUBJECT: { CN: shortName(alice.subject) } } }]);
    const { app, page } = await start(`${own.origin}/`, { policies: root });
    await page.evaluate((url) => fetch(`${url}/from-page`, { mode: 'no-cors' }).catch(() => {}), target.origin);
    await expect.poll(() => target.of('/from-page').length).toBe(1);
    expect(await promptsOf(app)).toHaveLength(1);
    expect(target.of('/from-page')[0].certificate).toBeNull();
  });

  test('a print pop-up holding mail counts as a frame, on a server a rule names', async () => {
    const own = await certServer('own8', { plain: true });
    const marker = await certServer('marker8', { plain: true });
    const named = await certServer('named');
    const root = freshPolicies();
    setRules(root, [{ pattern: `https://${named.host}`, filter: { SUBJECT: { CN: shortName(alice.subject) } } }]);
    const { app, page } = await start(`${own.origin}/`, { policies: root, answer: { response: 0 } });
    await page.evaluate(([url, mark]) => {
      const popup = window.open('', '_blank')!;
      popup.document.write(`<!doctype html><img src="${url}/print.png"><img src="${mark}/print-ran.png">`);
      popup.document.close();
    }, [named.origin, marker.origin]);
    await expect.poll(() => marker.of('/print-ran.png').length).toBe(1);
    await settled();
    expect(named.hits.filter((hit) => hit.certificate)).toEqual([]);
    expect(await promptsOf(app)).toEqual([]);
  });
});

test.describe('Save image', () => {
  /** The real menu item, on what the context menu was given. */
  const saveImage = (app: ElectronApplication, url: string) =>
    app.evaluate(({ BrowserWindow, Menu }, srcURL) => {
      const original = Menu.buildFromTemplate;
      let template: Electron.MenuItemConstructorOptions[] = [];
      Menu.buildFromTemplate = ((items: Electron.MenuItemConstructorOptions[]) => {
        template = items;
        return { popup() {} } as unknown as Electron.Menu;
      }) as typeof Menu.buildFromTemplate;
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible())!;
      window.webContents.emit('context-menu', {}, { mediaType: 'image', hasImageContents: true, srcURL, editFlags: {}, dictionarySuggestions: [], linkURL: '', selectionText: '', isEditable: false, x: 0, y: 0, pageURL: window.webContents.getURL(), frameURL: '' });
      Menu.buildFromTemplate = original;
      const item = template.find((entry) => entry.id === 'context.saveImage');
      if (!item) return false;
      (item.click as () => void)();
      return true;
    }, url);

  test('an address mail picked doesn\'t get the Windows sign-in or a held certificate, and an ordinary one still saves', async () => {
    const own = await certServer('own9', { plain: true });
    const signIn = await signInServer('NTLM');
    const held = await certServer('heldsave');
    const plain = await certServer('plainsave', { plain: true });
    const root = freshPolicies({ AuthServerAllowlist: 'sso.localhost' });
    const { app } = await start(`${own.origin}/`, { policies: root, answer: { response: 0 } });
    // Chromium's own Save As stays away: nobody could answer it here.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.session.on('will-download', (event) => {
        (globalThis as unknown as { __downloads: number }).__downloads = ((globalThis as unknown as { __downloads?: number }).__downloads ?? 0) + 1;
        event.preventDefault();
      });
    });

    expect(await saveImage(app, signIn.url('sso.localhost', '/saved.png')), 'no such item for it').toBe(false);
    await settled();
    expect(signIn.asked('/saved.png')).toBe(false);

    await goTo(app, `${held.origin}/signin`);
    expect(held.of('/signin')[0]?.certificate).toBeTruthy();
    await goTo(app, `${own.origin}/back`);
    expect(await saveImage(app, `${held.origin}/saved.png`)).toBe(false);
    await settled();
    expect(held.of('/saved.png')).toEqual([]);

    expect(await saveImage(app, `${plain.origin}/saved.png`)).toBe(true);
    await expect.poll(() => plain.of('/saved.png').length).toBe(1);
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __downloads?: number }).__downloads ?? 0), 'it became a download').toBe(1);
  });
});

test.describe('several accounts', () => {
  test('one account signing out takes its own choices and nothing else: no restart, no question for the others', async () => {
    const own = await certServer('accounts');
    const other = await certServer('accounts2');
    const { app, page, profile } = await start(`${own.origin}/`, { answer: { response: 0, checkboxChecked: true } });
    await expect.poll(() => own.hits.length).toBeGreaterThan(0);
    await activeAccount(page, 'first@example.org');
    await goTo(app, `${other.origin}/`);
    await expect.poll(() => Object.keys(stateOf(profile).certificateChoices ?? {}).sort()).toEqual([own.host, other.host].sort());
    const asked = (await promptsOf(app)).length;
    const pid = await networkPid(app);
    await goTo(app, `${own.origin}/back`);
    const back = shownPageNow(app);

    await activeAccount(back, 'second@example.org');
    await activeAccount(back, 'first@example.org');
    await settled(2200);
    expect(await networkPid(app), 'a switch costs nothing').toBe(pid);
    expect(Object.keys(stateOf(profile).certificateChoices ?? {}).sort(), 'and takes nothing').toEqual([own.host, other.host].sort());

    await signOutOf(back, 'someone-else@example.org');
    expect(Object.keys(stateOf(profile).certificateChoices ?? {}).sort()).toEqual([own.host, other.host].sort());
    await signOutOf(back, 'first@example.org');
    await expect.poll(() => Object.keys(stateOf(profile).certificateChoices ?? {}), 'chosen before anyone signed in: it stays').toEqual([own.host]);
    await settled(2200);
    expect(await networkPid(app), 'still no restart').toBe(pid);
    expect((await promptsOf(app)).length).toBe(asked);
    await goTo(app, `${own.origin}/still`);
    expect(own.of('/still')[0]?.certificate, 'the others carry on').toBeTruthy();
    expect((await promptsOf(app)).length).toBe(asked);

    await lastSignOut(shownPageNow(app));
    await expect.poll(() => stateOf(profile).certificateChoices).toBeUndefined();
    await expect.poll(() => networkPid(app), 'the last one ends it').not.toBe(pid);
  });
});

test.describe('a sign-out with the picker open', () => {
  test('it closes, a pick that comes anyway sends and stores nothing, and the next request asks again', async () => {
    const own = await certServer('open', { plain: true });
    const target = await certServer('openpick');
    // Named by a rule that fits no certificate, so the page's fetch brings up the picker. A
    // window's navigation would do too, but a page in the middle of one can't be asked to sign out.
    const root = freshPolicies();
    setRules(root, [{ pattern: `https://${target.host}`, filter: { ISSUER: { CN: 'Nobody' } } }]);
    const { app, page, profile } = await start(`${own.origin}/`, { policies: root });
    const ask = (pathname: string) => page.evaluate((url) => void fetch(url, { mode: 'no-cors' }).catch(() => {}), `${target.origin}${pathname}`);
    await setAnswer(app, { hold: true, ignoreSignal: true });
    await ask('/first');
    await expect.poll(async () => (await promptsOf(app)).length).toBe(1);
    await lastSignOut(page);
    await app.evaluate(() => (globalThis as unknown as { __release(answer: unknown): void }).__release({ response: 0, checkboxChecked: true }));
    await settled(2500);
    expect(target.hits.filter((hit) => hit.certificate), 'nothing sent').toEqual([]);
    expect(stateOf(profile).certificateChoices, 'nothing stored').toBeUndefined();

    await setAnswer(app, { hold: true });
    await ask('/second');
    await expect.poll(async () => (await promptsOf(app)).length, 'no answer was left behind').toBe(2);
    await signOutOf(page, 'anyone@example.org');
    await expect.poll(async () => (await promptsOf(app))[1].closedBySignal, 'a real dialog closes').toBe(true);
    await settled();
    expect(target.hits.filter((hit) => hit.certificate)).toEqual([]);
  });
});

test.describe('forgetting', () => {
  const cookieNames = (app: ElectronApplication) =>
    app.evaluate(async ({ BrowserWindow }) => {
      const cookies = await BrowserWindow.getAllWindows()[0].webContents.session.cookies.get({});
      return cookies.filter((cookie) => cookie.name.includes('d5')).map((cookie) => `${cookie.name}${cookie.session ? ' (session)' : ''}`).sort();
    });

  test('the last sign-out takes the stored choice and what Chromium kept, and session cookies come back', async () => {
    const server = await certServer('forget');
    const first = await start(`${server.origin}/`, { answer: { response: 0, checkboxChecked: true } });
    await expect.poll(() => server.hits.length).toBeGreaterThan(0);
    await expect.poll(() => Object.keys(stateOf(first.profile).certificateChoices ?? {})).toEqual([server.host]);
    const asked = (await promptsOf(first.app)).length;
    const before = await cookieNames(first.app);
    expect(before).toEqual(['__Host-d5session (session)', 'd5', 'd5session (session)', 'd5shared (session)']);
    const pid = await networkPid(first.app);
    await setAnswer(first.app, { response: -1 });

    await lastSignOut(first.page);
    expect(stateOf(first.profile).certificateChoices, 'gone from disk at once').toBeUndefined();

    // As soon as a request can go at all, it has to go without the certificate and with the cookies.
    const page = first.page;
    let tries = 0;
    await expect
      .poll(
        async () => {
          tries += 1;
          await page.evaluate((path) => Promise.race([fetch(path).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1000))]), `/right-after?${tries}`);
          return (await networkPid(first.app)) !== pid && server.hits.some((hit) => hit.path.startsWith('/right-after') && !hit.certificate);
        },
        { timeout: 20_000, intervals: [50] },
      )
      .toBe(true);
    const after = server.hits.find((hit) => hit.path.startsWith('/right-after') && !hit.certificate)!;
    for (const name of ['d5=kept', 'd5session=1', '__Host-d5session=1', 'd5shared=1']) expect(after.cookie, name).toContain(name);
    expect(await cookieNames(first.app), 'and still as session cookies').toEqual(before);
    expect((await promptsOf(first.app)).length).toBeGreaterThan(asked);
  });

  test('a page is told at a restart, so what was under way can fail, and a stuck mail image doesn\'t cost a window its work', async () => {
    const server = await certServer('told');
    const { app, page } = await start(`${server.origin}/`, { answer: { response: 0 } });
    await expect.poll(() => server.hits.length).toBeGreaterThan(0);
    await page.evaluate(`
      window.__told = 0;
      window.__kept = 'unsaved';
      (${certificates})().onConnectionsReset(() => { window.__told += 1; });
      void fetch('/hang-post', { method: 'POST', body: 'x' }).catch(() => {});
    `);
    await mailFrame(page, `<img src="${server.origin}/hang.png">`);
    await expect.poll(() => server.of('/hang-post').length).toBe(1);
    await expect.poll(() => server.of('/hang.png').length).toBe(1);
    const pid = await networkPid(app);
    await lastSignOut(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __told: number }).__told), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await networkPid(app)).not.toBe(pid);
    await settled(1000);
    expect(await page.evaluate(() => (window as unknown as { __kept?: string }).__kept), 'not reloaded').toBe('unsaved');
  });

  test('requests sent during a restart fail at once, or go out with the session cookies', async () => {
    const server = await certServer('during');
    const { app, page } = await start(`${server.origin}/`, { answer: { response: 0 } });
    await expect.poll(() => server.hits.length).toBeGreaterThan(0);
    await setAnswer(app, { response: 0 });
    const pid = await networkPid(app);
    await lastSignOut(page);
    // A steady stream across the whole restart. Each has to settle: none may be left open.
    const outcomes = await page.evaluate(async () => {
      const results: string[] = [];
      for (let at = 0; at < 80; at += 1) {
        const one = fetch(`/during?${at}`).then((response) => `status ${response.status}`, () => 'failed');
        results.push(await Promise.race([one, new Promise<string>((resolve) => setTimeout(() => resolve('open'), 4000))]));
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return results;
    });
    expect(await networkPid(app), 'it did restart in that time').not.toBe(pid);
    expect(outcomes.filter((outcome) => outcome === 'open'), 'hanging').toEqual([]);
    expect(outcomes.at(-1)).toBe('status 200');
    const after = server.hits.filter((hit) => hit.path.startsWith('/during'));
    expect(after.filter((hit) => !hit.cookie.includes('d5session=1')), 'none without its session cookie').toEqual([]);
  });

  test('a page still loading comes back', async () => {
    const server = await certServer('stillloading');
    const { app, page } = await start(`${server.origin}/`, { answer: { response: 0 } });
    await expect.poll(() => server.hits.length).toBeGreaterThan(0);
    // In this order: a page in the middle of a navigation can't be asked to sign out.
    await lastSignOut(page);
    await startGoing(app, `${server.origin}/hang-page`);
    await expect.poll(() => server.of('/hang-page').length).toBe(1);
    // It would never end. A reload gives the window the page it was on.
    const before = server.of('/').length;
    await expect.poll(() => server.of('/').length, { message: 'reloaded', timeout: 15_000 }).toBeGreaterThan(before);
  });

  test('a second last sign-out soon after is as thorough', async () => {
    const server = await certServer('twice');
    const { app, page } = await start(`${server.origin}/`, { answer: { response: 0 } });
    await expect.poll(() => server.hits.length).toBeGreaterThan(0);
    const first = await networkPid(app);
    await lastSignOut(page);
    await expect.poll(() => networkPid(app)).not.toBe(first);
    await expect
      .poll(
        async () => {
          await page.evaluate(() => Promise.race([fetch('/again').catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]));
          return server.of('/again')[0]?.certificate;
        },
        { timeout: 15_000 },
      )
      .toBeTruthy();
    const second = await networkPid(app);
    await lastSignOut(page);
    await expect.poll(() => networkPid(app), { timeout: 8000 }).not.toBe(second);
  });

  test('clearing costs nobody a network restart when no certificate was involved', async () => {
    const server = await certServer('nothing', { plain: true });
    const { app, page } = await start(`${server.origin}/`);
    const pid = await networkPid(app);
    expect(pid).toBeTruthy();
    await lastSignOut(page);
    await settled(2500);
    expect(await networkPid(app)).toBe(pid);
  });

  test('the wipe nonce takes remembered choices, also at the start before anything is set up', async () => {
    const server = await certServer('wipe');
    const first = await start(`${server.origin}/`, { answer: { response: 0, checkboxChecked: true } });
    await expect.poll(() => Object.keys(stateOf(first.profile).certificateChoices ?? {})).toEqual([server.host]);
    await stop(first, true);

    const root = freshPolicies({ WipeOfflineData: 'd5-wipe-1' });
    const second = await start(`${server.origin}/`, { profile: first.profile, policies: root });
    await expect.poll(() => stateOf(first.profile).certificateChoices).toBeUndefined();
    await expect.poll(async () => (await promptsOf(second.app)).length, 'it asks again').toBeGreaterThan(0);
  });

  test('a live wipe nonce takes them too', async () => {
    const server = await certServer('wipe-live');
    const root = freshPolicies();
    const { app, page, profile } = await start(`${server.origin}/`, { policies: root, answer: { response: 0, checkboxChecked: true } });
    await expect.poll(() => Object.keys(stateOf(profile).certificateChoices ?? {})).toEqual([server.host]);
    const asked = (await promptsOf(app)).length;
    await page.evaluate(() => fetch('/set-old'));
    expect(await cookieNames(app)).toContain('d5old (session)');
    setPolicy(root, 'WipeOfflineData', 'd5-wipe-2');
    await expect.poll(() => stateOf(profile).certificateChoices).toBeUndefined();
    await setAnswer(app, { response: -1 });
    await expect
      .poll(
        async () => {
          await goTo(app, `${server.origin}/after-wipe`);
          return (await promptsOf(app)).length;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(asked);
    expect(await cookieNames(app), 'what the wipe deleted isn\'t set back with the session cookies').not.toContain('d5old (session)');
  });
});

test.describe('a new network service', () => {
  test('standalone: the app\'s own server is still accepted', async () => {
    const { app, page } = await start('', { standalone: true });
    // A request caught in the moment of the restart can hang. Those after it must work.
    const status = () =>
      page.evaluate(() => Promise.race([fetch('/api/config').then((response) => response.status, (error) => String(error)), new Promise((resolve) => setTimeout(() => resolve('hung'), 3000))]));
    expect(await status()).toBe(200);
    await app.evaluate(({ app: electronApp }) => {
      const service = electronApp.getAppMetrics().find((metric) => metric.serviceName?.includes('network'));
      process.kill(service!.pid);
    });
    await expect.poll(status, { timeout: 20_000 }).toBe(200);
  });
});

test.describe('the Windows sign-in', () => {
  const schemes = ['NTLM', 'Negotiate'];

  test('with no policy nobody gets it, also the machine Windows calls local', async () => {
    const own = await certServer('own4', { plain: true });
    const signIn = await signInServer('NTLM');
    const { app } = await start(`${own.origin}/`);
    // Windows' zones gave this host the sign-in, with no list set.
    await goTo(app, signIn.url('localhost', '/zone'));
    expect(signIn.asked('/zone')).toBe(true);
    await settled();
    expect(signIn.answered('/zone')).toBeNull();
  });

  for (const scheme of schemes) {
    test(`${scheme}: the listed server gets it from the window, and frames and pages never`, async () => {
      const own = await certServer(`own-${scheme.toLowerCase()}`, { plain: true });
      const marker = await certServer(`mark-${scheme.toLowerCase()}`, { plain: true });
      const signIn = await signInServer(scheme);
      const root = freshPolicies({ AuthServerAllowlist: 'sso.localhost' });
      const { app, page } = await start(`${own.origin}/`, { policies: root });

      // From inside the app first, while nothing has signed in. Chromium would answer each 401.
      await mailFrame(page, `<img src="${signIn.url('sso.localhost', '/mail.png')}"><iframe src="${signIn.url('sso.localhost', '/mail-frame')}"></iframe><img src="${marker.origin}/mail-ran.png">`);
      const inWorker = `fetch("${signIn.url('sso.localhost', '/worker')}",{mode:"no-cors",credentials:"include"}).catch(()=>{});try{new WebSocket("${signIn.ws('sso.localhost', '/worker-ws')}")}catch{}`;
      await pluginFrame(page, `fetch("${signIn.url('sso.localhost', '/plugin')}",{mode:"no-cors",credentials:"include"}).catch(()=>{});try{new WebSocket("${signIn.ws('sso.localhost', '/plugin-ws')}")}catch{};new Worker(URL.createObjectURL(new Blob([${JSON.stringify(inWorker)}])));fetch("${marker.origin}/plugin-ran",{mode:"no-cors"}).catch(()=>{});`);
      await page.evaluate(([url, ws]) => {
        void fetch(url, { credentials: 'include', mode: 'no-cors' }).catch(() => {});
        void new WebSocket(ws);
      }, [signIn.url('sso.localhost', '/page'), signIn.ws('sso.localhost', '/page-ws')]);
      await expect.poll(() => marker.hits.map((hit) => hit.path).sort()).toEqual(['/mail-ran.png', '/plugin-ran']);
      const inside = ['/mail.png', '/mail-frame', '/plugin', '/plugin-ws', '/worker', '/worker-ws', '/page', '/page-ws'];
      await expect.poll(() => inside.filter((pathname) => !signIn.asked(pathname)), 'each got as far as the 401').toEqual([]);
      await settled();
      for (const pathname of inside) expect(signIn.answered(pathname), pathname).toBeNull();

      // Not listed: not from the window either.
      await goTo(app, signIn.url('other.localhost', '/not-listed'));
      expect(signIn.asked('/not-listed')).toBe(true);
      await settled(300);
      expect(signIn.answered('/not-listed')).toBeNull();
      await goTo(app, signIn.url('a.sso.localhost', '/sub'));
      await settled(300);
      expect(signIn.answered('/sub'), 'no wildcard, no subdomain').toBeNull();

      // Listed, from the window: that's what the policy is for.
      await goTo(app, signIn.url('sso.localhost', '/window'));
      await expect.poll(() => signIn.answered('/window')).toBe(scheme);

      // That connection can stay signed in: from here frames don't even get to ask.
      await goTo(app, `${own.origin}/back`);
      const back = app.windows().at(-1)!;
      await mailFrame(back, `<img src="${signIn.url('sso.localhost', '/after.png')}"><img src="${marker.origin}/after-ran.png">`);
      await expect.poll(() => marker.of('/after-ran.png').length).toBe(1);
      await settled();
      expect(signIn.asked('/after.png')).toBe(false);
    });
  }

  test('a connection that signed in goes at the last sign-out: frames don\'t reach it', async () => {
    const own = await certServer('own10', { plain: true });
    const marker = await certServer('marker10', { plain: true });
    const signIn = await signInServer('NTLM');
    const root = freshPolicies({ AuthServerAllowlist: 'sso.localhost' });
    const { app } = await start(`${own.origin}/`, { policies: root });
    await goTo(app, signIn.url('sso.localhost', '/window'));
    await expect.poll(() => signIn.answered('/window')).toBe('NTLM');
    await goTo(app, `${own.origin}/back`);
    const page = shownPageNow(app);
    await lastSignOut(page);
    await settled(2500);
    await mailFrame(page, `<img src="${signIn.url('sso.localhost', '/after.png')}"><img src="${marker.origin}/ran.png">`);
    await pluginFrame(page, `fetch("${signIn.url('sso.localhost', '/after-plugin')}",{mode:"no-cors",credentials:"include"}).catch(()=>{});fetch("${marker.origin}/ran-plugin",{mode:"no-cors"}).catch(()=>{});`);
    await expect.poll(() => marker.hits.length).toBe(2);
    await settled();
    for (const pathname of ['/after.png', '/after-plugin']) {
      expect(signIn.onSignedInConnection(pathname), pathname).toBe(false);
      expect(signIn.answered(pathname), pathname).toBeNull();
    }
  });

  test('so does one on a server taken off the list', async () => {
    const own = await certServer('own11', { plain: true });
    const marker = await certServer('marker11', { plain: true });
    const signIn = await signInServer('NTLM');
    const root = freshPolicies({ AuthServerAllowlist: 'sso.localhost,spare.localhost' });
    const { app } = await start(`${own.origin}/`, { policies: root });
    await goTo(app, signIn.url('sso.localhost', '/window'));
    await expect.poll(() => signIn.answered('/window')).toBe('NTLM');
    await goTo(app, `${own.origin}/back`);
    const page = shownPageNow(app);
    setPolicy(root, 'AuthServerAllowlist', 'spare.localhost');
    await expect.poll(() => app.evaluate(({ app: electronApp }) => electronApp.commandLine.getSwitchValue('auth-server-whitelist'))).toBe('spare.localhost');
    await settled(500);
    await mailFrame(page, `<img src="${signIn.url('sso.localhost', '/off.png')}"><img src="${marker.origin}/ran.png">`);
    await expect.poll(() => marker.hits.length).toBe(1);
    await settled();
    expect(signIn.onSignedInConnection('/off.png')).toBe(false);
    await goTo(app, signIn.url('sso.localhost', '/off-window'));
    await settled(300);
    expect(signIn.onSignedInConnection('/off-window'), 'nor does the window keep it').toBe(false);
    expect(signIn.answered('/off-window')).toBeNull();
  });

  test('a server taken off the list stops getting it at once, and a new one waits for the restart', async () => {
    const own = await certServer('own5', { plain: true });
    const signIn = await signInServer('Negotiate');
    const root = freshPolicies({ AuthServerAllowlist: 'keep.localhost,drop.localhost', AuthNegotiateDelegateAllowlist: 'keep.localhost,drop.localhost' });
    const { app } = await start(`${own.origin}/`, { policies: root });
    const switches = () =>
      app.evaluate(({ app: electronApp }) => ({
        servers: electronApp.commandLine.getSwitchValue('auth-server-whitelist'),
        delegates: electronApp.commandLine.getSwitchValue('auth-negotiate-delegate-whitelist'),
      }));
    expect(await switches()).toEqual({ servers: 'keep.localhost,drop.localhost', delegates: 'keep.localhost,drop.localhost' });
    await goTo(app, signIn.url('drop.localhost', '/before'));
    await expect.poll(() => signIn.answered('/before')).toBe('Negotiate');

    setPolicy(root, 'AuthServerAllowlist', 'keep.localhost,new.localhost');
    setPolicy(root, 'AuthNegotiateDelegateAllowlist', 'keep.localhost');
    await expect.poll(switches).toEqual({ servers: 'keep.localhost', delegates: 'keep.localhost' });
    await goTo(app, signIn.url('drop.localhost', '/after'));
    expect(signIn.asked('/after')).toBe(true);
    await settled();
    expect(signIn.answered('/after'), 'off the list').toBeNull();
    await goTo(app, signIn.url('new.localhost', '/new'));
    await settled();
    expect(signIn.answered('/new'), 'not yet').toBeNull();
    await goTo(app, signIn.url('keep.localhost', '/kept'));
    await expect.poll(() => signIn.answered('/kept')).toBe('Negotiate');

    removePolicy(root, 'AuthServerAllowlist');
    removePolicy(root, 'AuthNegotiateDelegateAllowlist');
    await expect.poll(switches).toEqual({ servers: 'bulwark-no-integrated-sign-in.invalid', delegates: '' });
    await goTo(app, signIn.url('keep.localhost', '/gone'));
    await settled();
    expect(signIn.answered('/gone')).toBeNull();
  });
});
