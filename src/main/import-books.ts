/**
 * Thunderbird address books, as vCard text. abook.sqlite has one row per contact and
 * property. Thunderbird since 102 keeps the whole card in `_vCard`; older profiles have
 * only single properties, so a card is built from those. Read through Node's own
 * node:sqlite, opened read-only. Calendars stay out: local.sqlite spreads an event over
 * several tables, which is a converter of its own (the UI says so).
 *
 * This file comes from the disk and can be anything: `properties` as a view over an endless
 * query, or a table with billions of rows. It only ever runs in the import worker, under a
 * timeout, and asks sqlite_master first and stops at MAX_ROWS and MAX_BYTES.
 */

type Row = { card: string; name: string; value: string | null };

/** Far more than anyone's address book. */
const MAX_ROWS = 200_000;
const MAX_BYTES = 64 * 1024 * 1024;

function escapeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
}

const OLD_FIELDS: [string, (value: string) => string][] = [
  ['PrimaryEmail', (v) => `EMAIL;TYPE=pref:${escapeValue(v)}`],
  ['SecondEmail', (v) => `EMAIL:${escapeValue(v)}`],
  ['WorkPhone', (v) => `TEL;TYPE=work:${escapeValue(v)}`],
  ['HomePhone', (v) => `TEL;TYPE=home:${escapeValue(v)}`],
  ['CellularNumber', (v) => `TEL;TYPE=cell:${escapeValue(v)}`],
  ['Company', (v) => `ORG:${escapeValue(v)}`],
  ['JobTitle', (v) => `TITLE:${escapeValue(v)}`],
  ['Notes', (v) => `NOTE:${escapeValue(v)}`],
];

/** One card's rows as vCard text, or null for a card with nothing to go on. */
export function vCardFromProperties(properties: Map<string, string>): string | null {
  const full = properties.get('_vCard');
  if (full && /BEGIN:VCARD/i.test(full)) return full;
  const first = properties.get('FirstName') ?? '';
  const last = properties.get('LastName') ?? '';
  const display = properties.get('DisplayName') || `${first} ${last}`.trim() || properties.get('PrimaryEmail');
  if (!display) return null;
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${escapeValue(display)}`, `N:${escapeValue(last)};${escapeValue(first)};;;`];
  for (const [field, line] of OLD_FIELDS) {
    const value = properties.get(field);
    if (value) lines.push(line(value));
  }
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

type Sqlite = typeof import('node:sqlite');

/** Dynamic, so a build of Electron without it only loses the address books. */
export function loadSqlite(): Promise<Sqlite> {
  return import('node:sqlite');
}

function openBook({ DatabaseSync }: Sqlite, file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  // A view can run any query at all. Only a real table is an address book.
  const kind = db.prepare("SELECT type FROM sqlite_master WHERE name = 'properties'").get() as { type?: string } | undefined;
  if (kind?.type !== 'table') {
    db.close();
    throw new Error('not an address book');
  }
  return db;
}

/** Synchronous, for a scan that reports as it goes: a promise wouldn't get its turn while the scan blocks. */
export function countContactsWith(sqlite: Sqlite, file: string): number {
  const db = openBook(sqlite, file);
  try {
    const row = db.prepare('SELECT COUNT(DISTINCT card) AS n FROM (SELECT card FROM properties LIMIT ?)').get(MAX_ROWS) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

export async function countContacts(file: string): Promise<number> {
  return countContactsWith(await loadSqlite(), file);
}

export async function readVCards(file: string): Promise<string[]> {
  const db = openBook(await loadSqlite(), file);
  try {
    const cards = new Map<string, Map<string, string>>();
    let rows = 0;
    let bytes = 0;
    for (const row of db.prepare('SELECT card, name, value FROM properties').iterate() as Iterable<Row>) {
      if (++rows > MAX_ROWS) break;
      if (row.value === null) continue;
      const value = String(row.value);
      bytes += value.length;
      if (bytes > MAX_BYTES) break;
      let properties = cards.get(row.card);
      if (!properties) cards.set(row.card, (properties = new Map()));
      properties.set(row.name, value);
    }
    return [...cards.values()].map(vCardFromProperties).filter((card): card is string => card !== null);
  } finally {
    db.close();
  }
}
