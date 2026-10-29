import { defineConfig } from '@playwright/test';
import base from './playwright.config.mjs';

const args = process.platform === 'darwin'
  ? ['--use-angle=metal', '--enable-gpu']
  : ['--use-gl=angle', '--use-angle=gl', '--enable-gpu'];

export default defineConfig({
  ...base,
  globalSetup: './gpu-startup.mjs',
  projects: [{
    name: 'gpu-chromium',
    testMatch: [
      '**/antialias.spec.mjs', '**/box-depth.spec.mjs', '**/color-fill.spec.mjs',
      '**/edges.spec.mjs', '**/lighting-auto.spec.mjs', '**/mirrors.spec.mjs',
      '**/musical-motion.spec.mjs', '**/star-twinkle.spec.mjs', '**/stars.spec.mjs',
    ],
    use: { browserName: 'chromium', channel: 'chromium', launchOptions: { args } },
  }],
});
