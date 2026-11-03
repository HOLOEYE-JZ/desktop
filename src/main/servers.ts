/**
 * The mail servers this app talks to. A server on a private address or plain http
 * is only reachable after the user allowed it, in a native prompt. The embedded
 * server gets the approved list from here (the trusted set in
 * lib/desktop/trusted-servers.ts) and its /__jmap route forwards to nothing else.
 *
 * What `prepare` adds lasts until the app quits. It's stored for good only when a
 * session came back from that server (`noteSession`), so a mistyped address or a
 * failed sign-in leaves nothing behind, and sign-out takes it out again.
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
  private readonly pendingApproved = new Set<string>();
  private readonly pendingCors = new Set<string>();
  /** Session-named origins the user said no to, so a session refresh doesn't ask again. */
  private readonly declined = new Set<string>();
  private readonly asking = new Set<string>();

  constructor(private readonly options: ServerRegistryOptions) {
    const { state, cors } = options;
    // An earlier version could store what isn't a server, and it would break each launch.
    const cleanCors = state.data.corsOrigins.filter((origin) => serverOrigin(origin) === origin);
    const cleanApproved = state.data.approvedServers.filter((server) => serverOrigin(server.origin) === server.origin);
    if (cleanCors.length !== state.data.corsOrigins.length || cleanApproved.length !== state.data.approvedServers.length) {
      state.data.corsOrigins = cleanCors;
      state.data.approvedServers = cleanApproved;
      state.touch();
    }
    cors.set(cleanCors);
  }

  trustedOrigins(): string[] {
    return [...new Set([...this.options.state.data.approvedServers.map((server) => server.origin), ...this.pendingApproved])];
  }

  isApproved(origin: string): boolean {
    return this.trustedOrigins().includes(origin);
  }

  private async ask(box: Omit<MessageBoxOptions, 'title' | 'buttons' | 'defaultId' | 'cancelId' | 'noLink'>, parent: BrowserWindow | null): Promise<boolean> {
    const text = strings();
    const options: MessageBoxOptions = { title: 'Bulwark', buttons: [text.allow, text.cancel], defaultId: 1, cancelId: 1, noLink: true, ...box };
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return response === 0;
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
      const allowed = await this.ask(
        {
          type: 'warning',
          message: plainHttp ? text.serverHttpTitle : text.serverLanTitle,
          detail: plainHttp ? text.serverHttpDetail(host) : text.serverLanDetail(host),
        },
        parent,
      );
      if (!allowed) return { ok: false, reason: 'declined' };
      this.pendingApproved.add(origin);
      this.options.sendTrusted(this.trustedOrigins());
    }
    // Plain http goes through the same-origin /__jmap route, so CORS doesn't arise.
    if (!plainHttp && !this.options.state.data.corsOrigins.includes(origin)) {
      this.pendingCors.add(origin);
      this.options.cors.add(origin);
    }
    return { ok: true, approved: needsApproval };
  }

  /** Is this one of ours: stored, or prepared in this run? */
  private known(origin: string): boolean {
    return this.isApproved(origin) || this.pendingCors.has(origin) || this.options.state.data.corsOrigins.includes(origin);
  }

  /**
   * A session came back from this server, so the sign-in worked and the server
   * stays. A session may also name other origins, such as Fastmail's downloads:
   * those aren't the address the user typed, so the user decides, and a private
   * one is never added: a server could otherwise aim the app at the LAN.
   */
  async noteSession(serverUrl: unknown, urls: SessionUrls | undefined, parent: BrowserWindow | null): Promise<void> {
    const origin = serverOrigin(serverUrl);
    if (!origin || !this.known(origin)) return;
    const { state, cors } = this.options;

    if (this.pendingApproved.delete(origin)) {
      if (!state.data.approvedServers.some((server) => server.origin === origin)) {
        state.data.approvedServers.push({ origin, approvedAt: Date.now() });
      }
      state.touch();
    }
    if (this.pendingCors.delete(origin)) {
      if (!state.data.corsOrigins.includes(origin)) state.data.corsOrigins.push(origin);
      state.touch();
    }

    for (const url of Object.values(urls ?? {})) {
      // A template like {accountId} parses fine as a URL's path.
      const other = serverOrigin(url);
      if (!other?.startsWith('https:') || other === origin) continue;
      if (state.data.corsOrigins.includes(other) || this.declined.has(other) || this.asking.has(other)) continue;
      this.asking.add(other);
      try {
        const host = new URL(other).host;
        if (await isPrivateHost(new URL(other).hostname)) {
          this.declined.add(other);
          continue;
        }
        const text = strings();
        const allowed = await this.ask(
          { type: 'question', message: text.serverSecondOriginTitle(new URL(origin).host), detail: text.serverSecondOriginDetail(host) },
          parent,
        );
        if (!allowed) {
          this.declined.add(other);
          continue;
        }
        state.data.corsOrigins.push(other);
        state.touch();
        cors.add(other);
      } finally {
        this.asking.delete(other);
      }
    }
  }

  /**
   * `failed`: a sign-in that didn't work. What it added in this run goes, except the
   * user's yes to the prompt, so retrying a password doesn't ask again. What another
   * account stored stays.
   * `signed-out`: the last account on this server went. All of it goes.
   */
  forget(serverUrl: unknown, reason: unknown): void {
    const origin = serverOrigin(serverUrl);
    if (!origin) return;
    const { state, cors, sendTrusted } = this.options;
    if (reason === 'failed') {
      if (this.pendingCors.delete(origin)) cors.remove(origin);
      return;
    }
    if (reason !== 'signed-out') return;
    this.pendingCors.delete(origin);
    this.pendingApproved.delete(origin);
    state.data.corsOrigins = state.data.corsOrigins.filter((item) => item !== origin);
    state.data.approvedServers = state.data.approvedServers.filter((server) => server.origin !== origin);
    state.touch();
    cors.remove(origin);
    sendTrusted(this.trustedOrigins());
  }
}
