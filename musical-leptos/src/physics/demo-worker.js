// Silent visual sine wave across all 24 bands. This is an idle animation,
// independent of audio analysis; it neither opens audio nor fabricates sones.
let core, peak, sequence = 0, previousTime, elapsed = 0, phase = 0;
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      const response = await fetch(new URL('../loudness/loudness.wasm', import.meta.url));
      if (!response.ok) throw new Error(`Cannot load idle animation: HTTP ${response.status}`);
      core = (await WebAssembly.instantiate(await response.arrayBuffer())).instance.exports;
      peak = core.preview_create();
      self.postMessage({ type: 'ready' });
    } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
  }
  else if (data.type === 'pulse') {
    const state = new Float64Array(99), time = data.time;
    const dt = previousTime == null ? 0 : Math.max(0, time - previousTime);
    previousTime = Math.max(previousTime ?? time, time); elapsed += dt;
    if (!data.reduced) phase += dt * (data.direction ?? 1);
    state[0] = time;
    for (let i = 0; i < 24; i++) {
      state[4 + i * 4] = core.preview_level(phase, i, Number(data.reduced));
      state[5 + i * 4] = -1;
    }
    if (core.preview_accent(peak, elapsed, Number(data.reduced))) sequence++;
    self.postMessage({ type: 'frame', state, accentSequence: sequence });
  }
};
