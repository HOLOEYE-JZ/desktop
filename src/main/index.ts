/**
 * Bulwark's main process.
 *
 * ESM, with top-level await, because of one thing: the random port has to be
 * known before Chromium's network service starts, so it can go in
 * --host-resolver-rules, and Electron holds `ready` until this module finishes
 * loading. So: never await `app.whenReady()` at the top level here. It deadlocks.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, session as electronSession } from 'electron';
import { APP_HOST, APP_ORIGIN } from '../server/protocol';
import { CHANNEL, type Mode } from '../shared/bridge';
import { jmapServerAllowed, parseInstanceUrl } from '../shared/policy-schema';
import { APP_PARTITION, instancePartition, keepSignInsOnDisk, setupAppSession } from './app-session';
import { certificateFitsKey, fingerprintOf, generateCertificate } from './cert';
import { CorsInjector } from './cors';
import { setupFeatures, type FeatureContext } from './features';
import { registerImportScheme } from './features/import';
import { holdEarlyLaunches } from './features/os-launch';
import { setToastActivator } from './features/os-toasts';
import { holdUpdateInstall } from './features/updater';
import { addRestartTimers, askToRestart, policies } from './features/policies';
import { privacy } from './features/privacy';
import { clientAuth } from './features/client-certificates';
import { createChannels, registerBridge } from './ipc';
import { durableWrite, holdsAppLockRecords, KEY_CHECK_FOLDER, KEY_CHECK_SWITCH, KEY_INIT_SWITCH, keyInitArgs, keyOnDisk, keyOpens, KEYS_FOLDER, savedKey, saveKey, settleKeyBeforeChromium, waitForKeyOnDisk } from './key-on-disk';
import { addWipeStep, notePartition } from './features/local-wipe';
import { native } from './native';
import { LocalAdmin } from './local-admin';
import { requestGate } from './request-gate';
import { MenuController } from './menu';
import { attachWindowGuards, type GuardOptions } from './navigation';
import { LoopbackSignIn } from './oauth-loopback';
import { applyPermissionPolicy } from './permissions';
import { sandboxRefused } from './sandbox-check';
import { connectionMustChange, decideStart, restartKey, type StartDecision } from './policy-start';
import { deniedSwitches, withoutDeniedSwitches } from './switch-guard';
import { pluginFeatures, profilePaths, seedProfile, serverEnv } from './profile';
import { randomSecret, SecretStore, SecretStoreError } from './secrets';
import { startServerProcess, ServerStartError } from './server-process';
import { ServerRegistry } from './servers';
import { StateFile } from './state';
import { strings, unsentDetail } from './strings';
import { leaveLaunchFolder } from './system-exe';
import { ThemeController } from './theme';
import { WindowManager } from './windows';
import { ZoomController } from './zoom';
import { printWindow, saveWindowAsPdf } from './print';
import { navigateHistory } from './features/window-input';
import { appPathOfDeepLink, deepLinkWindowKey, LinkRateLimit, DEEP_LINK_SCHEME, type WindowLink } from './deep-link';
import { closeDictionaryDownloads } from './spellcheck';

// Set by build.mjs. Not app.isPackaged: Electron decides that by the exe's name, and
// anyone can rename it.
declare const __BULWARK_TEST_BUILD__: boolean;
declare const __BULWARK_TEST_PROFILE__: string;

// Before anything else, with or without a policy: see switch-guard.ts.
if (!__BULWARK_TEST_BUILD__) {
  const denied = deniedSwitches(process.argv);
  // An AppImage's AppRun adds --no-sandbox where the sandbox can't work. Restarting without it
  // would die in Chromium before any window. Left alone, the app says why and exits.
  const refusing = sandboxRefused({ platform: process.platform, appImage: process.env.APPIMAGE, noSandboxSwitch: process.argv.includes('--no-sandbox'), disableSandboxEnv: process.env.ELECTRON_DISABLE_SANDBOX });
  if (denied.length > 0 && !refusing) {
    console.warn(`Ignoring these switches: ${denied.join(', ')}`);
    for (const name of denied) app.commandLine.removeSwitch(name);
    app.relaunch({ args: withoutDeniedSwitches(process.argv).slice(1) });
    app.exit(0);
    await new Promise(() => {});
  }
  // The same as --ssl-key-log-file, for whoever sets the environment.
  delete process.env.SSLKEYLOGFILE;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, 'preload.cjs');
const WELCOME_PRELOAD = path.join(HERE, 'welcome-preload.cjs');
const WELCOME_PAGE = path.join(HERE, 'pages', 'welcome.html');
const SERVER_HOST = path.join(HERE, 'server-host.cjs');

const DEV = __BULWARK_TEST_BUILD__ && !app.isPackaged;
const MAX_SERVER_RESTARTS = 3;
const devTools = __BULWARK_TEST_BUILD__ && DEV && process.argv.includes('--dev');

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

// A test or a second development copy points this elsewhere.
const userDataArg = __BULWARK_TEST_BUILD__ && DEV ? argValue('bulwark-user-data') : undefined;
if (userDataArg) app.setPath('userData', userDataArg);
if (__BULWARK_TEST_PROFILE__) app.setPath('userData', __BULWARK_TEST_PROFILE__);

// Before anything can run a program: see system-exe.ts.
leaveLaunchFolder(app.getPath('userData'));

app.setName('Bulwark');
app.setAboutPanelOptions({ applicationName: 'Bulwark', applicationVersion: app.getVersion(), copyright: 'AGPL-3.0-only', website: 'https://bulwarkmail.org' });
if (process.platform === 'win32') {
  app.setAppUserModelId('org.bulwarkmail.desktop');
  setToastActivator();
}

/** A free port on 127.0.0.1, asked of the OS: Windows' excluded ranges made random picks hang. */
function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const keyInitOnly = process.argv.includes(KEY_INIT_SWITCH) || process.argv.includes(KEY_CHECK_SWITCH);
if (process.argv.includes(KEY_CHECK_SWITCH)) app.setPath('userData', path.join(app.getPath('userData'), KEY_CHECK_FOLDER));
const gotLock = !keyInitOnly && app.requestSingleInstanceLock();
// A clean quit is the one thing that makes Chromium write Local State at once.
if (keyInitOnly) void app.whenReady().then(() => app.quit());
else if (!gotLock) app.exit(0);

// Before `ready`: Chromium takes the auth lists from its command line at start.
if (gotLock) {
  if (process.platform === 'darwin') policies.useForcedCheck(native().policy.isForced);
  await policies.start({ argv: process.argv, isPackaged: app.isPackaged });
  policies.applySwitches(app.commandLine);
}

const stateFile = new StateFile(path.join(app.getPath('userData'), 'shell-state.json'));
policies.attachState(stateFile);
if (gotLock) privacy.start(stateFile);
if (gotLock) clientAuth.start(stateFile);

/** A production build has refused the switches that move the profile by now. */
function runKeyInit(run: string): void {
  spawnSync(process.execPath, keyInitArgs(process.argv, app.isPackaged, path.join(HERE, 'main.mjs'), run), { stdio: 'ignore', windowsHide: true, timeout: 20_000 });
}

// Holding the lock, so no other run of the app is making a key for this profile.
if (gotLock && process.platform === 'win32') {
  const userData = app.getPath('userData');
  settleKeyBeforeChromium(userData, {
    // A development switch for the test of what happens if that run gets nothing onto the disk.
    runKeyInit: () => {
      if (!(__BULWARK_TEST_BUILD__ && DEV && process.argv.includes('--bulwark-test-no-key-init'))) runKeyInit(KEY_INIT_SWITCH);
    },
    keyOpens: (key) => keyOpens(userData, key, () => runKeyInit(KEY_CHECK_SWITCH)),
    firstSecretsMayFollow: startDecision().kind !== 'instance',
  });
}

// After those runs, so another program has as little time as possible to take the port.
registerImportScheme();
const SERVER_PORT = await reservePort();
app.commandLine.appendSwitch('host-resolver-rules', `MAP ${APP_HOST}:443 127.0.0.1:${SERVER_PORT}`);

let windowManager: WindowManager | null = null;
let signIn: LoopbackSignIn | null = null;
let appStartUrl = '';
let mainWindowAllowed = false;
let menu: MenuController | null = null;
const zoom = new ZoomController(stateFile);
/** A bulwark:// link from before anyone was signed in: a pop-out borrows the main window's session. */
let pendingDeepLink: WindowLink | null = null;
let sessionReady = false;
const linkLimit = new LinkRateLimit();

function serverDirectory(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'server.asar');
  const chosen = __BULWARK_TEST_BUILD__ && DEV ? argValue('bulwark-server-dir') : undefined;
  return chosen ?? path.join(HERE, '..', 'webmail');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function errorPageUrl(title: string, body: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Bulwark</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh}main{max-width:32em;padding:2em}h1{font-size:1.3em;font-weight:600}@media(prefers-color-scheme:dark){body{background:#17181b;color:#f4f4f5}}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Says what's wrong, in the window, and changes nothing. */
async function showErrorPage(title: string, body: string): Promise<void> {
  const window = new BrowserWindow({
    width: 640,
    height: 420,
    autoHideMenuBar: true,
    title: 'Bulwark',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadURL(errorPageUrl(title, body));
}

let pinFailed = false;

/**
 * The pin failed: something between the app and its own server on this machine
 * replaced the certificate, usually a security program inspecting TLS. Chromium's
 * error page would explain nothing.
 */
function watchForReplacedCertificate(window: BrowserWindow): void {
  window.webContents.on('did-fail-load', (_event, _code, _description, url, isMainFrame) => {
    if (!pinFailed || !isMainFrame || !url.startsWith(APP_ORIGIN)) return;
    const text = strings();
    void window.loadURL(errorPageUrl(text.errorCertificateTitle, text.errorCertificateBody));
  });
}

function createWindowManager(mode: Mode, origin: string, session: Electron.Session, theme: ThemeController, startUrl: string): WindowManager {
  const guard: GuardOptions = { mode, origin, windows: () => windowManager!, forced: () => policies.snapshot.InstanceUrl.locked };
  windowManager = new WindowManager({
    state: stateFile,
    theme,
    session,
    origin,
    mode,
    preloadPath: PRELOAD,
    devTools,
    spare: !(DEV && process.argv.includes('--bulwark-no-spare')),
    spareIdleMs: DEV && argValue('bulwark-test-spare-idle') ? Number(argValue('bulwark-test-spare-idle')) : undefined,
    attachGuards: (window) => attachWindowGuards(window, guard),
  });
  zoom.attach(windowManager);
  menu!.attach(windowManager);
  addWipeStep(async () => windowManager?.forgetSession());
  windowManager.on('sessionReady', onSessionReady);
  // A development switch for the test of the tray's hook, until the tray exists.
  if (DEV && process.argv.includes('--bulwark-test-close-to-background')) windowManager.setCloseToBackground(() => true);
  appStartUrl = startUrl;
  windowManager.on('stayed', () => {
    switching = false;
    quitFlushed = false;
    windowManager?.cancelQuit();
  });
  return windowManager;
}

/** The TLS pair of this install. A lost one only means a new one: the pin is set anew each launch. */
async function tlsMaterial(secrets: SecretStore, dir: string): Promise<{ keyPem: string; certPem: string; fingerprint: string }> {
  const certFile = path.join(dir, 'app-cert.pem');
  let keyPem: string | null = null;
  try {
    keyPem = await secrets.get('tls-key');
  } catch (error) {
    if (error instanceof SecretStoreError && error.code === 'unavailable') throw error;
  }
  if (keyPem && existsSync(certFile)) {
    const certPem = readFileSync(certFile, 'utf8');
    if (certificateFitsKey(certPem, keyPem)) return { keyPem, certPem, fingerprint: fingerprintOf(certPem) };
  }
  const fresh = generateCertificate(APP_HOST);
  await secrets.set('tls-key', fresh.keyPem);
  durableWrite(certFile, fresh.certPem);
  return fresh;
}

/**
 * In instance mode a replaced key costs no error page: the page just asks for a sign-in, with
 * nothing to say why. So it's said here, once for each key lost. A standalone profile shows the
 * error page instead, since its secrets went too.
 */
function tellSignInsLost(lostKey: string): void {
  const told = createHash('sha256').update(lostKey).digest('base64url');
  if (stateFile.data.keyLossTold === told) return;
  stateFile.data.keyLossTold = told;
  stateFile.save();
  const text = strings();
  void dialog.showMessageBox({ type: 'info', title: 'Bulwark', message: text.signInsLostTitle, detail: text.signInsLostDetail }).catch(() => {});
}

/**
 * Nothing that encrypts runs before this: not the secrets, the server, the pages or their
 * cookies. The saved copy of the key goes before the first secret, and isn't changed while
 * secrets can't be read, as then it's the only copy that opens them.
 *
 * Instance mode has no secrets to protect, so it always goes on. All it risks is a sign-in.
 */
async function keySafeOnDisk(instance: boolean): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  const userData = app.getPath('userData');
  const saveIfReadable = async () => {
    // What the app lock holds can't be tried from here, so the copy that may open it stays.
    if (savedKey(userData) && holdsAppLockRecords(userData)) return;
    if (await new SecretStore(path.join(userData, KEYS_FOLDER)).allReadable()) saveKey(userData);
  };
  try {
    if (!(await waitForKeyOnDisk(userData))) return instance;
    const onDisk = keyOnDisk(userData);
    const saved = savedKey(userData);
    if (instance && saved && saved !== onDisk) tellSignInsLost(saved);
    if (saved === onDisk && stateFile.data.keyLossTold) {
      stateFile.data.keyLossTold = undefined;
      stateFile.save();
    }
    if (instance) {
      // Chromium's new key reaches the disk within its ten seconds, if this start was given one.
      const deadline = Date.now() + 30_000;
      const watch = setInterval(() => {
        const now = keyOnDisk(userData);
        if (now && onDisk && now !== onDisk) {
          tellSignInsLost(onDisk);
          void saveIfReadable().catch((error) => console.error(error));
        }
        if ((now && now !== onDisk) || Date.now() >= deadline) clearInterval(watch);
      }, 1000);
      watch.unref();
    }
    if (saved !== onDisk) await saveIfReadable();
    return true;
  } catch (error) {
    console.error(error);
    return instance;
  }
}

async function bootStandalone(theme: ThemeController): Promise<void> {
  const userData = app.getPath('userData');
  const secretsDir = path.join(userData, KEYS_FOLDER);
  mkdirSync(secretsDir, { recursive: true });
  const secrets = new SecretStore(secretsDir);
  const profile = profilePaths(userData);

  let sessionSecret: string;
  let adminPassword: string;
  let tlsPair: Awaited<ReturnType<typeof tlsMaterial>>;
  try {
    // getOrCreate never replaces one it can't read: that would wipe every account.
    // The first run makes the secret before it seeds the profile, so a seeded profile
    // without one lost it. A new one would sign out every account just the same.
    const seeded = existsSync(path.join(profile.adminConfig, 'config.json'));
    sessionSecret = await secrets.getOrCreate('session-secret', () => randomSecret(48), { mustExist: seeded });
    // A new credential only takes if the stored hash goes with the old one.
    const admin = await secrets.getOrReplace('admin-credential', () => randomSecret(32), () => rmSync(path.join(profile.adminConfig, 'admin.json'), { force: true }));
    adminPassword = admin.value;
    tlsPair = await tlsMaterial(secrets, secretsDir);
  } catch (error) {
    if (error instanceof SecretStoreError) {
      const text = strings();
      if (error.code === 'missing') await showErrorPage(text.errorSecretMissingTitle, text.errorSecretMissingBody(secretsDir));
      else await showErrorPage(text.errorSecretsTitle, text.errorSecretsBody);
      return;
    }
    throw error;
  }

  seedProfile(profile, pluginFeatures(policies.snapshot.PluginsMode.value));

  const launchSecret = randomBytes(32).toString('base64url');
  const mainSecret = randomBytes(32).toString('base64url');
  // A development switch for the test of a replaced certificate.
  const pin = __BULWARK_TEST_BUILD__ && DEV && process.argv.includes('--bulwark-test-wrong-pin') ? 'sha256/wrong' : tlsPair.fingerprint;
  const session = setupAppSession(pin, launchSecret, () => {
    pinFailed = true;
  });
  keepSignInsOnDisk(session);
  notePartition(stateFile, APP_PARTITION);
  applyPermissionPolicy(session, APP_ORIGIN);

  const cors = new CorsInjector(session, APP_ORIGIN);
  const spawnServer = (append: boolean) =>
    startServerProcess({
      hostScript: SERVER_HOST,
      serverDir: serverDirectory(),
      env: {
        ...serverEnv(profile, process.env, process.platform),
        // Only a test build: the local stand-in for the collector needs it.
        ...(__BULWARK_TEST_BUILD__ && process.env.BULWARK_TELEMETRY_ALLOW_PRIVATE === '1' ? { BULWARK_TELEMETRY_ALLOW_PRIVATE: '1' } : {}),
      },
      logDir: path.join(userData, 'logs'),
      append,
      init: {
        type: 'init',
        serverDir: serverDirectory(),
        port: SERVER_PORT,
        parentPid: process.pid,
        launchSecret,
        mainSecret,
        tls: { key: tlsPair.keyPem, cert: tlsPair.certPem },
        secretEnv: { SESSION_SECRET: sessionSecret, ADMIN_PASSWORD: adminPassword },
        trustedOrigins: stateFile.data.approvedServers.map((s) => s.origin).filter((origin) => policies.serverAllowed(origin)),
        policy: policies.serverPolicy(),
        privacy: privacy.serverView('standalone'),
      },
    });
  let server = spawnServer(false);
  const servers = new ServerRegistry({ state: stateFile, cors, sendTrusted: (origins) => server.sendTrusted(origins), isAllowedByPolicy: policies.serverAllowed });
  requestGate(session).add((url) => servers.refusesRequest(url));
  // config-manager notices the changed file by itself, within seconds.
  policies.on('changed', (snapshot) => {
    server.sendPolicy(policies.serverPolicy());
    servers.applyPolicy();
    seedProfile(profile, pluginFeatures(snapshot.PluginsMode.value));
  });
  privacy.on('changed', () => server.sendPrivacy(privacy.serverView('standalone')));
  const localAdmin = new LocalAdmin({ port: SERVER_PORT, certPem: tlsPair.certPem, launchSecret, mainSecret, password: adminPassword });

  const windows = createWindowManager('standalone', APP_ORIGIN, session, theme, `${APP_ORIGIN}/`);
  signIn = new LoopbackSignIn(() => windows.focus());
  const ctx: FeatureContext = {
    mode: 'standalone',
    origin: APP_ORIGIN,
    session,
    state: stateFile,
    theme,
    windows,
    menu: menu!,
    zoom,
    servers,
    localAdmin,
    showMain,
    openLink: openDeepLink,
    ...createChannels(APP_ORIGIN),
  };
  registerBridge(ctx, { origin: APP_ORIGIN, signIn, pluginPolicy: policies.pluginPolicy });
  setupFeatures(ctx);

  try {
    const ready = await server.ready;
    if (ready.caError) console.warn('System certificates are not in use:', ready.caError);
  } catch (error) {
    // Only a port someone took between the probe and now can be fixed by trying again.
    if (error instanceof ServerStartError && error.code === 'EADDRINUSE' && !process.argv.includes('--port-retry')) {
      app.relaunch({ args: [...process.argv.slice(1), '--port-retry'] });
      app.exit(0);
      return;
    }
    console.error(error);
    const text = strings();
    await showErrorPage(text.errorServerTitle, text.errorServerBody);
    return;
  }

  privacy.useServerSink((error) => server.sendMainError(error));

  // A crash shouldn't end the app: same port, same secret, so open windows carry on.
  let restarts = 0;
  const watch = () => {
    const current = server;
    current.process.once('exit', () => {
      if (current.stopped() || restarts >= MAX_SERVER_RESTARTS) return;
      restarts += 1;
      server = spawnServer(true);
      watch();
      server.ready.catch((error) => console.error(error));
    });
  };
  watch();

  windows.on('created', ({ window }) => watchForReplacedCertificate(window));
  mainWindowAllowed = true;
  windows.open({ type: 'main', url: `${APP_ORIGIN}/` });
}

async function bootInstance(instanceUrl: string, theme: ThemeController): Promise<void> {
  const origin = new URL(instanceUrl).origin;
  const partition = instancePartition(origin);
  const session = electronSession.fromPartition(partition);
  keepSignInsOnDisk(session);
  notePartition(stateFile, partition);
  closeDictionaryDownloads(session);
  applyPermissionPolicy(session, origin);
  const windows = createWindowManager('instance', origin, session, theme, instanceUrl);
  const ctx: FeatureContext = { mode: 'instance', origin, session, state: stateFile, theme, windows, menu: menu!, zoom, showMain, openLink: openDeepLink, ...createChannels(origin) };
  registerBridge(ctx, { origin });
  setupFeatures(ctx);
  mainWindowAllowed = true;
  windows.open({ type: 'main', url: instanceUrl });
}

/** The first run asks which of the two the user wants. A forced InstanceUrl skips this. */
function showWelcome(theme: ThemeController, decision: Extract<StartDecision, { kind: 'welcome' }>): void {
  const colours = theme.colours();
  const questions = privacy.firstRunQuestions();
  const window = new BrowserWindow({
    width: 620,
    height: 520,
    resizable: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: colours.background,
    title: 'Bulwark',
    webPreferences: {
      preload: WELCOME_PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools,
      // Encoded: quotes don't survive Chromium's command line on Windows.
      additionalArguments: [`--bulwark-welcome=${encodeURIComponent(JSON.stringify({ allowStandalone: decision.allowStandalone, instanceUrl: decision.instanceUrl, urlLocked: decision.urlLocked, askTelemetry: questions.telemetry, askCrashReports: questions.crashReports }))}`],
    },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  ipcMain.handle(CHANNEL.welcomeChoose, async (event, choice: { mode?: unknown; url?: unknown }) => {
    if (event.sender !== window.webContents || !event.senderFrame?.url.startsWith('data:')) throw new Error('Not allowed');
    let instanceUrl: string | undefined;
    if (choice?.mode === 'standalone') {
      if (!decision.allowStandalone) return { ok: false, error: 'invalid_choice' };
    } else if (choice?.mode === 'instance') {
      const parsed = parseInstanceUrl(decision.urlLocked ? decision.instanceUrl : choice.url, policies.snapshot.AllowInsecureInstance.value);
      if (!parsed.ok) return { ok: false, error: 'invalid_url' };
      // A forced one needs no listing, and only a forced one is locked here.
      if (!decision.urlLocked && !jmapServerAllowed(policies.snapshot.AllowedJmapServers.value, parsed.value)) return { ok: false, error: 'policy' };
      instanceUrl = parsed.value;
    } else {
      return { ok: false, error: 'invalid_choice' };
    }
    // Kept until the last answer: closing the window here leaves the first run still to do.
    const mode = choice.mode as Mode;
    const finish = async () => {
      stateFile.data.mode = mode;
      if (instanceUrl) stateFile.data.instanceUrl = instanceUrl;
      stateFile.data.askConnection = undefined;
      stateFile.save();
      ipcMain.removeHandler(CHANNEL.welcomeChoose);
      ipcMain.removeHandler(CHANNEL.welcomePrivacy);
      await boot(theme);
      window.destroy();
      return { ok: true };
    };
    if (!questions.telemetry && !questions.crashReports) return finish();
    ipcMain.removeHandler(CHANNEL.welcomePrivacy);
    ipcMain.handle(CHANNEL.welcomePrivacy, async (answerEvent, answers: { telemetry?: unknown; crashReports?: unknown }) => {
      if (answerEvent.sender !== window.webContents || !answerEvent.senderFrame?.url.startsWith('data:')) throw new Error('Not allowed');
      privacy.answerFirstRun(answers ?? {});
      return finish();
    });
    return { ok: true, next: 'privacy' };
  });
  // A data: page: with the grantFileProtocolExtraPrivileges fuse off, a file: one doesn't run.
  void window.loadURL(`data:text/html;charset=utf-8;base64,${readFileSync(WELCOME_PAGE).toString('base64')}`);
}

function startDecision(): StartDecision {
  return decideStart(policies.snapshot, policies.problem, {
    mode: stateFile.data.mode,
    instanceUrl: stateFile.data.instanceUrl,
    askConnection: stateFile.data.askConnection,
    devInstance: __BULWARK_TEST_BUILD__ && DEV ? argValue('instance') : null,
    devStandalone: __BULWARK_TEST_BUILD__ && DEV && process.argv.includes('--standalone'),
  });
}

/** The policy fails closed: this is all the user gets, with no way around it. */
async function showPolicyError(decision: Extract<StartDecision, { kind: 'policy-error' }>): Promise<void> {
  const text = strings();
  const reason = text.policyReasons[decision.reason] ?? text.policyReasons.other;
  await showErrorPage(text.policyErrorTitle, text.policyErrorBody(decision.policy, reason, decision.raw));
}

let bootedKey = '';
let bootedDecision: StartDecision | null = null;
let askedKey = '';

async function boot(theme: ThemeController): Promise<void> {
  // First, before any window has a database open, and whatever comes next.
  await policies.settleLocalData();
  const decision = startDecision();
  bootedKey = restartKey(decision, policies.snapshot);
  bootedDecision = decision;
  menu?.allowSwitchingMode(decision.canSwitch ? switchMode : undefined);
  if (decision.kind === 'policy-error') await showPolicyError(decision);
  else if (decision.kind === 'welcome') showWelcome(theme, decision);
  else if (!(await keySafeOnDisk(decision.kind === 'instance'))) await showErrorPage(strings().errorKeyNotSavedTitle, strings().errorKeyNotSavedBody);
  else if (decision.kind === 'instance') await bootInstance(decision.url, theme);
  else await bootStandalone(theme);
}

function restartNow(): void {
  // Installing now would kill the app relaunched here. It's on disk for the next quit.
  holdUpdateInstall();
  app.relaunch();
  // Quitting asks each page to save first (before-quit).
  app.quit();
}

/**
 * A change that needs a restart asks for one, once for each outcome. Where a forced
 * connection is what changed, "Later" isn't for good: it asks again, and after the
 * deadline it restarts by itself.
 */
function watchPolicyForRestart(booted: StartDecision): void {
  // A wipe left the windows blank: they had nothing to come back to anyway.
  policies.on('wiped', () => {
    const main = windowManager?.mainWindow();
    for (const window of BrowserWindow.getAllWindows()) if (window !== main) window.destroy();
    if (main) void main.loadURL(appStartUrl).catch(() => {});
  });
  let cancelTimers = () => {};
  let asking = false;
  const ask = (key: string) => {
    // One question at a time, or they'd pile up on an unattended machine.
    if (asking) return;
    asking = true;
    const text = strings();
    void askToRestart(text.policyChangedTitle, text.policyChangedDetail, text.policyRestart, text.policyLater).then((restart) => {
      asking = false;
      if (restart && askedKey === key) restartNow();
    });
  };
  policies.on('changed', () => {
    const decision = startDecision();
    const key = restartKey(decision, policies.snapshot);
    if (key === askedKey) return;
    cancelTimers();
    cancelTimers = () => {};
    if (key === bootedKey) {
      askedKey = '';
      return;
    }
    askedKey = key;
    ask(key);
    if (connectionMustChange(booted, decision)) {
      cancelTimers = addRestartTimers(() => ask(key), () => {
        if (askedKey === key) restartNow();
      });
    }
  });
}

// "Show me the app". With only a pop-out left open, that's a new main window. A second launch
// comes here through features/os-launch.ts, which knows the ones that show nothing.
function showMain(): void {
  // Until the server is up, the boot opens it: a window now would load an error page.
  if (!windowManager || !mainWindowAllowed) return;
  if (windowManager.mainWindow()) windowManager.focus();
  else windowManager.open({ type: 'main', url: appStartUrl });
}

// Quitting closes the windows, and each may ask first. Nothing is forgotten until all
// of them have gone, so choosing Stay keeps the mode.
let switching = false;

function switchMode(): void {
  switching = true;
  app.quit();
}

function finishSwitch(): void {
  // Installing now would kill the app relaunched below. It's on disk for the next quit.
  holdUpdateInstall();
  stateFile.data.mode = undefined;
  stateFile.data.instanceUrl = undefined;
  stateFile.data.askConnection = true;
  stateFile.save();
  app.relaunch();
}

let quitFlushed = false;

function openDeepLink(link: WindowLink): void {
  const windows = windowManager;
  if (!windows || !sessionReady) {
    pendingDeepLink = link;
    if (windows?.mainWindow() && linkLimit.allow(Date.now())) windows.focus();
    return;
  }
  if (!linkLimit.allow(Date.now())) return;
  const target = `${windows.originUrl()}${appPathOfDeepLink(link)}`;
  if (link.kind === 'message') {
    windows.open({ type: 'message', url: target, key: deepLinkWindowKey(link.emailId) });
    return;
  }
  const main = windows.mainWindow();
  if (!main) {
    windows.open({ type: 'main', url: target });
    return;
  }
  // Without a load: there may be a draft on that page. The webmail's router takes it.
  windows.focusWindow(main);
  main.webContents.send(CHANNEL.menuCommand, `link.folder:${link.folder}`);
}

/** A window can lend its session now. Links and windows from last time were waiting for that. */
function onSessionReady(): void {
  sessionReady = true;
  windowManager?.restoreSession();
  flushDeepLink();
}

function flushDeepLink(): void {
  if (!pendingDeepLink) return;
  const link = pendingDeepLink;
  pendingDeepLink = null;
  openDeepLink(link);
}

function buildMenu(): MenuController {
  return new MenuController({
    devTools,
    newWindow: () => {
      // Unique across runs: one restored from last time may hold a low number.
      windowManager?.open({ type: 'main', url: appStartUrl, key: `main:${randomBytes(6).toString('hex')}` });
    },
    openSettings: () => {
      const windows = windowManager;
      if (windows) windows.open({ type: 'settings', url: `${windows.originUrl()}/settings`, key: 'settings' });
    },
    zoom: (step) => zoom.step(step),
    print: (window) => printWindow(window, menu?.commandState(window)),
    saveAsPdf: (window) => void saveWindowAsPdf(window, menu?.commandState(window)),
    back: (window, direction) => navigateHistory(window, direction),
  });
}

if (gotLock) {
  // Nothing may attach a webview or open a window behind the window manager's back.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  // Registered here: macOS sends a launch's file or link before `ready`.
  holdEarlyLaunches();
  // Unpackaged, the shell isn't what the OS should start for these.
  if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);

  app.on('window-all-closed', () => {
    // Closing to the tray hides the main window, so this means there's nothing left.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (windowManager && windowManager.noneVisible()) showMain();
  });

  // Pages save first, within limits, and then the quit goes on. A preventDefault in a
  // window's own close would call the quit off, so it's done here.
  app.on('before-quit', (event) => {
    signIn?.closeAll();
    stateFile.save();
    windowManager?.beginQuit();
    if (quitFlushed || !windowManager) return;
    event.preventDefault();
    quitFlushed = true;
    const windows = windowManager;
    void windows.flushAll().then((summary) => {
      if (summary.failed > 0 || summary.unsent > 0) {
        const text = strings();
        const parent = windows.focusedManaged()?.window ?? windows.mainWindow();
        const options: Electron.MessageBoxSyncOptions = {
          type: 'warning',
          title: 'Bulwark',
          message: summary.failed > 0 ? text.unsavedTitle : text.unsentTitle,
          detail: summary.failed > 0 ? text.unsavedDetail : unsentDetail(text, summary.unsent),
          buttons: [summary.failed > 0 ? text.closeAnyway : text.closeNow, text.stay],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        };
        const choice = parent ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options);
        if (choice !== 0) {
          quitFlushed = false;
          switching = false;
          windows.cancelQuit();
          return;
        }
      }
      windows.beginQuit();
      app.quit();
    });
  });

  app.on('will-quit', () => {
    if (switching) finishSwitch();
  });

  app.whenReady().then(async () => {
    if (sandboxRefused({ platform: process.platform, appImage: process.env.APPIMAGE, noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'), disableSandboxEnv: process.env.ELECTRON_DISABLE_SANDBOX })) {
      const text = strings();
      dialog.showMessageBoxSync({ type: 'error', title: 'Bulwark', message: text.sandboxTitle, detail: text.sandboxDetail, buttons: [text.ok], noLink: true });
      app.exit(1);
      return;
    }
    menu = buildMenu();
    menu.rebuild();
    const theme = new ThemeController(stateFile);
    await boot(theme);
    policies.watch();
    watchPolicyForRestart(bootedDecision!);
  }).catch((error) => {
    console.error(error);
    dialog.showErrorBox('Bulwark', String(error instanceof Error ? error.message : error));
    app.exit(1);
  });
}

