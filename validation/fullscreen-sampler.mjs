// Observe the existing submitted-frame hook. An animation callback without a
// draw must not count as recovery, and collection must not add another clock.
export function recordFullscreenFrames(view) {
  const samples = [], report = view.report, frame = report.frame, recordTiming = view.recordTiming;
  let previous;
  view.recordTiming = true;
  report.frame = function (timestamp, cost) {
    frame.call(this, timestamp, cost);
    const g = view.layout[17];
    samples.push({ t: timestamp, frame: previous === undefined ? 0 : timestamp - previous,
      debt: view.metrics.debt, age: view.metrics.snapshotAgeMs, overload: view.metrics.overloadTicks,
      substepTotal: view.metrics.substepTotal, requestedSubstepTotal: view.metrics.requestedSubstepTotal,
      height: view.current[g], baseline: view.current[g+5], travel: view.current[g+6],
      configuredHeight: view.current[1], requested: view.input[32] });
    previous = timestamp;
  };
  return () => {
    report.frame = frame; view.recordTiming = recordTiming;
    return samples;
  };
}
