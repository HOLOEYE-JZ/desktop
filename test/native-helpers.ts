import { request as httpsRequest } from 'node:https';
import type { ElectronApplication, Page } from '@playwright/test';

/** What a native menu held when it came up. */
export interface SeenItem {
  id?: string;
  label: string;
  type: string;
  enabled: boolean;
  checked?: boolean;
  accelerator?: string;
  registerAccelerator?: boolean;
  submenu?: SeenItem[];
}

/**
 * Native menus can't be driven from a test: this replaces `popup` and records what a
 * menu would have shown. With `pick`, the item with that label is chosen, as a user would.
 */
export async function recordMenus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { __menus: unknown[]; __pick: string | null };
    g.__menus = [];
    g.__pick = null;
    type Item = { label: string; type: string; enabled: boolean; checked: boolean; id: string; submenu?: { items: Item[] }; click: () => void };
    const read = (items: Item[]): unknown[] =>
      items.map((item) => ({ id: item.id, label: item.label, type: item.type, enabled: item.enabled, checked: item.checked, submenu: item.submenu ? read(item.submenu.items) : undefined }));
    const find = (items: Item[], label: string): Item | null => {
      for (const item of items) {
        if (item.label === label && !item.submenu) return item;
        const below = item.submenu ? find(item.submenu.items, label) : null;
        if (below) return below;
      }
      return null;
    };
    Menu.prototype.popup = function popup(this: { items: Item[] }, options?: { callback?: () => void }) {
      g.__menus.push(read(this.items));
      if (g.__pick) find(this.items, g.__pick)?.click();
      g.__pick = null;
      setTimeout(() => options?.callback?.(), 0);
    } as never;
  });
}

export function lastMenu(app: ElectronApplication): Promise<SeenItem[] | undefined> {
  return app.evaluate(() => (globalThis as unknown as { __menus: SeenItem[][] }).__menus.at(-1));
}

export function menuCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as { __menus: unknown[] }).__menus.length);
}

export function pickNext(app: ElectronApplication, label: string): Promise<void> {
  return app.evaluate((_electron, wanted) => {
    (globalThis as unknown as { __pick: string }).__pick = wanted;
  }, label);
}

/** The app menu as it stands, by item id. */
export function menuItem(app: ElectronApplication, id: string): Promise<SeenItem | null> {
  return app.evaluate(({ Menu }, wanted) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(wanted) as unknown as (SeenItem & { accelerator?: string; registerAccelerator?: boolean; submenu?: unknown }) | null;
    if (!item) return null;
    return { id: wanted, label: item.label, type: item.type, enabled: item.enabled, checked: item.checked, accelerator: item.accelerator, registerAccelerator: item.registerAccelerator };
  }, id);
}

export function clickMenuItem(app: ElectronApplication, id: string): Promise<void> {
  return app.evaluate(({ Menu, BrowserWindow }, wanted) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(wanted);
    if (!item) throw new Error(`No menu item ${wanted}`);
    item.click(undefined, BrowserWindow.getFocusedWindow() ?? undefined, {} as never);
  }, id);
}

/** A window of the app by what its URL holds. */
export async function pageWith(app: ElectronApplication, part: string, timeoutMs = 60_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((candidate) => !candidate.isClosed() && candidate.url().includes(part));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No window with ${part}: ${app.windows().map((w) => w.url()).join(', ')}`);
}

/** Bare JMAP, for setting up and checking what the UI did. Test servers only. */
export async function jmap(server: string, user: string, password: string, calls: unknown[]): Promise<unknown[][]> {
  const session = await nodeFetch(`${server}/jmap/session`, user, password);
  const info = JSON.parse(session) as { apiUrl: string; primaryAccounts: Record<string, string> };
  const account = info.primaryAccounts['urn:ietf:params:jmap:mail'];
  const body = JSON.stringify({
    using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
    methodCalls: (calls as [string, Record<string, unknown>, string][]).map(([name, args, tag]) => [name, { accountId: account, ...args }, tag]),
  });
  const answer = await nodeFetch(new URL(info.apiUrl, server).toString(), user, password, body);
  return (JSON.parse(answer) as { methodResponses: unknown[][] }).methodResponses;
}

function nodeFetch(url: string, user: string, password: string, body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: body ? 'POST' : 'GET',
      rejectUnauthorized: false,
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, 'Content-Type': 'application/json' },
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

export async function mailboxIdOf(server: string, user: string, password: string, role: string): Promise<string> {
  const [[, answer]] = await jmap(server, user, password, [['Mailbox/get', { ids: null, properties: ['role'] }, 'm']]);
  const found = (answer as { list: { id: string; role: string | null }[] }).list.find((mailbox) => mailbox.role === role);
  if (!found) throw new Error(`No ${role} folder`);
  return found.id;
}

/** Puts a message straight in the Inbox. Returns its id. */
export async function seedMessage(server: string, user: string, password: string, subject: string, body = 'Seeded for the desktop tests.', extra: Record<string, unknown> = {}): Promise<string> {
  const inbox = await mailboxIdOf(server, user, password, 'inbox');
  const [[, answer]] = await jmap(server, user, password, [['Email/set', {
    create: {
      a: {
        mailboxIds: { [inbox]: true },
        keywords: {},
        subject,
        from: [{ name: 'Desktop Test', email: 'desktop-test@example.org' }],
        to: [{ email: user }],
        receivedAt: new Date().toISOString(),
        bodyStructure: { type: 'text/plain', partId: '1' },
        bodyValues: { 1: { value: body } },
        ...extra,
      },
    },
  }, 's']]);
  const created = (answer as { created?: { a?: { id: string } }; notCreated?: unknown }).created?.a?.id;
  if (!created) throw new Error(`Not created: ${JSON.stringify(answer)}`);
  return created;
}

export async function destroyMessages(server: string, user: string, password: string, ids: string[]): Promise<void> {
  if (ids.length) await jmap(server, user, password, [['Email/set', { destroy: ids }, 'd']]);
}

/** Ids of messages with this subject in the Drafts folder. */
export async function draftsWithSubject(server: string, user: string, password: string, subject: string): Promise<string[]> {
  const drafts = await mailboxIdOf(server, user, password, 'drafts');
  const [[, answer]] = await jmap(server, user, password, [['Email/query', { filter: { inMailbox: drafts, subject }, limit: 20 }, 'q']]);
  return (answer as { ids: string[] }).ids;
}
