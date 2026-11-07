import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, removeProfile, tempProfile } from './helpers';

/**
 * The main window opens while Next is still loading, and its first request waits in the host.
 * A stand-in for the webmail: a `next` whose prepare takes a while (or fails), so the order
 * can be read back without timing anything.
 */
// The page sets --titlebar-right-inset, or the window would be rebuilt with a native frame.
function fakeServer(dir: string, prepare: 'slow' | 'fails'): string {
  mkdirSync(path.join(dir, '.next'), { recursive: true });
  mkdirSync(path.join(dir, 'node_modules', 'next'), { recursive: true });
  writeFileSync(path.join(dir, '.next', 'required-server-files.json'), JSON.stringify({ config: {} }));
  writeFileSync(path.join(dir, 'server.js'), '');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fake-webmail', version: '0.0.0' }));
  const marker = JSON.stringify(path.join(dir, 'prepared.txt'));
  const body =
    prepare === 'slow'
      ? `new Promise((resolve) => setTimeout(() => { require('fs').writeFileSync(${marker}, String(Date.now())); resolve(); }, 4000))`
      : `new Promise((_resolve, reject) => setTimeout(() => reject(new Error('fake next failed to load')), 1500))`;
  writeFileSync(
    path.join(dir, 'node_modules', 'next', 'index.js'),
    `module.exports = () => ({
  prepare: () => ${body},
  getRequestHandler: () => (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><title>Fake</title><style>:root { --titlebar-right-inset: 0px }</style></head><body><p id="fake">held and answered</p></body></html>');
  },
});`,
  );
  return dir;
}

test('the main window is there before Next has loaded, and its first request gets the page', async () => {
  const profile = tempProfile('start-order');
  const server = fakeServer(tempProfile('fake-next'), 'slow');
  const app = await launch(profile, '--standalone', `--bulwark-server-dir=${server}`);
  try {
    // Read in main: Playwright reports a window only once its first page has come.
    let windowAt = 0;
    await expect
      .poll(
        async () => {
          const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
          if (count > 0 && !windowAt) windowAt = Date.now();
          return count;
        },
        { timeout: 60_000, intervals: [50] },
      )
      .toBeGreaterThan(0);
    const page = await app.firstWindow({ timeout: 60_000 });
    await expect(page.locator('#fake')).toHaveText('held and answered', { timeout: 60_000 });
    const preparedAt = Number(readFileSync(path.join(server, 'prepared.txt'), 'utf8'));
    // The prepare takes 4 s: a window made after it would come after the marker.
    expect(windowAt).toBeLessThan(preparedAt);
    expect(new URL(page.url()).origin).toBe('https://app.bulwark.localhost');
  } finally {
    await app.close();
    removeProfile(profile);
    removeProfile(server);
  }
});

test('Next failing after the port listens shows the error page, and no window is left waiting', async () => {
  const profile = tempProfile('start-fail');
  const server = fakeServer(tempProfile('fake-next'), 'fails');
  const app = await launch(profile, '--standalone', `--bulwark-server-dir=${server}`);
  try {
    await expect
      .poll(
        () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .filter((w) => !w.isDestroyed())
              .map((w) => w.webContents.getURL().slice(0, 30)),
          ),
        { timeout: 60_000 },
      )
      .toEqual(['data:text/html;charset=utf-8,%']);
    const error = app.windows().find((w) => w.url().startsWith('data:'));
    await expect(error!.locator('h1')).toHaveText("Bulwark couldn't start");
  } finally {
    await app.close();
    removeProfile(profile);
    removeProfile(server);
  }
});
