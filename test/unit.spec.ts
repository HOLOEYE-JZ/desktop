import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer, request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { fingerprintOf, generateCertificate } from '../src/main/cert';
import { isSsoStart, looksLikeProviderLogout } from '../src/main/navigation-rules';
import { isPrivateAddress, isPrivateHost, serverOrigin } from '../src/main/server-address';
import { cascadeFrom, centreIn, CASCADE_PX, isOnSomeDisplay, placeWindow } from '../src/main/window-placement';
import { forwardJmap, isJmapRoute, parseJmapRoute } from '../src/server/jmap-proxy';
import { sanitizeRequest } from '../src/server/sanitize';

const HOST = 'app.bulwark.localhost';
const display = (x: number, y: number, width = 1920, height = 1040) => ({ workArea: { x, y, width, height } });

test.describe('certificate made with Node only', () => {
  test('parses as X.509 for our name, valid today', () => {
    const { certPem } = generateCertificate(HOST);
    const cert = new X509Certificate(certPem);
    expect(cert.subjectAltName).toBe(`DNS:${HOST}`);
    expect(new Date(cert.validFrom).getTime()).toBeLessThan(Date.now());
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now() + 365 * 86400_000);
    expect(cert.checkHost(HOST)).toBe(HOST);
    expect(cert.verify(cert.publicKey)).toBe(true);
  });

  test('a TLS server runs on it, and pinning the certificate as the only CA connects', async () => {
    const { keyPem, certPem } = generateCertificate(HOST);
    const server = createHttpsServer({ key: keyPem, cert: certPem }, (_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const body = await new Promise<string>((resolve, reject) => {
      request({ host: '127.0.0.1', port, servername: HOST, ca: certPem, headers: { host: HOST } }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve(text));
      }).on('error', reject).end();
    });
    server.close();
    expect(body).toBe('ok');
  });

  test('another certificate does not pass the pin', async () => {
    const mine = generateCertificate(HOST);
    const other = generateCertificate(HOST);
    expect(fingerprintOf(mine.certPem)).not.toBe(fingerprintOf(other.certPem));
    const server = createHttpsServer({ key: other.keyPem, cert: other.certPem }, (_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const code = await new Promise<string>((resolve) => {
      request({ host: '127.0.0.1', port, servername: HOST, ca: mine.certPem }, () => resolve('connected'))
        .on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'))
        .end();
    });
    server.close();
    expect(code).not.toBe('connected');
  });
});

test.describe('window placement', () => {
  const size = { width: 800, height: 600 };

  test('a stored position on a monitor that is gone is not used', () => {
    const stored = { x: 3000, y: 200, width: 800, height: 600 };
    expect(isOnSomeDisplay(stored, [display(0, 0)])).toBe(false);
    const placed = placeWindow({ size, stored, displays: [display(0, 0)], current: display(0, 0) });
    expect(placed.x).toBeLessThan(1920);
    expect(placed).toEqual(centreIn(size, display(0, 0).workArea));
  });

  test('a stored position on a second monitor that is still there is kept', () => {
    const stored = { x: 2200, y: 200, width: 800, height: 600 };
    const placed = placeWindow({ size, stored, displays: [display(0, 0), display(1920, 0)], current: display(0, 0) });
    expect(placed).toEqual(stored);
  });

  test('new windows of a type cascade from the last one', () => {
    const sameType = { x: 100, y: 100, width: 800, height: 600 };
    const placed = placeWindow({ size, sameType, anchor: sameType, displays: [display(0, 0)], current: display(0, 0) });
    expect(placed).toEqual({ x: 100 + CASCADE_PX, y: 100 + CASCADE_PX, width: 800, height: 600 });
  });

  test('the cascade wraps at the edge rather than walk off the screen', () => {
    const area = display(0, 0).workArea;
    const placed = cascadeFrom({ x: 1600, y: 800, width: 800, height: 600 }, size, area);
    expect(placed.x + placed.width).toBeLessThanOrEqual(1920);
    expect(placed.y + placed.height).toBeLessThanOrEqual(1040);
  });

  test('a new window opens on the monitor in use, not where its type last was', () => {
    const stored = { x: 100, y: 100, width: 800, height: 600 };
    const anchor = { x: 2100, y: 100, width: 1000, height: 800 };
    const placed = placeWindow({ size, stored, anchor, displays: [display(0, 0), display(1920, 0)], current: display(1920, 0) });
    expect(placed.x).toBeGreaterThanOrEqual(1920);
  });

  test('never larger than the monitor', () => {
    const placed = placeWindow({ size: { width: 4000, height: 3000 }, displays: [display(0, 0)], current: display(0, 0) });
    expect(placed.width).toBeLessThanOrEqual(1920);
    expect(placed.height).toBeLessThanOrEqual(1040);
  });
});

test.describe('server addresses', () => {
  for (const address of ['10.1.2.3', '127.0.0.1', '192.168.1.5', '172.16.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    test(`${address} is private`, () => expect(isPrivateAddress(address)).toBe(true));
  }
  for (const address of ['62.176.249.204', '8.8.8.8', '2a01:584:3e::20']) {
    test(`${address} is public`, () => expect(isPrivateAddress(address)).toBe(false));
  }

  test('the names the webmail refuses are private too, so they get the prompt', async () => {
    for (const host of ['localhost', 'mail.local', 'mail.internal', 'x.localhost', 'mail.localdomain', '[::1]']) {
      expect(await isPrivateHost(host), host).toBe(true);
    }
  });

  test('serverOrigin refuses what the login routes would', () => {
    expect(serverOrigin('https://mail.example:8443/jmap')).toBe('https://mail.example:8443');
    expect(serverOrigin('http://192.168.1.5:8080/')).toBe('http://192.168.1.5:8080');
    expect(serverOrigin('ftp://mail.example')).toBeNull();
    expect(serverOrigin('https://user:pw@mail.example')).toBeNull();
    expect(serverOrigin('nonsense')).toBeNull();
    expect(serverOrigin(42)).toBeNull();
  });
});

test.describe('navigation rules', () => {
  const origin = 'https://mail.example.org';

  test('an authorize request back to the instance starts the SSO chain', () => {
    const url = new URL(`https://idp.example/authorize?client_id=x&redirect_uri=${encodeURIComponent(`${origin}/en/auth/callback`)}`);
    expect(isSsoStart(url, origin)).toBe(true);
  });

  test('a link that names another redirect does not', () => {
    const url = new URL('https://evil.example/authorize?redirect_uri=https://evil.example/cb');
    expect(isSsoStart(url, origin)).toBe(false);
    expect(isSsoStart(new URL('https://example.com/page'), origin)).toBe(false);
  });

  test('provider logout URLs are recognised', () => {
    expect(looksLikeProviderLogout(new URL('https://idp.example/oidc/logout?client_id=x'))).toBe(true);
    expect(looksLikeProviderLogout(new URL('https://idp.example/x?id_token_hint=abc'))).toBe(true);
    expect(looksLikeProviderLogout(new URL('https://idp.example/end_session'))).toBe(true);
    expect(looksLikeProviderLogout(new URL('https://example.com/about'))).toBe(false);
  });
});

test.describe('request sanitising', () => {
  function requestWith(headers: Record<string, string>): IncomingMessage {
    const raw: string[] = [];
    for (const [name, value] of Object.entries(headers)) raw.push(name, value);
    return { headers: { ...headers }, rawHeaders: raw } as unknown as IncomingMessage;
  }

  test('removes what page script can forge, and sets the real values', () => {
    const req = requestWith({
      host: 'evil.example',
      'x-bulwark-launch': 'secret',
      'x-forwarded-for': '6.6.6.6',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http',
      'x-forwarded-port': '1',
      'x-middleware-subrequest': 'middleware:middleware',
      'x-real-ip': '6.6.6.6',
      forwarded: 'for=6.6.6.6',
      cookie: 'kept=1',
      'sec-fetch-site': 'same-origin',
    });
    sanitizeRequest(req);
    expect(req.headers).toEqual({
      host: HOST,
      cookie: 'kept=1',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-host': HOST,
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '127.0.0.1',
    });
    expect(req.rawHeaders).not.toContain('secret');
    expect(req.rawHeaders).not.toContain('6.6.6.6');
  });
});

test.describe('/__jmap route', () => {
  let upstream: Server;
  let origin = '';
  const seen: { url: string; method: string; headers: IncomingMessage['headers']; body: string }[] = [];

  test.beforeAll(async () => {
    upstream = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
        if (req.url === '/.well-known/jmap') {
          res.writeHead(307, { location: '/jmap/session' }).end();
          return;
        }
        if (req.url === '/stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: one\n\n');
          setTimeout(() => {
            res.write('data: two\n\n');
            res.end();
          }, 200);
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'upstream=1',
          'www-authenticate': 'Basic realm=x',
        });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  test.afterAll(() => {
    upstream.close();
    upstream.closeAllConnections();
  });

  const idOf = (value: string) => Buffer.from(value).toString('base64url');

  async function through(url: string, init: RequestInit & { headers?: Record<string, string> } = {}, trusted = true) {
    const server = createHttpServer((req, res) => {
      void forwardJmap(req, res, (candidate) => trusted && candidate === origin);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(address + url, init);
      return { status: response.status, headers: response.headers, text: await response.text() };
    } finally {
      server.close();
      server.closeAllConnections();
    }
  }

  test('a server that is not approved gets nothing', async () => {
    const before = seen.length;
    const answer = await through(`/__jmap/${idOf(origin)}/jmap/`, {}, false);
    expect(answer.status).toBe(403);
    expect(seen.length).toBe(before);
  });

  test('forwards with the path, and follows the discovery redirect', async () => {
    const answer = await through(`/__jmap/${idOf(origin)}/.well-known/jmap`);
    expect(answer.status).toBe(200);
    expect(seen.at(-1)?.url).toBe('/jmap/session');
    expect(JSON.parse(answer.text)).toEqual({ ok: true });
  });

  test('the app\'s cookies never reach the mail server, and its cookies never reach the app', async () => {
    const answer = await through(`/__jmap/${idOf(origin)}/jmap/`, {
      method: 'POST',
      body: '{"using":[]}',
      headers: { authorization: 'Basic abc', cookie: 'jmap_session=secret', origin: 'https://app.bulwark.localhost', 'content-type': 'application/json' },
    });
    const sent = seen.at(-1)!;
    expect(sent.method).toBe('POST');
    expect(sent.body).toBe('{"using":[]}');
    expect(sent.headers.authorization).toBe('Basic abc');
    expect(sent.headers.cookie).toBeUndefined();
    expect(sent.headers.origin).toBeUndefined();
    expect(answer.headers.get('set-cookie')).toBeNull();
    expect(answer.headers.get('www-authenticate')).toBeNull();
  });

  test('the push stream arrives piece by piece', async () => {
    const server = createHttpServer((req, res) => {
      void forwardJmap(req, res, (candidate) => candidate === origin);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${address}/__jmap/${idOf(origin)}/stream`);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('one');
    expect(first).not.toContain('two');
    await reader.cancel();
    server.close();
    server.closeAllConnections();
  });

  test('route parsing refuses what is not an origin', () => {
    expect(isJmapRoute('/__jmap/abc/x')).toBe(true);
    expect(isJmapRoute('/en/mail')).toBe(false);
    expect(parseJmapRoute(`/__jmap/${idOf('http://a.example:8080')}/jmap/?x=1`)).toEqual({ origin: 'http://a.example:8080', rest: '/jmap/?x=1' });
    expect(parseJmapRoute(`/__jmap/${idOf('http://a.example/path')}/x`)).toBeNull();
    expect(parseJmapRoute(`/__jmap/${idOf('file:///etc/passwd')}/x`)).toBeNull();
    expect(parseJmapRoute('/__jmap/..%2f/x')).toBeNull();
  });

});

test.describe('the system CA store in the embedded server', () => {
  const electronBinary = path.resolve(import.meta.dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');

  test.skip(process.platform !== 'win32', 'run with the Windows binary here');

  test('setDefaultCACertificates governs fetch under Electron\'s Node, and the OS list is readable', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-ca-'));
    const { keyPem, certPem } = generateCertificate('localhost');
    const script = path.join(dir, 'check.cjs');
    writeFileSync(script, `
      const tls = require('node:tls'), https = require('node:https');
      const key = ${JSON.stringify(keyPem)}, cert = ${JSON.stringify(certPem)};
      (async () => {
        const out = { bundled: tls.getCACertificates('default').length, system: tls.getCACertificates('system').length };
        const server = https.createServer({ key, cert }, (q, s) => s.end('ok'));
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const url = 'https://localhost:' + server.address().port + '/';
        out.before = await fetch(url).then((r) => r.status).catch((e) => String(e.cause?.code ?? e.message));
        tls.setDefaultCACertificates([...tls.getCACertificates('default'), cert]);
        out.after = await fetch(url).then((r) => r.status).catch((e) => String(e.cause?.code ?? e.message));
        server.close(); server.closeAllConnections();
        console.log(JSON.stringify(out));
      })();
    `);
    const run = spawnSync(electronBinary, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}');
    expect(result.system, 'the OS store is readable').toBeGreaterThan(0);
    expect(result.before, 'a private CA fails by default').not.toBe(200);
    expect(result.after, 'and works once added').toBe(200);
  });
});
