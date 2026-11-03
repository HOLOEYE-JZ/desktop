/**
 * The mail servers this app talks to. A server on a private address or plain http
 * is only reachable after the user allowed it, in a native prompt. The embedded
 * server gets the approved list from here (the trusted set in
 * lib/desktop/trusted-servers.ts) and its /__jmap route forwards to nothing else.
 */

import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import type { ServerPrepareResult, SessionUrls } from '../shared/bridge';
import type { CorsInjector } from './cors';
import { isPrivateHost, serverOrigin } from './server-address';
import type { StateFile } from './state';
import { strings } from './strings';

export interface ServerRegistryOptions {
  state: StateFile;
  cors: CorsInjector;
  /** Sends the approved list to the embedded server. */
  sendTrusted: (origins: string[]) => void;
  /**
   * Step 6's `AllowedJmapServers` policy goes here: false refuses the server before
   * anyone is asked. Everything is allowed until a policy says otherwise.
   */
  isAllowedByPolicy?: (origin: string) => boolean;
}

export class ServerRegistry {
  constructor(private readonly options: ServerRegistryOptions) {
    options.cors.set(options.state.data.corsOrigins);
  }

  trustedOrigins(): string[] {
    return this.options.state.data.approvedServers.map((server) => server.origin);
  }

  isApproved(origin: string): boolean {
    return this.trustedOrigins().includes(origin);
  }

  private approve(origin: string): void {
    const { state, sendTrusted } = this.options;
    if (this.isApproved(origin)) return;
    state.data.approvedServers.push({ origin, approvedAt: Date.now() });
    state.save();
    sendTrusted(this.trustedOrigins());
  }

  private noteOrigin(origin: string): void {
    const { state, cors } = this.options;
    // Plain http goes through the same-origin /__jmap route, so CORS doesn't arise.
    if (origin.startsWith('http:')) return;
    if (!state.data.corsOrigins.includes(origin)) {
      state.data.corsOrigins.push(origin);
      state.touch();
    }
    cors.add(origin);
  }

  /** Called before a sign-in. Prompts for a server that needs it. Rejects what the user declines. */
  async prepare(serverUrl: unknown, parent: BrowserWindow | null): Promise<ServerPrepareResult> {
    const origin = serverOrigin(serverUrl);
    if (!origin) return { ok: false, reason: 'invalid' };
    if (this.options.isAllowedByPolicy && !this.options.isAllowedByPolicy(origin)) return { ok: false, reason: 'declined' };
    const { protocol, hostname, host } = new URL(origin);
    const plainHttp = protocol === 'http:';
    const needsApproval = plainHttp || (await isPrivateHost(hostname));
    if (needsApproval && !this.isApproved(origin)) {
      const text = strings();
      const box: MessageBoxOptions = {
        type: 'warning',
        title: 'Bulwark',
        message: plainHttp ? text.serverHttpTitle : text.serverLanTitle,
        detail: plainHttp ? text.serverHttpDetail(host) : text.serverLanDetail(host),
        buttons: [text.allow, text.cancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const { response } = parent ? await dialog.showMessageBox(parent, box) : await dialog.showMessageBox(box);
      if (response !== 0) return { ok: false, reason: 'declined' };
      this.approve(origin);
    }
    this.noteOrigin(origin);
    return { ok: true, approved: needsApproval };
  }

  /** The origins a session names, which may differ from the server's (Fastmail's downloads). */
  noteSession(serverUrl: unknown, urls: SessionUrls | undefined): void {
    const origin = serverOrigin(serverUrl);
    if (!origin || !this.options.state.data.corsOrigins.includes(origin)) return;
    for (const url of Object.values(urls ?? {})) {
      // Templates like {accountId} parse fine as a URL's path.
      const other = serverOrigin(url);
      if (other?.startsWith('https:')) this.noteOrigin(other);
    }
  }
}
