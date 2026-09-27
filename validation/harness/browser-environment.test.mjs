import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBrowserEnvironment } from '../browser-environment.mjs';
import startup from '../browser-startup.mjs';
import { chromium, webkit } from '@playwright/test';

test('restricted macOS preflight launches zero browsers for every project selection', async () => {
  const engines = [chromium, webkit];
  const originals = engines.map(engine => engine.launch);
  let launches = 0;
  try {
    for (const engine of engines) engine.launch = async () => { launches++; throw new Error('fake browser must not launch'); };
    for (const names of [['chromium'], ['webkit'], ['chromium', 'webkit']]) {
      const config = { filteredProjects: names.map(browserName => ({ name: browserName, use: { browserName } })) };
      await assert.rejects(startup(config, { platform: 'darwin', env: { CODEX_SANDBOX: 'seatbelt' } }), /require_escalated.*Zero browsers/s);
      assert.equal(launches, 0, names.join(','));
    }
  } finally { engines.forEach((engine, i) => { engine.launch = originals[i]; }); }

});

test('host macOS and Linux may proceed to serial startup', () => {
  assert.doesNotThrow(() => assertBrowserEnvironment('darwin', {}));
  assert.doesNotThrow(() => assertBrowserEnvironment('linux', { CODEX_SANDBOX: 'seatbelt' }));
});
