// Offline production-WASM observations. Synthetic click expectations do not
// certify metrical interpretation of music; no fitted gains or shifted traces.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { tonePCM } from '../../musical-leptos/src/tones.js';
import { flashTrace } from './flash-fixtures.mjs';
const output = 'docs/musical-motion-results';
const bytes = await readFile('musical-lights-worklet/pkg/loudness.wasm');
const module = new WebAssembly.Module(bytes);
const before = process.argv[2] ? new WebAssembly.Module(await readFile(process.argv[2])) : null;
const equality = [];
if (before) {
  for (const kind of ['stationary', 'bursts', 'two', 'sweep', 'exercise', 'silence']) {
    const pcm = tonePCM(kind).slice(0, 48000 * 3);
    const a = flashTrace(before, pcm), b = flashTrace(module, pcm);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) assert.deepEqual(a[i], b[i], `${kind} full diagnostic row ${i}`);
    equality.push({ kind, samples: pcm.length, rows: a.length, identicalFullRows: true });
  }
}
function observe(pcm, seconds) {
  const w = new WebAssembly.Instance(module).exports, h = w.processor_create(0, 2, 0);
  const input = new Float32Array(w.memory.buffer, w.processor_input(h), w.processor_capacity(h));
  const values = [];
  for (let first = 0; first < seconds * 48000; first += 128) {
    const n = Math.min(128, seconds * 48000 - first);
    for (let i = 0; i < n; i++) input[i] = pcm[(first + i) % pcm.length];
    assert.equal(w.processor_process(h, n, BigInt(first)), 1);
    if (first % 24000 < 128) values.push({ seconds: first / 48000, bpm: w.processor_tempo(h), confidence: w.processor_tempo_confidence(h) });
  }
  w.processor_destroy(h); return values;
}
const observations = [];
for (const bpm of [60, 90, 120, 150, 180, 200]) {
  const pcm = Float32Array.from({ length: 48000 * 12 }, (_, i) => (i / 48000 * bpm / 60) % 1 < .08 ? .03 * Math.sin(2 * Math.PI * 1000 * i / 48000) : 0);
  const values = observe(pcm, 24), last = values.at(-1);
  assert(last.confidence > .45 && Math.abs(last.bpm - bpm) < 5, `PCM clicks ${bpm}: ${JSON.stringify(last)}`);
  observations.push({ source: `${bpm} BPM click train`, values, expectedBpm: bpm });
}
for (const name of ['trumpet', 'music']) {
  const raw = await readFile(`musical-leptos/public/review/${name}.f32`);
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  observations.push({ source: `${name} licensed excerpt repeated for 24 seconds`, metricalTruth: 'not independently annotated; human listening pending', values: observe(pcm, 24) });
}
await mkdir(output, { recursive: true });
await writeFile(`${output}/tempo-observations.json`, JSON.stringify({ equality, observations }, null, 2) + '\n');
console.log(JSON.stringify({ equality, observations: observations.map(x => ({ source: x.source, final: x.values.at(-1) })) }, null, 2));
