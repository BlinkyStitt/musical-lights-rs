import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

export function fullscreenWindows(data) {
  return data.marks.map(({ event, t }) => {
    const points = data.samples.filter(p => p.t >= t && p.t < t + 2000);
    const before = data.samples.findLast(p => p.t < t);
    assert(before, event + ' has no preceding frame');
    assert(points.length > 0, event + ' has no measured frames');
    const frames = points.map(p => p.frame).sort((a, b) => a - b);
    return { event, fps: 1000 * frames.length / frames.reduce((a, b) => a + b, 0),
      p95: frames[Math.ceil(frames.length * .95) - 1], maxFrame: frames.at(-1),
      over25Fraction: frames.filter(x => x > 25).length / frames.length,
      maxDebt: Math.max(...points.map(p => p.debt)), maxSnapshotAge: Math.max(...points.map(p => p.age)),
      overloadTicks: points.at(-1).overload - before.overload,
      substeps: points.at(-1).substepTotal - before.substepTotal,
      requestedSubsteps: points.at(-1).requestedSubstepTotal - before.requestedSubstepTotal,
      fromHeight: before.height, toHeight: points.at(-1).height };
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

// Software frame rates remain reported. Hardware retains the smooth-motion
// limits; both paths must preserve live audio and timely simulation updates.
export function validateFullscreenResult(result) {
  assert.equal(result.complete, true, 'Incomplete fullscreen capture');
  assert(['hardware', 'software'].includes(result.rendering?.kind), 'Fullscreen renderer is unverified');
  assert.equal(result.errors.length, 0);
  assert.equal(result.discardedSimulationMs, 0);
  assert.equal(result.workload.state, 'playing');
  assert.equal(result.workload.diagnostics, false);
  for (const window of result.windows) {
    if (result.rendering.kind === 'hardware') {
      assert(window.fps >= 59 && window.p95 <= 18.5 && window.over25Fraction < .01,
        `${result.browser} ${window.event} frame budget exceeded`);
    }
    assert(window.maxSnapshotAge < 100 && window.maxDebt < 2 * 1000 / 120,
      `${result.browser} ${window.event} lost timely updates`);
  }
}
