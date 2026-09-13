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

test('a steady quiet tone adapts its bars without holding white edges on', () => {
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
      const heights = Array.from({ length: 24 }, (_, band) => state[2 + 6 * band]);
      const strongest = heights.indexOf(Math.max(...heights));
      expect(state[5 + 6 * strongest], `white edge at ${second}s`).toBe(0);
      expect(p.value.wasm.processor_sones(p.value.processor)).toBeCloseTo(4.957, 3);
      if (second === 10) early = heights[strongest];
      if (second === 100) {
        expect(heights[strongest]).toBeGreaterThan(early + .05);
        expect(state.slice(0, 2)).toEqual(state.slice(146, 148));
        const fine = Array.from({ length: 240 }, (_, i) => state[148 + 6 * i]);
        // Finite-time gain approaches its target; the displayed meter rounds
        // to 100 while the unchanged aggregate still targets 80.
        expect(Math.round(Math.max(...fine) * 100)).toBe(100);
        expect(new Set(fine).size).toBeGreaterThan(24);
        for (let group = 0; group < 24; group++) {
          const sum = Array.from({ length: 10 }, (_, i) => state[153 + 6 * (group * 10 + i)]).reduce((a, b) => a + b, 0);
          expect(sum).toBeCloseTo(state[7 + 6 * group], 5);
        }
      }
    }
  }
  const louder = tone(4800, 1000, .04);
  expect(p.push(louder)).toBe(true);
  const attacked = p.snapshot();
  expect(Array.from({ length: 24 }, (_, band) => attacked[5 + 6 * band])).toContain(1);
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
    expect(p.messages[0].data.state.length).toBe(1588);
    expect(Object.keys(p.messages[0].data).sort()).toEqual(['calibration', 'clipped', 'sones', 'state', 'type']);
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
    expect(state[0]).toBe(3.998);
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
