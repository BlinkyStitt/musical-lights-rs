import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fullscreenWindows, retainFullscreenResult, validateFullscreenResult } from '../fullscreen-evidence.mjs';

const sample = (t, frame, substeps, height = 2) => ({ t, frame, debt: 4, age: 7,
  overload: 0, substepTotal: substeps, requestedSubstepTotal: substeps, height });
const capture = () => ({ browser: 'webkit', gpu: 'fixture GPU', build: { version: 'fixture' },
  marks: [{ event: 'enter', t: 1000 }], samples: Array.from({ length: 202 }, (_, i) => sample(990 + i * 16, 16, 10 + i, i ? 2 : 1)),
  snapshots: [{ at: 1006, debt: 4 }], discardedSimulationMs: 0 });

test('transition and fixed recovery windows retain timing, work and geometry boundaries', () => {
  const [window] = fullscreenWindows(capture());
  assert.equal(window.event, 'enter'); assert.equal(window.durationMs, 3000);
  assert.equal(window.fps, 62.5); assert.equal(window.p95, 16);
  assert.equal(window.fromHeight, 1); assert.equal(window.toHeight, 2);
  assert.equal(window.substeps, 189); assert.equal(window.requestedSubsteps, 189);
  assert.equal(window.recovery.afterMs, 1000); assert.equal(window.recovery.durationMs, 2000);
  assert(window.recovery.measuredMs >= 2000); assert.equal(window.recovery.fps, 62.5);
  assert.equal(window.recovery.finalDebt, 4); assert.equal(window.recovery.debtGrowthMs, 0);
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

const measuredResult = kind => ({ complete: true, timingSource: 'submitted-frames', browser: 'fixture', rendering: { kind },
  errors: [], discardedSimulationMs: 0, workload: { state: 'playing', diagnostics: false },
  windows: [{ event: 'enter', fps: 60, p95: 16.7, maxFrame: 16.7, over25Fraction: 0, maxSnapshotAge: 20, maxDebt: 8,
    recovery: { afterMs: 1000, durationMs: 2000, measuredMs: 2000, fps: 60, p95: 16.7,
      maxFrame: 16.7, over25Fraction: 0, maxSnapshotAge: 20, maxDebt: 8, finalDebt: 4, debtGrowthMs: 0 } }] });

test('software frame timing is reported without applying hardware frame limits', () => {
  const result = measuredResult('software');
  for (const phase of [result.windows[0], result.windows[0].recovery])
    Object.assign(phase, { fps: 20, p95: 65, maxFrame: 80, over25Fraction: 1 });
  assert.doesNotThrow(() => validateFullscreenResult(result));
  result.rendering.kind = 'hardware';
  assert.throws(() => validateFullscreenResult(result), /did not recover frame budget/);
});

test('a brief slow transition passes only with a full fixed recovery period', () => {
  const data = capture();
  const burst = data.samples.find(p => p.t >= 1100);
  Object.assign(burst, { debt: 40, frame: 60 });
  const result = { ...measuredResult('hardware'), windows: fullscreenWindows(data) };
  assert.equal(result.windows[0].maxDebt, 40);
  assert.doesNotThrow(() => validateFullscreenResult(result));
  // A later isolated peak can also catch up under the normal debt contract.
  data.samples.find(p => p.t >= 2100).debt = 40;
  result.windows = fullscreenWindows(data);
  assert.doesNotThrow(() => validateFullscreenResult(result));
  assert.equal(result.windows[0].recovery.maxDebt, 40);
  assert.equal(result.windows[0].recovery.finalDebt, 4);
  // Final backlog fails even when most recovery samples were timely.
  data.samples.find(p => p.t >= 4000).debt = 20;
  result.windows = fullscreenWindows(data);
  assert.throws(() => validateFullscreenResult(result), /did not recover timely updates/);
});

test('sustained debt growth fails even below the final backlog limit', () => {
  const data = capture();
  for (const point of data.samples) if (point.t >= 3800) point.debt = 13;
  const result = { ...measuredResult('hardware'), windows: fullscreenWindows(data) };
  assert.equal(result.windows[0].recovery.finalDebt, 13);
  assert.equal(result.windows[0].recovery.debtGrowthMs, 9);
  assert.throws(() => validateFullscreenResult(result), /did not recover timely updates/);
});

test('missing tail frames and a freeze across the end boundary cannot pass recovery', () => {
  const data = capture();
  data.samples = data.samples.filter(p => p.t < 3900);
  assert.throws(() => fullscreenWindows(data), /incomplete recovery coverage/);
  const frozen = capture();
  frozen.samples.find(p => p.t >= 4000).frame = 1100;
  const result = { ...measuredResult('software'), windows: fullscreenWindows(frozen) };
  assert.throws(() => validateFullscreenResult(result), /froze during transition/);
});

test('recovery keeps frame, age and debt limits; transients and freezes remain bounded', () => {
  for (const boundary of [{ fps: 58.99 }, { p95: 18.51 }, { over25Fraction: .01 }]) {
    const result = measuredResult('hardware'); Object.assign(result.windows[0].recovery, boundary);
    assert.throws(() => validateFullscreenResult(result), /did not recover frame budget/);
  }
  for (const kind of ['software', 'hardware']) {
    assert.doesNotThrow(() => validateFullscreenResult(measuredResult(kind)));
    const growthBoundary = measuredResult(kind); growthBoundary.windows[0].recovery.debtGrowthMs = 1000 / 120;
    assert.doesNotThrow(() => validateFullscreenResult(growthBoundary));
    for (const boundary of [{ finalDebt: 2 * 1000 / 120 }, { debtGrowthMs: 1000 / 120 + .001 },
      { maxDebt: 100 }, { maxSnapshotAge: 100 }, { finalDebt: undefined }, { debtGrowthMs: NaN }]) {
      const result = measuredResult(kind); Object.assign(result.windows[0].recovery, boundary);
      assert.throws(() => validateFullscreenResult(result), /did not recover timely updates/);
    }
    for (const boundary of [{ maxDebt: 100 }, { maxSnapshotAge: 100 }]) {
      const result = measuredResult(kind); Object.assign(result.windows[0], boundary);
      assert.throws(() => validateFullscreenResult(result), /exceeded transient debt or age bound/);
    }
    const frozen = measuredResult(kind);
    frozen.windows[0].maxFrame = kind === 'hardware' ? 100 : 1000;
    assert.throws(() => validateFullscreenResult(frozen), /froze during transition/);
    for (const recovery of [undefined, { afterMs: 1001 }, { durationMs: 1999 }, { measuredMs: 1999 }]) {
      const result = measuredResult(kind);
      result.windows[0].recovery = recovery && { ...result.windows[0].recovery, ...recovery };
      assert.throws(() => validateFullscreenResult(result), /incomplete recovery evidence/);
    }
    for (const invalid of [{ complete: false }, { timingSource: 'animation-callbacks' }, { errors: ['page error'] }, { discardedSimulationMs: 1 },
      { workload: { state: 'stopped', diagnostics: false } }, { workload: { state: 'playing', diagnostics: true } }]) {
      assert.throws(() => validateFullscreenResult({ ...measuredResult(kind), ...invalid }));
    }
  }
  assert.throws(() => validateFullscreenResult(measuredResult('unverified')), /renderer is unverified/);
  const missing = measuredResult('hardware'); delete missing.rendering;
  assert.throws(() => validateFullscreenResult(missing), /renderer is unverified/);
});
