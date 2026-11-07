import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { lifelinePath } from '../src/server/lifeline';

/** A child process's next stdout line that matches. */
function lineFrom(child: ReturnType<typeof spawn>, wanted: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`no ${wanted} within ${timeoutMs} ms; got ${JSON.stringify(buffer)}`)), timeoutMs);
    child.stdout!.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split('\n').find((l) => wanted.test(l));
      if (line) {
        clearTimeout(timer);
        resolve(line);
      }
    });
  });
}

test('the lifeline closes on the server side the moment the process holding it is killed', async () => {
  const where = lifelinePath(process.platform, randomBytes(8).toString('hex'));
  // Stands in for main: listens and holds every connection, says nothing.
  const holder = spawn(process.execPath, ['-e', `require('node:net').createServer((s) => s.on('error', () => {})).listen(${JSON.stringify(where)}, () => console.log('ready'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
  // Stands in for the server: connected, and reports the close.
  let watcher: ReturnType<typeof spawn> | null = null;
  try {
    await lineFrom(holder, /^ready/, 10_000);
    watcher = spawn(process.execPath, ['-e', `const s = require('node:net').connect(${JSON.stringify(where)}); s.on('connect', () => console.log('connected')); s.on('data', () => {}); s.on('error', () => {}); s.on('close', () => { console.log('closed'); process.exit(0); }); setTimeout(() => {}, 60000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await lineFrom(watcher, /^connected/, 10_000);
    const closed = lineFrom(watcher, /^closed/, 3000);
    // TerminateProcess on Windows, SIGKILL elsewhere: no code of the holder runs to close it.
    holder.kill('SIGKILL');
    expect(await closed).toBe('closed');
  } finally {
    holder.kill('SIGKILL');
    watcher?.kill('SIGKILL');
  }
});

test('a lifeline leaves no file behind where the OS allows it', () => {
  expect(lifelinePath('win32', 'ab')).toBe(String.raw`\\.\pipe\bulwark-lifeline-ab`);
  expect(lifelinePath('linux', 'ab')).toBe('\0bulwark-lifeline-ab');
  expect(lifelinePath('darwin', 'ab', '/tmp/x')).toBe(path.join('/tmp/x', 'bulwark-lifeline-ab.sock'));
});
