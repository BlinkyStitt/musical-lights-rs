import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { evaluatePerformance } from '../../musical-leptos/src/physics/performance.js';

// Synthetic measurements test the gate, never claim rendered performance.
function fixture() {
  return { hz: 120, intervals: Array(18000).fill(1000 / 60), renderCosts: [1],
    progress: Array.from({ length: 300 }, (_, i) => ({ elapsedMs: i * 1000, tick: 1800 + i * 120, debtMs: 0 })),
    maxSnapshotAgeMs: 1, invalid: [], data: { physicsCosts: Array(37800).fill(.1), elapsedMs: 315000,
      initialTick: 0, finalTick: 37800, debt: 0, maxDebt: 1, discardedSimulationMs: 0, recordingOverflow: false } };
}
test('five-minute numeric acceptance retains every frame, debt, lag and invalidation limit', () => {
  assert.equal(evaluatePerformance(fixture()).numericPass, true);
  const mutations = [
    f => { f.intervals = []; },
    f => { f.intervals = Array(17900).fill(1000 / 60); },
    f => { f.intervals.fill(1000 / 58); },
    f => { f.intervals.fill(19, 0, 1000); },
    f => { f.intervals.fill(26, 0, 180); },
    f => { f.intervals[0] = NaN; },
    f => { f.data.debt = 2 * 1000 / 120; },
    f => { f.data.maxDebt = 100; },
    f => { f.progress.slice(-10).forEach(row => { row.debtMs = 9; }); },
    f => { f.data.finalTick += 2; },
    f => { f.data.finalTick -= 3; },
    f => { f.progress.at(-1).tick += 3; },
    f => { f.maxSnapshotAgeMs = 100; },
    f => { f.data.discardedSimulationMs = .001; },
    f => { f.data.recordingOverflow = true; },
    f => { f.invalid.push('Page hidden'); },
    f => { f.progress = []; },
    f => { f.renderCosts = []; },
    f => { f.data.physicsCosts = []; },
    f => { f.data.elapsedMs = 314999; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert.equal(evaluatePerformance(f).numericPass, false, mutate.toString());
  }
});

test('automated collector counts only submitted frames, catches interruptions and restores hooks', async () => {
  const source = await readFile(new URL('../active-gap-sampler.mjs', import.meta.url), 'utf8');
  for (const interrupted of [false, true]) {
    let now = 0;
    const doc = Object.assign(new EventTarget(), { hidden: false });
    const context = { performance: { now: () => now, timeOrigin: 0 }, innerWidth: 390, innerHeight: 844,
      document: doc, setTimeout: () => 1, clearTimeout() {}, structuredClone };
    runInNewContext(source.replace('export function', 'function') + '\nglobalThis.collect = collectActiveGapPerformance;', context);
    const originalFrame = () => {}, originalReceive = () => {}, originalInvalidate = () => {};
    const view = { card: Object.assign(new EventTarget(), { hasAttribute: () => false, querySelector: () => ({ checked: true }) }),
      canvas: new EventTarget(), layout: [24, 120], palette: [.5], cameraBase: 0, cameraParameters: { values: { zoom: 100 } },
      settings: { cameraMotion: true }, metrics: { physicsSteps: 0, debt: 0, snapshotAgeMs: 1 },
      report: { frame: originalFrame, receive: originalReceive, invalidate: originalInvalidate,
        audioState: { sessionId: 1, continuity: { segment: 0 } }, acceptanceWorkload: () => true,
        readConfig: () => Array.from({ length: 12 }, (_, i) => i === 11 ? .6 : 0) } };
    view.worker = { postMessage(data) {
      if (data.type === 'record') view.report.receive({ type: 'recording', timestamp: 0 });
      else view.report.receive({ ...fixture().data, type: 'report', config: [], finalTick: now * 120 / 1000, elapsedMs: now });
    } };
    const result = context.collect(view, 'normal', evaluatePerformance);
    // No calls to the submission hook means no frame samples, regardless of
    // elapsed wall time. Then feed genuine hook calls for the complete window.
    for (let tick = 0; tick <= 18901; tick++) {
      now = tick * 1000 / 60; view.metrics.physicsSteps = tick * 2;
      if (interrupted && tick === 100) {
        doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); doc.hidden = false;
        view.report.invalidate('Camera changed during test');
        view.report.audioState.continuity.segment++;
      }
      view.report.frame(now, .2);
    }
    const data = await result;
    assert.equal(data.numericPass, !interrupted);
    assert.equal(data.frameIntervalsMs.length, 18000);
    assert.equal(data.physicalPhone, false);
    for (const key of ['ios', 'device', 'lowPowerMode', 'smoothMotionConfirmed']) assert.equal(data[key], undefined);
    if (interrupted) assert(data.invalidReasons.includes('Page hidden during test'));
    assert.equal(view.report.frame, originalFrame); assert.equal(view.report.receive, originalReceive);
    assert.equal(view.report.invalidate, originalInvalidate);
  }
});
