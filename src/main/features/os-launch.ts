/**
 * How the outside world reaches the app: a mailto: or webcal: link, a double-clicked
 * .eml, .ics or .vcf, a file dropped on the icon, a jump list entry. On a cold start
 * and on a second launch alike. Everything ends as a command to the page, which takes
 * it through lib/launch-handoff and the protocol handlers.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { OsCommand, OsFile } from '../../shared/bridge';
import type { OsHub } from './os-hub';
import { commandFromUrl, fileReason, MAX_LAUNCH_FILE_BYTES, parseArgv, parseToastUrl, type LaunchRequest } from './os-rules';

const early: { urls: string[]; files: string[] } = { urls: [], files: [] };
let liveHandler: ((request: LaunchRequest) => void) | null = null;

/**
 * macOS sends these before `ready`, and before anything else is set up, on a cold
 * start. Dropping a file on the dock comes in here too.
 */
export function holdEarlyLaunches(): void {
  app.on('open-file', (event, file) => {
    event.preventDefault();
    if (liveHandler) liveHandler({ commands: [], files: [file], fromLogin: false, toastUrls: [] });
    else early.files.push(file);
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const command = commandFromUrl(url);
    if (!command) return;
    if (liveHandler) liveHandler({ commands: [command], files: [], fromLogin: false, toastUrls: [] });
    else early.urls.push(url);
  });
}

async function readFiles(files: readonly string[]): Promise<OsCommand[]> {
  const byReason: Record<'open' | 'attach', { files: OsFile[]; failed: string[] }> = {
    open: { files: [], failed: [] },
    attach: { files: [], failed: [] },
  };
  for (const file of files) {
    const reason = fileReason(file);
    const name = path.basename(file);
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      if (info.size > MAX_LAUNCH_FILE_BYTES) {
        byReason[reason].failed.push(name);
        continue;
      }
      byReason[reason].files.push({ name, data: new Uint8Array(await readFile(file)) });
    } catch {
      // Named on a command line and not there: only worth saying if it looks meant.
      if (path.extname(file)) byReason[reason].failed.push(name);
    }
  }
  return (['open', 'attach'] as const)
    .filter((reason) => byReason[reason].files.length + byReason[reason].failed.length > 0)
    .map((reason) => ({ type: 'files' as const, reason, ...byReason[reason] }));
}

export interface LaunchHandle {
  handle: (argv: string[], cwd: string) => Promise<number>;
}

export function setupLaunch(hub: OsHub): LaunchHandle {
  const skip = [app.getAppPath(), process.argv[1] ?? ''].filter(Boolean);

  /** What the toast URLs ask for. One that isn't ours is dropped. */
  const toastActions = (request: LaunchRequest) => request.toastUrls.flatMap((url) => parseToastUrl(url, hub.toastSecret()) ?? []);

  const run = async (request: LaunchRequest): Promise<number> => {
    const commands = [...request.commands, ...(await readFiles(request.files))];
    for (const command of commands) hub.dispatch(command);
    const actions = toastActions(request);
    for (const { action, context } of actions) hub.toastAction(action, context);
    return commands.length + actions.length;
  };

  /** Pressing Archive shows nothing. Any other launch means "show me the app". */
  const staysHidden = (request: LaunchRequest) =>
    request.commands.length === 0 && request.files.length === 0 && toastActions(request).length > 0 && toastActions(request).every(({ action }) => action !== 'open' && action !== 'reply');

  liveHandler = (request) => void run(request);

  const handle = (argv: string[], cwd: string) => run(parseArgv(argv, { cwd, skip }));

  app.on('second-instance', (_event, argv, cwd) => {
    const request = parseArgv(argv, { cwd, skip });
    if (!staysHidden(request)) hub.ctx.showMain();
    void run(request);
  });

  const first = parseArgv(process.argv, { cwd: process.cwd(), skip });
  const wasAtLogin = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
  first.commands.push(...early.urls.flatMap((url) => commandFromUrl(url) ?? []));
  first.files.push(...early.files);
  early.urls.length = 0;
  early.files.length = 0;
  if ((first.fromLogin || wasAtLogin) && hub.settings().startMinimized && first.commands.length === 0 && first.files.length === 0) {
    hub.ctx.windows.startMainHidden();
  }
  if (staysHidden(first)) hub.ctx.windows.startMainHidden();
  void run(first);

  return { handle };
}
