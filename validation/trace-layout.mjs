// One current measurement/transport contract. Historical reports document old schemas.
export function traceLayout(stride) {
  if (stride !== 472) throw new Error(`Unknown loudness trace stride: ${stride}`);
  return { version: 8, measured: 242, gain: 266, novelty: 267, magnitude: 291,
    display: 315, header: 3, filtered: 1, sample: 0, step: 4, acoustic: 417, suppressed: 441, gateState: 465, revision: 466, visual: 467, segment: 471,
    model: 'ISO532-1-one-Bark-integrals', mapping: 'proportional-shared-one-euro' };
}
