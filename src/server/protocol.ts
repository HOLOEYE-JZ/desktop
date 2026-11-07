/** Shared between main and the utilityProcess. No imports: both bundle this. */

export const APP_HOST = 'app.bulwark.localhost';
export const APP_ORIGIN = `https://${APP_HOST}`;
export const LAUNCH_HEADER = 'x-bulwark-launch';
/** Only main's own requests carry this. The app session's requests carry the launch header too. */
export const MAIN_HEADER = 'x-bulwark-main';

/** What a stack has of the disk is the app's folder. A frame under it becomes `/desktop/...`. */
export function normalizeStack(stack: string, dir: string): string {
  const base = dir.replace(/\\/g, '/').replace(/\/$/, '');
  return stack
    .split('\n')
    .map((line) => {
      const forward = line.replace(/\\/g, '/').replace(/file:\/\/\//g, '/');
      const at = forward.toLowerCase().indexOf(`${base.toLowerCase()}/`);
      if (at < 0) return line;
      return `${forward.slice(0, at).replace(/\/$/, '')}/desktop/${forward.slice(at + base.length + 1)}`;
    })
    .join('\n');
}

export interface PrivacyMessage {
  type: 'privacy';
  privacy: { telemetry: boolean; crashReports: boolean; appVersion: string; build: string; endpoint?: string };
}

export interface MainErrorMessage {
  type: 'main-error';
  name?: unknown;
  message?: unknown;
  stack?: string;
  mechanism: 'uncaughtexception' | 'unhandledrejection';
}

export interface InitMessage {
  type: 'init';
  /** The server's root: resources/server.asar in a package, a plain folder in development. */
  serverDir: string;
  port: number;
  /** Main's pid, to go down with it (host.ts). */
  parentPid: number;
  launchSecret: string;
  mainSecret: string;
  tls: { key: string; cert: string };
  /** On globalThis in the utilityProcess before Next loads. Never in its environment. */
  secrets: { sessionSecret: string; adminPassword: string };
  trustedOrigins: string[];
  privacy: PrivacyMessage['privacy'];
  /** What OS policies say the server has to enforce. */
  policy: ServerPolicyMessage['policy'];
}

export interface TrustedMessage {
  type: 'trusted';
  origins: string[];
}

export interface ServerPolicyMessage {
  type: 'policy';
  policy: { pluginsMode: 'allowed' | 'allowlist' | 'off'; pluginAllowlist: string[]; allowedJmapServers: string[] | null };
}

export type HostMessage = InitMessage | TrustedMessage | ServerPolicyMessage | PrivacyMessage | MainErrorMessage;

export type HostEvent =
  /** The port takes requests; page requests wait until Next has loaded. */
  | { type: 'listening' }
  | { type: 'ready'; systemCertificates: number; caError?: string }
  | { type: 'fatal'; code?: string; error: string }
  | { type: 'log'; level: string; message: string };
