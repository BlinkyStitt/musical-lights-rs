import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { evaluatePerformance, performanceCaptureTiming } from '../../musical-leptos/src/physics/performance.js';

// Synthetic measurements test the gate, never claim rendered performance.
function fixture(captureProfile = 'standard') {
  const timing = performanceCaptureTiming(captureProfile), seconds = timing.durationMs / 1000;
  return { captureProfile, hz: 120, intervals: Array(timing.measurementSeconds * 60).fill(1000 / 60), renderCosts: [1],
    progress: Array.from({ length: timing.measurementSeconds }, (_, i) => ({ elapsedMs: i * 1000, tick: 1800 + i * 120, debtMs: 0 })),
    maxSnapshotAgeMs: 1, invalid: [], data: { physicsCosts: Array(seconds * 120).fill(.1), elapsedMs: timing.durationMs,
      initialTick: 0, finalTick: seconds * 120, debt: 0, maxDebt: 1, discardedSimulationMs: 0, recordingOverflow: false } };
}

for (const captureProfile of ['standard', 'endurance']) {
  test(`${captureProfile} numeric acceptance retains every frame, debt, lag and invalidation limit`, () => {
    const timing = performanceCaptureTiming(captureProfile);
    assert.equal(evaluatePerformance(fixture(captureProfile)).numericPass, true);
    const mutations = [
      f => { f.intervals = []; },
      f => { f.intervals = Array((timing.measurementSeconds - 1) * 60 - 1).fill(1000 / 60); },
      f => { f.intervals.fill(1000 / 29); },
      f => { f.intervals.fill(38, 0, 1000); },
      f => { f.intervals.fill(51, 0, Math.ceil(f.intervals.length / 100)); },
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
      f => { f.data.elapsedMs = timing.durationMs - 1; },
    ];
    for (const mutate of mutations) {
      const f = fixture(captureProfile); mutate(f);
      assert.equal(evaluatePerformance(f).numericPass, false, mutate.toString());
    }
  });
}

test('only the approved profiles are accepted and two minutes cannot pass endurance', () => {
  assert.deepEqual(performanceCaptureTiming('standard'), { profile: 'standard', warmupSeconds: 15,
    measurementSeconds: 120, warmupMs: 15000, durationMs: 135000, minimumFrameMs: 119000, deadlineMs: 150000 });
  assert.deepEqual(performanceCaptureTiming('endurance'), { profile: 'endurance', warmupSeconds: 15,
    measurementSeconds: 300, warmupMs: 15000, durationMs: 315000, minimumFrameMs: 299000, deadlineMs: 330000 });
  for (const profile of [undefined, null, 'one-minute', '', '__proto__', 'toString', 120, { toString: () => 'standard' }]) {
    assert.throws(() => performanceCaptureTiming(profile), /Unknown performance capture profile/);
    assert.throws(() => evaluatePerformance({ ...fixture(), captureProfile: profile }), /Unknown performance capture profile/);
  }
  assert.equal(evaluatePerformance({ ...fixture('standard'), captureProfile: 'endurance' }).numericPass, false);
});

test('temporary 30 FPS acceptance keeps full cadence and physics evidence', () => {
  const f = fixture(); f.intervals = Array.from({ length: 3600 }, (_, i) => [33, 33, 34][i % 3]);
  const result = evaluatePerformance(f);
  assert.equal(result.summary.fps, 30); assert.equal(result.numericPass, true);
  assert.equal(result.summary.slowFrameMs, 50); assert.equal(result.summary.slowFrameFraction, 0);
  f.data.maxDebt = 100; assert.equal(evaluatePerformance(f).numericPass, false);
});

for (const captureProfile of ['standard', 'endurance']) {
  test(`${captureProfile} collector counts only submitted frames, catches interruptions and restores hooks`, async () => {
    const timing = performanceCaptureTiming(captureProfile);
    const source = await readFile(new URL('../active-gap-sampler.mjs', import.meta.url), 'utf8');
    for (const interruption of [null, 'visibility', 'continuity', 'session', 'workload', 'backpressure', 'audio-event-overflow', 'cap', 'initial-cap']) {
      let now = 0, timeoutMs, cleared = false, reportedAt;
      const doc = Object.assign(new EventTarget(), { hidden: false });
      const context = { performance: { now: () => now, timeOrigin: 0 }, innerWidth: 390, innerHeight: 844,
        document: doc, setTimeout: (_callback, ms) => { timeoutMs = ms; return 1; }, clearTimeout() { cleared = true; }, structuredClone };
      runInNewContext(source.replace('export function', 'function') + '\nglobalThis.collect = collectActiveGapPerformance;', context);
      const originalFrame = () => {}, originalReceive = () => {}, originalInvalidate = () => {};
      const originalOnFrame = () => {}, originalReady = () => interruption !== 'backpressure';
      const view = { card: Object.assign(new EventTarget(), { hasAttribute: () => false, querySelector: () => ({ checked: true }) }),
        onFrame: originalOnFrame, gpuFrames: { ready: originalReady },
        canvas: new EventTarget(), layout: [24, 120], palette: [.5], cameraBase: 0, cameraParameters: { values: { zoom: 100 } },
        input: new Float32Array(76), settings: { cameraMotion: true }, metrics: { physicsSteps: 0, debt: 0, snapshotAgeMs: 1 },
        report: { frame: originalFrame, receive: originalReceive, invalidate: originalInvalidate,
          audioState: { sessionId: 1, source: 'generated', kind: 'exercise', state: 'playing', repeat: true,
            diagnostics: false, sampleRate: 48000, dbfs: -34, frequency: 1000, channel: 0, pascalsPerUnit: 2,
            continuity: { segment: 0, missingSamples: 0 },
            // Published production sessions carry live transport and processor
            // resources. Evidence must neither invoke nor clone these handles.
            restart() { assert.fail('Collector must not restart playback'); },
            node: { port: { postMessage() { assert.fail('Collector must not command the audio processor'); } } } },
          acceptanceWorkload: () => true,
          defaults: Array.from({ length: 12 }, (_, i) => i === 11 ? 1.6 : 0),
          readConfig: () => Array.from({ length: 12 }, (_, i) => i === 11 ? (interruption === 'initial-cap' ? 1.2 : 1.6) : 0) } };
      view.input[67] = 1.6;
      view.worker = { postMessage(data) {
        if (data.type === 'record') view.report.receive({ type: 'recording', timestamp: 0 });
        else { reportedAt = now; view.report.receive({ ...fixture(captureProfile).data, type: 'report', config: [], finalTick: now * 120 / 1000, elapsedMs: now }); }
      } };
      const result = context.collect(view, 'normal', { evaluatePerformance, performanceCaptureTiming }, captureProfile);
      if (interruption === 'initial-cap') {
        await assert.rejects(result, /Invalid active-gap acceptance workload or view/);
        assert.equal(cleared, true);
        assert.equal(view.report.frame, originalFrame);
        continue;
      }
      // No calls to the submission hook means no frame samples, regardless of
      // elapsed wall time. Then feed genuine hook calls for the complete window.
      for (let tick = 0; tick <= timing.durationMs * 60 / 1000 + 1; tick++) {
        now = tick * 1000 / 60; view.metrics.physicsSteps = tick * 2;
        if (tick === 100) {
          if (interruption === 'visibility') {
            doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); doc.hidden = false;
            view.report.invalidate('Camera changed during test');
          }
          if (interruption === 'continuity') {
            view.report.audioState.continuity.segment++;
            view.report.audioState.continuity.missingSamples = 128;
            view.report.audioState.reason = 'analysis resumed after sample gap';
          }
          if (interruption === 'session') view.report.audioState.sessionId++;
          if (interruption === 'workload') view.report.audioState.dbfs++;
          if (interruption === 'continuity' || interruption === 'audio-event-overflow') {
            for (let i = 0; i < (interruption === 'audio-event-overflow' ? 65 : 1); i++) {
              const event = new Event('audio-session'); event.detail = view.report.audioState;
              view.card.dispatchEvent(event);
            }
          }
        }
        // Change the cap during measurement, then restore it before reporting.
        if (interruption === 'cap' && tick === 2000) view.input[67] = .4;
        if (interruption === 'cap' && tick === 2001) view.input[67] = 1.6;
        view.onFrame(now, false);
        if (view.gpuFrames.ready()) view.report.frame(now, .2);
      }
      // A complete worker report cannot turn skipped submissions into FPS.
      if (interruption === 'backpressure') view.worker.postMessage({ type: 'report' });
      const data = await result;
      assert.equal(data.numericPass, interruption === null, interruption);
      assert.equal(data.frameIntervalsMs.length, interruption === 'backpressure' ? 0 : timing.measurementSeconds * 60);
      const workload = { sessionId: 1, source: 'generated', kind: 'exercise', state: 'playing', repeat: true,
        diagnostics: false, sampleRate: 48000, dbfs: -34, frequency: 1000, channel: 0, pascalsPerUnit: 2,
        continuity: { segment: 0, missingSamples: 0 } };
      assert.deepEqual(JSON.parse(JSON.stringify(data.workload)), workload);
      assert.deepEqual(structuredClone(data.workload), workload);
      assert.equal(data.physicalPhone, false);
      assert.equal(data.captureProfile, captureProfile);
      assert.equal(data.warmupSeconds, 15); assert.equal(data.measurementSeconds, timing.measurementSeconds);
      assert.equal(timeoutMs, timing.deadlineMs); assert.equal(cleared, true);
      assert(reportedAt >= timing.durationMs && reportedAt < timing.durationMs + 20);
      for (const key of ['ios', 'device', 'lowPowerMode', 'smoothMotionConfirmed']) assert.equal(data[key], undefined);
      if (interruption === 'visibility') assert(data.invalidReasons.includes('Page hidden during test'));
      if (interruption === 'continuity' || interruption === 'session') assert(data.invalidReasons.includes('Audio interrupted or changed'));
      if (interruption === 'workload') assert(data.invalidReasons.includes('Audio workload changed'));
      if (interruption === 'cap') assert(data.invalidReasons.includes('Bar travel cap changed during test'));
      if (interruption === 'continuity') {
        assert.equal(data.audioTransitions.length, 1);
        assert.equal(data.audioTransitions[0].atMs, 100 * 1000 / 60);
        assert.equal(data.audioTransitions[0].audio.reason, 'analysis resumed after sample gap');
        assert.equal(data.audioTransitions[0].audio.continuity.missingSamples, 128);
        assert.equal(data.invalidations[0].audio.continuity.segment, 1);
        assert.equal(data.finalAudio.continuity.segment, 1);
        view.report.audioState.continuity.missingSamples = 256;
        assert.equal(data.audioTransitions[0].audio.continuity.missingSamples, 128);
      }
      if (interruption === 'audio-event-overflow') {
        assert.equal(data.audioTransitions.length, 64);
        assert(data.invalidReasons.includes('Audio event evidence capacity exceeded'));
      }
      assert(data.renderProgress.length > timing.measurementSeconds && data.renderProgress.length <= 400);
      assert(data.renderProgress.some(row => row.callbacks > 50));
      assert(data.renderProgress.some(row => row.maxAnimationGapMs > 16));
      assert.equal(data.renderProgress.some(row => row.backpressure > 0), interruption === 'backpressure');
      assert.equal(data.renderProgress.some(row => row.submissions > 0), interruption !== 'backpressure');
      assert.equal(view.report.frame, originalFrame); assert.equal(view.report.receive, originalReceive);
      assert.equal(view.report.invalidate, originalInvalidate);
      assert.equal(view.onFrame, originalOnFrame); assert.equal(view.gpuFrames.ready, originalReady);
    }
  });
}
