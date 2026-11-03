/** Shared between main and the utilityProcess. No imports: both bundle this. */

export const APP_HOST = 'app.bulwark.localhost';
export const APP_ORIGIN = `https://${APP_HOST}`;
export const LAUNCH_HEADER = 'x-bulwark-launch';
/** Only main's own requests carry this. The app session's requests carry the launch header too. */
export const MAIN_HEADER = 'x-bulwark-main';

export interface InitMessage {
  type: 'init';
  port: number;
  /** Main's pid, to go down with it (host.ts). */
  parentPid: number;
  launchSecret: string;
  mainSecret: string;
  tls: { key: string; cert: string };
  /** Set on process.env in the utilityProcess before Next loads. */
  secretEnv: Record<string, string>;
  trustedOrigins: string[];
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

export type HostMessage = InitMessage | TrustedMessage | ServerPolicyMessage;

export type HostEvent =
  | { type: 'ready'; systemCertificates: number; caError?: string }
  | { type: 'fatal'; code?: string; error: string }
  | { type: 'log'; level: string; message: string };
