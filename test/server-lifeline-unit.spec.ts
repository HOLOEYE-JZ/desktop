import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { connect } from 'node:net';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { LifelineGate, lifelinePath, removeStaleLifelines, serveLifeline } from '../src/server/lifeline';

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
  expect(lifelinePath('linux', 'ab', {})).toBe('\0bulwark-lifeline-ab');
  expect(lifelinePath('darwin', 'ab', {}, '/tmp/x')).toBe(path.join('/tmp/x', 'bulwark-lifeline-ab.sock'));
  // A Linux session's runtime folder, which only its user can enter, over an abstract socket anyone can reach.
  expect(lifelinePath('linux', 'ab', { XDG_RUNTIME_DIR: '/run/user/1000' })).toBe(path.join('/run/user/1000', 'bulwark-lifeline-ab.sock'));
});

/** Connects and reports whether the other side closed the connection within the wait. */
function connectAndWatch(where: string): Promise<{ closed: () => boolean; end: () => void }> {
  return new Promise((resolve, reject) => {
    let closed = false;
    const socket = connect(where);
    socket.on('error', () => {});
    socket.on('close', () => {
      closed = true;
    });
    socket.once('connect', () => resolve({ closed: () => closed, end: () => socket.destroy() }));
    setTimeout(() => reject(new Error('no connect')), 5000);
  });
}

test('the lifeline keeps one connection per server main started and closes any more', async () => {
  const gate = new LifelineGate();
  const where = lifelinePath(process.platform, randomBytes(8).toString('hex'));
  const server = await serveLifeline(where, gate);
  expect(server).not.toBeNull();
  const clients: Array<{ closed: () => boolean; end: () => void }> = [];
  try {
    gate.grant();
    for (let i = 0; i < 3; i += 1) clients.push(await connectAndWatch(where));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(clients.map((c) => c.closed())).toEqual([false, true, true]);
    // A restarted server is granted its own.
    gate.grant();
    clients.push(await connectAndWatch(where));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(clients[3].closed()).toBe(false);
  } finally {
    for (const c of clients) c.end();
    server?.close();
  }
});

test('a lifeline file nothing listens on is removed at start, one in use stays', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lifeline-'));
  try {
    const stale = path.join(dir, 'bulwark-lifeline-old.sock');
    writeFileSync(stale, '');
    const other = path.join(dir, 'unrelated.sock');
    writeFileSync(other, '');
    let live: Awaited<ReturnType<typeof serveLifeline>> = null;
    const inUse = path.join(dir, 'bulwark-lifeline-live.sock');
    // Socket files: not on Windows, whose lifeline is a pipe.
    if (process.platform !== 'win32') live = await serveLifeline(inUse, new LifelineGate());
    const removed = await removeStaleLifelines(dir);
    expect(removed).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(other)).toBe(true);
    if (live) {
      expect(existsSync(inUse)).toBe(true);
      live.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
