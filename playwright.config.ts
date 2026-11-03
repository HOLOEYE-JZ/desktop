import { defineConfig } from '@playwright/test';

// Electron windows and one shared test account: nothing here runs in parallel.
export default defineConfig({
  testDir: './test',
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  retries: 0,
});
