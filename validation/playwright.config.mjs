import { defineConfig, devices } from '@playwright/test';
process.env.DEBUG = [process.env.DEBUG, 'pw:browser'].filter(Boolean).join(',');
export default defineConfig({
  testDir: './tests',
  globalSetup: './browser-startup.mjs',
  // Real AudioContexts must not compete with each other and offline WASM
  // stress tests. Sample gaps invalidate continuity acceptance even after recovery.
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['./browser-process-reporter.mjs']],
  // Recording the live DOM on every protocol call stalls software renderers.
  // Keep action/source traces, failure screenshots and explicit pixel/image
  // assertions without continuous DOM snapshots or a screenshot filmstrip.
  use: { headless: true, screenshot: 'only-on-failure',
    trace: { mode: 'retain-on-failure', screenshots: false, snapshots: false, sources: true } },
  projects: [
    { name: 'chromium', testIgnore: ['**/active-gap-performance.spec.mjs', '**/mobile-screen.spec.mjs', '**/permissions-native.spec.mjs', '**/other-apps.spec.mjs'], use: { browserName: 'chromium' } },
    { name: 'other-apps', testMatch: '**/other-apps.spec.mjs', use: { browserName: 'chromium' } },
    { name: 'chromium-permissions', testMatch: '**/permissions-native.spec.mjs', use: {
      browserName: 'chromium', channel: 'chromium', launchOptions: { args: [
        '--use-fake-device-for-media-stream',
        '--host-resolver-rules=MAP musical-lights-insecure.test 127.0.0.1',
        '--no-proxy-server',
      ] },
    } },
    { name: 'webkit-spectrum', testMatch: ['**/mobile-layout.spec.mjs', '**/spectrum-keyboard.spec.mjs', '**/spectrum.spec.mjs', '**/edges.spec.mjs', '**/balloons.spec.mjs', '**/motion-gravity.spec.mjs', '**/routes.spec.mjs', '**/deployment.spec.mjs', '**/tones.spec.mjs', '**/notices.spec.mjs', '**/advanced.spec.mjs', '**/musical-motion.spec.mjs', '**/mirrors.spec.mjs', '**/box-depth.spec.mjs', '**/active-gap.spec.mjs', '**/antialias.spec.mjs', '**/color-fill.spec.mjs', '**/audio-recovery.spec.mjs', '**/lighting-auto.spec.mjs', '**/tilt-lighting.spec.mjs', '**/stars.spec.mjs', '**/star-twinkle.spec.mjs', '**/capture-startup.spec.mjs', '**/listening-review.spec.mjs', '**/permissions.spec.mjs', '**/recognition.spec.mjs', '**/youtube.spec.mjs', '**/fullscreen-settings.spec.mjs'], use: { browserName: 'webkit' } },
    { name: 'iphone-webkit', testMatch: ['**/mobile-screen.spec.mjs', '**/mobile-layout.spec.mjs', '**/motion-gravity.spec.mjs', '**/stars.spec.mjs', '**/star-twinkle.spec.mjs', '**/mirrors.spec.mjs', '**/box-depth.spec.mjs', '**/active-gap.spec.mjs', '**/antialias.spec.mjs', '**/color-fill.spec.mjs', '**/audio-recovery.spec.mjs', '**/permissions.spec.mjs', '**/capture-startup.spec.mjs', '**/youtube.spec.mjs', '**/fullscreen-settings.spec.mjs'], use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  ],
  webServer: {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:8101/',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 1000 },
  },
});
