import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBrowserEnvironment, classifyBrowserReport } from '../browser-environment.mjs';
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

const ips = (header, report) => JSON.stringify(header) + '\n' + JSON.stringify(report);
const fault = { procName: 'com.apple.WebKit.Networking.Development', exception: { type: 'EXC_GUARD', subtype: 'GUARD_TYPE_USER' } };
test('native crash guard distinguishes simulated fault snapshots from process crashes', () => {
  assert.equal(classifyBrowserReport(ips({ is_simulated: 1 }, { ...fault, isSimulated: 1 })), 'simulated-fault');
  for (const type of ['EXC_BAD_ACCESS', 'EXC_CRASH', 'EXC_GUARD']) {
    assert.equal(classifyBrowserReport(ips({}, { ...fault, exception: { type } })), 'crash');
  }
  for (const [header, report] of [[{ is_simulated: 1 }, fault], [{}, { ...fault, isSimulated: 1 }], [{ is_simulated: 0 }, { ...fault, isSimulated: 0 }]]) {
    assert.equal(classifyBrowserReport(ips(header, report)), 'crash');
  }
});
test('native crash guard fails closed for truncated, malformed or incomplete IPS reports', () => {
  for (const text of ['', '{', '{}\n{', 'bad\n{}', '{}\n{}', 'null\nnull', ips({ is_simulated: 1 }, { isSimulated: 1 })]) {
    assert.equal(classifyBrowserReport(text), 'unreadable');
  }
});
