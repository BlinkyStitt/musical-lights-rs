import { defineConfig } from '@playwright/test';
import base from './playwright.config.mjs';

const args = process.platform === 'darwin'
  ? ['--use-angle=metal', '--enable-gpu']
  : ['--use-gl=angle', '--use-angle=gl', '--enable-gpu'];

const tests = [
  '**/active-gap-performance.spec.mjs',
  '**/active-gap.spec.mjs',
  '**/antialias.spec.mjs', '**/box-depth.spec.mjs', '**/color-fill.spec.mjs',
  '**/edges.spec.mjs', '**/lighting-auto.spec.mjs', '**/mirrors.spec.mjs',
  '**/musical-motion.spec.mjs', '**/star-twinkle.spec.mjs', '**/stars.spec.mjs',
  '**/tilt-lighting.spec.mjs',
];

export default defineConfig({
  ...base,
  globalSetup: './gpu-startup.mjs',
  projects: [{
    name: 'gpu-chromium',
    testMatch: tests,
    use: { browserName: 'chromium', channel: 'chromium', launchOptions: { args } },
  }],
});
