// Exercise the release producer with continuous, phase-correct PCM.
import assert from 'node:assert/strict';

export function flashPCM(kind, frequency, amplitude = .02) {
  let phase = 0;
  return Float32Array.from({ length: 2 * 48000 }, (_, i) => {
    const t = i / 48000;
    phase += 2 * Math.PI * frequency * (kind === 'vibrato' ? 1 + .04 * Math.sin(2 * Math.PI * 6 * t) : 1) / 48000;
    let level = t >= .4 && t < 1.6 ? amplitude : 0;
    if (kind === 'repeated') level = (t >= .4 && t < .7) || (t >= 1 && t < 1.3) ? amplitude : 0;
    if (kind === 'swell') level = amplitude * Math.max(0, Math.min(1, (t - .4) / .8));
    if (kind === 'tremolo') level *= 1 + .1 * Math.sin(2 * Math.PI * 8 * t);
    if (kind === 'silence') level = 0;
    if (kind === 'masked') return amplitude * Math.sin(2 * Math.PI * 1000 * t) + level * .01 * Math.sin(2 * Math.PI * 840 * t);
    return level * Math.sin(phase);
  });
}

export function flashTrace(module, pcm, reduced = false, { calibration = 2, chunk = 128 } = {}) {
  const w = new WebAssembly.Instance(module).exports;
  const h = w.processor_create(1, calibration, Number(reduced)), rows = [];
  w.processor_trace_enable(h, 1);
  const stride = w.processor_trace_stride(h);
  assert.ok([463, 511].includes(stride));
  assert.equal(w.processor_trace_version(h), stride === 511 ? 5 : 4);
  assert.equal(w.processor_snapshot_length(h), 99);
  try {
    for (let at = 0; at < pcm.length; at += chunk) {
      const block = pcm.subarray(at, at + chunk);
      new Float32Array(w.memory.buffer, w.processor_input(h), block.length).set(block);
      assert.equal(w.processor_process(h, block.length, BigInt(at)), 1);
      const data = new Float64Array(w.memory.buffer, w.processor_trace_ptr(h), stride * w.processor_trace_count(h));
      for (let j = 0; j < data.length; j += stride) rows.push(data.slice(j, j + stride));
      w.processor_trace_clear(h);
    }
    assert.equal(w.processor_trace_dropped(h), 0);
    return rows;
  } finally { w.processor_destroy(h); }
}

export function flashSummary(rows, band) {
  return {
    peakTarget: Math.max(...rows.map(row => row[367 + 4 * band])),
    peakFiltered: Math.max(...rows.map(row => row[368 + 4 * band])),
    attacks: [...new Set(rows.map(row => row[369 + 4 * band]).filter(at => at >= 0))],
  };
}
