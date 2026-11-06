// An in-memory registry with the helper's shape (native-loader.ts Registry), for unit tests of
// what main reads and writes. Key names and value names compare without case, as Windows does.
import type { NativeRegistryNode, NativeRegistryValue, Registry } from '../src/main/native-loader';

interface Key {
  name: string;
  values: NativeRegistryValue[];
}

export interface FakeRegistry extends Registry {
  /** Every key there is, as written, for checks. */
  keys(): string[];
  /** Makes reads of keys under this one throw, as a key that's there and denied. */
  deny(key: string): void;
}

export function fakeRegistry(initial: Record<string, NativeRegistryValue[]> = {}): FakeRegistry {
  const keys = new Map<string, Key>();
  const denied = new Set<string>();
  const low = (key: string) => key.toLowerCase();
  const parentOf = (key: string) => key.slice(0, Math.max(0, key.lastIndexOf('\\')));
  const ensure = (key: string): Key => {
    const found = keys.get(low(key));
    if (found) return found;
    const parent = parentOf(key);
    if (parent.includes('\\')) ensure(parent);
    const made = { name: key.slice(key.lastIndexOf('\\') + 1), values: [] };
    keys.set(low(key), made);
    return made;
  };
  const childrenOf = (key: string) => [...keys.entries()].filter(([path]) => parentOf(path) === low(key)).map(([path, entry]) => ({ path, entry }));
  for (const [key, values] of Object.entries(initial)) ensure(key).values.push(...values.map((value) => ({ ...value })));

  const read = (key: string, depth = 0): NativeRegistryNode[] | null => {
    if ([...denied].some((blocked) => low(key) === blocked || low(key).startsWith(`${blocked}\\`))) throw new Error('registry:denied (0x80070005)');
    if (!keys.has(low(key))) return null;
    const nodes: NativeRegistryNode[] = [];
    const walk = (path: string, relative: string, left: number) => {
      const children = childrenOf(path);
      nodes.push({ path: relative, values: keys.get(low(path))!.values.map((value) => ({ ...value })), subkeys: children.map((child) => child.entry.name) });
      if (left === 0) return;
      for (const child of children) walk(`${path}\\${child.entry.name}`, relative ? `${relative}\\${child.entry.name}` : child.entry.name, left - 1);
    };
    walk(key, '', depth);
    return nodes;
  };

  return {
    read,
    setString: (key, name, data) => {
      const entry = ensure(key);
      const wanted = low(name ?? '');
      entry.values = entry.values.filter((value) => low(value.name) !== wanted);
      entry.values.push({ name: name ?? '', kind: 'sz', text: data });
      return true;
    },
    deleteKey: (key) => {
      if (!keys.has(low(key))) return false;
      for (const path of [...keys.keys()]) if (path === low(key) || path.startsWith(`${low(key)}\\`)) keys.delete(path);
      return true;
    },
    deleteValue: (key, name) => {
      const entry = keys.get(low(key));
      if (!entry) return false;
      const before = entry.values.length;
      entry.values = entry.values.filter((value) => low(value.name) !== low(name));
      return entry.values.length !== before;
    },
    keys: () => [...keys.keys()],
    deny: (key) => denied.add(low(key)),
  };
}
