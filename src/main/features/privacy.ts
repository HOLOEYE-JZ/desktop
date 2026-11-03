/**
 * Telemetry and crash reports: each with its own consent, both off until the user says yes,
 * and either can be forced off by policy (`TelemetryAllowed`, `CrashReportsAllowed`).
 *
 * The embedded server's lib/telemetry sends standalone's heartbeat. With no server (instance
 * mode) main sends its own small one under its own id, so the instance's numbers aren't
 * counted twice. Crash files stay on this computer and only leave by "Send crash report",
 * which names where they go in a native dialog.
 *
 * A same-origin plugin can reach the bridge (see ipc.ts), so nothing here may do harm on a
 * call alone: saying yes and sending both ask natively. Taking back needs no asking.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { hostname, homedir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, crashReporter, dialog, net, type BrowserWindow, type MessageBoxOptions } from 'electron';
import { CHANNEL, type CrashFileInfo, type CrashSendResult, type Mode, type PrivacyState } from '../../shared/bridge';
import {
  DESKTOP_RETRY_MS,
  buildDesktopErrorBatch,
  buildDesktopPing,
  consentInForce,
  desktopBuildTag,
  desktopChannel,
  desktopOsFamily,
  forcedOffByPolicy,
  heartbeatDelayMs,
  type DesktopServerPrivacy,
} from '../../shared/desktop-telemetry';
import { normalizeStack, type MainErrorMessage } from '../../server/protocol';
import { CRASH_LIMITS, buildCrashUpload, listCrashFiles, removeAllCrashFiles, scrubMinidump, sweepCrashFiles, validUploadUrl } from '../crash-files';
import { MainErrorCounter } from '../main-errors';
import type { StateFile } from '../state';
import { strings } from '../strings';
import { addWipeStep } from './local-wipe';
import { policies } from './policies';
import type { Feature, FeatureContext } from '.';

declare const __BULWARK_TEST_BUILD__: boolean;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Fixed, so it's no setting a plugin could aim. Standalone's is lib/telemetry/types.ts's, the same. */
const HEARTBEAT_ENDPOINT = 'https://telemetry.bulwarkmail.org/v1/heartbeat';
const ERRORS_TICK_MS = 60_000;
const SEND_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_QUEUED_ERRORS = 20;
/** Crashpad needs a moment to finish writing after a process goes. */
const SWEEP_AFTER_CRASH_MS = 5_000;

function testArg(name: string): string | undefined {
  if (!__BULWARK_TEST_BUILD__) return undefined;
  const prefix = `--bulwark-test-${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

interface PrivacyEvents {
  changed: [];
}

export class PrivacyManager extends EventEmitter<PrivacyEvents> {
  private state: StateFile | null = null;
  private mode: Mode | null = null;
  private ctx: FeatureContext | null = null;
  private crashDir = '';
  private reporterStarted = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private errorsTimer: NodeJS.Timeout | null = null;
  private serverSink: ((error: MainErrorMessage) => void) | null = null;
  private queued: MainErrorMessage[] = [];
  private counter: MainErrorCounter | null = null;

  /** Before `ready`, as early as it can be: a crash handler only covers what starts after it. */
  start(state: StateFile): void {
    this.state = state;
    this.crashDir = path.join(app.getPath('userData'), 'crash-reports');
    app.setPath('crashDumps', this.crashDir);
    this.counter = new MainErrorCounter(app.getVersion());
    if (this.crashReportsOn) this.startCrashReporter();
    else removeAllCrashFiles(this.crashDir);
    sweepCrashFiles(this.crashDir);
    process.on('uncaughtExceptionMonitor', (error) => this.noteMainError(error, 'uncaughtexception'));
    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled rejection in the main process:', reason);
      this.noteMainError(reason, 'unhandledrejection');
    });
  }

  private get stored() {
    return this.state?.data.privacy ?? {};
  }

  private store(change: Partial<NonNullable<StateFile['data']['privacy']>>): void {
    this.state!.data.privacy = { ...this.stored, ...change };
    this.state!.save();
  }

  get telemetryOn(): boolean {
    return consentInForce(this.stored.telemetry, policies.snapshot.TelemetryAllowed);
  }

  get crashReportsOn(): boolean {
    return consentInForce(this.stored.crashReports, policies.snapshot.CrashReportsAllowed);
  }

  view(): PrivacyState {
    return {
      telemetry: { on: this.telemetryOn, forcedOff: forcedOffByPolicy(policies.snapshot.TelemetryAllowed) },
      crashReports: {
        on: this.crashReportsOn,
        forcedOff: forcedOffByPolicy(policies.snapshot.CrashReportsAllowed),
        uploadUrl: this.stored.crashUploadUrl ?? '',
      },
    };
  }

  /** What the first run still has to ask. Nothing a policy forced off, and only ever once. */
  firstRunQuestions(): { telemetry: boolean; crashReports: boolean } {
    if (this.stored.asked) return { telemetry: false, crashReports: false };
    return {
      telemetry: !forcedOffByPolicy(policies.snapshot.TelemetryAllowed),
      crashReports: !forcedOffByPolicy(policies.snapshot.CrashReportsAllowed),
    };
  }

  /** The first-run page's own answer: it's the user's click, on a page no plugin can reach. */
  answerFirstRun(answers: { telemetry?: unknown; crashReports?: unknown }): void {
    this.store({ asked: true, telemetry: answers.telemetry === true, crashReports: answers.crashReports === true });
    if (this.crashReportsOn) this.startCrashReporter();
  }

  private channel() {
    return desktopChannel(policies.snapshot.UpdateChannel, (this.state?.data as { updateChannel?: unknown } | undefined)?.updateChannel, app.getVersion());
  }

  serverView(mode: Mode): DesktopServerPrivacy {
    return {
      telemetry: this.telemetryOn,
      crashReports: this.crashReportsOn,
      appVersion: app.getVersion(),
      build: desktopBuildTag(mode, this.channel()),
    };
  }

  private startCrashReporter(): void {
    if (this.reporterStarted) return;
    this.reporterStarted = true;
    // No URL and no upload: only "Send crash report" ever sends one.
    crashReporter.start({ uploadToServer: false, ignoreSystemCrashHandler: true, productName: 'Bulwark', compress: false });
  }

  /** The shell's id, never an instance's. Random, made once. */
  private ownId(): string {
    const id = this.stored.id ?? randomUUID();
    if (!this.stored.id) this.store({ id });
    return id;
  }

  private endpoint(): string {
    return testArg('telemetry-endpoint') ?? HEARTBEAT_ENDPOINT;
  }

  private async post(url: string, body: unknown): Promise<boolean> {
    // No redirects: nothing checked where a 3xx would lead. No cookies, no proxy surprises.
    const response = await net.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return response.ok;
  }

  private planPing(delay?: number): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
    if (this.mode !== 'instance' || !this.telemetryOn) return;
    const testDelay = Number(testArg('ping-delay')) || undefined;
    const wait = delay ?? testDelay ?? heartbeatDelayMs(this.stored.lastPingAt, Date.now());
    this.pingTimer = setTimeout(() => void this.sendPing(), wait);
    this.pingTimer.unref?.();
  }

  private async sendPing(): Promise<void> {
    this.pingTimer = null;
    if (this.mode !== 'instance' || !this.telemetryOn) return;
    let sent = false;
    try {
      sent = await this.post(this.endpoint(), buildDesktopPing({
        instanceId: this.ownId(),
        appVersion: app.getVersion(),
        nodeVersion: process.versions.node,
        osFamily: desktopOsFamily(process.platform),
        mode: 'instance',
        channel: this.channel(),
        now: Date.now(),
      }));
    } catch (error) {
      console.warn('The usage info was not sent:', error instanceof Error ? error.message : error);
    }
    if (sent) this.store({ lastPingAt: Date.now() });
    this.planPing(sent ? undefined : Number(testArg('ping-retry')) || DESKTOP_RETRY_MS);
  }

  private noteMainError(error: unknown, mechanism: MainErrorMessage['mechanism']): void {
    if (!this.crashReportsOn) return;
    if (this.mode === 'instance') {
      this.counter?.note(error);
      return;
    }
    const e = (error && typeof error === 'object' ? error : { message: String(error) }) as { name?: unknown; message?: unknown; stack?: unknown };
    // The app's folder is what a stack has of the disk: it becomes `/desktop/`.
    const message: MainErrorMessage = {
      type: 'main-error',
      name: e.name,
      message: e.message,
      stack: typeof e.stack === 'string' ? normalizeStack(e.stack, HERE) : undefined,
      mechanism,
    };
    if (this.serverSink) this.toServer(this.serverSink, message);
    else if (this.queued.length < MAX_QUEUED_ERRORS) this.queued.push(message);
  }

  /** The embedded server is ready for main's errors, and whatever waited goes now. */
  useServerSink(sink: (error: MainErrorMessage) => void): void {
    this.serverSink = sink;
    for (const message of this.queued.splice(0)) if (this.crashReportsOn) this.toServer(sink, message);
  }

  /** A server that just went down isn't a reason for another error. */
  private toServer(sink: (error: MainErrorMessage) => void, message: MainErrorMessage): void {
    try {
      sink(message);
    } catch {
      // Dropped: it restarts by itself.
    }
  }

  private async sendErrorBatch(): Promise<void> {
    if (!this.crashReportsOn || !this.counter) return;
    const errors = this.counter.unsent();
    if (errors.length === 0) return;
    const url = new URL('errors', this.endpoint()).toString();
    try {
      if (await this.post(url, buildDesktopErrorBatch(this.ownId(), Date.now(), errors))) this.counter.markSent(errors);
    } catch {
      // The next tick tries again.
    }
  }

  private async confirm(window: BrowserWindow | null, box: Pick<MessageBoxOptions, 'message' | 'detail'>, yes: string): Promise<boolean> {
    const text = strings();
    const options: MessageBoxOptions = { type: 'question', title: 'Bulwark', buttons: [yes, text.cancel], defaultId: 1, cancelId: 1, noLink: true, ...box };
    const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    return response === 0;
  }

  private announce(): void {
    this.planPing();
    this.ctx?.windows.broadcast(CHANNEL.privacyChanged, this.view());
    this.emit('changed');
  }

  async setTelemetry(on: unknown, window: BrowserWindow | null): Promise<PrivacyState> {
    if (on === true) {
      const text = strings();
      if (!this.telemetryOn && !forcedOffByPolicy(policies.snapshot.TelemetryAllowed)
        && await this.confirm(window, { message: text.telemetryAskTitle, detail: text.telemetryAskDetail }, text.telemetryAskYes)) {
        this.store({ asked: true, telemetry: true });
        this.announce();
      }
    } else if (on === false) {
      this.store({ asked: true, telemetry: false });
      this.announce();
    }
    return this.view();
  }

  async setCrashReports(on: unknown, window: BrowserWindow | null): Promise<PrivacyState> {
    if (on === true) {
      const text = strings();
      if (!this.crashReportsOn && !forcedOffByPolicy(policies.snapshot.CrashReportsAllowed)
        && await this.confirm(window, { message: text.crashAskTitle, detail: text.crashAskDetail }, text.crashAskYes)) {
        this.store({ asked: true, crashReports: true });
        this.startCrashReporter();
        this.announce();
      }
    } else if (on === false) {
      this.store({ asked: true, crashReports: false });
      this.turnedOffCrashReports();
      this.announce();
    }
    return this.view();
  }

  /** Crashpad can't be stopped once it runs, so what it writes from here on goes on sight. */
  private turnedOffCrashReports(): void {
    removeAllCrashFiles(this.crashDir);
    this.counter?.clear();
    this.queued = [];
  }

  setCrashUploadUrl(value: unknown): { ok: boolean; state: PrivacyState } {
    const text = typeof value === 'string' ? value.trim() : null;
    if (text === '') {
      this.store({ crashUploadUrl: '' });
    } else {
      const url = validUploadUrl(text);
      if (!url) return { ok: false, state: this.view() };
      this.store({ crashUploadUrl: url });
    }
    this.announce();
    return { ok: true, state: this.view() };
  }

  listCrashes(): CrashFileInfo[] {
    if (this.crashDir) sweepCrashFiles(this.crashDir);
    return listCrashFiles(this.crashDir).map(({ id, createdAt, bytes }) => ({ id, createdAt, bytes }));
  }

  deleteCrashes(): void {
    removeAllCrashFiles(this.crashDir);
  }

  /** The one way a crash file leaves. Never called but by the user's own action. */
  async sendCrash(id: unknown, window: BrowserWindow | null): Promise<CrashSendResult> {
    if (!this.crashReportsOn) return { ok: false, reason: 'no-consent' };
    const url = validUploadUrl(this.stored.crashUploadUrl);
    if (!url) return { ok: false, reason: 'no-url' };
    const crash = listCrashFiles(this.crashDir).find((candidate) => candidate.id === id);
    if (!crash || crash.bytes > CRASH_LIMITS.bytes) return { ok: false, reason: 'not-found' };
    const text = strings();
    const host = new URL(url).host;
    if (!await this.confirm(window, { message: text.crashSendTitle(host), detail: text.crashSendDetail }, text.crashSendYes)) {
      return { ok: false, reason: 'cancelled' };
    }
    try {
      const user = (() => {
        try {
          return userInfo().username;
        } catch {
          return '';
        }
      })();
      const dump = scrubMinidump(readFileSync(crash.file), { home: homedir(), username: user, hostname: hostname() });
      const upload = buildCrashUpload(
        dump,
        { prod: 'Bulwark', ver: app.getVersion(), platform: process.platform, build: desktopBuildTag(this.mode ?? 'standalone', this.channel()) },
        `bulwark-${randomBytes(16).toString('hex')}`,
      );
      const response = await net.fetch(url, {
        method: 'POST',
        headers: { 'content-type': upload.contentType },
        body: new Uint8Array(upload.body),
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      return response.ok ? { ok: true } : { ok: false, reason: 'failed' };
    } catch (error) {
      console.warn('The crash file was not sent:', error instanceof Error ? error.message : error);
      return { ok: false, reason: 'failed' };
    }
  }

  setup(ctx: FeatureContext): void {
    this.ctx = ctx;
    this.mode = ctx.mode;
    ctx.handle(CHANNEL.privacyGet, () => this.view());
    ctx.handle(CHANNEL.privacySetTelemetry, (_event, window, on) => this.setTelemetry(on, window));
    ctx.handle(CHANNEL.privacySetCrashReports, (_event, window, on) => this.setCrashReports(on, window));
    ctx.handle(CHANNEL.privacySetCrashUploadUrl, (_event, _window, url) => this.setCrashUploadUrl(url));
    ctx.handle(CHANNEL.privacyListCrashes, () => this.listCrashes());
    ctx.handle(CHANNEL.privacySendCrash, (_event, window, id) => this.sendCrash(id, window));
    ctx.handle(CHANNEL.privacyDeleteCrashes, () => this.deleteCrashes());

    policies.on('changed', (snapshot, previous) => {
      if (forcedOffByPolicy(snapshot.CrashReportsAllowed) && !forcedOffByPolicy(previous.CrashReportsAllowed)) this.turnedOffCrashReports();
      // Lifted over a stored yes: nothing the user has to do again.
      if (this.crashReportsOn) this.startCrashReporter();
      this.announce();
    });

    // What a crash left behind is held to the limits, or removed if nobody agreed to keep it.
    const afterCrash = () => {
      const timer = setTimeout(() => {
        if (this.crashReportsOn) sweepCrashFiles(this.crashDir);
        else removeAllCrashFiles(this.crashDir);
      }, Number(testArg('crash-sweep-delay')) || SWEEP_AFTER_CRASH_MS);
      timer.unref?.();
    };
    app.on('child-process-gone', afterCrash);
    app.on('render-process-gone', afterCrash);

    // Crash files can hold mail: a wipe takes them too.
    addWipeStep(async () => {
      removeAllCrashFiles(this.crashDir);
    });

    this.planPing();
    if (ctx.mode === 'instance') {
      this.errorsTimer = setInterval(() => void this.sendErrorBatch(), Number(testArg('errors-tick')) || ERRORS_TICK_MS);
      this.errorsTimer.unref?.();
    }
  }
}

export const privacy = new PrivacyManager();

export const privacyFeature: Feature = {
  name: 'privacy',
  modes: ['standalone', 'instance'],
  setup: (ctx) => privacy.setup(ctx),
};
