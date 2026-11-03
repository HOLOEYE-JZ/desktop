/** What the install prompt says. No Electron at runtime here, so tests can load it. */

import type { MessageBoxOptions } from 'electron';

export interface PromptText {
  pluginInstallTitle: (name: string) => string;
  pluginPublisher: (publisher: string, verified: boolean) => string;
  pluginNoPublisher: string;
  pluginPermissions: string;
  pluginNoPermissions: string;
  pluginPrivileged: string;
  install: string;
  cancel: string;
}

/** What the admin route answers for an extension (app/api/admin/marketplace/[slug]). */
export interface PluginDetail {
  extension?: {
    name?: unknown;
    author?: { displayName?: unknown; githubLogin?: unknown; verified?: unknown } | null;
    permissionDetails?: { title?: unknown; highRisk?: unknown }[];
  };
  preview?: { version?: unknown; yanked?: unknown } | null;
  bundle?: { manifest?: { tier?: unknown; name?: unknown } | null } | null;
}

export interface PluginFacts {
  name: string;
  publisher: string | null;
  verified: boolean;
  permissions: string[];
  privileged: boolean;
  version: string | null;
}

export function pluginFacts(detail: PluginDetail, slug: string): PluginFacts {
  const author = detail.extension?.author;
  const nameOf = (value: unknown) => (typeof value === 'string' && value ? value : null);
  const version = nameOf(detail.preview?.version);
  return {
    name: nameOf(detail.extension?.name) ?? nameOf(detail.bundle?.manifest?.name) ?? slug,
    publisher: nameOf(author?.displayName) ?? nameOf(author?.githubLogin),
    verified: author?.verified === true,
    permissions: (detail.extension?.permissionDetails ?? []).flatMap((p) => (typeof p?.title === 'string' ? [p.title] : [])),
    privileged: detail.bundle?.manifest?.tier === 'privileged',
    version: detail.preview?.yanked ? null : version,
  };
}

export function pluginPrompt(facts: PluginFacts, text: PromptText): MessageBoxOptions {
  const lines = [
    facts.publisher ? text.pluginPublisher(facts.publisher, facts.verified) : text.pluginNoPublisher,
    '',
    ...(facts.permissions.length > 0 ? [text.pluginPermissions, ...facts.permissions.map((p) => `• ${p}`)] : [text.pluginNoPermissions]),
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
