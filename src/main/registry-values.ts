/**
 * Reading single values through the native helper's registry (native-loader.ts). What
 * `reg query <key> /v <name>` gave, without starting reg.exe. No Electron here.
 */

import type { NativeRegistryNode, NativeRegistryValue, Registry } from './native-loader';

/** A key's value by name, which the registry compares without case. '' is the default value. */
export function valueOf(node: NativeRegistryNode | undefined, name: string): NativeRegistryValue | undefined {
  const wanted = name.toLowerCase();
  return node?.values.find((value) => value.name.toLowerCase() === wanted);
}

/** The key alone, or null: not there, or it couldn't be read, which callers treat the same. */
export function readKey(registry: Registry | null, key: string): NativeRegistryNode | null {
  try {
    return registry?.read(key, 0)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** A REG_SZ or REG_EXPAND_SZ value's text, not expanded. Null for none, or one of another type. */
export function stringOf(value: NativeRegistryValue | undefined): string | null {
  return value && (value.kind === 'sz' || value.kind === 'expand_sz') ? value.text ?? '' : null;
}

/** A string value of a key: `''` for the default value. Null as stringOf, or with no key. */
export function readString(registry: Registry | null, key: string, name = ''): string | null {
  return stringOf(valueOf(readKey(registry, key) ?? undefined, name));
}

/** Whether a key has a value of that name, of any type. */
export function hasValue(registry: Registry | null, key: string, name: string): boolean {
  return valueOf(readKey(registry, key) ?? undefined, name) !== undefined;
}
