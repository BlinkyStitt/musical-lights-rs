// Historical traces retain their original layouts. Reject unknown schemas.
export function traceLayout(stride) {
  if (stride === 463) return { version: 4, measured: 291, gain: 315, novelty: 316, magnitude: 340, display: 364, header: 3, filtered: 1, sample: 266, step: 4, model: 'MGB1997-GM2002-source-bands', mapping: 'proportional-shared-one-euro' };
  if (stride === 462) return { version: 3, measured: 291, emphasized: 316, gain: 315, display: 340, sample: 266, step: 5, model: 'MGB1997-GM2002-source-bands', mapping: 'treble-shelf-2x' };
  if (stride === 438) return { version: 2, measured: 291, gain: 315, display: 316, sample: 266, step: 5, model: 'MGB1997-GM2002-source-bands' };
  if (stride === 389) return { version: 1, measured: 242, gain: 266, display: 267, sample: 0, step: 5, model: 'ISO532-1-integrals' };
  if (stride === 413) return { version: 1, measured: 242, gain: 266, display: 267, sample: 0, step: 6, model: 'ISO532-1-integrals-compressed' };
  throw new Error(`Unknown loudness trace stride: ${stride}`);
}
