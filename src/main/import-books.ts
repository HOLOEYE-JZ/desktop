/**
 * Thunderbird address books, as vCard text. abook.sqlite has one row per contact and
 * property. Thunderbird since 102 keeps the whole card in `_vCard`; older profiles have
 * only single properties, so a card is built from those. Read through Node's own
 * node:sqlite, opened read-only. Calendars stay out: local.sqlite spreads an event over
 * several tables, which is a converter of its own (the UI says so).
 */

type Row = { card: string; name: string; value: string | null };

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

async function openReadOnly(file: string) {
  // Dynamic, so a build of Electron without it only loses the address books.
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

export async function countContacts(file: string): Promise<number> {
  const db = await openReadOnly(file);
  try {
    const row = db.prepare('SELECT COUNT(DISTINCT card) AS n FROM properties').get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

export async function readVCards(file: string): Promise<string[]> {
  const db = await openReadOnly(file);
  try {
    const rows = db.prepare('SELECT card, name, value FROM properties').all() as unknown as Row[];
    const cards = new Map<string, Map<string, string>>();
    for (const row of rows) {
      if (row.value === null) continue;
      let properties = cards.get(row.card);
      if (!properties) cards.set(row.card, (properties = new Map()));
      properties.set(row.name, String(row.value));
    }
    return [...cards.values()].map(vCardFromProperties).filter((card): card is string => card !== null);
  } finally {
    db.close();
  }
}
