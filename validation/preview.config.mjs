import config from './playwright.config.mjs';
export default {
  ...config,
  testDir: './preview',
  workers: 1,
  outputDir: './test-results/preview',
};
