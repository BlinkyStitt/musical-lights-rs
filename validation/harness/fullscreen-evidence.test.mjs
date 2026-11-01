import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fullscreenWindows, retainFullscreenResult, validateFullscreenResult } from '../fullscreen-evidence.mjs';

const sample = (t, frame, substeps, height = 2) => ({ t, frame, debt: 4, age: 7,
  overload: 0, substepTotal: substeps, requestedSubstepTotal: substeps, height });
const capture = () => ({ browser: 'webkit', gpu: 'fixture GPU', build: { version: 'fixture' },
  marks: [{ event: 'enter', t: 1000 }], samples: [sample(990, 16, 10, 1), sample(1006, 16, 12), sample(1022, 16, 15)],
  snapshots: [{ at: 1006, debt: 4 }], discardedSimulationMs: 0 });

test('transition windows retain the measured frame, work and geometry boundaries', () => {
  assert.deepEqual(fullscreenWindows(capture()), [{ event: 'enter', fps: 62.5,
    p95: 16, maxFrame: 16, over25Fraction: 0, maxDebt: 4, maxSnapshotAge: 7,
    overloadTicks: 0, substeps: 5, requestedSubsteps: 5, fromHeight: 1, toHeight: 2 }]);
});

test('a fourth capture without a baseline retains all earlier results and its raw evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fullscreen-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'fullscreen.json'), results = [];
  for (let i = 0; i < 3; i++) await retainFullscreenResult(output, results, capture());
  const previous = structuredClone(results), failed = capture();
  failed.samples.shift();
  await assert.rejects(retainFullscreenResult(output, results, failed), /enter has no preceding frame/);
  const retained = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(retained.length, 4);
  assert.deepEqual(retained.slice(0, 3), previous);
  assert.deepEqual(retained[3].samples, failed.samples);
  assert.deepEqual(retained[3].snapshots, failed.snapshots);
  assert.deepEqual(retained[3].build, failed.build);
  assert.equal(retained[3].complete, false);
  assert.match(retained[3].error, /no preceding frame/);
  assert.equal(retained[3].windows, undefined);
});

test('a transition with no observed frames cannot produce accepted timing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fullscreen-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'fullscreen.json'), failed = capture();
  failed.samples.splice(1);
  await assert.rejects(retainFullscreenResult(output, [], failed), /enter has no measured frames/);
  const [retained] = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(retained.complete, false);
  assert.deepEqual(retained.marks, failed.marks);
  assert.deepEqual(retained.samples, failed.samples);
});

const measuredResult = kind => ({ complete: true, browser: 'fixture', rendering: { kind },
  errors: [], discardedSimulationMs: 0, workload: { state: 'playing', diagnostics: false },
  windows: [{ event: 'enter', fps: 60, p95: 16.7, over25Fraction: 0, maxSnapshotAge: 20, maxDebt: 8 }] });

test('software frame timing is reported without applying hardware frame limits', () => {
  const result = measuredResult('software');
  Object.assign(result.windows[0], { fps: 20, p95: 65, over25Fraction: 1 });
  assert.doesNotThrow(() => validateFullscreenResult(result));
  result.rendering.kind = 'hardware';
  assert.throws(() => validateFullscreenResult(result), /frame budget exceeded/);
});

test('hardware keeps every frame threshold and both renderers keep age and debt thresholds', () => {
  for (const boundary of [{ fps: 58.99 }, { p95: 18.51 }, { over25Fraction: .01 }]) {
    const result = measuredResult('hardware'); Object.assign(result.windows[0], boundary);
    assert.throws(() => validateFullscreenResult(result), /frame budget exceeded/);
  }
  for (const kind of ['software', 'hardware']) {
    assert.doesNotThrow(() => validateFullscreenResult(measuredResult(kind)));
    for (const boundary of [{ maxDebt: 2 * 1000 / 120 }, { maxSnapshotAge: 100 }]) {
      const result = measuredResult(kind); Object.assign(result.windows[0], boundary);
      assert.throws(() => validateFullscreenResult(result), /lost timely updates/);
    }
    for (const invalid of [{ complete: false }, { errors: ['page error'] }, { discardedSimulationMs: 1 },
      { workload: { state: 'stopped', diagnostics: false } }, { workload: { state: 'playing', diagnostics: true } }]) {
      assert.throws(() => validateFullscreenResult({ ...measuredResult(kind), ...invalid }));
    }
  }
  assert.throws(() => validateFullscreenResult(measuredResult('unverified')), /renderer is unverified/);
  const missing = measuredResult('hardware'); delete missing.rendering;
  assert.throws(() => validateFullscreenResult(missing), /renderer is unverified/);
});
