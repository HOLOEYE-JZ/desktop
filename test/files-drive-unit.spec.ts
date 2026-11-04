import { expect, test } from '@playwright/test';
import type { FilesFetchRequest } from '../src/shared/bridge';
import { ALIGN, FetchRelay, PIECE } from '../src/main/files/drive-fetch';
import { settleLetter, type LetterSystem } from '../src/main/files/drive-letter';
import {
  displayNameFor,
  filesErrorOf,
  folderNameFor,
  freeLetters,
  letterTarget,
  parseSubst,
  relativeParts,
  resolveUnder,
  wantedLetter,
} from '../src/main/files/drive-places';
import type { NativeFetchEvent } from '../src/main/native-loader';

/**
 * The Files drive's rules that need no Windows: the fetch relay against a fake helper, names,
 * paths and the letter. test/files-drive-native.spec.ts runs the real thing.
 */

interface Sent {
  offset: number;
  bytes: number[];
}

function fakeHelper() {
  const sent: Sent[] = [];
  const failed: { offset: number; length: number; reason: string }[] = [];
  return {
    sent,
    failed,
    native: {
      filesDriveTransfer: async (_c: string, _t: string, _r: string, offset: number, data: Buffer) => {
        sent.push({ offset, bytes: [...data] });
      },
      filesDriveTransferFailed: (_c: string, _t: string, _r: string, offset: number, length: number, reason: string) => {
        failed.push({ offset, length, reason });
      },
    },
  };
}

function relayWith(options: { ask?: (request: FilesFetchRequest) => true | 'not-running'; firstAnswerMs?: number; idleMs?: number } = {}) {
  const helper = fakeHelper();
  const asked: FilesFetchRequest[] = [];
  const cancelled: string[] = [];
  const relay = new FetchRelay({
    native: helper.native,
    locate: (connection, file) => (connection === 'c1' && file.startsWith('C:\\root\\') ? { rootId: 'r1', path: file.slice('C:\\root\\'.length).replaceAll('\\', '/') } : null),
    ask: options.ask ?? ((request) => {
      asked.push(request);
      return true;
    }),
    cancelled: (id) => cancelled.push(id),
    firstAnswerMs: options.firstAnswerMs,
    idleMs: options.idleMs,
    warn: () => {},
  });
  return { relay, helper, asked, cancelled };
}

const fetchEvent = (over: Partial<NativeFetchEvent> = {}): NativeFetchEvent => ({
  kind: 'fetch',
  connection: 'c1',
  transferKey: 't1',
  requestKey: 'q1',
  path: 'C:\\root\\Ordner mit Ümlaut\\a b.bin',
  identity: 'node-1',
  offset: 0,
  length: 10,
  total: 10,
  pid: 1,
  ...over,
});

const pattern = (length: number, from = 0) => Uint8Array.from({ length }, (_, index) => (from + index) % 251);

test.describe('the fetch relay', () => {
  test('asks the page with the path in the root, and hands Windows the bytes', async () => {
    const { relay, helper, asked } = relayWith();
    relay.onNative(fetchEvent());
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ rootId: 'r1', identity: 'node-1', path: 'Ordner mit Ümlaut/a b.bin', offset: 0, length: 10, total: 10 });
    expect(await relay.supply(asked[0].fetchId, 0, pattern(10))).toBe(true);
    expect(helper.sent).toEqual([{ offset: 0, bytes: [...pattern(10)] }]);
    // Done: more is refused.
    expect(await relay.supply(asked[0].fetchId, 10, pattern(1))).toBe(false);
    expect(relay.active()).toEqual([]);
  });

  test('pieces start at 4 KB aligned offsets and only the last may be short, whatever sizes the page sends', async () => {
    const total = PIECE * 2 + 5000;
    const { relay, helper, asked } = relayWith();
    relay.onNative(fetchEvent({ total, length: total }));
    const data = pattern(total);
    // Odd sizes on purpose.
    let at = 0;
    for (const size of [1000, 777_777, 1_500_000, total]) {
      const end = Math.min(at + size, total);
      expect(await relay.supply(asked[0].fetchId, at, data.subarray(at, end))).toBe(true);
      at = end;
      if (at === total) break;
    }
    expect(helper.sent.map((piece) => piece.offset)).toEqual([0, PIECE, PIECE * 2]);
    for (const piece of helper.sent.slice(0, -1)) expect(piece.bytes.length % ALIGN).toBe(0);
    expect(Buffer.concat(helper.sent.map((piece) => Buffer.from(piece.bytes)))).toEqual(Buffer.from(data));
  });

  test('a request in the middle asks from the 4 KB before it, and the page may start at 0', async () => {
    const total = 3 * ALIGN;
    const { relay, helper, asked } = relayWith();
    relay.onNative(fetchEvent({ offset: ALIGN + 100, length: 50, total }));
    expect(asked[0]).toMatchObject({ offset: ALIGN, length: total - ALIGN, total });
    expect(await relay.supply(asked[0].fetchId, 0, pattern(total))).toBe(true);
    expect(helper.sent).toHaveLength(1);
    expect(helper.sent[0].offset).toBe(ALIGN);
    expect(helper.sent[0].bytes).toEqual([...pattern(total - ALIGN, ALIGN)]);
  });

  test('a gap fails the fetch, and Windows is told', async () => {
    const { relay, helper, asked, cancelled } = relayWith();
    relay.onNative(fetchEvent({ total: 100, length: 100 }));
    expect(await relay.supply(asked[0].fetchId, 50, pattern(50))).toBe(false);
    expect(helper.failed).toHaveLength(1);
    expect(cancelled).toEqual([asked[0].fetchId]);
  });

  test('a fetch the page never answers fails on its own, so the program that opened it gets an error', async () => {
    const { relay, helper, asked, cancelled } = relayWith({ firstAnswerMs: 50 });
    relay.onNative(fetchEvent());
    await expect.poll(() => helper.failed.map((entry) => entry.reason)).toEqual(['timeout']);
    expect(cancelled).toEqual([asked[0].fetchId]);
    expect(await relay.supply(asked[0].fetchId, 0, pattern(10))).toBe(false);
  });

  test('a page that stops in the middle times out too', async () => {
    const { relay, helper, asked } = relayWith({ idleMs: 60 });
    relay.onNative(fetchEvent({ total: 100, length: 100 }));
    expect(await relay.supply(asked[0].fetchId, 0, pattern(40))).toBe(true);
    await expect.poll(() => helper.failed.map((entry) => entry.reason)).toEqual(['timeout']);
  });

  test('no page to ask: Windows hears at once', () => {
    const { relay, helper } = relayWith({ ask: () => 'not-running' });
    relay.onNative(fetchEvent());
    expect(helper.failed.map((entry) => entry.reason)).toEqual(['not-running']);
    expect(relay.active()).toEqual([]);
  });

  test('a path outside every root, or no identity, is refused', () => {
    const { relay, helper, asked } = relayWith();
    relay.onNative(fetchEvent({ path: 'C:\\elsewhere\\x' }));
    relay.onNative(fetchEvent({ identity: '' }));
    expect(asked).toEqual([]);
    expect(helper.failed).toHaveLength(2);
  });

  test("Windows' cancel reaches the page, and later bytes are refused", async () => {
    const { relay, asked, cancelled } = relayWith();
    relay.onNative(fetchEvent({ total: 100, length: 100 }));
    relay.onNative(fetchEvent({ kind: 'cancel' }));
    expect(cancelled).toEqual([asked[0].fetchId]);
    expect(await relay.supply(asked[0].fetchId, 0, pattern(100))).toBe(false);
  });

  test('the page saying offline ends it as offline', () => {
    const { relay, helper, asked } = relayWith();
    relay.onNative(fetchEvent());
    relay.fail(asked[0].fetchId, 'offline');
    expect(helper.failed.map((entry) => entry.reason)).toEqual(['offline']);
  });

  test('a root that goes ends its fetches', () => {
    const { relay, helper, cancelled } = relayWith();
    relay.onNative(fetchEvent());
    relay.dropRoot('r1');
    expect(helper.failed.map((entry) => entry.reason)).toEqual(['not-running']);
    expect(cancelled).toHaveLength(1);
  });
});

test.describe('names and paths', () => {
  test('one account is "Bulwark Files", several are told apart by address', () => {
    expect(displayNameFor('alice@example.org', 1)).toBe('Bulwark Files');
    expect(displayNameFor('alice@example.org', 2)).toBe('Bulwark Files - alice@example.org');
  });

  test('a folder name Windows can hold, and a second one for the same address', () => {
    expect(folderNameFor('alice@example.org', [])).toBe('alice@example.org');
    expect(folderNameFor('a<b>c:d"e/f\\g|h?i*j.', [])).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(folderNameFor('con', [])).toBe('_con');
    expect(folderNameFor('Alice@example.org', ['alice@example.org'])).toBe('Alice@example.org (2)');
  });

  test("the page's paths: relative, `/` between parts, nothing that leaves", () => {
    expect(relativeParts('Ordner mit Ümlaut/a b.txt')).toEqual(['Ordner mit Ümlaut', 'a b.txt']);
    for (const bad of ['', '/a', 'a//b', 'a/../b', '..', 'a\\b', 'C:/x', 'a/./b', 'file.txt:stream', 'a\u0000']) expect(relativeParts(bad), bad).toBeNull();
  });

  test('a link on the way is refused', () => {
    const links = new Set(['C:\\root\\link']);
    const lstat = (file: string) => ({ isSymbolicLink: () => links.has(file) });
    expect(resolveUnder('C:\\root', 'dir/file', lstat)).toEqual({ ok: true, absolute: 'C:\\root\\dir\\file', parts: ['dir', 'file'] });
    expect(resolveUnder('C:\\root', 'link/file', lstat)).toEqual({ ok: false, error: 'outside' });
  });

  test("the helper's codes become the page's errors", () => {
    expect(filesErrorOf('not-placeholder')).toBe('changed');
    expect(filesErrorOf('changed')).toBe('changed');
    expect(filesErrorOf('pinned')).toBe('busy');
    expect(filesErrorOf('timeout')).toBe('failed');
  });
});

test.describe('the drive letter', () => {
  test('the policy wins over the choice, and none without a drive', () => {
    expect(wantedLetter(null, 'X', true)).toBe('X');
    expect(wantedLetter('none', 'X', true)).toBeNull();
    expect(wantedLetter('Q', 'X', true)).toBe('Q');
    expect(wantedLetter(null, 'X', false)).toBeNull();
    expect(wantedLetter(null, null, true)).toBeNull();
  });

  test('one account: its folder; several: the folder that holds them', () => {
    expect(letterTarget('C:\\B', [])).toBeNull();
    expect(letterTarget('C:\\B', ['C:\\B\\a'])).toBe('C:\\B\\a');
    expect(letterTarget('C:\\B', ['C:\\B\\a', 'C:\\B\\b'])).toBe('C:\\B');
  });

  test('free letters skip what the system uses, but keep our own', () => {
    const used = (letters: string) => [...letters].reduce((mask, letter) => mask | (1 << (letter.charCodeAt(0) - 65)), 0);
    const free = freeLetters(used('CDZ'), 'Z');
    expect(free).not.toContain('C');
    expect(free).not.toContain('D');
    expect(free).toContain('Z');
    expect(free).toContain('E');
  });

  test('subst output is read per line', () => {
    expect(parseSubst('X:\\: => C:\\Users\\a\\Bulwark Files\\a@b.c\r\nY:\\: => D:\\other\r\n')).toEqual(
      new Map([
        ['X', 'C:\\Users\\a\\Bulwark Files\\a@b.c'],
        ['Y', 'D:\\other'],
      ]),
    );
  });

  function fakeLetters(initial: Record<string, string>, usedMask = 0): LetterSystem & { map: Map<string, string> } {
    const map = new Map(Object.entries(initial));
    return {
      map,
      list: async () => new Map(map),
      add: async (letter, target) => {
        map.set(letter, target);
        return true;
      },
      remove: async (letter) => map.delete(letter),
      usedMask: () => [...map.keys()].reduce((mask, letter) => mask | (1 << (letter.charCodeAt(0) - 65)), usedMask),
    };
  }

  test("settling never touches someone else's subst, and moves ours", async () => {
    const system = fakeLetters({ Y: 'D:\\other', X: 'C:\\B\\a' });
    expect(await settleLetter(system, 'C:\\B', 'W', 'C:\\B', () => {})).toBe('W');
    expect(system.map).toEqual(new Map([['Y', 'D:\\other'], ['W', 'C:\\B']]));
    expect(await settleLetter(system, 'C:\\B', null, null, () => {})).toBeNull();
    expect(system.map).toEqual(new Map([['Y', 'D:\\other']]));
  });

  test('a letter in use by something else is not taken', async () => {
    const system = fakeLetters({ Y: 'D:\\other' });
    expect(await settleLetter(system, 'C:\\B', 'Y', 'C:\\B\\a', () => {})).toBeNull();
    expect(system.map.get('Y')).toBe('D:\\other');
  });
});
