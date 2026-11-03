/** Shared between main and the utilityProcess. No imports: both bundle this. */

export const APP_HOST = 'app.bulwark.localhost';
export const APP_ORIGIN = `https://${APP_HOST}`;
export const LAUNCH_HEADER = 'x-bulwark-launch';

export interface InitMessage {
  type: 'init';
  port: number;
  /** Main's pid, to go down with it (host.ts). */
  parentPid: number;
  launchSecret: string;
  tls: { key: string; cert: string };
  /** Set on process.env in the utilityProcess before Next loads. */
  secretEnv: Record<string, string>;
  trustedOrigins: string[];
}

export interface TrustedMessage {
  type: 'trusted';
  origins: string[];
}

export type HostMessage = InitMessage | TrustedMessage;

export type HostEvent =
  | { type: 'ready'; systemCertificates: number; caError?: string }
  | { type: 'fatal'; code?: string; error: string }
  | { type: 'log'; level: string; message: string };
