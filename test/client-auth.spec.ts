import { expect, test } from '@playwright/test';
import {
  asksForWindowsSignIn,
  CertificateChooser,
  certificateRow,
  classifyRequest,
  cleanName,
  hostOnSignInList,
  cookieToSetBack,
  displayHost,
  hostPortOf,
  MAX_WAITING_HOSTS,
  narrowedList,
  pickerPages,
  RequestLedger,
  signInListUrls,
  targetOrigin,
  type ChoosableCertificate,
  type PickAnswer,
  type PickQuestion,
  type RequestFacts,
} from '../src/main/client-auth';
import { parseCertificateRule, type CertificateRule } from '../src/shared/policy-schema';
import { deniedSwitches } from '../src/main/switch-guard';
import { LABEL_KEY, labelKeepsPlaceholders } from '../src/main/label-keys';

/** Who gets a certificate or a Windows sign-in, with the dialog as a fake. The real thing: client-certs.spec.ts. */

const OWN = 'https://webmail.example';
const SERVER = 'https://mail.example';

const never = () => false;
const top = { parent: null, origin: OWN };
/** How a mail frame shows up: sandboxed with allow-same-origin, so it has the page's origin. */
const mailFrame = { parent: {}, origin: OWN };
/** How a plugin frame shows up: sandboxed without it. */
const pluginFrame = { parent: {}, origin: 'null' };

test.describe('who is asking', () => {
  const rows: { name: string; facts: RequestFacts; want: string }[] = [
    { name: 'a window going somewhere', facts: { url: 'https://idp.example/x', resourceType: 'mainFrame', webContentsId: 1, frame: top }, want: 'first-party' },
    { name: 'the page, for its own origin', facts: { url: `${OWN}/api`, resourceType: 'xhr', webContentsId: 1, initiatorOrigin: OWN, frame: top }, want: 'first-party' },
    { name: 'a sign-in page, for its own origin', facts: { url: 'https://idp.example/a.js', resourceType: 'script', webContentsId: 1, initiatorOrigin: 'https://idp.example', frame: { parent: null, origin: 'https://idp.example' } }, want: 'first-party' },
    { name: 'a plugin frame, for the app\'s own server', facts: { url: `${OWN}/plugin-sandbox/a.js`, resourceType: 'script', webContentsId: 1, initiatorOrigin: 'null', frame: pluginFrame }, want: 'first-party' },
    { name: 'a service worker, for its own origin', facts: { url: `${OWN}/sw`, resourceType: 'other', initiatorOrigin: OWN }, want: 'first-party' },
    { name: 'the page, for another origin', facts: { url: `${SERVER}/jmap`, resourceType: 'xhr', webContentsId: 1, initiatorOrigin: OWN, frame: top }, want: 'other-page' },
    { name: 'a service worker, for another origin', facts: { url: `${SERVER}/jmap`, resourceType: 'other', initiatorOrigin: OWN }, want: 'other-page' },
    { name: 'a mail frame\'s image', facts: { url: `${SERVER}/x.png`, resourceType: 'image', webContentsId: 1, initiatorOrigin: OWN, frame: mailFrame }, want: 'frame' },
    { name: 'a plugin frame\'s fetch', facts: { url: `${SERVER}/x`, resourceType: 'xhr', webContentsId: 1, initiatorOrigin: 'null', frame: pluginFrame }, want: 'frame' },
    { name: 'a plugin frame\'s WebSocket', facts: { url: 'wss://mail.example/x', resourceType: 'webSocket', webContentsId: 1, initiatorOrigin: 'null', frame: pluginFrame }, want: 'frame' },
    { name: 'a frame loading another site', facts: { url: `${SERVER}/x`, resourceType: 'subFrame', webContentsId: 1, initiatorOrigin: OWN, frame: top }, want: 'frame' },
    { name: 'a frame that has gone', facts: { url: `${SERVER}/x`, resourceType: 'image', webContentsId: 1, initiatorOrigin: OWN, frame: null }, want: 'frame' },
    { name: 'a frame on the server it asks', facts: { url: `${SERVER}/x`, resourceType: 'image', webContentsId: 1, initiatorOrigin: SERVER, frame: { parent: {}, origin: SERVER } }, want: 'frame' },
    { name: 'an address that isn\'t one', facts: { url: 'about:blank', resourceType: 'other', webContentsId: 1, frame: top }, want: 'frame' },
  ];
  for (const { name, facts, want } of rows) {
    test(name, () => {
      expect(classifyRequest(facts, OWN, never)).toBe(want);
    });
  }

  test('the app\'s page asking a listed mail server is that, but a frame or another page asking it is not', () => {
    const listed = (origin: string) => origin === SERVER;
    expect(classifyRequest({ url: `${SERVER}/jmap`, resourceType: 'xhr', webContentsId: 1, initiatorOrigin: OWN, frame: top }, OWN, listed)).toBe('listed-server');
    expect(classifyRequest({ url: `${SERVER}/x.png`, resourceType: 'image', webContentsId: 1, initiatorOrigin: OWN, frame: mailFrame }, OWN, listed)).toBe('frame');
    expect(classifyRequest({ url: `${SERVER}/x`, resourceType: 'xhr', webContentsId: 1, initiatorOrigin: 'https://idp.example', frame: { parent: null, origin: 'https://idp.example' } }, OWN, listed)).toBe('other-page');
  });

  test('a print pop-up is a frame: its images look like the main window\'s top frame asking', () => {
    const listed = () => true;
    for (const resourceType of ['image', 'stylesheet', 'font', 'media', 'script', 'object', 'ping', 'cspReport']) {
      expect(classifyRequest({ url: `${SERVER}/x`, resourceType, webContentsId: 1, initiatorOrigin: OWN, frame: top }, OWN, listed), resourceType).toBe('frame');
    }
    for (const resourceType of ['xhr', 'webSocket']) {
      expect(classifyRequest({ url: `${SERVER}/x`, resourceType, webContentsId: 1, initiatorOrigin: OWN, frame: top }, OWN, listed), resourceType).toBe('listed-server');
    }
    expect(classifyRequest({ url: `${OWN}/x.png`, resourceType: 'image', webContentsId: 1, initiatorOrigin: OWN, frame: top }, OWN, never), 'the app\'s own server is one party').toBe('first-party');
    expect(classifyRequest({ url: 'https://idp.example/x.png', resourceType: 'image', webContentsId: 1, initiatorOrigin: 'https://idp.example', frame: { parent: null, origin: 'https://idp.example' } }, OWN, never), 'a page\'s own image').toBe('first-party');
  });

  test('so is what a window of its own, outside the manager, asks for', () => {
    const facts = { url: `${SERVER}/next`, resourceType: 'mainFrame', webContentsId: 2, frame: top };
    expect(classifyRequest(facts, OWN, () => true, () => true)).toBe('frame');
    expect(classifyRequest(facts, OWN, () => true, () => false)).toBe('first-party');
    expect(classifyRequest({ ...facts, url: `${OWN}/x.png` }, OWN, () => true, () => true)).toBe('first-party');
  });

  test('addresses read as the event spells them', () => {
    expect(hostPortOf('https://Mail.Example/x')).toBe('mail.example:443');
    expect(hostPortOf('wss://mail.example/x')).toBe('mail.example:443');
    expect(hostPortOf('http://mail.example/x')).toBe('mail.example:80');
    expect(hostPortOf('https://[::1]:8443/x')).toBe('[::1]:8443');
    expect(hostPortOf('about:blank')).toBeNull();
    expect(targetOrigin('wss://mail.example:8443/x')).toBe('https://mail.example:8443');
    expect(targetOrigin('data:text/plain,x')).toBeNull();
  });
});

test.describe('whose question an event is', () => {
  test('in the order requests started, so a frame behind a real request gets its own answer', () => {
    const ledger = new RequestLedger();
    ledger.note(1, 'a:443', 'first-party');
    ledger.note(2, 'a:443', 'frame');
    ledger.note(3, 'b:443', 'frame');
    expect(ledger.claim('a:443')).toBe('first-party');
    expect(ledger.claim('a:443')).toBe('frame');
    expect(ledger.claim('b:443')).toBe('frame');
  });

  test('a second event goes to the latest open, and nobody open is nobody of ours', () => {
    const ledger = new RequestLedger();
    ledger.note(1, 'a:443', 'first-party');
    expect(ledger.claim('a:443')).toBe('first-party');
    expect(ledger.claim('a:443')).toBe('first-party');
    ledger.finish(1);
    expect(ledger.claim('a:443')).toBeNull();
    expect(ledger.standingOf(1)).toBeNull();
  });

  test('a redirect\'s next address replaces the old one', () => {
    const ledger = new RequestLedger();
    ledger.note(1, 'a:443', 'frame');
    ledger.note(1, 'b:443', 'frame');
    expect(ledger.claim('a:443')).toBeNull();
    expect(ledger.claim('b:443')).toBe('frame');
  });

  test('it can\'t grow for good', () => {
    const ledger = new RequestLedger();
    for (let id = 0; id < 5000; id += 1) ledger.note(id, 'a:443', 'frame');
    expect(ledger.standingOf(0)).toBeNull();
    expect(ledger.standingOf(4999)).toBe('frame');
  });
});

function certificate(name: string, issuer = 'Test CA', extra: Partial<ChoosableCertificate> = {}): ChoosableCertificate {
  return { fingerprint: `sha256/${name}`, subjectName: name, issuerName: issuer, validExpiry: 1_900_000_000, subject: { commonName: name }, issuer: { commonName: issuer }, ...extra };
}

function harness(options: { rules?: string[]; userServers?: string[]; answer?: (question: PickQuestion<ChoosableCertificate>) => PickAnswer<ChoosableCertificate> } = {}) {
  const stored = new Map<string, string>();
  const asked: PickQuestion<ChoosableCertificate>[] = [];
  const rules: CertificateRule[] = (options.rules ?? []).map((rule) => parseCertificateRule(rule)!);
  const chooser = new CertificateChooser<ChoosableCertificate>({
    rules: () => rules,
    choices: { get: (host) => stored.get(host), set: (host, value) => void stored.set(host, value), clear: () => stored.clear(), clearAccount: (account) => void stored.delete(account) },
    ask: async (question) => {
      asked.push(question);
      return options.answer ? options.answer(question) : { certificate: question.certificates[0], remember: false };
    },
    isUserServer: (host) => options.userServers?.includes(host) ?? false,
  });
  return { chooser, stored, asked };
}

const NO_CHOICES = { get: () => undefined, set: () => {}, clear: () => {}, clearAccount: () => {} };
const ALICE = certificate('Alice');
const BOB = certificate('Bob', 'Other CA');

test.describe('what goes out', () => {
  test('a frame gets nothing and no answer, so a real request later still gets asked', async () => {
    const { chooser, asked } = harness();
    expect(await chooser.decide('a:443', 'frame', [ALICE], null)).toEqual({ kind: 'leave' });
    expect(asked).toHaveLength(0);
    expect(chooser.holds('a:443')).toBe(false);
    expect(chooser.forget(), 'Chromium was told nothing').toBe(false);
    expect(await chooser.decide('a:443', 'first-party', [ALICE], null)).toEqual({ kind: 'send', certificate: ALICE });
  });

  for (const standing of ['other-page', null] as const) {
    test(`${standing ?? 'nobody'} gets no certificate and no question`, async () => {
      const { chooser, asked } = harness({ rules: ['{"pattern":"https://a"}'] });
      expect(await chooser.decide('a:443', standing, [ALICE], null)).toEqual({ kind: 'none' });
      expect(asked).toHaveLength(0);
    });
  }

  test('a rule doesn\'t reach a frame or another page', async () => {
    const { chooser } = harness({ rules: ['{"pattern":"https://a"}'] });
    expect((await chooser.decide('a:443', 'frame', [ALICE], null)).kind).toBe('leave');
    expect((await chooser.decide('a:443', 'other-page', [ALICE], null)).kind).toBe('none');
  });

  test('the first asking stops frames at once, before the user has answered', async () => {
    let answer!: (value: PickAnswer<ChoosableCertificate>) => void;
    const chooser = new CertificateChooser<ChoosableCertificate>({
      rules: () => [],
      choices: NO_CHOICES,
      ask: () => new Promise((resolve) => { answer = resolve; }),
      isUserServer: never,
    });
    const decided = chooser.decide('a:443', 'first-party', [ALICE], null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chooser.holds('a:443')).toBe(true);
    answer({ certificate: ALICE, remember: false });
    await decided;
    expect(chooser.holds('a:443')).toBe(true);
  });

  test('a declined server isn\'t asked again, and stops being held', async () => {
    const { chooser, asked } = harness({ answer: () => ({ certificate: null, remember: true }) });
    expect(await chooser.decide('a:443', 'first-party', [ALICE], null)).toEqual({ kind: 'none' });
    expect(await chooser.decide('a:443', 'first-party', [ALICE], null)).toEqual({ kind: 'none' });
    expect(asked).toHaveLength(1);
    expect(chooser.holds('a:443')).toBe(false);
  });

  test('a dialog that fails is a no', async () => {
    const chooser = new CertificateChooser<ChoosableCertificate>({
      rules: () => [],
      choices: NO_CHOICES,
      ask: () => Promise.reject(new Error('no window')),
      isUserServer: never,
    });
    expect(await chooser.decide('a:443', 'first-party', [ALICE], null)).toEqual({ kind: 'none' });
  });

  test('requests waiting together share one dialog and each sends from its own list', async () => {
    const { chooser, asked } = harness();
    const copy = { ...ALICE };
    const [one, two] = await Promise.all([chooser.decide('a:443', 'first-party', [ALICE], null), chooser.decide('a:443', 'first-party', [copy], null)]);
    expect(asked).toHaveLength(1);
    expect(one).toEqual({ kind: 'send', certificate: ALICE });
    expect((two as { certificate: unknown }).certificate).toBe(copy);
  });

  test('past the limit a host waits on no dialog', async () => {
    const chooser = new CertificateChooser<ChoosableCertificate>({
      rules: () => [],
      choices: NO_CHOICES,
      ask: () => new Promise(() => {}),
      isUserServer: never,
    });
    for (let host = 0; host < MAX_WAITING_HOSTS; host += 1) void chooser.decide(`h${host}:443`, 'first-party', [ALICE], null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await chooser.decide('more:443', 'first-party', [ALICE], null)).toEqual({ kind: 'none' });
  });
});

test.describe('a question still open at a sign-out', () => {
  function held() {
    const stored = new Map<string, string>();
    const asks: { resolve: (answer: PickAnswer<ChoosableCertificate>) => void; signal: AbortSignal }[] = [];
    const chooser = new CertificateChooser<ChoosableCertificate>({
      rules: () => [],
      choices: { get: (host) => stored.get(host), set: (host, value) => void stored.set(host, value), clear: () => stored.clear(), clearAccount: () => {} },
      ask: (_question, _window, signal) => new Promise((resolve) => asks.push({ resolve, signal })),
      isUserServer: never,
    });
    return { chooser, stored, asks };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  for (const [name, clear] of [['the last', (chooser: CertificateChooser<ChoosableCertificate>) => void chooser.forget()], ['an account\'s own', (chooser: CertificateChooser<ChoosableCertificate>) => chooser.forgetAccount('a')]] as const) {
    test(`${name}: it closes, and a pick that comes anyway sends and stores nothing, and leaves no answer`, async () => {
      const { chooser, stored, asks } = held();
      const decided = chooser.decide('a:443', 'first-party', [ALICE], null);
      await tick();
      expect(asks[0].signal.aborted).toBe(false);
      clear(chooser);
      expect(asks[0].signal.aborted).toBe(true);
      asks[0].resolve({ certificate: ALICE, remember: true });
      expect(await decided).toEqual({ kind: 'leave' });
      expect(stored.size).toBe(0);
    });
  }

  test('the next request asks afresh', async () => {
    const { chooser, asks } = held();
    void chooser.decide('a:443', 'first-party', [ALICE], null);
    await tick();
    chooser.forget();
    const next = chooser.decide('a:443', 'first-party', [ALICE], null);
    await tick();
    expect(asks).toHaveLength(2);
    expect(asks[1].signal.aborted).toBe(false);
    asks[1].resolve({ certificate: ALICE, remember: false });
    expect(await next).toEqual({ kind: 'send', certificate: ALICE });
  });
});

test.describe('one account signing out', () => {
  test('takes that account\'s choices and doesn\'t ask for the network to go', async () => {
    const { chooser, stored } = harness();
    await chooser.decide('a:443', 'first-party', [ALICE], null);
    stored.set('acct', ALICE.fingerprint);
    chooser.forgetAccount('acct');
    expect(stored.has('acct')).toBe(false);
    expect(chooser.holdsAnswers(), 'Chromium keeps it for the accounts still here').toBe(true);
    expect(chooser.holds('a:443')).toBe(true);
  });
});

test.describe('remembering', () => {
  test('only for that host and port', async () => {
    const { chooser, stored, asked } = harness({ answer: (question) => ({ certificate: question.certificates[1], remember: true }) });
    expect(await chooser.decide('a:443', 'first-party', [ALICE, BOB], null)).toEqual({ kind: 'send', certificate: BOB });
    expect(stored.get('a:443')).toBe(BOB.fingerprint);
    expect(await chooser.decide('a:443', 'first-party', [ALICE, BOB], null)).toEqual({ kind: 'send', certificate: BOB });
    expect(asked).toHaveLength(1);
    await chooser.decide('a:8443', 'first-party', [ALICE, BOB], null);
    await chooser.decide('sub.a:443', 'first-party', [ALICE, BOB], null);
    expect(asked, 'another port and a subdomain are asked').toHaveLength(3);
  });

  test('without the tick nothing is stored', async () => {
    const { chooser, stored } = harness();
    await chooser.decide('a:443', 'first-party', [ALICE], null);
    expect(stored.size).toBe(0);
  });

  test('a certificate that\'s gone is asked about again', async () => {
    const { chooser, stored, asked } = harness();
    stored.set('a:443', 'sha256/gone');
    await chooser.decide('a:443', 'first-party', [ALICE], null);
    expect(asked).toHaveLength(1);
  });

  test('forgetting takes the stored choice and the refusals', async () => {
    let refuse = true;
    const { chooser, stored, asked } = harness({ answer: (question) => ({ certificate: refuse ? null : question.certificates[0], remember: !refuse }) });
    await chooser.decide('a:443', 'first-party', [ALICE], null);
    stored.set('b:443', ALICE.fingerprint);
    expect(chooser.forget(), 'Chromium keeps its "none"').toBe(true);
    expect(stored.size).toBe(0);
    refuse = false;
    await chooser.decide('a:443', 'first-party', [ALICE], null);
    expect(asked).toHaveLength(2);
  });

  test('forgetting keeps frames away until the network service has gone', async () => {
    const { chooser } = harness();
    await chooser.decide('a:443', 'first-party', [ALICE], null);
    expect(chooser.forget()).toBe(true);
    expect(chooser.holds('a:443')).toBe(true);
    chooser.networkEmptied();
    expect(chooser.holds('a:443')).toBe(false);
    expect(chooser.forget(), 'nothing new since').toBe(false);
  });
});

test.describe('AutoSelectCertificateForUrls', () => {
  test('one match goes without a question, in preference to a remembered choice', async () => {
    const { chooser, stored, asked } = harness({ rules: ['{"pattern":"https://[*.]example.com","filter":{"ISSUER":{"CN":"Test CA"}}}'] });
    stored.set('mail.example.com:443', BOB.fingerprint);
    expect(await chooser.decide('mail.example.com:443', 'first-party', [BOB, ALICE], null)).toEqual({ kind: 'send', certificate: ALICE });
    expect(asked).toHaveLength(0);
    expect(chooser.holds('mail.example.com:443')).toBe(true);
  });

  test('another host, or no matching certificate, goes to the picker', async () => {
    const { chooser, asked } = harness({ rules: ['{"pattern":"https://mail.example.com","filter":{"ISSUER":{"CN":"Nobody"}}}', '{"pattern":"https://other.example.com"}'] });
    await chooser.decide('mail.example.com:443', 'first-party', [ALICE, BOB], null);
    expect(asked.map((question) => question.certificates)).toEqual([[ALICE, BOB]]);
    await chooser.decide('elsewhere.example.org:443', 'first-party', [ALICE], null);
    expect(asked).toHaveLength(2);
  });

  test('several matches: the user picks among those only', async () => {
    const { chooser, asked } = harness({ rules: ['{"pattern":"https://a","filter":{"ISSUER":{"CN":"Test CA"}}}'] });
    const other = certificate('Carol');
    await chooser.decide('a:443', 'first-party', [ALICE, BOB, other], null);
    expect(asked[0].certificates).toEqual([ALICE, other]);
  });

  test('a remembered choice outside the matches doesn\'t count', async () => {
    const { chooser, stored, asked } = harness({ rules: ['{"pattern":"https://a","filter":{"ISSUER":{"CN":"Test CA"}}}'] });
    stored.set('a:443', BOB.fingerprint);
    const other = certificate('Carol');
    await chooser.decide('a:443', 'first-party', [ALICE, BOB, other], null);
    expect(asked).toHaveLength(1);
    stored.set('a:443', other.fingerprint);
    expect(await chooser.decide('a:443', 'first-party', [ALICE, BOB, other], null)).toEqual({ kind: 'send', certificate: other });
  });
});

test.describe('a rule that only covers a host by wildcard', () => {
  const RULE = '{"pattern":"https://[*.]example.com","filter":{"ISSUER":{"CN":"Test CA"}}}';
  const HOST = 'mail.example.com:443';

  test('the page\'s own request asks, once a run, with nothing to remember', async () => {
    const { chooser, asked, stored } = harness({ rules: [RULE] });
    expect(await chooser.decide(HOST, 'listed-server', [ALICE, BOB], null)).toEqual({ kind: 'send', certificate: ALICE });
    expect(asked).toHaveLength(1);
    expect(asked[0].rememberable).toBe(false);
    expect(asked[0].certificates).toEqual([ALICE]);
    expect(stored.size, 'for this run only').toBe(0);
    expect(await chooser.decide(HOST, 'listed-server', [ALICE, BOB], null)).toEqual({ kind: 'send', certificate: ALICE });
    expect(asked).toHaveLength(1);
    await chooser.decide('other.example.com:443', 'listed-server', [ALICE, BOB], null);
    expect(asked, 'per host').toHaveLength(2);
    chooser.forget();
    await chooser.decide(HOST, 'listed-server', [ALICE, BOB], null);
    expect(asked, 'consent goes at the last sign-out').toHaveLength(3);
  });

  test('a no holds, and sends nothing', async () => {
    const { chooser, asked } = harness({ rules: [RULE], answer: () => ({ certificate: null, remember: false }) });
    expect(await chooser.decide(HOST, 'listed-server', [ALICE], null)).toEqual({ kind: 'none' });
    expect(await chooser.decide(HOST, 'listed-server', [ALICE], null)).toEqual({ kind: 'none' });
    expect(asked).toHaveLength(1);
  });

  test('with no fitting certificate there is nothing to ask about', async () => {
    const { chooser, asked } = harness({ rules: [RULE] });
    expect(await chooser.decide(HOST, 'listed-server', [BOB], null)).toEqual({ kind: 'none' });
    expect(asked).toHaveLength(0);
  });

  test('a window going there stays silent', async () => {
    const { chooser, asked } = harness({ rules: [RULE] });
    expect(await chooser.decide(HOST, 'first-party', [ALICE, BOB], null)).toEqual({ kind: 'send', certificate: ALICE });
    expect(asked).toHaveLength(0);
  });

  test('a rule that spells out the host stays silent', async () => {
    const { chooser, asked } = harness({ rules: ['{"pattern":"https://mail.example.com","filter":{"ISSUER":{"CN":"Test CA"}}}'] });
    expect(await chooser.decide(HOST, 'listed-server', [ALICE, BOB], null)).toEqual({ kind: 'send', certificate: ALICE });
    expect(asked).toHaveLength(0);
  });

  test('a server the user added stays as it was', async () => {
    const { chooser, asked } = harness({ rules: [RULE], userServers: [HOST] });
    expect(await chooser.decide(HOST, 'listed-server', [ALICE, BOB], null)).toEqual({ kind: 'send', certificate: ALICE });
    expect(asked, 'the rule fits one, and the user chose this server').toHaveLength(0);
    const open = harness({ userServers: [HOST] });
    await open.chooser.decide(HOST, 'listed-server', [ALICE, BOB], null);
    expect(open.asked[0].rememberable).toBe(true);
    expect(open.asked[0].certificates).toEqual([ALICE, BOB]);
  });
});

test.describe('the Windows sign-in', () => {
  test('a 401 that names it, and nothing else', () => {
    for (const value of ['Negotiate', 'NTLM', 'negotiate abc', 'Basic realm="x", NTLM']) {
      expect(asksForWindowsSignIn(401, { 'WWW-Authenticate': [value] }), value).toBe(true);
    }
    expect(asksForWindowsSignIn(401, { 'www-authenticate': ['Basic realm="x"', 'Negotiate'] })).toBe(true);
    expect(asksForWindowsSignIn(401, { 'www-authenticate': ['Basic realm="NTLM"'] })).toBe(false);
    expect(asksForWindowsSignIn(401, { 'www-authenticate': ['Bearer'] })).toBe(false);
    expect(asksForWindowsSignIn(200, { 'www-authenticate': ['Negotiate'] })).toBe(false);
    expect(asksForWindowsSignIn(401, undefined)).toBe(false);
  });

  test('a host is on the list as Chromium reads it, or wider', () => {
    const list = 'sso.example,*.corp.example,other.example:8080';
    for (const host of ['sso.example', 'SSO.example', 'a.corp.example', 'a.b.corp.example', 'corp.example', 'other.example']) expect(hostOnSignInList(list, host), host).toBe(true);
    for (const host of ['a.sso.example', 'xcorp.example', 'example']) expect(hostOnSignInList(list, host), host).toBe(false);
    expect(hostOnSignInList(null, 'sso.example')).toBe(false);
  });

  test('a list narrows, and never widens', () => {
    expect(narrowedList('a.example,*.b.example', '*.b.example')).toBe('*.b.example');
    expect(narrowedList('a.example', 'a.example,new.example')).toBe('a.example');
    expect(narrowedList('a.example', null)).toBeNull();
    expect(narrowedList(null, 'a.example')).toBeNull();
    expect(narrowedList('A.Example', 'a.example')).toBe('A.Example');
  });

  test('the responses to watch cover the whole list', () => {
    expect(signInListUrls('sso.example,*.corp.example:8443')).toEqual([
      '*://sso.example/*', 'ws://sso.example/*', 'wss://sso.example/*',
      '*://*.corp.example/*', 'ws://*.corp.example/*', 'wss://*.corp.example/*',
    ]);
    expect(signInListUrls(null)).toEqual([]);
  });

  test('a production build refuses the switches that widen it', () => {
    for (const arg of ['--auth-server-whitelist=*', '--auth-negotiate-delegate-whitelist=*', '--enable-auth-negotiate-port', '--disable-ntlm-v2', '--auto-select-certificate-for-urls=x']) {
      expect(deniedSwitches(['Bulwark.exe', arg], 'win32'), arg).toHaveLength(1);
    }
  });
});

test.describe('the picker', () => {
  test('pages keep every certificate reachable', () => {
    const list = Array.from({ length: 13 }, (_, index) => index);
    const pages = pickerPages(list, 6);
    expect(pages.map((page) => page.length)).toEqual([6, 6, 1]);
    expect(pages.flat()).toEqual(list);
  });

  test('a name can\'t add lines or turn the text round', () => {
    expect(cleanName('Alice\nOK‮gnp.exe')).toBe('Alice OK gnp.exe');
    expect(cleanName('x'.repeat(200))).toHaveLength(80);
  });

  test('the server is named as a person reads it', () => {
    expect(displayHost('mail.example:443')).toBe('mail.example');
    expect(displayHost('mail.example:8443')).toBe('mail.example:8443');
  });

  test('a row says who issued it and until when', () => {
    const details = (issuer: string, date: string) => `Issued by ${issuer}, until ${date}`;
    expect(certificateRow(ALICE, details, 'en-US', 'win32')).toBe('Alice\nIssued by Test CA, until Mar 17, 2030');
    expect(certificateRow(ALICE, details, 'en-US', 'linux')).toBe('Alice (Issued by Test CA, until Mar 17, 2030)');
    expect(certificateRow({ ...ALICE, subjectName: '' }, details, 'en-US', 'win32')).toContain('sha256/Alice');
  });

  test('a label can\'t leave out the server', () => {
    expect(labelKeepsPlaceholders('certificateTitle', 'Trust this')).toBe(false);
    expect(labelKeepsPlaceholders('certificateRemember', 'Remember')).toBe(false);
    expect(labelKeepsPlaceholders('certificateIssued', 'Issued by {issuer}')).toBe(false);
    expect(labelKeepsPlaceholders('certificateTitle', '{host} fragt')).toBe(true);
    expect(labelKeepsPlaceholders('certificateNone', 'Nothing')).toBe(true);
    expect(LABEL_KEY.test('pickerServerLine'), 'and the line that names it is no label').toBe(false);
  });

  test('a session cookie goes back as what it was', () => {
    const hostOnly = cookieToSetBack({ name: '__Host-a', value: '1', domain: 'mail.example', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
    expect(hostOnly).toEqual({ name: '__Host-a', value: '1', url: 'https://mail.example/', path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
    const shared = cookieToSetBack({ name: 'b', value: '2', domain: '.example', hostOnly: false, path: '/x', secure: false });
    expect(shared).toEqual({ name: 'b', value: '2', url: 'http://example/x', domain: '.example', path: '/x', secure: false });
    expect(hostOnly, 'no expiry: it stays a session cookie').not.toHaveProperty('expirationDate');
  });

  test('its text can come from the webmail', () => {
    for (const key of ['certificateTitle', 'certificateDetail', 'certificateIssued', 'certificateRemember', 'certificateNone', 'certificateMore']) expect(LABEL_KEY.test(key), key).toBe(true);
  });
});
