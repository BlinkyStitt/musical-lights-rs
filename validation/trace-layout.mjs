// One current measurement/transport contract. Historical reports document old schemas.
export function traceLayout(stride) {
  if (stride !== 466) throw new Error(`Unknown loudness trace stride: ${stride}`);
  return { version: 7, measured: 242, gain: 266, novelty: 267, magnitude: 291,
    display: 315, header: 3, filtered: 1, sample: 0, step: 4, acoustic: 417, suppressed: 441, segment: 465,
    model: 'ISO532-1-one-Bark-integrals', mapping: 'proportional-shared-one-euro' };
}
