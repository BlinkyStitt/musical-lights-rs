import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: 0,
  workers: 3,
  reporter: 'list',
  use: { headless: true, screenshot: 'only-on-failure' },
  webServer: {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:8101/',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 1000 },
  },
});
