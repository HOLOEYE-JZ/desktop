/** What the install prompt says. No Electron at runtime here, so tests can load it. */

import type { MessageBoxOptions } from 'electron';

export interface PromptText {
  pluginInstallTitle: (name: string) => string;
  pluginPublisher: (publisher: string, verified: boolean) => string;
  pluginNoPublisher: string;
  pluginPermissions: string;
  pluginNoPermissions: string;
  pluginPrivileged: string;
  /** What `keystore` is called when the server's list has no text for it. */
  pluginKeystore: string;
  /** Above what an update adds. */
  pluginNewPermissions: string;
  install: string;
  cancel: string;
}

/** What the admin route answers for an extension (app/api/admin/marketplace/[slug]). */
export interface PluginDetail {
  extension?: {
    name?: unknown;
    author?: { displayName?: unknown; githubLogin?: unknown; verified?: unknown } | null;
    permissionDetails?: { id?: unknown; title?: unknown; highRisk?: unknown }[];
  };
  preview?: { version?: unknown; yanked?: unknown } | null;
  bundle?: {
    manifest?: { tier?: unknown; name?: unknown; permissions?: unknown; optionalPermissions?: unknown } | null;
    /** What this version asks for that the installed one doesn't. Absent on older webmails. */
    addedPermissions?: unknown;
  } | null;
}

export interface PluginFacts {
  name: string;
  publisher: string | null;
  verified: boolean;
  /** Text where the server has one, the permission's own name otherwise. */
  permissions: string[];
  /** The same ids the server was asked about, for its check that an update's additions were shown. */
  permissionIds: string[];
  /** The part of `permissions` an update adds. */
  added: string[];
  privileged: boolean;
  version: string | null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function pluginFacts(detail: PluginDetail, slug: string): PluginFacts {
  const author = detail.extension?.author;
  const nameOf = (value: unknown) => (typeof value === 'string' && value ? value : null);
  const version = nameOf(detail.preview?.version);
  const privileged = detail.bundle?.manifest?.tier === 'privileged';
  const details = detail.extension?.permissionDetails ?? [];
  const titles = new Map<string, string>();
  const untitled: string[] = [];
  for (const entry of details) {
    if (typeof entry?.title !== 'string') continue;
    if (typeof entry.id === 'string') titles.set(entry.id, entry.title);
    else untitled.push(entry.title);
  }
  // The directory's list leaves out optional permissions on older servers, and an install
  // prompt has to show what it can get. `keystore` only reaches the privileged tier.
  const declared = [...new Set([...stringList(detail.bundle?.manifest?.permissions), ...stringList(detail.bundle?.manifest?.optionalPermissions)])]
    .filter((id) => id !== 'keystore' || privileged);
  const ids = [...new Set([...titles.keys(), ...declared])].filter((id) => id !== 'keystore' || privileged);
  const titleOf = (id: string) => titles.get(id) ?? id;
  return {
    name: nameOf(detail.extension?.name) ?? nameOf(detail.bundle?.manifest?.name) ?? slug,
    publisher: nameOf(author?.displayName) ?? nameOf(author?.githubLogin),
    verified: author?.verified === true,
    permissions: [...untitled, ...ids.map(titleOf)],
    permissionIds: ids,
    added: stringList(detail.bundle?.addedPermissions).filter((id) => ids.includes(id)).map(titleOf),
    privileged,
    version: detail.preview?.yanked ? null : version,
  };
}

export function pluginPrompt(facts: PluginFacts, text: PromptText): MessageBoxOptions {
  const named = (permission: string) => (permission === 'keystore' ? text.pluginKeystore : permission);
  const bullet = (permission: string) => `• ${named(permission)}`;
  const lines = [
    facts.publisher ? text.pluginPublisher(facts.publisher, facts.verified) : text.pluginNoPublisher,
    '',
    ...(facts.permissions.length > 0 ? [text.pluginPermissions, ...facts.permissions.map(bullet)] : [text.pluginNoPermissions]),
    ...(facts.added.length > 0 ? ['', text.pluginNewPermissions, ...facts.added.map(bullet)] : []),
    ...(facts.privileged ? ['', text.pluginPrivileged] : []),
  ];
  return {
    type: facts.privileged ? 'warning' : 'question',
    title: 'Bulwark',
    message: text.pluginInstallTitle(facts.name),
    detail: lines.join('\n'),
    buttons: [text.install, text.cancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}
