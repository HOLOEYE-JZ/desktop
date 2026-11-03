/**
 * Where the updater hears about the `AutoUpdate` and `UpdateChannel` policies. No Electron
 * here, so tests can load it. features/updater.ts connects it to the policy reader.
 */

import type { UpdatePolicy } from './update-rules';

let source: () => UpdatePolicy = () => ({});
const listeners = new Set<() => void>();

export function setUpdatePolicySource(read: () => UpdatePolicy): void {
  source = read;
  notifyUpdatePolicyChanged();
}

export function notifyUpdatePolicyChanged(): void {
  for (const listener of listeners) listener();
}

export function readUpdatePolicy(): UpdatePolicy {
  return source();
}

export function onUpdatePolicyChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
