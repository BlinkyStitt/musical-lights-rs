import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoDepth, depthPass, STARTUP_DEPTH_CANDIDATES } from '../../musical-leptos/src/physics/depth-auto.js';
import { readSettings, SETTINGS_KEY } from '../../musical-leptos/src/presentation.js';
import { validAudio, DEFAULT_AUDIO } from '../../musical-leptos/src/audio_controls.js';
for (const hz of [60, 90, 120, 144]) test(`Auto selects once at ${hz} Hz and rejects slow candidates`, () => {
  let count, result, now = 0;
  const selection = new AutoDepth(value => { count = value; }, value => { result = value; }, 0);
  while (!selection.done) { now += count <= 128 ? 1000 / hz : 2000 / hz; selection.sample(now); }
  assert.equal(result.count, 128); assert(Math.abs(result.hz - hz) < .01);
  selection.sample(now + 1000); assert.equal(count, 128);
});
for (const supported of [0, 3, 7]) test(`startup depth stays between 1 and 7 with support through ${supported}`, () => {
  let count, result, now = 0; const applied = [];
  const selection = new AutoDepth(value => { count = value; applied.push(value); }, value => { result = value; }, 0, STARTUP_DEPTH_CANDIDATES);
  while (!selection.done) { now += count <= supported ? 1000 / 60 : 2000 / 60; selection.sample(now); }
  assert.equal(result.count, Math.max(1, supported));
  assert(applied.slice(1).every(value => value >= 1 && value <= 7));
});
test('explicit Auto can select the full 2048-image range', () => {
  let result, now = 0;
  const selection = new AutoDepth(() => {}, value => { result = value; }, 0);
  while (!selection.done) { now += 1000 / 60; selection.sample(now); }
  assert.equal(result.count, 2048);
});
test('Auto cancellation prevents further writes and frame criteria reject missed refreshes', () => {
  let writes = 0; const selection = new AutoDepth(() => { writes++; }, () => assert.fail('canceled'), 0);
  selection.cancel(); selection.sample(100); assert.equal(writes, 1);
  assert(depthPass(Array(60).fill(1000 / 120), 1000 / 120));
  assert(!depthPass([...Array(59).fill(1000 / 120), 20], 1000 / 120));
});
test('new preferences select Auto while every old count stays manual', () => {
  const read = saved => readSettings({ getItem(key) { assert.equal(key, SETTINGS_KEY); return JSON.stringify(saved); } });
  assert.equal(read(null).depthMode, 'auto');
  for (const count of [0, 6, 128, 2048]) { const saved = read({ version: 1, mirrorCount: count }); assert.equal(saved.depthMode, 'manual'); assert.equal(saved.mirrorCount, count); }
  assert.equal(read({ version: 1, mirrorCount: 128, depthMode: 'auto' }).depthMode, 'auto');
  for (const [mirrorCount, expected] of [[0, 1], [3, 3], [7, 7], [128, 7], [2048, 7]])
    assert.equal(read({ version: 1, mirrorCount, depthMode: 'auto' }).mirrorCount, expected);
});
test('audio preferences reject invalid controls without changing the model contract', () => {
  assert(validAudio([...DEFAULT_AUDIO]));
  for (let i = 0; i < DEFAULT_AUDIO.length; i++) { const values = [...DEFAULT_AUDIO]; values[i] = NaN; assert(!validAudio(values)); }
  const values = [...DEFAULT_AUDIO]; values[18] = 190; values[19] = 100; assert(!validAudio(values));
});
