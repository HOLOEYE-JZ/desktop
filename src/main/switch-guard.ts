/**
 * Command-line switches a production build refuses, with or without a policy. Each of
 * these lets whoever starts the app, or a shortcut someone edited, script the page,
 * read its traffic or aim it elsewhere: a debugging port, another profile, a proxy,
 * host rules, turned-off certificate checks or sandboxing, features switched on or off.
 * The fuses already cover Node's own. No Electron here, so tests can load it.
 *
 * Chromium reads some of these before any of our code runs (the sandbox, V8's flags,
 * the feature list), so taking them off the command line isn't enough: main restarts
 * itself without them.
 */

const DENIED: readonly RegExp[] = [
  /^remote-/,
  /^inspect/,
  /^debug(-|$)/,
  /^devtools/,
  /^auto-open-devtools/,
  /^user-data-dir$/,
  /^disk-cache-/,
  /^host-rules$/,
  /^host-resolver-rules$/,
  /^ignore-certificate-errors/,
  /^ignore-urlfetcher/,
  /^allow-insecure-localhost$/,
  /^proxy-/,
  /^no-proxy-server$/,
  /^winhttp-proxy/,
  /^no-sandbox/,
  /^disable-.*sandbox/,
  /^no-zygote$/,
  /^single-process$/,
  /^in-process-/,
  /-cmd-prefix$/,
  /^gpu-launcher$/,
  /^browser-subprocess-path$/,
  /^disable-web-security$/,
  /^allow-running-insecure-content$/,
  /^unsafely-treat-insecure-origin-as-secure$/,
  /^allow-file-access/,
  /^disable-features$/,
  /^enable-features$/,
  /^force-fieldtrial/,
  /^enable-blink-features$/,
  /^disable-blink-features$/,
  /^enable-experimental-web-platform-features$/,
  /^enable-unsafe/,
  /^js-flags$/,
  /^load-extension$/,
  /^disable-extensions/,
  /^disable-site-isolation/,
  /^isolate-origins$/,
  /^auth-/,
  /^enable-auth-negotiate-port$/,
  /^disable-ntlm-v2$/,
  /^auto-select-certificate/,
  /^ssl-/,
  /^cipher-suite-blacklist$/,
  /^log-net-log$/,
  /^net-log/,
  /^origin-to-force-quic/,
  /^user-agent$/,
];

/**
 * Chromium trims each argument before it looks for a switch: all Unicode white space on
 * Windows, ASCII elsewhere, so ` --no-sandbox` is `--no-sandbox` to it. This takes more
 * than that, quotes and control characters too. A file name with those around it and a
 * refused switch inside is not something anyone needs, and treating it as a file is the
 * mistake that lets a switch through.
 */
const AT_THE_EDGES = /^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff"']+|[\s\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff"']+$/g;

function bare(arg: string): string {
  return arg.replace(AT_THE_EDGES, '');
}

/** `--name=value` as Chromium reads it. On Windows it also takes `-name` and `/name`, in any case. */
function switchName(arg: string, platform: NodeJS.Platform): string | null {
  const match = (platform === 'win32' ? /^(?:--|-|\/)([^=]+)/ : /^(?:--|-)([^=]+)/).exec(bare(arg));
  return match ? bare(match[1]).replace(/^-+/, '').toLowerCase() : null;
}

function isDenied(arg: string, platform: NodeJS.Platform): boolean {
  const name = switchName(arg, platform);
  return !!name && DENIED.some((pattern) => pattern.test(name));
}

/** Everything after a bare `--` is an argument to the app, as for Chromium. */
function untilEnd(argv: readonly string[]): number {
  const end = argv.findIndex((arg) => bare(arg) === '--');
  return end === -1 ? argv.length : end;
}

export function deniedSwitches(argv: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const names = argv
    .slice(1, untilEnd(argv))
    .filter((arg) => isDenied(arg, platform))
    .map((arg) => switchName(arg, platform) as string);
  return [...new Set(names)];
}

export function withoutDeniedSwitches(argv: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const end = untilEnd(argv);
  return argv.filter((arg, index) => index === 0 || index >= end || !isDenied(arg, platform));
}

/**
 * The same for the environment. Electron turns the sandbox off for ELECTRON_DISABLE_SANDBOX,
 * on every OS, and Node and Chromium read the others before any of our code runs. These
 * few only change how a window looks or where deleted files go.
 */
const HARMLESS_ENV = /^ELECTRON_(?:OZONE_PLATFORM_HINT|TRASH|FORCE_WINDOW_MENU_BAR)$/i;
const DENIED_ENV = /^(?:ELECTRON_|NODE_(?!ENV$)|SSLKEYLOGFILE$|CHROME_LOG_FILE$)/i;

export function deniedEnvironment(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((name) => env[name] !== undefined && DENIED_ENV.test(name) && !HARMLESS_ENV.test(name));
}
