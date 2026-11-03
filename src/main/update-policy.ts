/**
 * Where the updater hears about the `AutoUpdate` and `UpdateChannel` policies. A small
 * hook, because the policy reader is its own feature. It calls `setUpdatePolicySource`
 * once at start, and the listener when a policy changes:
 *
 *   setUpdatePolicySource(() => ({ autoUpdate: read('AutoUpdate'), channel: read('UpdateChannel') }));
 *   watcher.on('change', notifyUpdatePolicyChanged);
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
