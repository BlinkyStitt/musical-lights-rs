// Frozen expectations before running the new detector on these held-out cases.
// Development: flash-fixtures.mjs, including the original 150/8600 Hz misses.
// Synthetic engineering labels, not human listening annotations.
export const heldOut = [
  // Confirmation fixtures frozen after the development bass-vibrato leakage
  // failure and before running the final 30% acoustic prominence policy.
  { name: 'confirmation-mid', frequency: 570, amplitude: .009, starts: [.35, 1.1], duration: .18, ramp: .01, expected: 2 },
  { name: 'confirmation-high', frequency: 7000, amplitude: .009, starts: [.35, 1.1], duration: .18, ramp: .01, expected: 2 },
  { name: 'confirmation-burst', frequency: 2150, amplitude: .025, starts: [.35, 1.1], duration: .02, ramp: .003, expected: 2 },
  { name: 'confirmation-swell', frequency: 570, amplitude: .04, starts: [.35], duration: 1.2, ramp: .7, expected: 0 },
  { name: 'low-mid-repeat', frequency: 250, amplitude: .012, starts: [.4, 1], duration: .24, ramp: .005, expected: 2 },
  { name: 'upper-mid-repeat', frequency: 3400, amplitude: .008, starts: [.4, 1], duration: .24, ramp: .015, expected: 2 },
  { name: 'soft-crest', frequency: 1600, amplitude: .02, starts: [.4], duration: .6, ramp: .025, expected: 1 },
  { name: 'articulated-train', frequency: 1000, amplitude: .02, starts: [.4, .52, .64, .76], duration: .06, ramp: .002, expectedAcoustic: 4 },
  { name: 'gentle-rise', frequency: 3400, amplitude: .02, starts: [.4], duration: 1.1, ramp: .6, expected: 0 },
  { name: 'short-burst', frequency: 1000, amplitude: .02, starts: [.4, 1], duration: .01, ramp: .001, expected: 2 },
];
export function corpusPCM({ frequency, amplitude, starts, duration, ramp }) {
  return Float32Array.from({ length: 96000 }, (_, i) => {
    const t = i / 48000;
    const envelope = Math.max(0, ...starts.map(start => t >= start && t < start + duration
      ? Math.min(1, (t - start) / ramp, (start + duration - t) / ramp) : 0));
    return amplitude * envelope * Math.sin(2 * Math.PI * frequency * t);
  });
}
