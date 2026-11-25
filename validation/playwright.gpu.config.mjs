import { defineConfig } from '@playwright/test';
import base from './playwright.config.mjs';

const args = process.platform === 'darwin'
  ? ['--use-angle=metal', '--enable-gpu']
  : ['--use-gl=angle', '--use-angle=gl', '--enable-gpu'];

const nvidiaTests = [
  '**/active-gap.spec.mjs', '**/antialias.spec.mjs', '**/box-depth.spec.mjs',
  '**/color-fill.spec.mjs', '**/edges.spec.mjs', '**/lighting-auto.spec.mjs',
  '**/stars.spec.mjs', '**/tilt-lighting.spec.mjs',
];
const intelTests = [
  '**/active-gap-performance.spec.mjs', '**/mirrors.spec.mjs',
  '**/musical-motion.spec.mjs', '**/star-twinkle.spec.mjs',
];

// Keep the long active-gap browser captures apart from the separate NVIDIA
// latency and tilt measurements. Local runs cover both sets.
const shard = process.env.GPU_BROWSER_SHARD;
const testsByShard = { '1': nvidiaTests, '2': intelTests };
if (shard !== undefined && !Object.hasOwn(testsByShard, shard)) {
  throw new Error(`Invalid GPU browser shard: ${shard}`);
}

export default defineConfig({
  ...base,
  globalSetup: './gpu-startup.mjs',
  projects: [{
    name: 'gpu-chromium',
    testMatch: shard === undefined ? [...nvidiaTests, ...intelTests] : testsByShard[shard],
    use: { browserName: 'chromium', channel: 'chromium', launchOptions: { args } },
  }],
});
