import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  globalSetup: './browser-startup.mjs',
  fullyParallel: true,
  retries: 0,
  workers: 3,
  reporter: 'list',
  use: { headless: true, screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', testIgnore: '**/mobile-screen.spec.mjs', use: { browserName: 'chromium' } },
    { name: 'webkit-spectrum', testMatch: '**/spectrum-keyboard.spec.mjs', use: { browserName: 'webkit' } },
    { name: 'iphone-webkit', testMatch: '**/mobile-screen.spec.mjs', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  ],
  webServer: {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:8101/',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 1000 },
  },
});
