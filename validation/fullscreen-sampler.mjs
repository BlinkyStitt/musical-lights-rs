// Observe the existing submitted-frame hook. An animation callback without a
// draw must not count as recovery, and collection must not add another clock.
export function recordFullscreenFrames(view) {
  const samples = [], report = view.report, frame = report.frame, recordTiming = view.recordTiming;
  const onFrame = view.onFrame, ready = view.gpuFrames.ready;
  let previous, lastAnimation, callbacks = 0, backpressure = 0, maxAnimationGapMs = 0;
  view.onFrame = function (...args) {
    onFrame.apply(this, args);
    if (args[1]) return;
    callbacks++;
    if (lastAnimation !== undefined) maxAnimationGapMs = Math.max(maxAnimationGapMs, args[0] - lastAnimation);
    lastAnimation = args[0];
  };
  view.gpuFrames.ready = function () {
    const available = ready.call(this);
    if (!available) backpressure++;
    return available;
  };
  view.recordTiming = true;
  report.frame = function (timestamp, cost) {
    frame.call(this, timestamp, cost);
    const g = view.layout[17];
    samples.push({ t: timestamp, frame: previous === undefined ? 0 : timestamp - previous,
      cost, callbacks, backpressure, maxAnimationGapMs,
      debt: view.metrics.debt, age: view.metrics.snapshotAgeMs, overload: view.metrics.overloadTicks,
      substepTotal: view.metrics.substepTotal, requestedSubstepTotal: view.metrics.requestedSubstepTotal,
      height: view.current[g], baseline: view.current[g+5], travel: view.current[g+6],
      configuredHeight: view.current[1], requested: view.input[32] });
    previous = timestamp; callbacks = backpressure = maxAnimationGapMs = 0;
  };
  return () => {
    report.frame = frame; view.recordTiming = recordTiming;
    view.onFrame = onFrame; view.gpuFrames.ready = ready;
    return samples;
  };
}
