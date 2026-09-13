import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const validation = fileURLToPath(new URL('../', import.meta.url));
const runner = require.resolve('@playwright/test/cli');
const testModule = import.meta.resolve('@playwright/test');

for (const selected of [undefined, 'chromium', 'webkit']) {
  test(`a startup failure stops the suite: ${selected ?? 'all projects'}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'musical-browser-startup-'));
    try {
      const executable = path.join(directory, 'unavailable-browser');
      const attempts = path.join(directory, 'attempts');
      const report = path.join(directory, 'report.json');
      // Exercise Playwright's real process launcher without crashing a native browser.
      await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$STARTUP_BROWSER" >> "$STARTUP_ATTEMPTS"\necho "fixture: browser service registration denied" >&2\nexit 1\n', { mode: 0o700 });
      const projects = ['chromium', 'webkit'].map(browserName => ({
        name: browserName,
        use: {
          browserName,
          launchOptions: {
            executablePath: executable,
            env: { STARTUP_ATTEMPTS: attempts, STARTUP_BROWSER: browserName },
          },
        },
      }));
      await writeFile(path.join(directory, 'playwright.config.mjs'), `
        import base from ${JSON.stringify(pathToFileURL(path.join(validation, 'playwright.config.mjs')).href)};
        export default {
          ...base,
          globalSetup: base.globalSetup && ${JSON.stringify(validation)} + base.globalSetup,
          webServer: undefined,
          testDir: ${JSON.stringify(directory)},
          outputDir: ${JSON.stringify(path.join(directory, 'results'))},
          reporter: [['json', { outputFile: ${JSON.stringify(report)} }]],
          projects: ${JSON.stringify(projects)},
        };
      `);
      await writeFile(path.join(directory, 'startup.spec.mjs'), `
        import { test } from ${JSON.stringify(testModule)};
        for (let i = 0; i < 3; i++) {
          test('page ' + i, async ({ page }) => { await page.goto('about:blank'); });
        }
      `);
      const args = [runner, 'test', '--config', path.join(directory, 'playwright.config.mjs')];
      if (selected) args.push('--project', selected);
      await assert.rejects(run(process.execPath, args, { cwd: validation, timeout: 30_000 }), { code: 1 });
      const result = JSON.parse(await readFile(report, 'utf8'));
      const launches = await readFile(attempts, 'utf8').catch(error => {
        assert.fail(`${error.message}\n${JSON.stringify(result.errors)}`);
      });
      assert.equal(launches, `${selected ?? 'chromium'}\n`, 'only one browser launch should occur');
      assert.equal(result.stats.unexpected, 0, 'setup failure must stop tests before workers start');
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0].message, /Browser startup failed/);
      assert.match(result.errors[0].message, /fixture: browser service registration denied/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
