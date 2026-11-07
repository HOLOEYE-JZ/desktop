#!/usr/bin/env node
// Fills an account's Inbox for scripts/perf-check.mjs, so the list draws real rows: varied
// senders, subjects and body sizes, a third with HTML, most read, a few flagged. Adds only
// what's missing up to --count, so it can run again.
//
//   BULWARK_PERF_SERVER=<jmap url> BULWARK_PERF_USER=<address> BULWARK_PERF_PASSWORD=<password> \
//     node scripts/perf-seed.mjs [--count 400]

const at = process.argv.indexOf('--count');
const count = at > 0 ? Number(process.argv[at + 1]) : 400;
const { BULWARK_PERF_SERVER: server, BULWARK_PERF_USER: user, BULWARK_PERF_PASSWORD: password } = process.env;
if (!server || !user || !password) {
  console.error('set BULWARK_PERF_SERVER, BULWARK_PERF_USER and BULWARK_PERF_PASSWORD');
  process.exit(2);
}

const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];

async function json(url, body) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

const session = await json(`${server.replace(/\/$/, '')}/.well-known/jmap`);
// A server behind a proxy may name itself by another host: keep the one we were given.
const apiUrl = new URL(new URL(session.apiUrl).pathname, server).toString();
const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
const call = async (calls) => (await json(apiUrl, { using: USING, methodCalls: calls })).methodResponses;

const [[, mailboxes]] = await call([['Mailbox/get', { accountId, properties: ['role'] }, '0']]);
const inbox = mailboxes.list.find((m) => m.role === 'inbox')?.id;
if (!inbox) throw new Error('no Inbox');
const [[, query]] = await call([['Email/query', { accountId, filter: { inMailbox: inbox }, limit: 1, calculateTotal: true }, '0']]);
let done = query.total;

const senders = [['Alice Example', 'alice@example.net'], ['Bob Example', 'bob@example.net'], ['Carol Example', 'carol@example.net'], ['News', 'news@example.net'], ['Billing', 'billing@example.net'], ['Jürgen Müller', 'juergen@example.net'], ['Dana Okafor', 'dana@example.net'], ['Support Desk', 'support@example.net']];
const words = 'project status report meeting invoice update review notes draft budget plan release design travel lunch question answer follow-up reminder agenda summary Zahlungserinnerung Rechnungsbetrag Besprechungsprotokoll Termin'.split(' ');
// Seeded, so every run fills the same mail.
let seed = 7 + done;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (list) => list[Math.floor(random() * list.length)];
const now = Date.now();

while (done < count) {
  const create = {};
  for (let i = 0; i < Math.min(100, count - done); i += 1) {
    const n = done + i;
    const [name, email] = senders[n % senders.length];
    const subject = Array.from({ length: pick([3, 5, 8]) }, () => pick(words)).join(' ');
    const body = `${Array.from({ length: pick([40, 120, 250, 500, 1200]) }, () => pick(words)).join(' ')}\n`;
    const received = new Date(now - n * 900_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const keywords = {};
    if (n % 3) keywords.$seen = true;
    if (n % 17 === 0) keywords.$flagged = true;
    const mail = {
      mailboxIds: { [inbox]: true },
      keywords,
      from: [{ name, email }],
      to: [{ email: user }],
      subject: subject[0].toUpperCase() + subject.slice(1),
      receivedAt: received,
      sentAt: received,
      bodyValues: { b: { value: body } },
      textBody: [{ partId: 'b', type: 'text/plain' }],
    };
    if (n % 3 === 0) {
      mail.bodyValues.h = { value: `<html><body><p>${body.trim()}</p><table><tr><td>${name}</td></tr></table></body></html>` };
      mail.htmlBody = [{ partId: 'h', type: 'text/html' }];
    }
    create[`m${i}`] = mail;
  }
  const [[, result]] = await call([['Email/set', { accountId, create }, '0']]);
  const failed = Object.values(result.notCreated ?? {});
  if (failed.length) throw new Error(`${failed.length} not created: ${JSON.stringify(failed[0]).slice(0, 200)}`);
  done += Object.keys(create).length;
}
console.log(`Inbox holds ${done} messages`);
