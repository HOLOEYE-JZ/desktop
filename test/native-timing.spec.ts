import { writeFileSync } from 'node:fs';
import { test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, removeProfile, shownPage, tempProfile, waitForLogin } from './helpers';

/**
 * How long a pop-out takes to come up, with and without the warm spare. Timing, so
 * on the bench rig only, never on a developer's machine:
 *   BULWARK_TIMING=<result file> xvfb-run npx playwright test test/native-timing.spec.ts
 * No account needed: what's timed is the window and the pop-out's frame, up to the
 * skeleton a signed-in window shows for as long as its session takes.
 */
test.skip(!process.env.BULWARK_TIMING, 'run with BULWARK_TIMING=<result file>, on the bench rig');

const ROUNDS = 12;

async function recordShows(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    const g = globalThis as unknown as { __shows: Record<number, number> };
    g.__shows = {};
    electronApp.on('browser-window-created', (_event, window) => {
      window.once('show', () => {
        g.__shows[window.id] = Date.now();
      });
    });
  });
}

async function openOne(app: ElectronApplication, page: Page, id: string): Promise<{ show: number; frame: number }> {
  const start = Date.now();
  await page.evaluate(
    (emailId) => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: `/popout/message/${emailId}`, emailId }),
    id,
  );
  let found: Page | undefined;
  while (!found) {
    found = app.windows().find((w) => !w.isClosed() && w.url().includes(`/popout/message/${id}`));
    if (!found) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await found.locator('[data-popout-window]').waitFor({ state: 'attached', timeout: 60_000 });
  const frame = Date.now() - start;
  const show = await app.evaluate(({ BrowserWindow }, [wanted, since]) => {
    const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(wanted as string));
    const at = window ? (globalThis as unknown as { __shows: Record<number, number> }).__shows[window.id] : undefined;
    return at ? at - (since as number) : -1;
  }, [`/popout/message/${id}`, start] as const);
  await found.close();
  return { show, frame };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

test('pop-outs, cold and from the spare', async () => {
  test.setTimeout(900_000);
  const result: Record<string, unknown> = {};
  for (const [name, args] of [['no spare', []], ['spare', ['--bulwark-test-spare']]] as const) {
    const profile = tempProfile('timing');
    const app = await launch(profile, '--standalone', ...args);
    await recordShows(app);
    const page = await shownPage(app);
    await waitForLogin(page);
    if (name === 'spare') {
      await page.waitForTimeout(14_000);
      result.spareMemoryMb = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
        const spare = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/spare'));
        const pid = spare?.webContents.getOSProcessId();
        const metric = electronApp.getAppMetrics().find((m) => m.pid === pid);
        return metric ? Math.round(metric.memory.workingSetSize / 1024) : null;
      });
    }
    const rounds: { show: number; frame: number }[] = [];
    // The first few warm the HTTP cache and the code cache, as a user's first windows would.
    for (let i = 0; i < ROUNDS; i += 1) {
      if (name === 'spare') {
        await page.waitForTimeout(i === 0 ? 12_000 : 3500);
      } else {
        await page.waitForTimeout(500);
      }
      rounds.push(await openOne(app, page, `t${i}x${Date.now().toString(36)}`));
    }
    const warm = rounds.slice(2);
    result[name] = { rounds, medianShowMs: median(warm.map((r) => r.show)), medianFrameMs: median(warm.map((r) => r.frame)) };
    await app.close();
    removeProfile(profile);
  }
  writeFileSync(process.env.BULWARK_TIMING!, JSON.stringify(result, null, 2));
});
