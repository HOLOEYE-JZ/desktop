import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { HeldRequests } from '../src/server/held-requests';

function listen(pages: HeldRequests): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => pages.handle(req, res));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    })
      .on('error', reject)
      .end();
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

test('a page request that comes before Next has loaded waits, and Next answers it once it is there', async () => {
  const pages = new HeldRequests();
  const { server, port } = await listen(pages);
  try {
    let answered = false;
    const first = get(port, '/first').then((r) => ((answered = true), r));
    const second = get(port, '/second');
    await until(() => pages.waiting === 2);
    expect(pages.waiting).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(answered).toBe(false);

    pages.open((req, res) => res.end(`next ${req.url}`));
    expect(await first).toEqual({ status: 200, body: 'next /first' });
    expect(await second).toEqual({ status: 200, body: 'next /second' });
    expect(pages.waiting).toBe(0);
    // After that, straight through.
    expect(await get(port, '/later')).toEqual({ status: 200, body: 'next /later' });
  } finally {
    server.close();
  }
});

test('when Next fails to load, what waited and what comes after gets 503, never a hang', async () => {
  const pages = new HeldRequests();
  const { server, port } = await listen(pages);
  try {
    const held = get(port, '/held');
    await until(() => pages.waiting === 1);
    pages.fail();
    expect(await held).toEqual({ status: 503, body: 'Not available' });
    expect(await get(port, '/after')).toEqual({ status: 503, body: 'Not available' });
  } finally {
    server.close();
  }
});
