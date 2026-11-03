/**
 * Bulwark's main process.
 *
 * ESM, with top-level await, because of one thing: the random port has to be
 * known before Chromium's network service starts, so it can go in
 * --host-resolver-rules, and Electron holds `ready` until this module finishes
 * loading. So: never await `app.whenReady()` at the top level here. It deadlocks.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, session as electronSession } from 'electron';
import { APP_HOST, APP_ORIGIN } from '../server/protocol';
import { CHANNEL, type Mode } from '../shared/bridge';
import { instancePartition, setupAppSession } from './app-session';
import { fingerprintOf, generateCertificate } from './cert';
import { CorsInjector } from './cors';
import { setupFeatures, type FeatureContext } from './features';
import { registerImportScheme } from './features/import';
import { createChannels, registerBridge } from './ipc';
import { LocalAdmin } from './local-admin';
import { installMenu } from './menu';
import { attachWindowGuards, type GuardOptions } from './navigation';
import { LoopbackSignIn } from './oauth-loopback';
import { applyPermissionPolicy } from './permissions';
import { profilePaths, seedProfile, serverEnv } from './profile';
import { randomSecret, SecretStore, SecretStoreError } from './secrets';
import { startServerProcess, ServerStartError } from './server-process';
import { ServerRegistry } from './servers';
import { StateFile } from './state';
import { strings } from './strings';
import { ThemeController } from './theme';
import { WindowManager } from './windows';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, 'preload.cjs');
const WELCOME_PRELOAD = path.join(HERE, 'welcome-preload.cjs');
const WELCOME_PAGE = path.join(HERE, 'pages', 'welcome.html');
const SERVER_HOST = path.join(HERE, 'server-host.cjs');

const DEV = !app.isPackaged;
const MAX_SERVER_RESTARTS = 3;
const devTools = DEV && process.argv.includes('--dev');

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

// A test or a second development copy points this elsewhere.
const userDataArg = DEV ? argValue('bulwark-user-data') : undefined;
if (userDataArg) app.setPath('userData', userDataArg);

app.setName('Bulwark');
if (process.platform === 'win32') app.setAppUserModelId('org.bulwarkmail.desktop');

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

registerImportScheme();
const SERVER_PORT = await reservePort();
app.commandLine.appendSwitch('host-resolver-rules', `MAP ${APP_HOST}:443 127.0.0.1:${SERVER_PORT}`);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);

const stateFile = new StateFile(path.join(app.getPath('userData'), 'shell-state.json'));
let windowManager: WindowManager | null = null;
let signIn: LoopbackSignIn | null = null;
let appStartUrl = '';

function serverDirectory(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'server');
  return argValue('bulwark-server-dir') ?? path.join(HERE, '..', 'webmail');
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

function createWindowManager(mode: Mode, origin: string, session: Electron.Session, theme: ThemeController): WindowManager {
  const guard: GuardOptions = { mode, origin, windows: () => windowManager! };
  windowManager = new WindowManager({
    state: stateFile,
    theme,
    session,
    origin,
    mode,
    preloadPath: PRELOAD,
    devTools,
    attachGuards: (window) => attachWindowGuards(window, guard),
  });
  appStartUrl = mode === 'instance' ? validInstanceUrl(argValue('instance')) ?? validInstanceUrl(stateFile.data.instanceUrl) ?? `${origin}/` : `${origin}/`;
  windowManager.on('stayed', () => {
    switching = false;
    quitFlushed = false;
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
    return { keyPem, certPem, fingerprint: fingerprintOf(certPem) };
  }
  const fresh = generateCertificate(APP_HOST);
  await secrets.set('tls-key', fresh.keyPem);
  writeFileSync(certFile, fresh.certPem);
  return fresh;
}

async function bootStandalone(theme: ThemeController): Promise<void> {
  const userData = app.getPath('userData');
  const secretsDir = path.join(userData, 'keys');
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
    const admin = await secrets.getOrReplace('admin-credential', () => randomSecret(32));
    adminPassword = admin.value;
    // A new credential only takes if the stored hash goes with the old one.
    if (admin.created) rmSync(path.join(profile.adminConfig, 'admin.json'), { force: true });
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

  seedProfile(profile);

  const launchSecret = randomBytes(32).toString('base64url');
  const mainSecret = randomBytes(32).toString('base64url');
  // A development switch for the test of a replaced certificate.
  const pin = DEV && process.argv.includes('--bulwark-test-wrong-pin') ? 'sha256/wrong' : tlsPair.fingerprint;
  const session = setupAppSession(pin, launchSecret, () => {
    pinFailed = true;
  });
  applyPermissionPolicy(session, APP_ORIGIN);

  const cors = new CorsInjector(session, APP_ORIGIN);
  const spawnServer = (append: boolean) =>
    startServerProcess({
      hostScript: SERVER_HOST,
      serverDir: serverDirectory(),
      env: serverEnv(profile, process.env, process.platform),
      logDir: path.join(userData, 'logs'),
      append,
      init: {
        type: 'init',
        port: SERVER_PORT,
        parentPid: process.pid,
        launchSecret,
        mainSecret,
        tls: { key: tlsPair.keyPem, cert: tlsPair.certPem },
        secretEnv: { SESSION_SECRET: sessionSecret, ADMIN_PASSWORD: adminPassword },
        trustedOrigins: stateFile.data.approvedServers.map((s) => s.origin),
      },
    });
  let server = spawnServer(false);
  const servers = new ServerRegistry({ state: stateFile, cors, sendTrusted: (origins) => server.sendTrusted(origins) });
  const localAdmin = new LocalAdmin({ port: SERVER_PORT, certPem: tlsPair.certPem, launchSecret, mainSecret, password: adminPassword });

  const windows = createWindowManager('standalone', APP_ORIGIN, session, theme);
  signIn = new LoopbackSignIn(() => windows.focus());
  const ctx: FeatureContext = {
    mode: 'standalone',
    origin: APP_ORIGIN,
    session,
    state: stateFile,
    theme,
    windows,
    servers,
    localAdmin,
    ...createChannels(APP_ORIGIN),
  };
  registerBridge(ctx, { origin: APP_ORIGIN, signIn });
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
  windows.open({ type: 'main', url: `${APP_ORIGIN}/` });
}

async function bootInstance(instanceUrl: string, theme: ThemeController): Promise<void> {
  const origin = new URL(instanceUrl).origin;
  const session = electronSession.fromPartition(instancePartition(origin));
  applyPermissionPolicy(session, origin);
  const windows = createWindowManager('instance', origin, session, theme);
  const ctx: FeatureContext = { mode: 'instance', origin, session, state: stateFile, theme, windows, ...createChannels(origin) };
  registerBridge(ctx, { origin });
  setupFeatures(ctx);
  windows.open({ type: 'main', url: instanceUrl });
}

function validInstanceUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return parsed.origin + parsed.pathname.replace(/\/+$/, '') + '/';
  } catch {
    return null;
  }
}

/** The first run asks which of the two the user wants. Step 6's forced InstanceUrl policy skips this. */
function showWelcome(theme: ThemeController): void {
  const colours = theme.colours();
  const window = new BrowserWindow({
    width: 620,
    height: 520,
    resizable: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: colours.background,
    title: 'Bulwark',
    webPreferences: { preload: WELCOME_PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  ipcMain.handle(CHANNEL.welcomeChoose, async (event, choice: { mode?: unknown; url?: unknown }) => {
    if (event.sender !== window.webContents || !event.senderFrame?.url.startsWith('data:')) throw new Error('Not allowed');
    if (choice?.mode === 'standalone') {
      stateFile.data.mode = 'standalone';
    } else if (choice?.mode === 'instance') {
      const instanceUrl = validInstanceUrl(choice.url);
      if (!instanceUrl) return { ok: false, error: 'invalid_url' };
      stateFile.data.mode = 'instance';
      stateFile.data.instanceUrl = instanceUrl;
    } else {
      return { ok: false, error: 'invalid_choice' };
    }
    stateFile.save();
    ipcMain.removeHandler(CHANNEL.welcomeChoose);
    await boot(theme);
    window.destroy();
    return { ok: true };
  });
  // A data: page: with the grantFileProtocolExtraPrivileges fuse off, a file: one doesn't run.
  void window.loadURL(`data:text/html;charset=utf-8;base64,${readFileSync(WELCOME_PAGE).toString('base64')}`);
}

async function boot(theme: ThemeController): Promise<void> {
  const forcedInstance = DEV ? validInstanceUrl(argValue('instance')) : null;
  const mode: Mode | undefined = forcedInstance ? 'instance' : DEV && process.argv.includes('--standalone') ? 'standalone' : stateFile.data.mode;
  if (mode === 'instance') {
    const url = forcedInstance ?? validInstanceUrl(stateFile.data.instanceUrl);
    if (url) {
      await bootInstance(url, theme);
      return;
    }
  } else if (mode === 'standalone') {
    await bootStandalone(theme);
    return;
  }
  showWelcome(theme);
}

// Quitting closes the windows, and each may ask first. Nothing is forgotten until all
// of them have gone, so choosing Stay keeps the mode.
let switching = false;

function switchMode(): void {
  switching = true;
  app.quit();
}

function finishSwitch(): void {
  stateFile.data.mode = undefined;
  stateFile.data.instanceUrl = undefined;
  stateFile.save();
  app.relaunch();
}

let quitFlushed = false;

if (gotLock) {
  // Nothing may attach a webview or open a window behind the window manager's back.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  // Another launch means "show me the app". With only a pop-out left open, that's a new main window.
  const showMain = () => {
    if (!windowManager) return;
    if (windowManager.mainWindow()) windowManager.focus();
    else windowManager.open({ type: 'main', url: appStartUrl });
  };

  app.on('second-instance', showMain);

  app.on('window-all-closed', () => {
    // Step 6 keeps the app running here when close-to-tray is on.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (windowManager && windowManager.isEmpty()) showMain();
  });

  // Pages save first, within limits, and then the quit goes on. A preventDefault in a
  // window's own close would call the quit off, so it's done here.
  app.on('before-quit', (event) => {
    signIn?.closeAll();
    stateFile.save();
    if (quitFlushed || !windowManager) return;
    event.preventDefault();
    quitFlushed = true;
    void windowManager.flushAll().finally(() => app.quit());
  });

  app.on('will-quit', () => {
    if (switching) finishSwitch();
  });

  app.whenReady().then(async () => {
    installMenu({ switchMode, devTools });
    const theme = new ThemeController(stateFile);
    await boot(theme);
  }).catch((error) => {
    console.error(error);
    dialog.showErrorBox('Bulwark', String(error instanceof Error ? error.message : error));
    app.exit(1);
  });
}

