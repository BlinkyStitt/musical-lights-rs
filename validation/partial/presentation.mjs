// Production WASM: measurements versus the previous build, motion versus the
// independent scalar One Euro equations, and complete attack timing.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { tonePCM } from '../../musical-leptos/src/tones.js';
const output = 'docs/partial-loudness-results/contained-display';
const load = async path => (await WebAssembly.instantiate(await readFile(path))).instance.exports;
const before = await load(process.argv[2] ?? '.cache/before-contained.wasm');
const after = await load('musical-lights-worklet/pkg/loudness.wasm');
function run(w, pcm, record = true) {
  const h = w.processor_create(0, 2, 0), rows = [], stride = w.processor_trace_stride(h);
  w.processor_trace_enable(h, Number(record));
  const start = performance.now();
  for (let at = 0; at < pcm.length; at += 128) {
    const block = pcm.subarray(at, at + 128);
    new Float32Array(w.memory.buffer, w.processor_input(h), block.length).set(block);
    assert.equal(w.processor_process(h, block.length, BigInt(at)), 1);
    if (record) {
      const data = new Float64Array(w.memory.buffer, w.processor_trace_ptr(h), stride * w.processor_trace_count(h));
      for (let j = 0; j < data.length; j += stride) rows.push(data.slice(j, j + stride));
      w.processor_trace_clear(h);
    }
  }
  const cpuMs = performance.now() - start;
  assert.equal(w.processor_trace_dropped(h), 0); w.processor_destroy(h);
  return { rows, cpuMs };
}
const coefficient = f => 1 / (1 + 1 / (2 * Math.PI * f * .002));
const cases = [];
for (const kind of ['stationary', 'two', 'bursts', 'exercise', 'silence']) {
  const pcm = tonePCM(kind).subarray(0, 4 * 48000);
  const old = run(before, pcm), current = run(after, pcm);
  assert.equal(old.rows.length, current.rows.length);
  let maximumFilterError = 0, maximumTargetRatioError = 0;
  const y = Array(24).fill(0), dy = Array(24).fill(0);
  current.rows.forEach((row, n) => {
    assert.deepEqual(row.slice(0, 315), old.rows[n].slice(0, 315), 'ISO or partial measurements changed');
    const targets = y.map((_, i) => row[367 + 4 * i]);
    const peak = Math.max(...row.slice(291, 315)), top = Math.max(...targets);
    for (let i = 0; i < 24; i++) dy[i] += coefficient(1) * ((targets[i] - y[i]) / .002 - dy[i]);
    const a = coefficient(1 + .8 * Math.max(...dy.map(Math.abs)));
    for (let i = 0; i < 24; i++) {
      y[i] += a * (targets[i] - y[i]);
      maximumFilterError = Math.max(maximumFilterError, Math.abs(y[i] - row[368 + 4 * i]));
      if (peak) maximumTargetRatioError = Math.max(maximumTargetRatioError, Math.abs(row[291 + i] / peak - targets[i] / top));
    }
  });
  assert(maximumFilterError < 1e-7); assert(maximumTargetRatioError < 2e-7);
  const oldCpuMs = run(before, pcm, false).cpuMs, cpuMs = run(after, pcm, false).cpuMs;
  assert(cpuMs < pcm.length / 48 * .5);
  cases.push({ kind, frames: current.rows.length, measurementsBitIdentical: true, maximumFilterError, maximumTargetRatioError, oldCpuMs, cpuMs, audioMs: pcm.length / 48 });
}
const pcm = Float32Array.from({ length: 2 * 48000 }, (_, i) => i >= 48000 && i < 72000 ? .2 * Math.sin(2 * Math.PI * 1000 * i / 48000) : 0);
const { rows } = run(after, pcm);
const timing = {};
for (const [stage, index] of [['instantaneous', 267 + 8], ['shortTerm', 291 + 8], ['immediateTarget', 367 + 4 * 8], ['filteredTarget', 368 + 4 * 8]]) {
  const peak = Math.max(...rows.map(row => row[index]));
  timing[stage] = Object.fromEntries([.1, .5, .9].map(fraction => [fraction, (rows.find(row => row[266] >= 48000 && row[index] >= peak * fraction)[266] - 48000) / 48]));
}
const attacks = [...new Set(rows.map(row => row[369 + 4 * 8]).filter(at => at >= 0))];
assert.equal(attacks.length, 1, 'one prominent attack, no offset flash');
timing.attackMs = (attacks[0] - 1) * 1000;
await writeFile(`${output}/presentation.json`, JSON.stringify({ model: 'unchanged MGB1997-GM2002; no frequency shelves', filter: { minCutoffHz: 1, derivativeCutoffHz: 1, beta: .8, sharedCoefficient: true }, cases, timing, windowSpanMs: 2048 / 48, physicalPhone: false }, null, 2) + '\n');
console.log(JSON.stringify({ cases, timing }, null, 2));
