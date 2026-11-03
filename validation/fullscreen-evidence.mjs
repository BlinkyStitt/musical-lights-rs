import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { summarize as summarizeValues } from '../musical-leptos/src/physics/performance.js';

// Fixed input-to-recovery deadline; do not wait for a favorable frame to start
// the recovery window. Keep the complete transition alongside its steady period.
export const fullscreenRecovery = { afterMs: 1000, durationMs: 2000 };

export function fullscreenWindows(data) {
  const summarize = (event, start, end) => {
    const before = data.samples.findLast(p => p.t < start);
    assert(before, event + ' has no preceding frame');
    assert(data.samples.some(p => p.t >= start && p.t < end), event + ' has no measured frames');
    // Include the first frame across the end boundary. A freeze at the end
    // cannot disappear merely because its next callback falls outside the window.
    const through = data.samples.find(p => p.t >= end);
    assert(through, event + ' has incomplete recovery coverage');
    const points = data.samples.filter(p => p.t >= start && p.t <= through.t);
    const frames = points.map(p => p.frame).sort((a, b) => a - b);
    const measuredMs = frames.reduce((a, b) => a + b, 0);
    return { measuredMs, fps: 1000 * frames.length / measuredMs,
      p95: frames[Math.ceil(frames.length * .95) - 1], maxFrame: frames.at(-1),
      over25Fraction: frames.filter(x => x > 25).length / frames.length,
      maxDebt: Math.max(...points.map(p => p.debt)), finalDebt: points.at(-1).debt,
      debtGrowthMs: summarizeValues(points.slice(-10).map(p => p.debt)).mean
        - summarizeValues(points.slice(0, 10).map(p => p.debt)).mean,
      maxSnapshotAge: Math.max(...points.map(p => p.age)),
      overloadTicks: points.at(-1).overload - before.overload,
      substeps: points.at(-1).substepTotal - before.substepTotal,
      requestedSubsteps: points.at(-1).requestedSubstepTotal - before.requestedSubstepTotal,
      fromHeight: before.height, toHeight: points.at(-1).height };
  };
  return data.marks.map(({ event, t }) => {
    const end = t + fullscreenRecovery.afterMs + fullscreenRecovery.durationMs;
    return { event, durationMs: fullscreenRecovery.afterMs + fullscreenRecovery.durationMs,
      ...summarize(event, t, end),
      recovery: { ...fullscreenRecovery, ...summarize(event, t + fullscreenRecovery.afterMs, end) } };
  });
}

// A later browser or derived-window failure must not erase earlier captures or
// the raw samples that explain why the last transition cannot be evaluated.
export async function retainFullscreenResult(output, results, result) {
  result.complete = false;
  results.push(result);
  const save = () => writeFile(output, JSON.stringify(results, null, 2) + '\n');
  await save();
  try {
    result.windows = fullscreenWindows(result);
    result.complete = true;
  } catch (error) {
    result.error = error.message;
    await save();
    throw error;
  }
  await save();
  return result;
}

// Software frame rates remain reported. A brief transition can exceed steady
// limits, but must stay bounded and recover by the fixed deadline on both paths.
export function validateFullscreenResult(result) {
  assert.equal(result.complete, true, 'Incomplete fullscreen capture');
  assert.equal(result.timingSource, 'submitted-frames', 'Fullscreen recovery needs submitted frames');
  assert(['hardware', 'software'].includes(result.rendering?.kind), 'Fullscreen renderer is unverified');
  assert.equal(result.errors.length, 0);
  assert.equal(result.discardedSimulationMs, 0);
  assert.equal(result.workload.state, 'playing');
  assert.equal(result.workload.diagnostics, false);
  for (const window of result.windows) {
    assert(window.maxDebt < 100 && window.maxSnapshotAge < 100,
      `${result.browser} ${window.event} exceeded transient debt or age bound`);
    assert(window.maxFrame < (result.rendering.kind === 'hardware' ? 100 : 1000),
      `${result.browser} ${window.event} froze during transition`);
    const recovery = window.recovery;
    assert(recovery && recovery.afterMs === fullscreenRecovery.afterMs
      && recovery.durationMs === fullscreenRecovery.durationMs && recovery.measuredMs >= fullscreenRecovery.durationMs,
      `${result.browser} ${window.event} has incomplete recovery evidence`);
    if (result.rendering.kind === 'hardware') {
      assert(recovery.fps >= 59 && recovery.p95 <= 18.5 && recovery.over25Fraction < .01,
        `${result.browser} ${window.event} did not recover frame budget`);
    }
    // Use the existing steady-state catch-up contract: isolated debt peaks can
    // recover, but final backlog and sustained growth cannot pass.
    assert(recovery.maxSnapshotAge < 100 && recovery.maxDebt < 100
      && Number.isFinite(recovery.finalDebt) && recovery.finalDebt < 2 * 1000 / 120
      && Number.isFinite(recovery.debtGrowthMs) && recovery.debtGrowthMs <= 1000 / 120,
      `${result.browser} ${window.event} did not recover timely updates`);
  }
}
