import { chromium, firefox, webkit } from '@playwright/test';
import { assertBrowserEnvironment, monitorBrowserCrashes } from './browser-environment.mjs';

const browsers = { chromium, firefox, webkit };

/** @param {import('@playwright/test').FullConfig<{}, import('@playwright/test').PlaywrightWorkerOptions>} config */
export default async function checkBrowserStartup(config, environment = {}) {
  assertBrowserEnvironment(environment.platform, environment.env);
  const finish = await monitorBrowserCrashes();
  // Check serially before workers start. Otherwise each failed test launches
  // another browser, even with retries disabled, and can cause a crash storm.
  for (const project of config.filteredProjects) {
    const { browserName = 'chromium', launchOptions = {}, headless, channel } = project.use;
    try {
      const browser = await browsers[browserName].launch({
        ...launchOptions,
        headless: headless ?? launchOptions.headless ?? true,
        channel: channel ?? launchOptions.channel,
      });
      try {
        await browser.newPage();
      } finally {
        await browser.close();
      }
    } catch (error) {
      let crashError = '';
      try { await finish(); } catch (failure) { crashError = `\n${failure.message}`; }
      throw new Error(
        `Browser startup failed for ${project.name} (${browserName}); no tests ran. ` +
        `Check browser installation and OS permissions. See docs/validation.md for host access requirements.\n${error.message}${crashError}`,
        { cause: error },
      );
    }
  }
  return finish;
}
