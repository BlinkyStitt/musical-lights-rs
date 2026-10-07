import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('phone progress and sensor ages use the worker clock while FPS keeps frame timestamps', async () => {
  let monotonic = 15125;
  const context = { performance: { now: () => monotonic }, innerWidth: 390, innerHeight: 844 };
  const source = await readFile(new URL('../../musical-leptos/src/physics/report.js', import.meta.url), 'utf8');
  runInNewContext(source.replace(/^import .*;\n/gm, '').replace('export class PhoneReport', 'class PhoneReport') + '\nglobalThis.Report = PhoneReport;', context);
  const nodes = new Map();
  const query = selector => { if (!nodes.has(selector)) nodes.set(selector, { textContent: '', checked: false }); return nodes.get(selector); };
  const report = Object.assign(Object.create(context.Report.prototype), {
    active: true, startMs: 0, lastProgress: 0, count: 0, costCount: 0, progress: [], maxSnapshotAgeMs: 0,
    intervals: new Float32Array(10), renderCosts: new Float32Array(10), query,
    metadata: { scrolling: false, mode: 'normal', viewport: [390, 844], sessionId: 1 },
    audioState: { source: 'generated', kind: 'exercise', state: 'playing', repeat: true, diagnostics: false, sessionId: 1 },
    invalidate: reason => { throw Error(reason); },
    view: { sceneVisible: true, metrics: { frames: 1, snapshotAgeMs: 2, physicsSteps: 1800, debt: 0 },
      card: { querySelector: query, hasAttribute: () => false }, input: new Float32Array(38),
      motion: { state: 'active', readings: { at: 15100, motionEvents: 1, orientationEvents: 0 } } },
  });
  report.frame(15050, .2);
  assert.equal(report.progress[0].elapsedMs, 125);
  assert.match(query('.sensor-readings').textContent, /reading age: 25 ms/);
  monotonic = 15142;
  report.frame(15066.67, .2);
  assert.equal(report.count, 1);
  assert.ok(Math.abs(report.intervals[0] - 16.67) < 1e-4);
  const reasons = []; report.invalidate = reason => reasons.push(reason);
  report.view.sceneVisible = false; monotonic = 15159;
  report.frame(15083.34, .2);
  assert.deepEqual(reasons, ['Visualizer left the viewport during test']);
  assert.equal(report.count, 1); assert.equal(report.previous, null);
});
