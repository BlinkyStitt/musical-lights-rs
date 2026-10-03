import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { heldOut, corpusPCM } from '../partial/audit-corpus.mjs';
import { flashPCM, flashTrace, flashSummary } from '../partial/flash-fixtures.mjs';

const bytes = await readFile(new URL('../../musical-lights-worklet/pkg/loudness.wasm', import.meta.url));
const module = new WebAssembly.Module(bytes);
const source = await readFile(new URL('../../musical-lights-worklet/processor.js', import.meta.url), 'utf8');
function processor(channel = 0) {
  const messages = [];
  const scope = { currentFrame: 0, sampleRate: 48000, WebAssembly, Float32Array, Float64Array,
    AudioWorkletProcessor: class { port = { postMessage(data, transfer = []) {
      // Real MessagePort delivery clones the packet and detaches transferred
      // buffers. Keeping the original object can conceal buffer reuse bugs.
      messages.push({ data: structuredClone(data, { transfer }) });
      for (const buffer of transfer) assert.equal(buffer.byteLength, 0);
    } }; },
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

for (const [name, frequency, band, peak] of [['bass', 150, 1, .466], ['treble', 8600, 21, .566]]) {
  test(`production WASM flashes both ${name} attacks below 60 percent height`, () => {
    const rows = flashTrace(module, flashPCM('repeated', frequency, .006));
    const summary = flashSummary(rows, band);
    expect(summary.peakFiltered).toBeCloseTo(peak, 2);
    expect(summary.attacks).toHaveLength(2);
    for (const [i, onset] of [.4, 1].entries()) {
      expect(summary.attacks[i]).toBeGreaterThan(onset);
      expect(summary.attacks[i]).toBeLessThan(onset + .1);
    }
    // No extra band or offset flashes, including after both notes have stopped.
    const events = rows.flatMap((_, i) => i === 0 ? [] : Array.from({ length: 24 }, (_, band) =>
      rows[i][369 + 4 * band] !== rows[i - 1][369 + 4 * band] ? rows[i][369 + 4 * band] : -1)).filter(at => at >= 0);
    expect(events).toEqual(summary.attacks);
  });
}

test('production WASM rejects sustain modulation, swells, masked notes, offsets and silence', () => {
  for (const frequency of [150, 1000, 8600]) {
    for (const kind of ['sustain', 'vibrato', 'tremolo', 'swell', 'masked', 'silence']) {
      const rows = flashTrace(module, flashPCM(kind, frequency));
      const attacks = Array.from({ length: 24 }, (_, band) => flashSummary(rows, band).attacks).flat();
      const label = `${kind} at ${frequency} Hz`;
      if (['sustain', 'vibrato', 'tremolo'].includes(kind)) {
        expect(attacks, label).toHaveLength(1);
        expect(attacks[0], label).toBeGreaterThan(.4);
        expect(attacks[0], label).toBeLessThan(.5);
      } else expect(attacks, label).toEqual([]);
    }
  }
});

test('production WASM preserves the measured balance of a weaker high tone', () => {
  const p = processor();
  const samples = tone(48000, 1000, .02);
  const treble = tone(48000, 8000, .01);
  for (let i = 0; i < samples.length; i++) samples[i] += treble[i];
  for (let i = 0; i < samples.length; i += 128) expect(p.push(samples.subarray(i, i + 128))).toBe(true);
  const state = p.snapshot();
  const measuredRatio = state[6 + 21 * 4] / state[6 + 8 * 4];
  const heightRatio = state[3 + 21 * 4] / state[3 + 8 * 4];
  expect(measuredRatio).toBeGreaterThan(.30);
  expect(measuredRatio).toBeLessThan(.34);
  expect(heightRatio).toBeCloseTo(measuredRatio, 6);
  expect(heightRatio).toBeGreaterThan(.30);
  expect(state[3 + 23 * 4]).toBeLessThan(.00001);
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
      const heights = Array.from({ length: 24 }, (_, band) => state[4 + 4 * band]);
      const strongest = heights.indexOf(Math.max(...heights));
      expect(state[5 + 4 * strongest], `white attack timestamp at ${second}s`).toBeLessThan(state[0] - .1);
      expect(p.value.wasm.processor_sones(p.value.processor)).toBeCloseTo(4.957, 3);
      if (second === 10) early = heights[strongest];
      if (second === 100) {
        expect(heights[strongest]).toBeLessThan(early - .002);
        expect(state).toHaveLength(99);
        expect(Math.max(...heights)).toBeGreaterThan(.75);
        expect(Math.max(...heights)).toBeCloseTo(.8, 6);
      }
    }
  }
  // A distinct new articulation after a quiet gap, rather than a higher retained peak.
  expect(p.push(new Float32Array(12000))).toBe(true);
  const louder = tone(4800, 1000, .04);
  expect(p.push(louder)).toBe(true);
  const attacked = p.snapshot();
  expect(Array.from({ length: 24 }, (_, band) => attacked[5 + 4 * band]).some(at => at > attacked[0] - .1)).toBe(true);
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
    expect(p.messages[0].data.state.length).toBe(99);
    expect(Object.keys(p.messages[0].data).sort()).toEqual(['calibration', 'clipped', 'sessionId', 'sones', 'state', 'tempo', 'tempoConfidence', 'type']);
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
    // This manual trace consumer enables recording after construction. Lazy
    // allocation can grow WASM memory, so renew its views before processing.
    // The production processor enables diagnostics before constructing views.
    p.value.input = new Float32Array(w.memory.buffer, w.processor_input(h), w.processor_capacity(h));
    p.value.snapshot = new Float64Array(w.memory.buffer, w.processor_snapshot(h), w.processor_snapshot_length(h));
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
    if (reference) assert.deepEqual(rows, reference);
    else reference = rows;
    let integrationError = 0, ratioError = 0;
    for (const row of rows) {
      const bands = row.slice(291, 315), peak = Math.max(...bands);
      const targets = bands.map((_, i) => row[367 + 4 * i]), top = Math.max(...targets);
      for (let i = 0; i < 24; i++) {
        const integrated = row.slice(2 + 10 * i, 12 + 10 * i).reduce((a, b) => a + b, 0) * .1;
        integrationError = Math.max(integrationError, Math.abs(row[242 + i] - integrated));
        if (peak) ratioError = Math.max(ratioError, Math.abs(targets[i] / top - bands[i] / peak));
      }
    }
    expect(integrationError).toBeLessThan(5e-7);
    expect(ratioError).toBeLessThan(5e-7);
    expect(p.push(pcm)).toBe(true);
    expect(w.processor_trace_count(h)).toBe(64);
    expect(w.processor_trace_dropped(h)).toBeGreaterThan(0);
    expect(p.messages).toHaveLength(1);
  }
});

test('equivalent pressure is invariant to recording gain, calibration, callback size and Reduced Motion', () => {
  const pcm = flashPCM('repeated', 150, .006);
  const reference = flashTrace(module, pcm);
  for (const [factor, calibration, chunk, reduced] of [[.5, 4, 96, false], [2, 1, 800, true]]) {
    const actual = flashTrace(module, pcm.map(x => x * factor), reduced, { calibration, chunk });
    expect(actual).toHaveLength(reference.length);
    let maxError = 0;
    for (let n = 0; n < actual.length; n++) {
      // Reduced Motion is a rendering flag, not a detector input.
      for (let i = 0; i < actual[n].length; i++) {
        if (i !== 365) maxError = Math.max(maxError, Math.abs(actual[n][i] - reference[n][i]));
      }
    }
    expect(maxError).toBeLessThan(5e-11);
    expect(flashSummary(actual, 1).attacks).toHaveLength(2);
  }
});

for (const fixture of heldOut) {
  test(`held-out acoustic fixture: ${fixture.name}`, () => {
    const rows = flashTrace(module, corpusPCM(fixture));
    const events = Array.from({ length: 24 }, (_, b) => [...new Set(rows.map(r => r[463 + b]).filter(at => at >= 0))]).flat();
    const flashes = Array.from({ length: 24 }, (_, b) => flashSummary(rows, b).attacks).flat();
    expect(events).toHaveLength(fixture.expectedAcoustic ?? fixture.expected);
    if (fixture.expected !== undefined) expect(flashes).toHaveLength(fixture.expected);
    for (const at of events) expect(fixture.starts.some(start => at > start && at < start + .1)).toBe(true);
    if (fixture.name === 'articulated-train') {
      expect(flashes).toEqual([events[0], events[2]]);
      expect(rows.at(-1)[487 + 8]).toBe(2);
    }
  });
}
