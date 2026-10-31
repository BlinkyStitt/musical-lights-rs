// Shared numeric acceptance for recorded submissions and worker progress.
// Device declarations and optional human feedback belong to the diagnostic UI.
export const summarize = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
};

export function evaluatePerformance({ intervals, renderCosts, progress, maxSnapshotAgeMs, invalid, hz, data }) {
  const frames = summarize(intervals), render = summarize(renderCosts);
  const fps = frames ? 1000 / frames.mean : 0;
  const over25 = intervals.filter(x => x > 25).length / Math.max(1, intervals.length);
  const physics = summarize(data.physicsCosts.slice(15 * hz));
  const firstDebt = summarize(progress.slice(0, 10).map(sample => sample.debtMs));
  const lastDebt = summarize(progress.slice(-10).map(sample => sample.debtMs));
  const debtGrowthMs = firstDebt && lastDebt ? lastDebt.mean - firstDebt.mean : null;
  const stepMs = 1000 / hz;
  const simulationLagMs = data.elapsedMs - (data.finalTick - data.initialTick) * stepMs;
  const firstProgress = progress[0], lastProgress = progress.at(-1);
  const snapshotProgressDriftMs = firstProgress && lastProgress
    ? lastProgress.elapsedMs - firstProgress.elapsedMs - (lastProgress.tick - firstProgress.tick) * stepMs : null;
  return {
    summary: { fps, frameIntervalMs: frames, renderCostMs: render, physicsStepMs: physics, over25Fraction: over25 },
    debtGrowthMs, simulationLagMs, snapshotProgressDriftMs,
    numericPass: Boolean(hz === 120 && data.elapsedMs >= 315000 && progress.length >= 20
      && intervals.every(value => Number.isFinite(value) && value > 0)
      && render && physics && frames && intervals.reduce((a, b) => a + b, 0) >= 299000
      && fps >= 59 && frames.p95 <= 18.5 && over25 < .01 && data.debt < 2 * stepMs
      && data.discardedSimulationMs === 0 && simulationLagMs >= -stepMs && simulationLagMs < 3 * stepMs
      && snapshotProgressDriftMs !== null && Math.abs(snapshotProgressDriftMs) < 3 * stepMs && maxSnapshotAgeMs < 100
      && debtGrowthMs !== null && debtGrowthMs <= stepMs && data.maxDebt < 100 && data.recordingOverflow === false && !invalid.length),
  };
}
