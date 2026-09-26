import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const bytes = await readFile(new URL('../../musical-lights-worklet/pkg/loudness.wasm', import.meta.url));
const module = new WebAssembly.Module(bytes);
const source = await readFile(new URL('../../musical-lights-worklet/processor.js', import.meta.url), 'utf8');
function processor(channel = 0) {
  const messages = [];
  const scope = { currentFrame: 0, sampleRate: 48000, WebAssembly, Float32Array, Float64Array,
    AudioWorkletProcessor: class { port = { postMessage: (data, transfer) => messages.push({ data, transfer }) }; },
    registerProcessor: (_, value) => { scope.Processor = value; },
  };
  vm.runInNewContext(source, scope);
  const value = new scope.Processor({ processorOptions: { module, channel, reducedMotion: false } });
  return { value, scope, messages, push(samples, extra) {
    const ok = value.process([extra ? [samples, extra] : [samples]]);
    scope.currentFrame += samples.length;
    return ok;
  }, snapshot() {
    value.wasm.processor_snapshot(value.processor);
    return [...value.snapshot];
  } };
}
function tone(length, frequency = 50, gain = 0.5) {
  return Float32Array.from({ length }, (_, i) => Math.sin(i * 2 * Math.PI * frequency / 48000) * gain);
}

test('treble emphasis reveals a weaker high tone while preserving its measured partial loudness', () => {
  const p = processor();
  const samples = tone(48000, 1000, .02);
  const treble = tone(48000, 8000, .01);
  for (let i = 0; i < samples.length; i++) samples[i] += treble[i];
  for (let i = 0; i < samples.length; i += 128) expect(p.push(samples.subarray(i, i + 128))).toBe(true);
  const state = p.snapshot();
  const measuredRatio = state[6 + 21 * 5] / state[6 + 8 * 5];
  const heightRatio = state[2 + 21 * 5] / state[2 + 8 * 5];
  expect(measuredRatio).toBeGreaterThan(.30);
  expect(measuredRatio).toBeLessThan(.34);
  expect(heightRatio).toBeCloseTo(2 * measuredRatio, 6);
  expect(heightRatio).toBeGreaterThan(.6);
  expect(state[2 + 23 * 5]).toBeLessThan(.00001);
});

test('a steady quiet tone adapts its bars without holding the white glow on', () => {
  const p = processor();
  // One exact second repeats without phase jumps, including across callbacks.
  const samples = tone(48000, 1000, .02);
  let early;
  for (let second = 1; second <= 100; second++) {
    for (let i = 0; i < samples.length; i += 128) {
      if (!p.push(samples.subarray(i, i + 128))) throw new Error(p.messages.at(-1).data.message);
    }
    if (second >= 10) {
      const state = p.snapshot();
      const heights = Array.from({ length: 24 }, (_, band) => state[2 + 5 * band]);
      const strongest = heights.indexOf(Math.max(...heights));
      expect(state[5 + 5 * strongest], `white glow at ${second}s`).toBe(0);
      expect(p.value.wasm.processor_sones(p.value.processor)).toBeCloseTo(4.957, 3);
      if (second === 10) early = heights[strongest];
      if (second === 100) {
        expect(heights[strongest]).toBeLessThan(early - .002);
        expect(state).toHaveLength(122);
        expect(Math.max(...heights)).toBeGreaterThan(.75);
        expect(Math.max(...heights)).toBeCloseTo(.8, 6);
      }
    }
  }
  const louder = tone(4800, 1000, .04);
  expect(p.push(louder)).toBe(true);
  const attacked = p.snapshot();
  expect(Array.from({ length: 24 }, (_, band) => attacked[5 + 5 * band])).toContain(1);
});

test('audio WASM has no imports and callback boundaries cannot change analysis or attacks', () => {
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const samples = tone(144_017);
  let reference;
  for (const size of [128, 800, 4096, 1]) {
    const p = processor();
    const initialMemory = p.value.wasm.memory.buffer.byteLength;
    for (let i = 0; i < samples.length; i += size) {
      if (!p.push(samples.subarray(i, i + size))) throw new Error(`DSP failed at sample ${i}: ${p.messages.at(-1).data.message}`);
    }
    const state = p.snapshot();
    if (!reference) reference = state;
    expect(state).toEqual(reference);
    expect(p.value.wasm.processor_sones(p.value.processor)).toBeGreaterThan(0);
    expect(p.value.wasm.memory.buffer.byteLength).toBe(initialMemory);
    // A stalled UI has only one queued snapshot. No PCM crosses its port.
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0].data.type).toBe('frame');
    expect(p.messages[0].data.state).toBeInstanceOf(Float64Array);
    expect(p.messages[0].data.state.length).toBe(122);
    expect(Object.keys(p.messages[0].data).sort()).toEqual(['calibration', 'clipped', 'sessionId', 'sones', 'state', 'type']);
    p.value.port.onmessage({ data: { type: 'ack' } });
    p.push(tone(128));
    expect(p.messages).toHaveLength(2);
    expect(p.messages[1].data.state[0]).toBeGreaterThan(3);
  }
});

test('selected channel survives opposite phase and invalid input or gaps stop analysis', () => {
  const samples = tone(48000, 1000, .1);
  const inverted = samples.map(v => -v);
  const a = processor(0), b = processor(1);
  expect(a.push(samples, inverted)).toBe(true);
  expect(b.push(samples, inverted)).toBe(true);
  expect(a.snapshot()).toEqual(b.snapshot());
  expect(a.value.wasm.processor_sones(a.value.processor)).toBeGreaterThan(1);
  const missing = processor(2);
  expect(missing.push(new Float32Array(128))).toBe(false);
  expect(missing.messages.at(-1).data.message).toContain('channel 3');
  const bad = new Float32Array(128); bad[108] = NaN;
  expect(a.push(bad)).toBe(false);
  expect(a.messages.at(-1).data.message).toContain('sample 108');
  expect(a.push(new Float32Array(128))).toBe(false);
  b.scope.currentFrame += 128;
  expect(b.push(new Float32Array(128), new Float32Array(128))).toBe(false);
  expect(b.messages.at(-1).data.message).toContain('clock jumped by 128 samples');
});

test('reference calibration uses exactly three seconds across callback partitions', () => {
  const samples = tone(192_017, 1000, .5);
  let reference;
  for (const size of [128, 800, 4096]) {
    const p = processor();
    p.value.port.onmessage({ data: { type: 'calibrate', dbSpl: 94 } });
    for (let i = 0; i < samples.length; i += size) {
      if (!p.push(samples.subarray(i, i + size))) throw new Error(`DSP failed at sample ${i}: ${p.messages.at(-1).data.message}`);
    }
    const pressure = p.value.wasm.processor_calibration_result(p.value.processor);
    expect(pressure).toBeCloseTo(2e-5 * 10 ** (94 / 20) / (.5 / Math.sqrt(2)), 5);
    const state = p.snapshot();
    if (!reference) reference = state;
    expect(state).toEqual(reference);
    expect(state[0]).toBe(4.0); // End-exclusive causal partial-loudness window.
  }
});

test('worklet keeps warmed audio processing below its host real-time budget', () => {
  const p = processor();
  const samples = tone(192000, 80, .4);
  for (let i = 0; i < samples.length; i += 128) p.push(samples.subarray(i, i + 128));
  const start = performance.now();
  for (let i = 0; i < samples.length; i += 128) p.push(samples.subarray(i, i + 128));
  const elapsed = performance.now() - start;
  console.log(`WASM processor: 4 s audio / ${elapsed.toFixed(2)} ms host CPU; ${(elapsed / 40).toFixed(3)}% of real time; ${p.value.wasm.memory.buffer.byteLength} memory bytes`);
  expect(p.value.failed).toBe(false);
  expect(elapsed).toBeLessThan(4000);
});

test('diagnostic frames preserve all 240 measurements and bound a stalled receiver', () => {
  const pcm = tone(24000, 1000, .002);
  let reference;
  for (const size of [128, 800, 4096]) {
    const p = processor();
    const w = p.value.wasm, h = p.value.processor;
    w.processor_trace_enable(h, 1);
    const rows = [];
    for (let i = 0; i < pcm.length; i += size) {
      expect(p.push(pcm.subarray(i, i + size))).toBe(true);
      const stride = w.processor_trace_stride(h);
      const data = new Float64Array(w.memory.buffer, w.processor_trace_ptr(h), w.processor_trace_count(h) * stride);
      for (let j = 0; j < data.length; j += stride) rows.push(Array.from(data.subarray(j, j + stride)));
      w.processor_trace_clear(h);
    }
    expect(w.processor_trace_dropped(h)).toBe(0);
    expect(rows.length).toBe(250);
    if (reference) expect(rows).toEqual(reference);
    else reference = rows;
    for (const row of rows) {
      const bands = row.slice(316, 340), peak = Math.max(...bands);
      const targets = bands.map((_, i) => row[342 + 5 * i]), top = Math.max(...targets);
      for (let i = 0; i < 24; i++) {
        const integrated = row.slice(2 + 10 * i, 12 + 10 * i).reduce((a, b) => a + b, 0) * .1;
        expect(row[242 + i]).toBeCloseTo(integrated, 6);
        if (peak) expect(targets[i] / top).toBeCloseTo(bands[i] / peak, 6);
      }
    }
    expect(p.push(pcm)).toBe(true);
    expect(w.processor_trace_count(h)).toBe(64);
    expect(w.processor_trace_dropped(h)).toBeGreaterThan(0);
    expect(p.messages).toHaveLength(1);
  }
});
