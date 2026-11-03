/**
 * Installing a marketplace plugin for the renderer: slug in, through the local
 * admin route with its unchanged signature and hash checks. A native prompt comes
 * first, so script in a page can't install anything on its own.
 *
 * `checkPolicy` is the hook for step 6's PluginsMode and PluginAllowlist: main
 * refuses here, and the webmail enforces the same in its install path.
 */

import { dialog, type BrowserWindow } from 'electron';
import type { PluginInstallResult } from '../shared/bridge';
import type { LocalAdmin } from './local-admin';
import { strings } from './strings';

const SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export type PluginPolicyCheck = (slug: string) => { allowed: true } | { allowed: false; code: string };

export const allowEveryPlugin: PluginPolicyCheck = () => ({ allowed: true });

/** The version the admin route shows for an extension: the directory's latest for this app. */
function latestOf(detail: unknown): string | null {
  const preview = (detail as { preview?: { version?: unknown; yanked?: unknown } } | null)?.preview;
  return typeof preview?.version === 'string' && !preview.yanked ? preview.version : null;
}

export async function installPlugin(
  admin: LocalAdmin,
  slug: unknown,
  version: unknown,
  parent: BrowserWindow | null,
  checkPolicy: PluginPolicyCheck = allowEveryPlugin,
): Promise<PluginInstallResult> {
  if (typeof slug !== 'string' || !SLUG.test(slug)) return { ok: false, error: 'invalid_slug' };
  const policy = checkPolicy(slug);
  if (!policy.allowed) return { ok: false, error: 'blocked_by_policy', code: policy.code };

  const text = strings();
  const box = {
    type: 'question' as const,
    title: 'Bulwark',
    message: text.pluginInstallTitle(slug),
    detail: text.pluginInstallDetail,
    buttons: [text.install, text.cancel],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const { response } = parent ? await dialog.showMessageBox(parent, box) : await dialog.showMessageBox(box);
  if (response !== 0) return { ok: false, error: 'cancelled' };

  try {
    let target = typeof version === 'string' && version ? version : null;
    if (!target) {
      const detail = await admin.call('GET', `/api/admin/marketplace/${encodeURIComponent(slug)}`);
      if (detail.status !== 200) return { ok: false, error: 'not_found' };
      target = latestOf(detail.body);
      if (!target) return { ok: false, error: 'not_found' };
    }
    const answer = await admin.call('POST', '/api/admin/marketplace', { slug, version: target, type: 'plugin' });
    const body = answer.body as { plugin?: { id?: string; version?: string }; error?: string; code?: string };
    if (answer.status !== 200 || !body?.plugin?.id) {
      return { ok: false, error: typeof body?.error === 'string' ? body.error : `install_failed_${answer.status}`, code: body?.code };
    }
    return { ok: true, id: body.plugin.id, version: body.plugin.version ?? target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'install_failed' };
  }
}
