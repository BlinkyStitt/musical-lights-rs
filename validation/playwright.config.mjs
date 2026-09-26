import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  globalSetup: './browser-startup.mjs',
  // Real AudioContexts must not compete with each other and offline WASM
  // stress tests. Callback gaps correctly stop capture; they are not retries.
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { headless: true, screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', testIgnore: '**/mobile-screen.spec.mjs', use: { browserName: 'chromium' } },
    { name: 'webkit-spectrum', testMatch: ['**/spectrum-keyboard.spec.mjs', '**/spectrum.spec.mjs', '**/edges.spec.mjs', '**/balloons.spec.mjs', '**/routes.spec.mjs', '**/tones.spec.mjs'], use: { browserName: 'webkit' } },
    { name: 'iphone-webkit', testMatch: '**/mobile-screen.spec.mjs', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  ],
  webServer: {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:8101/',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 1000 },
  },
});
