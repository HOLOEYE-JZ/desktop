/**
 * Client certificates and the Windows sign-in, where a page can reach them.
 *
 * The rules are in client-auth.ts. This wires them to Electron: the event, the request and
 * response gates, the native picker, the state file, and what ends Chromium's memory of an
 * answer. The event is listened to from the top of main, before any window: left alone it
 * sends the first certificate in the store to whoever asks.
 */

import { app, BrowserWindow, dialog, type Certificate, type Session, type WebContents } from 'electron';
import { CHANNEL } from '../../shared/bridge';
import { certificateRuleMatchesUrl, type PolicySnapshot } from '../../shared/policy-schema';
import {
  asksForWindowsSignIn,
  CertificateChooser,
  certificateRow,
  classifyRequest,
  displayHost,
  hostPortOf,
  narrowedList,
  NO_INTEGRATED_SIGN_IN,
  pickerPages,
  RequestLedger,
  signInListUrls,
  type PickAnswer,
  type PickQuestion,
  type RememberedChoices,
} from '../client-auth';
import { requestGate, responseGate } from '../request-gate';
import type { StateFile } from '../state';
import { fill, strings } from '../strings';
import { addWipeStep } from './local-wipe';
import { policies } from './policies';
import type { Feature, FeatureContext } from '.';

const AUTH_SERVER_SWITCH = 'auth-server-whitelist';
const AUTH_DELEGATE_SWITCH = 'auth-negotiate-delegate-whitelist';

const MAX_CHOICES = 64;
/** A sign-out still has requests under way: its token's revocation, for one. */
const NETWORK_RESET_DELAY_MS = 1500;
/** Plugins in the page can reach the clearing call. They can't use it to keep cutting off the network. */
const NETWORK_RESET_GAP_MS = 30_000;

function storedChoices(state: StateFile): RememberedChoices {
  return {
    get: (hostPort) => state.data.certificateChoices?.[hostPort],
    set: (hostPort, fingerprint) => {
      const entries = Object.entries(state.data.certificateChoices ?? {}).filter(([host]) => host !== hostPort);
      state.data.certificateChoices = Object.fromEntries([...entries, [hostPort, fingerprint]].slice(-MAX_CHOICES));
      state.save();
    },
    clear: () => {
      if (!state.data.certificateChoices) return;
      delete state.data.certificateChoices;
      state.save();
    },
  };
}

/** The window behind the question. A hidden spare can't carry a dialog: the user wouldn't see it. */
function dialogParent(window: unknown, ctx: FeatureContext): BrowserWindow | null {
  const asked = window instanceof BrowserWindow && !window.isDestroyed() && window.isVisible() ? window : null;
  return asked ?? ctx.windows.focusedManaged()?.window ?? ctx.windows.mainWindow() ?? null;
}

async function askInDialog(question: PickQuestion<Certificate>, window: unknown, ctx: FeatureContext): Promise<PickAnswer<Certificate>> {
  const text = strings();
  const host = displayHost(question.hostPort);
  const details = (issuer: string, date: string) => fill(text.certificateIssued, { issuer, date });
  const pages = pickerPages(question.certificates);
  for (let page = 0; ; page = (page + 1) % pages.length) {
    const shown = pages[page];
    const buttons = [...shown.map((certificate) => certificateRow(certificate, details, app.getLocale(), process.platform)), ...(pages.length > 1 ? [text.certificateMore] : []), text.certificateNone];
    const none = buttons.length - 1;
    const options = {
      type: 'question' as const,
      title: 'Bulwark',
      message: fill(text.certificateTitle, { host }),
      detail: text.certificateDetail,
      buttons,
      // Enter and Esc send nothing.
      defaultId: none,
      cancelId: none,
      // Windows draws the rows as command links, each with its name and a line below.
      noLink: false,
      checkboxLabel: fill(text.certificateRemember, { host }),
      checkboxChecked: false,
    };
    const parent = dialogParent(window, ctx);
    const { response, checkboxChecked } = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
    if (response < shown.length) return { certificate: shown[response], remember: checkboxChecked };
    if (response === none) return { certificate: null, remember: false };
  }
}

function isNetworkService(details: { type: string; serviceName?: string }): boolean {
  return details.type === 'Utility' && !!details.serviceName?.includes('network');
}

/**
 * The only thing that ends what Chromium keeps for a host: its certificate, its "none" and its
 * TLS sessions. No session call does it, and a restart of the app would take the windows away.
 * Chromium starts a new one by itself, and pages carry on. A request under way fails, as on any
 * network change. Cookies are on disk first. app-session.ts sets up what doesn't survive it.
 */
async function restartNetworkService(session: Session): Promise<boolean> {
  await session.cookies.flushStore().catch(() => {});
  const service = app.getAppMetrics().find((metric) => isNetworkService(metric));
  if (!service) return false;
  try {
    const loading = BrowserWindow.getAllWindows().filter((window) => window.webContents.isLoading() && window.webContents.session === session);
    process.kill(service.pid);
    // A page on its way in would stop at an error page.
    setTimeout(() => {
      for (const window of loading) if (!window.isDestroyed()) window.webContents.reload();
    }, 500).unref?.();
    return true;
  } catch (error) {
    console.warn('The network service did not stop:', error);
    return false;
  }
}

class ClientAuth {
  private state: StateFile | null = null;
  private answer: ((contents: WebContents | null, hostPort: string, list: Certificate[], callback: (certificate?: Certificate) => void) => void) | null = null;
  private clearAll: (() => void) | null = null;

  /** From the top of main. A wipe at the start comes before any feature is set up. */
  start(state: StateFile): void {
    this.state = state;
    app.on('select-client-certificate', (event, contents, hostPort, list, callback) => {
      event.preventDefault();
      if (this.answer) this.answer(contents, hostPort, list, callback);
      else callback();
    });
    addWipeStep(async () => this.clear());
  }

  private clear(): void {
    if (this.state) storedChoices(this.state).clear();
    this.clearAll?.();
  }

  setup(ctx: FeatureContext): void {
    const { session, origin } = ctx;
    const ledger = new RequestLedger();
    const chooser = new CertificateChooser<Certificate>({
      rules: () => policies.snapshot.AutoSelectCertificateForUrls.value,
      choices: storedChoices(ctx.state),
      ask: (question, window) => askInDialog(question, window, ctx),
    });
    const isListedServer = (target: string) => !!ctx.servers?.isKnown(target) || policies.snapshot.AutoSelectCertificateForUrls.value.some((rule) => certificateRuleMatchesUrl(rule, target));

    // Hosts that had this user's Windows sign-in this run: such a connection stays signed in.
    const signedIn = new Set<string>();

    const gate = requestGate(session);
    gate.add((url, details) => {
      const hostPort = hostPortOf(url);
      if (!hostPort) return false;
      const standing = classifyRequest(details, origin, isListedServer);
      const trusted = standing === 'first-party' || standing === 'listed-server';
      if (!trusted && chooser.holds(hostPort)) return true;
      if (standing !== 'first-party' && signedIn.has(hostPort)) return true;
      ledger.note(details.id, hostPort, standing);
      return false;
    });
    gate.onEnded((id) => ledger.finish(id));

    this.answer = (contents, hostPort, list, callback) => {
      const ours = !contents || contents.session === session;
      const standing = ours ? ledger.claim(hostPort) : null;
      const window = contents && !contents.isDestroyed() ? BrowserWindow.fromWebContents(contents) : null;
      void chooser
        .decide(hostPort, standing, list, window)
        .then((decision) => {
          if (decision.kind === 'send') callback(decision.certificate);
          else if (decision.kind === 'none') callback();
          // 'leave': dropped. The request fails when this callback is collected.
        })
        .catch((error) => {
          console.error(error);
          callback();
        });
    };

    const respond = responseGate(session);
    let serverList = app.commandLine.getSwitchValue(AUTH_SERVER_SWITCH);
    let delegateList = app.commandLine.getSwitchValue(AUTH_DELEGATE_SWITCH);
    const inForce = () => (serverList === NO_INTEGRATED_SIGN_IN ? null : serverList || null);
    const watchResponses = () => {
      const urls = signInListUrls(inForce());
      // Either all can be watched, or everything is.
      respond.set('windows-sign-in', urls.every((url) => respond.accepts(url)) ? urls : ['*://*/*'], (details) => {
        if (!asksForWindowsSignIn(details.statusCode, details.responseHeaders)) return null;
        if (ledger.standingOf(details.id) !== 'first-party') return { cancel: true };
        const hostPort = hostPortOf(details.url);
        if (hostPort) signedIn.add(hostPort);
        return null;
      });
    };
    if (inForce()) watchResponses();

    // Taking a server off the list counts at once. A new one waits for the restart the app asks for.
    const narrow = (snapshot: PolicySnapshot, previous: PolicySnapshot) => {
      const servers = snapshot.AuthServerAllowlist.value;
      const delegates = snapshot.AuthNegotiateDelegateAllowlist.value;
      if (servers === previous.AuthServerAllowlist.value && delegates === previous.AuthNegotiateDelegateAllowlist.value) return;
      serverList = narrowedList(inForce(), servers) ?? NO_INTEGRATED_SIGN_IN;
      delegateList = narrowedList(delegateList || null, delegates) ?? '';
      // Also for a network service that starts later: it reads these.
      app.commandLine.appendSwitch(AUTH_SERVER_SWITCH, serverList);
      if (delegateList) app.commandLine.appendSwitch(AUTH_DELEGATE_SWITCH, delegateList);
      else app.commandLine.removeSwitch(AUTH_DELEGATE_SWITCH);
      // Global in spite of its place on Session. It also empties the delegation list until the restart.
      session.allowNTLMCredentialsForDomains(serverList);
      signedIn.clear();
      void session.clearAuthCache().catch(() => {});
      watchResponses();
    };
    policies.on('changed', narrow);

    let resetTimer: NodeJS.Timeout | null = null;
    let lastReset = 0;
    const emptyNetwork = () => {
      if (resetTimer) return;
      const wait = Math.max(NETWORK_RESET_DELAY_MS, lastReset + NETWORK_RESET_GAP_MS - Date.now());
      resetTimer = setTimeout(() => {
        resetTimer = null;
        lastReset = Date.now();
        void restartNetworkService(session).then((done) => {
          if (done) chooser.networkEmptied();
          else console.warn('A client certificate stays in use until the app restarts.');
        });
      }, wait);
      resetTimer.unref?.();
    };
    // A rule that's gone mustn't go on working through what Chromium was given under it.
    policies.on('changed', (snapshot, previous) => {
      const rules = (policy: PolicySnapshot) => JSON.stringify(policy.AutoSelectCertificateForUrls.value);
      if (rules(snapshot) !== rules(previous) && chooser.holdsAnswers()) emptyNetwork();
    });
    this.clearAll = () => {
      if (chooser.forget()) emptyNetwork();
      if (signedIn.size > 0) {
        signedIn.clear();
        void session.clearAuthCache().catch(() => {});
      }
    };
    // At sign-out and account switch, next to the keystore's grants. Only narrows, so any page may.
    ctx.handle(CHANNEL.certificatesClearChoices, () => this.clear());
  }
}

export const clientAuth = new ClientAuth();

export const clientCertificatesFeature: Feature = {
  name: 'client-certificates',
  modes: ['standalone', 'instance'],
  setup: (ctx) => clientAuth.setup(ctx),
};
