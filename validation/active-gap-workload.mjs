// Retain the three seeds from the failed NUC1 captures on 2026-10-31.
// Each runner uses the recorded initial seed for its view.
export const activeGapSeeds = Object.freeze({
  normal: 3086797548,
  'portrait-fullscreen': 4156900579,
  'landscape-fullscreen': 1360618947,
});

// Runs before application startup. Match fullscreen-timing.mjs's existing
// single-word seed control while retaining real randomness for other requests.
export function setActiveGapSeed(seed) {
  const random = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = values => {
    if (values instanceof Uint32Array && values.length === 1) { values[0] = seed; return values; }
    return random(values);
  };
}
