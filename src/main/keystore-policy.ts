/**
 * Whether policy has the keystore off. On its own so windows.ts can leave the bridge's
 * member out, and features/policies.ts can say so, without those two importing each other.
 * Main refuses at each call as well (keystore-consent.ts): a policy can change while a
 * page that already has the member stays open.
 */

let readOff: () => boolean = () => false;
const listeners = new Set<() => void>();

/** Set by features/policies.ts: KeystoreEnabled forced off, or PluginsMode off. */
export function setKeystoreOffPolicy(read: () => boolean): void {
  readOff = read;
}

export function keystoreOffByPolicy(): boolean {
  return readOff();
}

export function onKeystorePolicyChanged(listener: () => void): void {
  listeners.add(listener);
}

export function keystorePolicyChanged(): void {
  for (const listener of listeners) listener();
}
