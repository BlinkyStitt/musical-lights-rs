// Silent idle preview. Run deterministic sine PCM through the production DSP;
// no AudioContext, microphone, or autoplay permission is needed.
let wasm, processor, input, snapshot, sample = 0, phase = 0, running = false;
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    const response = await fetch(data.wasm);
    if (!response.ok) throw new Error(`Cannot load preview analysis: HTTP ${response.status}`);
    wasm = (await WebAssembly.instantiate(await response.arrayBuffer())).instance.exports;
    processor = wasm.processor_create(0, 2, Number(data.reduced));
    input = new Float32Array(wasm.memory.buffer, wasm.processor_input(processor), wasm.processor_capacity(processor));
    snapshot = new Float64Array(wasm.memory.buffer, wasm.processor_snapshot(processor), wasm.processor_snapshot_length(processor));
    running = true;
    self.postMessage({ type: 'ready' });
  } else if (data.type === 'pulse' && running) {
    wasm.processor_motion(processor, Number(data.reduced));
    // One 800-sample block per requested visual frame, paced on the caller clock.
    const length = 800;
    for (let i = 0; i < length; i++) {
      const t = (sample + i) / 48000;
      const frequency = 1000 * 2 ** (2 * Math.sin(2 * Math.PI * t / 16));
      const amplitude = .012 * (.55 + .45 * Math.sin(2 * Math.PI * t / 2));
      phase = (phase + 2 * Math.PI * frequency / 48000) % (2 * Math.PI);
      input[i] = amplitude * Math.sin(phase);
    }
    if (!wasm.processor_process(processor, length, BigInt(sample))) throw new Error('Preview analysis failed');
    sample += length;
    wasm.processor_snapshot(processor);
    self.postMessage({ type: 'frame', state: snapshot.slice() });
  }
};
