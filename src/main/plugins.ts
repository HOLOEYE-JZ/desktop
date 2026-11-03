/**
 * Installing a marketplace plugin for the renderer: slug in, through the local
 * admin route with its unchanged signature and hash checks. A native prompt comes
 * first and says who it's from and what it may do, so script in a page can't
 * install anything on its own, and Cancel is what Enter does.
 *
 * `checkPolicy` is PluginsMode and PluginAllowlist (features/policies.ts): main
 * refuses here, and the webmail enforces the same in its install path.
 */

import { dialog, type BrowserWindow } from 'electron';
import type { PluginInstallResult } from '../shared/bridge';
import type { LocalAdmin } from './local-admin';
import { pluginFacts, pluginPrompt, type PluginDetail } from './plugin-prompt';
import { strings } from './strings';

const SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export type PluginPolicyCheck = (slug: string) => { allowed: true } | { allowed: false; code: string };

export const allowEveryPlugin: PluginPolicyCheck = () => ({ allowed: true });

export async function installPlugin(
  admin: LocalAdmin,
  slug: unknown,
  version: unknown,
  parent: BrowserWindow | null,
  checkPolicy: PluginPolicyCheck = allowEveryPlugin,
): Promise<PluginInstallResult> {
  if (typeof slug !== 'string' || !SLUG.test(slug)) return { ok: false, error: 'invalid_slug' };
  if (version !== undefined && (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,64}$/.test(version))) return { ok: false, error: 'invalid_version' };
  const policy = checkPolicy(slug);
  if (!policy.allowed) return { ok: false, error: 'blocked_by_policy', code: policy.code };

  try {
    const query = version ? `?version=${encodeURIComponent(version)}` : '';
    const detail = await admin.call('GET', `/api/admin/marketplace/${encodeURIComponent(slug)}${query}`);
    if (detail.status !== 200) return { ok: false, error: 'not_found' };
    const facts = pluginFacts(detail.body as PluginDetail, slug);
    if (!facts.version) return { ok: false, error: 'not_found' };

    const box = pluginPrompt(facts, strings());
    const { response } = parent ? await dialog.showMessageBox(parent, box) : await dialog.showMessageBox(box);
    if (response !== 0) return { ok: false, error: 'cancelled' };

    const answer = await admin.call('POST', '/api/admin/marketplace', { slug, version: facts.version, type: 'plugin' });
    const body = answer.body as { plugin?: { id?: string; version?: string }; error?: string; code?: string };
    if (answer.status !== 200 || !body?.plugin?.id) {
      return { ok: false, error: typeof body?.error === 'string' ? body.error : `install_failed_${answer.status}`, code: body?.code };
    }
    return { ok: true, id: body.plugin.id, version: body.plugin.version ?? facts.version };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'install_failed' };
  }
}
