/**
 * The desktop profile of the embedded webmail: data dirs under userData, the
 * seeded config and policy, and the env the utilityProcess gets.
 *
 * The utilityProcess gets this env and nothing inherited. config-manager reads
 * about 75 keys from the environment, so a REDIS_URL, DEMO_MODE, JMAP_SERVER_URL,
 * NODE_OPTIONS or HOSTNAME on a user's machine would otherwise change how the
 * app behaves.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ProfilePaths {
  root: string;
  adminConfig: string;
  adminState: string;
  settings: string;
  pluginSecrets: string;
  telemetry: string;
  versionCheck: string;
}

export function profilePaths(userData: string): ProfilePaths {
  const root = path.join(userData, 'webmail');
  return {
    root,
    adminConfig: path.join(root, 'admin'),
    adminState: path.join(root, 'admin-state'),
    settings: path.join(root, 'settings'),
    pluginSecrets: path.join(root, 'plugin-secrets'),
    telemetry: path.join(root, 'telemetry'),
    versionCheck: path.join(root, 'version-check'),
  };
}

function writeJson(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

function readJson(file: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** What the app needs in config.json, whatever else has been saved there. */
const SEEDED_CONFIG = {
  setupComplete: true,
  allowCustomJmapEndpoint: true,
  // People bring tokens from their mail provider: it's their own client.
  loginShowTokenLogin: true,
};

/**
 * A user's upload is their own decision on their own machine, so it doesn't wait
 * for a local admin nobody can reach (lib/admin/types.ts:91-92). `PluginsMode`
 * off overrides these, through `pluginFeatures`.
 */
export const SEEDED_FEATURES = {
  pluginsEnabled: true,
  pluginsUploadEnabled: true,
  requirePluginApproval: false,
};

/**
 * With plugins off by policy the server's own switches go off too, which also closes
 * the sandbox routes, the plugin proxy and the settings page. A list closes uploads: a
 * package can name any id. When it's lifted they come back on: nothing the user set
 * lives here.
 */
export function pluginFeatures(mode: 'allowed' | 'allowlist' | 'off'): Record<string, boolean> {
  if (mode === 'off') return { ...SEEDED_FEATURES, pluginsEnabled: false, pluginsUploadEnabled: false };
  if (mode === 'allowlist') return { ...SEEDED_FEATURES, pluginsUploadEnabled: false };
  return SEEDED_FEATURES;
}

/**
 * Rewritten at each start since a user can edit these files: the keys above
 * always win, anything else stays. config-manager picks up later changes to them
 * on its own (5 s stat), so a policy can also rewrite them while running.
 */
export function seedProfile(paths: ProfilePaths, features: Record<string, boolean> = SEEDED_FEATURES): void {
  for (const dir of [paths.adminConfig, paths.adminState, paths.settings, paths.pluginSecrets, paths.telemetry, paths.versionCheck]) {
    mkdirSync(dir, { recursive: true });
  }
  const configFile = path.join(paths.adminConfig, 'config.json');
  writeJson(configFile, { ...readJson(configFile), ...SEEDED_CONFIG });

  const policyFile = path.join(paths.adminConfig, 'policy.json');
  const policy = readJson(policyFile);
  const currentFeatures = policy.features && typeof policy.features === 'object' ? policy.features : {};
  writeJson(policyFile, { ...policy, features: { ...currentFeatures, ...features } });
}

const PASS_THROUGH: Record<NodeJS.Platform | string, string[]> = {
  // What Windows itself needs to start a process and find its temp and DLLs.
  win32: ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATH', 'Path', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'],
  darwin: ['HOME', 'TMPDIR', 'USER', 'LANG', 'LC_ALL', 'PATH'],
  linux: ['HOME', 'TMPDIR', 'USER', 'LANG', 'LC_ALL', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'],
};

/**
 * `BULWARK_TELEMETRY=off` on this machine, as an admin would set it for any Bulwark. It beats
 * the user's yes for usage info and crash reports alike. A yes is never read from here.
 */
export function telemetryOffInEnv(env: Record<string, string | undefined>): boolean {
  const value = (env.BULWARK_TELEMETRY ?? '').toLowerCase();
  if (value === 'off' || value === 'false' || value === '0' || value === 'no') return true;
  const disabled = (env.BULWARK_TELEMETRY_DISABLED ?? '').toLowerCase();
  return disabled === '1' || disabled === 'true' || disabled === 'yes';
}

/** Allowlist only. Secrets don't go here: they arrive by message (protocol.ts). */
export function serverEnv(paths: ProfilePaths, source: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH[platform] ?? PASS_THROUGH.linux) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    COOKIE_SECURE: 'true',
    APP_NAME: 'Bulwark',
    BULWARK_UPDATE_CHECK: 'off',
    // The user's two switches decide, by message. Only an off gets past this allowlist.
    ...(telemetryOffInEnv(source) ? { BULWARK_TELEMETRY: 'off' } : {}),
    LOG_LEVEL: 'warn',
    ADMIN_CONFIG_DIR: paths.adminConfig,
    ADMIN_STATE_DIR: paths.adminState,
    SETTINGS_DATA_DIR: paths.settings,
    PLUGIN_SECRETS_DIR: paths.pluginSecrets,
    TELEMETRY_DATA_DIR: paths.telemetry,
    VERSION_CHECK_DATA_DIR: paths.versionCheck,
  };
}
