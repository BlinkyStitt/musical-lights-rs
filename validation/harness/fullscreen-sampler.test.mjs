import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordFullscreenFrames } from '../fullscreen-sampler.mjs';

test('fullscreen recovery counts submissions, retains skipped-frame gaps and restores the production hook', () => {
  let originalCalls = 0, callbacks = 0;
  const original = function (t, cost) { assert.equal(this, view.report); assert.equal(cost, .2); originalCalls++; };
  const view = { recordTiming: false, report: { frame: original }, layout: Array(18).fill(0),
    metrics: { debt: 8, snapshotAgeMs: 4, overloadTicks: 0, substepTotal: 10, requestedSubstepTotal: 10 },
    current: [2, 2, 0, 0, 0, .1, .3], input: new Float32Array(33), gpuFrames: { ready() { return callbacks % 3 === 1; } }, onFrame() { callbacks++; } };
  view.input[32] = 2;
  const onFrame = view.onFrame, ready = view.gpuFrames.ready;
  const stop = recordFullscreenFrames(view);
  assert.equal(view.recordTiming, true);
  for (let tick = 0; tick < 60; tick++) {
    view.onFrame(tick * 1000 / 60, false);
    // The production loop calls report.frame only after drawing. A slow GPU
    // can produce 60 animation callbacks but only 20 actual submissions.
    if (view.gpuFrames.ready()) view.report.frame(tick * 1000 / 60, .2);
  }
  const samples = stop();
  assert.equal(callbacks, 60); assert.equal(samples.length, 20); assert.equal(originalCalls, 20);
  assert(samples.slice(1).every(row => Math.abs(row.frame - 50) < 1e-9));
  assert.equal(samples[1].callbacks, 3); assert.equal(samples[1].backpressure, 2);
  assert(Math.abs(samples[1].maxAnimationGapMs - 1000 / 60) < 1e-9);
  assert.equal(samples[1].cost, .2);
  assert.equal(samples[1].debt, 8); assert.equal(samples[1].age, 4);
  assert.equal(samples[1].height, 2); assert.equal(samples[1].configuredHeight, 2); assert.equal(samples[1].requested, 2);
  assert.equal(view.onFrame, onFrame); assert.equal(view.gpuFrames.ready, ready);
  assert.equal(view.report.frame, original); assert.equal(view.recordTiming, false);
  view.report.frame(1000, .2); assert.equal(samples.length, 20); assert.equal(originalCalls, 21);
});
