import { test } from 'node:test';
import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { heldOut, corpusPCM } from '../partial/audit-corpus.mjs';
import { flashPCM, flashTrace, flashSummary } from '../partial/flash-fixtures.mjs';

const bytes = await readFile(new URL('../../musical-lights-worklet/pkg/loudness.wasm', import.meta.url));
const module = new WebAssembly.Module(bytes);
const source = await readFile(new URL('../../musical-lights-worklet/processor.js', import.meta.url), 'utf8');
function processor(channel = 0, diagnostics = false, options = {}) {
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
  const value = new scope.Processor({ processorOptions: { module, channel, diagnostics, reducedMotion: false, ...options } });
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

for (const [name, frequency, band] of [['bass', 150, 1], ['treble', 8600, 21]]) {
  test(`production WASM flashes both ${name} soft attacks`, () => {
    const rows = flashTrace(module, flashPCM('repeated', frequency, .006));
    const summary = flashSummary(rows, band);
    expect(summary.peakFiltered).toBeGreaterThan(0);
    expect(summary.peakFiltered).toBeLessThanOrEqual(1);
    expect(summary.attacks).toHaveLength(2);
    for (const [i, onset] of [.4, 1].entries()) {
      expect(summary.attacks[i]).toBeGreaterThan(onset);
      expect(summary.attacks[i]).toBeLessThan(onset + .1);
    }
    // Auditory spreading can excite adjacent bands. Every flash must follow a real onset.
    const events = rows.flatMap((_, i) => i === 0 ? [] : Array.from({ length: 24 }, (_, band) =>
      rows[i][320 + 4 * band] !== rows[i - 1][320 + 4 * band] ? rows[i][320 + 4 * band] : -1)).filter(at => at >= 0);
    for (const at of events) expect([.4, 1].some(onset => at > onset && at < onset + .1)).toBe(true);
  });
}

test('production WASM rejects sustain modulation, swells, masked notes, offsets and silence', () => {
  for (const frequency of [150, 1000, 8600]) {
    for (const kind of ['sustain', 'vibrato', 'tremolo', 'swell', 'masked', 'silence']) {
      const rows = flashTrace(module, flashPCM(kind, frequency));
      const attacks = Array.from({ length: 24 }, (_, band) => flashSummary(rows, band).attacks).flat();
      const label = `${kind} at ${frequency} Hz`;
      if (['sustain', 'vibrato', 'tremolo'].includes(kind)) {
        expect(attackGroups(attacks), label).toHaveLength(1);
        for (const at of attacks) {
          expect(at, label).toBeGreaterThan(.4);
          expect(at, label).toBeLessThan(.5);
        }
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
  expect(measuredRatio).toBeGreaterThan(0);
  expect(measuredRatio).toBeLessThan(1);
  expect(heightRatio).toBeCloseTo(measuredRatio, 6);
  for (let band = 0; band < 24; band++) {
    expect(state[3 + band * 4] / state[3 + 8 * 4]).toBeCloseTo(state[6 + band * 4] / state[6 + 8 * 4], 6);
  }
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
        expect(state).toHaveLength(102);
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
    expect(p.messages[0].data.state.length).toBe(102);
    expect(Object.keys(p.messages[0].data).sort()).toEqual(['accentSequence', 'calibration', 'clipped', 'continuity', 'quantum', 'readouts', 'sessionId', 'sones', 'state', 'tempo', 'tempoConfidence', 'type']);
    expect(Number.isInteger(p.messages[0].data.accentSequence)).toBe(true);
    p.value.port.onmessage({ data: { type: 'ack' } });
    p.push(tone(128));
    expect(p.messages).toHaveLength(2);
    expect(p.messages[1].data.state[0]).toBeGreaterThan(3);
  }
});

test('selected channel survives opposite phase and invalid PCM stops analysis', () => {
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
  const invalid = new Float32Array(128); invalid[0] = Infinity;
  expect(b.push(new Float32Array(128), invalid)).toBe(false);
  expect(b.messages.at(-1).data.message).toContain('not finite');
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
    expect(state[0]).toBe(3.998); // ISO sample grid, independent of callback size.
  }
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
      const bands = row.slice(242, 266), peak = Math.max(...bands);
      const targets = bands.map((_, i) => row[318 + 4 * i]), top = Math.max(...targets);
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
        if (i !== 316) maxError = Math.max(maxError, Math.abs(actual[n][i] - reference[n][i]));
      }
    }
    expect(maxError).toBeLessThan(5e-11);
    expect(flashSummary(actual, 1).attacks).toHaveLength(2);
  }
});

function attackGroups(times) {
  // A single note can excite several Bark bands. Group those events, while
  // retaining the per-event onset and no-offset checks below.
  return [...times].sort((a, b) => a - b).filter((at, i, all) => !i || at - all[i - 1] > .06);
}

for (const fixture of heldOut) {
  test(`held-out acoustic fixture: ${fixture.name}`, () => {
    const rows = flashTrace(module, corpusPCM(fixture));
    const events = Array.from({ length: 24 }, (_, b) => [...new Set(rows.map(r => r[417 + b]).filter(at => at >= 0))]).flat();
    const flashes = Array.from({ length: 24 }, (_, b) => flashSummary(rows, b).attacks).flat();
    expect(attackGroups(events)).toHaveLength(fixture.expectedAcoustic ?? fixture.expected);
    if (fixture.expected !== undefined) expect(attackGroups(flashes)).toHaveLength(fixture.expected);
    for (const at of events) expect(fixture.starts.some(start => at > start && at < start + .1)).toBe(true);
    if (fixture.name === 'articulated-train') {
      expect(attackGroups(flashes)).toEqual([attackGroups(events)[0], attackGroups(events)[2]]);
      expect(rows.at(-1)[441 + 8]).toBe(2);
    }
  });
}


test('diagnostics retain the actual nonzero input sample origin', () => {
  const p = processor(0, true); p.scope.currentFrame = 1024;
  const pcm = tone(4096, 3400, .02), rows = [];
  for (let at = 0; at < pcm.length; at += 128) {
    p.value.pending = false;
    expect(p.push(pcm.subarray(at, at + 128))).toBe(true);
  }
  for (const { data } of p.messages) {
    expect(data.inputStartSample).toBe(1024);
    for (let at = 0; at < data.trace.length; at += data.traceStride) rows.push(Array.from(data.trace.slice(at, at + data.traceStride)));
  }
  const reference = flashTrace(module, pcm, false, { firstSample: 1024 });
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row).toEqual(Array.from(reference.find(expected => expected[0] === row[0])));
});

test('browser and Rust share defaults and reject invalid audio settings before capture', async () => {
  const { DEFAULT_AUDIO } = await import('../../musical-leptos/src/audio_controls.js');
  const w = new WebAssembly.Instance(module).exports, h = w.processor_create(1, 2, 0);
  try {
    const settings = new Float64Array(w.memory.buffer, w.processor_settings_ptr(h), w.processor_settings_length(h));
    expect([...settings]).toEqual([...DEFAULT_AUDIO]);
    settings[23] = .25; expect(w.processor_configure(h)).toBe(1);
    settings[18] = 190; settings[19] = 100; expect(w.processor_configure(h)).toBe(0);
  } finally { w.processor_destroy(h); }
});


test('live settings apply at a fixed boundary and acknowledge only the active session and revision', async () => {
  const { DEFAULT_AUDIO } = await import('../../musical-leptos/src/audio_controls.js');
  const p = processor(0, false, { sessionId: 41, settings: [...DEFAULT_AUDIO] });
  assert(p.push(new Float32Array(128)));
  const send = data => p.value.port.onmessage({ data });
  const update = { type: 'settings', sessionId: 41, revision: 2, settings: [...DEFAULT_AUDIO], visual: [0, -60, 0, 2] };
  send({ ...update, sessionId: 40 });
  assert.equal(p.value.wasm.processor_revision(p.value.processor), 1);
  send(update);
  assert.equal(p.value.wasm.processor_revision(p.value.processor), 1);
  assert(p.push(new Float32Array(128)));
  assert.equal(p.value.wasm.processor_revision(p.value.processor), 2);
  assert.deepEqual(p.messages.filter(x => x.data.type === 'settings-ack').at(-1).data,
    { type: 'settings-ack', sessionId: 41, revision: 2, accepted: true });
  assert.equal(p.snapshot()[100], 2);
  const count = p.messages.length;
  send(update); // Duplicate cannot reapply.
  assert.equal(p.messages.length, count);
  send({ ...update, revision: 3, visual: [1, -100, 0, 2] });
  assert.equal(p.messages.at(-1).data.accepted, false);
  assert(p.push(new Float32Array(128)));
  assert.equal(p.value.wasm.processor_revision(p.value.processor), 2);
  assert.equal(p.value.wasm.processor_accent_sequence(p.value.processor), 0);
});

test('rejected visual settings cannot poison a later calibration or its accepted gain', async () => {
  const { DEFAULT_AUDIO } = await import('../../musical-leptos/src/audio_controls.js');
  const p = processor(0, false, { sessionId: 71, settings: [...DEFAULT_AUDIO], visual: [0, -60, 0, 2] });
  const samples = tone(48000, 1000, .002);
  assert(p.push(samples.subarray(0, 128)));
  p.value.port.onmessage({ data: { type: 'settings', sessionId: 71, revision: 2, settings: [...DEFAULT_AUDIO], visual: [1, -100, 0, 3] } });
  p.value.port.onmessage({ data: { type: 'calibrate', dbSpl: 60 } });
  for (let sample = 128; sample < 145000; sample += 128) assert(p.push(samples.subarray(sample % 48000, sample % 48000 + 128)));
  assert.equal(p.value.failed, false);
  assert.equal(p.snapshot()[100], 2);
});

test('live RMS tuning uses the same analysis boundary for every callback size', async () => {
  const { DEFAULT_AUDIO } = await import('../../musical-leptos/src/audio_controls.js');
  const samples = tone(24000, 1000, .02);
  let reference;
  for (const size of [1, 13, 128, 4096]) {
    const p = processor(0, false, { sessionId: 93, settings: [...DEFAULT_AUDIO] });
    for (let at = 0; at < 12000; at += size) assert(p.push(samples.subarray(at, Math.min(at + size, 12000))));
    const settings = [...DEFAULT_AUDIO]; settings[23] = .5;
    p.value.port.onmessage({ data: { type: 'settings', sessionId: 93, revision: 2, settings, visual: [0, -60, 1, 1] } });
    for (let at = 12000; at < samples.length; at += size) assert(p.push(samples.subarray(at, Math.min(at + size, samples.length))));
    const w = p.value.wasm, h = p.value.processor;
    const actual = [...new Float64Array(w.memory.buffer, w.processor_readouts(h), 4)];
    if (!reference) reference = actual;
    else expect(actual).toEqual(reference);
    assert.equal(w.processor_revision(h), 2);
  }
});

test('initial microphone gate survives saved-settings configuration while digital playback bypasses it', async () => {
  const { DEFAULT_AUDIO } = await import('../../musical-leptos/src/audio_controls.js');
  for (const microphone of [true, false]) {
    const p = processor(0, false, { sessionId: 117, microphone, settings: [...DEFAULT_AUDIO], visual: [1, -20, 1, 1] });
    const samples = tone(24000, 1000, .005);
    for (let at = 0; at < samples.length; at += 128) assert(p.push(samples.subarray(at, at + 128)));
    assert(p.value.wasm.processor_sones(p.value.processor) > 0);
    const targets = Array.from({length:24},(_,band)=>p.snapshot()[3 + band*4]);
    if (microphone) assert(targets.every(value=>value===0), 'saved settings must retain microphone gating');
    else assert(targets.some(value=>value>0), 'digital input must bypass the gate');
  }
});


test('forward gaps reject the block before an explicit reset and preserve raw sample accounting', () => {
  const p = processor(), w = p.value.wasm, h = p.value.processor;
  expect(p.push(new Float32Array(128))).toBe(true);
  new Float32Array(w.memory.buffer, w.processor_input(h), 128).fill(1);
  const before = w.processor_clipped(h);
  expect(w.processor_process(h, 128, 256n)).toBe(0);
  expect(w.processor_error(h)).toBe(3);
  expect(w.processor_gap_expected(h)).toBe(128n);
  expect(w.processor_gap_received(h)).toBe(256n);
  expect(w.processor_clipped(h)).toBe(before);
  expect(w.processor_process(h, 128, 256n)).toBe(0);
  expect(w.processor_recover_discontinuity(h)).toBe(1);
  expect(w.processor_recover_discontinuity(h)).toBe(0);
  expect(w.processor_process(h, 128, 256n)).toBe(1);
  expect(w.processor_clipped(h)).toBe(before + 128);
  expect(w.processor_segment(h)).toBe(1);
  expect(w.processor_missing_samples(h)).toBe(128n);
});

test('recovered analysis equals a fresh calibrated segment at the real clock without growing memory or the UI queue', () => {
  const options = { pascalsPerUnit: 1.5, microphone: true, visual: [0, -60, 0, 2], sessionId: 12 };
  const p = processor(0, false, options), reference = processor(0, false, options);
  const memory = p.value.wasm.memory.buffer.byteLength;
  const pcm = tone(48000, 1000, .02);
  for (let at = 0; at < pcm.length; at += 128) expect(p.push(pcm.subarray(at, at + 128))).toBe(true);
  const expected = p.scope.currentFrame;
  p.scope.currentFrame += 128; reference.scope.currentFrame = p.scope.currentFrame;
  for (let at = 0; at < pcm.length; at += 128) {
    const block = pcm.subarray(at, at + 128);
    expect(p.push(block)).toBe(true); expect(reference.push(block)).toBe(true);
  }
  expect(p.snapshot()).toEqual(reference.snapshot());
  expect(p.value.wasm.memory.buffer.byteLength).toBe(memory);
  expect(p.messages).toHaveLength(1);
  p.value.port.onmessage({ data: { type: 'ack' } }); expect(p.push(new Float32Array(128))).toBe(true);
  expect(p.messages).toHaveLength(2);
  expect(p.messages.at(-1).data.continuity).toEqual({ segment: 1, missingSamples: 128, overlapSamples: 0, expectedSample: expected, receivedSample: expected + 128, calibrationCancellations: 0 });
});

test('a gap cancels incomplete calibration, retains the accepted scale and applies queued settings', () => {
  const settings = [.8,2,20,1,1,.8,.01,.1,.03,.25,.01,.15,.1,.3,.01,.16,.06,.18,60,200,8,3,2,.125,30,.1,10,240];
  const p = processor(0, false, { pascalsPerUnit: 1.5, sessionId: 22, settings, visual: [0,-60,0,2] });
  for (let i = 0; i < 20; i++) expect(p.push(tone(128, 1000, .02))).toBe(true);
  p.value.port.onmessage({ data: { type: 'calibrate', dbSpl: 94 } });
  settings[0] = .7;
  p.value.port.onmessage({ data: { type: 'settings', sessionId: 22, revision: 2, settings, visual: [0,-60,0,4] } });
  p.scope.currentFrame += 128;
  const reference = processor(0, false, { pascalsPerUnit: 1.5, settings, visual: [0,-60,0,4] });
  reference.scope.currentFrame = p.scope.currentFrame;
  const pcm = tone(48000 * 4, 1000, .02);
  for (let at = 0; at < pcm.length; at += 128) {
    const block = pcm.subarray(at, at + 128);
    expect(p.push(block)).toBe(true); expect(reference.push(block)).toBe(true);
  }
  expect(p.snapshot()).toEqual(reference.snapshot());
  expect(p.value.wasm.processor_revision(p.value.processor)).toBe(2);
  expect(p.value.wasm.processor_calibration_result(p.value.processor)).toBe(0);
  expect(p.value.wasm.processor_calibration_cancellations(p.value.processor)).toBe(1);
});

test('diagnostic rows retain actual sample indices and identify both sides of a gap', () => {
  const p = processor(0, true);
  p.scope.currentFrame = 2 ** 32 - 512;
  for (let i = 0; i < 8; i++) { expect(p.push(tone(128, 1000, .02))).toBe(true); p.value.port.onmessage({ data: { type: 'ack' } }); }
  const expected = p.scope.currentFrame; p.scope.currentFrame += 128;
  for (let i = 0; i < 8; i++) { expect(p.push(tone(128, 1000, .02))).toBe(true); p.value.port.onmessage({ data: { type: 'ack' } }); }
  const rows = [];
  for (const { data } of p.messages) {
    expect(data.traceVersion).toBe(7); expect(data.traceStride).toBe(466);
    for (let at = 0; at < data.trace.length; at += data.traceStride) rows.push(data.trace.slice(at, at + data.traceStride));
  }
  expect(rows.some(row => row[465] === 0)).toBe(true);
  expect(rows.some(row => row[465] === 1)).toBe(true);
  for (const row of rows) {
    expect(row[0] < expected || row[0] >= expected + 128).toBe(true);
    if (row[465] === 1) expect(row[0]).toBeGreaterThanOrEqual(expected + 128);
  }
});


test('repeated forward gaps stay bounded and never make invalid PCM recoverable', () => {
  const p = processor(), w = p.value.wasm, h = p.value.processor;
  const memory = w.memory.buffer.byteLength;
  expect(p.push(new Float32Array(128))).toBe(true);
  for (let i = 0; i < 20; i++) {
    p.scope.currentFrame += 128;
    expect(p.push(new Float32Array(128))).toBe(true);
  }
  expect(w.processor_segment(h)).toBe(20);
  expect(w.processor_missing_samples(h)).toBe(2560n);
  expect(w.memory.buffer.byteLength).toBe(memory);
  expect(p.messages).toHaveLength(1);
  const invalid = new Float32Array(128); invalid[17] = Infinity;
  expect(p.push(invalid)).toBe(false);
  expect(w.processor_recover_discontinuity(h)).toBe(0);
  expect(p.messages.at(-1).data.message).toContain('not finite');
});


test('a backward clock rejects first, starts a declared overlapping segment and matches fresh analysis', () => {
  const options = { pascalsPerUnit: 1.5, sessionId: 28 };
  const p = processor(0, true, options), reference = processor(0, true, options);
  p.scope.currentFrame = 1024;
  for (let i = 0; i < 8; i++) { expect(p.push(tone(128, 1000, .02))).toBe(true); p.value.port.onmessage({ data: { type: 'ack' } }); }
  const expected = p.scope.currentFrame, received = expected - 128;
  const w = p.value.wasm, h = p.value.processor, memory = w.memory.buffer.byteLength;
  expect(w.processor_process(h, 128, BigInt(received))).toBe(0);
  expect(w.processor_error(h)).toBe(3);
  expect(w.processor_gap_expected(h)).toBe(BigInt(expected)); expect(w.processor_gap_received(h)).toBe(BigInt(received));
  expect(w.processor_recover_discontinuity(h)).toBe(1);
  expect(w.processor_recover_discontinuity(h)).toBe(0);
  p.scope.currentFrame = received; reference.scope.currentFrame = received;
  for (let i = 0; i < 32; i++) {
    const freshPCM = tone(128, 500, .01);
    expect(p.push(freshPCM)).toBe(true); expect(reference.push(freshPCM)).toBe(true);
    p.value.port.onmessage({ data: { type: 'ack' } });
  }
  expect(p.snapshot()).toEqual(reference.snapshot()); expect(w.memory.buffer.byteLength).toBe(memory);
  expect(p.messages.at(-1).data.continuity).toEqual({ segment: 1, missingSamples: 0, overlapSamples: 128, expectedSample: expected, receivedSample: received, calibrationCancellations: 0 });
  const rows = p.messages.flatMap(({ data }) => Array.from({ length: data.trace.length / data.traceStride }, (_, row) => data.trace.slice(row * data.traceStride, (row + 1) * data.traceStride)));
  const before = rows.filter(row => row[465] === 0), after = rows.filter(row => row[465] === 1);
  expect(before.length).toBeGreaterThan(0); expect(after.length).toBeGreaterThan(0);
  expect(after[0][0]).toBe(received); expect(after[0][0]).toBeLessThan(before.at(-1)[0]);
  for (let i = 1; i < after.length; i++) expect(after[i][0]).toBeGreaterThan(after[i - 1][0]);
});
