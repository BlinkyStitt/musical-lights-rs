import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { captureLatencyEvidence } from '../latency-evidence.mjs';
import { packetRenderCrossings, packetRenderSummary } from '../packet-render.mjs';

// Execute the actual collector with deterministic browser failures. These are
// evidence-lifetime checks, not browser or rendered-performance measurements.
async function collector(t, failure) {
  const directory = await mkdtemp(join(tmpdir(), 'latency-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'latency.json');
  await writeFile(output, '["stale capture"]');
  const raw = { seed: 1, packets: [{ at: 0, levels: Array(24).fill(.2) }],
    renders: [{ at: 10, levels: Array(24).fill(.2) }], chunks: [{ values: [1, 2] }],
    layout: [24, 120], metrics: { discardedSimulationMs: 0 }, audio: { state: 'playing' } };
  let launches = 0, finished = false;
  const engine = { async launch() {
    const index = ++launches;
    // Earlier captures must already be durable before this browser starts.
    const saved = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(saved.length, index);
    assert(saved.slice(0, -1).every(row => row.complete === true));
    assert.equal(saved.at(-1).complete, false);
    return {
      async close() { if (index === 4 && failure === 'cleanup') throw new Error('browser cleanup failed'); },
      async newContext() { return {
        async addInitScript() {}, async close() {},
        async newPage() {
          let evaluateCount = 0, pageError;
          return {
            on(name, listener) { if (name === 'pageerror') pageError = listener; },
            async goto() { if (index === 4 && failure === 'navigation') throw new Error('navigation timed out'); },
            async waitForFunction() {}, async waitForTimeout() {},
            locator() { return { async selectOption() {}, async check() {}, async click() {} }; },
            async evaluate() {
              if (++evaluateCount === 1) return 'fixture GPU';
              if (evaluateCount === 2) return;
              if (index === 4 && failure === 'page error') pageError(new Error('render failed'));
              return structuredClone(raw);
            },
          };
        },
      }; },
    };
  } };
  const source = (await readFile(new URL('../active-gap-latency.mjs', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '');
  const context = { process: { argv: ['node', 'collector', 'https://fixture', output, '--hardware'], platform: 'darwin' },
    chromium: engine, webkit: engine, devices: { 'iPhone 13': {} }, readFile, writeFile,
    captureLatencyEvidence, packetRenderCrossings, packetRenderSummary,
    hardwareBrowserOptions: () => ({}), requireHardwareRenderer() {}, renderingEvidence: () => ({ kind: 'hardware' }),
    startup: async () => { if (failure === 'startup') throw new Error('startup failed'); return async () => { finished = true; }; },
    staticPreview: async () => {}, openFullscreenSettings: async () => {}, console: { log() {} } };
  const pending = runInNewContext('(async () => {' + source + '})()', context);
  if (failure) await assert.rejects(pending, /startup failed|navigation timed out|render failed|browser cleanup failed/);
  else await pending;
  return { saved: JSON.parse(await readFile(output, 'utf8')), raw, launches, finished };
}

for (const failure of ['navigation', 'page error', 'cleanup']) {
  test(`fourth latency case ${failure} preserves earlier captures and available failing evidence`, async t => {
    const { saved, raw, launches, finished } = await collector(t, failure);
    assert.equal(launches, 4, 'Never retry a failed browser'); assert.equal(finished, true);
    assert.equal(saved.length, 4);
    for (const row of saved.slice(0, 3)) {
      assert.equal(row.complete, true); assert.deepEqual(row.packets, raw.packets);
      assert.deepEqual(row.renders, raw.renders); assert.deepEqual(row.chunks, raw.chunks);
    }
    const failed = saved[3];
    assert.equal(failed.browser, 'webkit'); assert.equal(failed.capCm, 2000);
    assert.equal(failed.complete, false); assert(failed.error);
    if (failure !== 'navigation') {
      assert.deepEqual(failed.packets, raw.packets); assert.deepEqual(failed.renders, raw.renders);
      assert.deepEqual(failed.chunks, raw.chunks); assert.equal(failed.summary.matched, 24);
    }
    if (failure === 'page error') assert.deepEqual(failed.errors, ['render failed']);
  });
}

test('successful latency collection retains all four complete captures', async t => {
  const { saved, launches, finished } = await collector(t);
  assert.equal(launches, 4); assert.equal(finished, true); assert.equal(saved.length, 4);
  assert(saved.every(row => row.complete && !row.error));
});

test('latency startup failure cannot leave an earlier successful output', async t => {
  const { saved, launches } = await collector(t, 'startup');
  assert.deepEqual(saved, []); assert.equal(launches, 0);
});
