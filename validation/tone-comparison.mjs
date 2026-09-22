// Same PCM and measurement stream for A (fixed gain), B (old adaptive gain),
// C (exact recorded B gain with one proportional headroom scale), and production.
import { readFile, mkdir, writeFile, open } from 'node:fs/promises';
import { tonePCM, toneCases } from '../musical-leptos/src/tones.js';
import assert from 'node:assert/strict';
const output = process.argv[2] ?? '.cache/tones';
await mkdir(output, { recursive: true });
const { instance: { exports: w } } = await WebAssembly.instantiate(await readFile('musical-lights-worklet/pkg/loudness.wasm'));
const summaries = [];
for (const kind of Object.keys(toneCases).filter(x => x !== 'exercise')) {
  const pcm = tonePCM(kind), h = w.processor_create(0, 2, 0);
  w.processor_trace_enable(h, 1);
  const input = new Float32Array(w.memory.buffer, w.processor_input(h), w.processor_capacity(h));
  const stride = w.processor_trace_stride(h), transport = w.processor_snapshot_length(h);
  const traceFile = await open(`${output}/${kind}.f64`, 'w');
  const comparisons = await open(`${output}/${kind}-comparison.f64`, 'w');
  let logGain = 0, count = 0, maxError = 0, maxAggregationError = 0;
  const checkpoints = [];
  for (let offset = 0; offset < pcm.length; offset += 128) {
    const block = pcm.subarray(offset, offset + 128); input.set(block);
    assert.equal(w.processor_process(h, block.length, BigInt(offset)), 1);
    const rows = new Float64Array(w.memory.buffer, w.processor_trace_ptr(h), w.processor_trace_count(h) * stride);
    await traceFile.write(new Uint8Array(rows.buffer, rows.byteOffset, rows.byteLength));
    const result = new Float64Array(rows.length / stride * 97);
    for (let offset = 0, n = 0; offset < rows.length; offset += stride, n += 97) {
      const row = rows.subarray(offset, offset + stride), bands = Array.from(row.subarray(242, 266));
      const peak = Math.max(...bands), main = bands.indexOf(peak);
      if (row[1] >= .1 && peak > 0) {
        const target = Math.log(Math.min(64, Math.max(1 / 64, 4 / peak)));
        logGain += -Math.expm1(-.002 / (target < logGain ? 2 : 20)) * (target - logGain);
      }
      const gain = Math.exp(logGain), scale = Math.min(gain, 1 / peak);
      const a = bands.map(x => x / (1 + x));
      const b = bands.map(x => gain * x / (1 + gain * x));
      const c = bands.map(x => x * scale);
      const production = bands.map((_, i) => row[269 + i * ((transport - 2) / 24)]);
      for (let i = 0; i < 24; i++) {
        if (peak) maxError = Math.max(maxError, Math.abs(c[i] / c[main] - bands[i] / peak));
        const integral = Array.from(row.subarray(2 + i * 10, 12 + i * 10)).reduce((a, b) => a + b, 0) * .1;
        maxAggregationError = Math.max(maxAggregationError, Math.abs(bands[i] - integral));
      }
      result[n] = row[0]; result.set(a, n + 1); result.set(b, n + 25); result.set(c, n + 49); result.set(production, n + 73);
      if (count % 500 === 499) {
        const neighbor = [main - 1, main + 1].filter(i => i >= 0 && i < 24).sort((i, j) => bands[j] - bands[i])[0];
        checkpoints.push({ seconds: row[0] / 48000, peakBand: main, neighborBand: neighbor, sones: row[1], gainB: gain, productionGain: row[266],
          measuredRatio: peak ? bands[neighbor] / peak : 0, a: a[main] ? a[neighbor] / a[main] : 0,
          b: b[main] ? b[neighbor] / b[main] : 0, c: c[main] ? c[neighbor] / c[main] : 0,
          production: production[main] ? production[neighbor] / production[main] : 0 });
      }
      count++;
    }
    await comparisons.write(new Uint8Array(result.buffer));
    w.processor_trace_clear(h);
  }
  assert.equal(w.processor_trace_dropped(h), 0);
  assert(maxError < 1e-14);
  await traceFile.close(); await comparisons.close();
  await writeFile(`${output}/${kind}.f32`, new Uint8Array(pcm.buffer));
  summaries.push({ kind, seconds: toneCases[kind], frames: count, stride, transport, maxNormalizedErrorC: maxError, maxAggregationError, checkpoints });
  w.processor_destroy(h);
  console.log(`${kind}: ${count} frames, proportional ratio error ${maxError}`);
}
await writeFile(`${output}/summary.json`, JSON.stringify(summaries, null, 2));
