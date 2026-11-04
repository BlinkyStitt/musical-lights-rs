// Shared numeric acceptance for recorded submissions and worker progress.
// Device declarations and optional human feedback belong to the diagnostic UI.
// Temporary 30 FPS acceptance approved by Bryan; this does not cap rendering.
// Scale the former 60 Hz interval allowances to a 30 Hz frame budget.
export const hardwareFrameBudget = Object.freeze({ minimumFps: 30, maxP95Ms: 37,
  slowFrameMs: 50, maxSlowFraction: .01 });

// Routine CI and optional endurance captures share every acceptance limit.
const captureSeconds = Object.freeze({ standard: 120, endurance: 300 });
export function performanceCaptureTiming(profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(captureSeconds, profile)) throw new Error('Unknown performance capture profile');
  const warmupSeconds = 15, measurementSeconds = captureSeconds[profile];
  return Object.freeze({ profile, warmupSeconds, measurementSeconds,
    warmupMs: warmupSeconds * 1000, durationMs: (warmupSeconds + measurementSeconds) * 1000,
    minimumFrameMs: (measurementSeconds - 1) * 1000,
    deadlineMs: (warmupSeconds + measurementSeconds + 15) * 1000 });
}

export const summarize = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
};

export function evaluatePerformance({ intervals, renderCosts, progress, maxSnapshotAgeMs, invalid, hz, data, captureProfile }) {
  const timing = performanceCaptureTiming(captureProfile);
  const frames = summarize(intervals), render = summarize(renderCosts);
  const totalFrameMs = intervals.reduce((a, b) => a + b, 0);
  const fps = frames ? 1000 * intervals.length / totalFrameMs : 0;
  const slow = intervals.filter(x => x > hardwareFrameBudget.slowFrameMs).length / Math.max(1, intervals.length);
  const physics = summarize(data.physicsCosts.slice(timing.warmupSeconds * hz));
  const firstDebt = summarize(progress.slice(0, 10).map(sample => sample.debtMs));
  const lastDebt = summarize(progress.slice(-10).map(sample => sample.debtMs));
  const debtGrowthMs = firstDebt && lastDebt ? lastDebt.mean - firstDebt.mean : null;
  const stepMs = 1000 / hz;
  const simulationLagMs = data.elapsedMs - (data.finalTick - data.initialTick) * stepMs;
  const firstProgress = progress[0], lastProgress = progress.at(-1);
  const snapshotProgressDriftMs = firstProgress && lastProgress
    ? lastProgress.elapsedMs - firstProgress.elapsedMs - (lastProgress.tick - firstProgress.tick) * stepMs : null;
  return {
    summary: { fps, frameIntervalMs: frames, renderCostMs: render, physicsStepMs: physics, slowFrameMs: hardwareFrameBudget.slowFrameMs, slowFrameFraction: slow },
    debtGrowthMs, simulationLagMs, snapshotProgressDriftMs,
    numericPass: Boolean(hz === 120 && data.elapsedMs >= timing.durationMs && progress.length >= 20
      && intervals.every(value => Number.isFinite(value) && value > 0)
      && render && physics && frames && totalFrameMs >= timing.minimumFrameMs
      && fps >= hardwareFrameBudget.minimumFps && frames.p95 <= hardwareFrameBudget.maxP95Ms
      && slow < hardwareFrameBudget.maxSlowFraction && data.debt < 2 * stepMs
      && data.discardedSimulationMs === 0 && simulationLagMs >= -stepMs && simulationLagMs < 3 * stepMs
      && snapshotProgressDriftMs !== null && Math.abs(snapshotProgressDriftMs) < 3 * stepMs && maxSnapshotAgeMs < 100
      && debtGrowthMs !== null && debtGrowthMs <= stepMs && data.maxDebt < 100 && data.recordingOverflow === false && !invalid.length),
  };
}
