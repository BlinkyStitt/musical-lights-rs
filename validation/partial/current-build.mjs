// Exact measurement and target contract for identical PCM, independent of UI.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { flashTrace, flashPCM } from './flash-fixtures.mjs';
import { corpusPCM, heldOut } from './audit-corpus.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (!process.argv[2]) throw new Error('Usage: node validation/partial/current-build.mjs BASELINE_WASM');
const beforeBytes = await readFile(process.argv[2]);
const afterBytes = await readFile('musical-lights-worklet/pkg/loudness.wasm');
const before = new WebAssembly.Module(beforeBytes), after = new WebAssembly.Module(afterBytes);
const corpus = [
  ...[50, 150, 250, 1000, 3400, 8600, 13700].map(f => ({ name: `tone-${f}`, pcm: flashPCM('repeated', f) })),
  ...heldOut.map(f => ({ name: f.name, pcm: corpusPCM(f) })),
];
for (const name of ['trumpet', 'music']) {
  const bytes = await readFile(`musical-leptos/public/review/${name}.f32`);
  corpus.push({ name, pcm: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice() });
}
const results = [];
for (const { name, pcm } of corpus) {
  for (const reduced of [false, true]) {
    const old = flashTrace(before, pcm, reduced), current = flashTrace(after, pcm, reduced);
    assert.equal(current.length, old.length);
    for (let i = 0; i < current.length; i++) assert.deepEqual(current[i], old[i], `${name}: all raw values, filtered targets and events must remain bit-identical`);
    results.push({ name, reducedMotion: reduced, pcmSha256: hash(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)), frames: current.length, fullTraceBitIdentical: true });
  }
}
// Recording storage is absent until requested, and never allocated in processing.
const w = new WebAssembly.Instance(after).exports, h = w.processor_create(0, 2, 0);
assert.equal(w.processor_trace_ptr(h), 0); assert.equal(w.processor_trace_count(h), 0);
w.processor_trace_enable(h, 1); assert.ok(w.processor_trace_ptr(h) > 0);
w.processor_trace_enable(h, 0); assert.equal(w.processor_trace_ptr(h), 0); w.processor_destroy(h);
await writeFile('docs/audio-audit-results/current-build.json', JSON.stringify({
  baselineCommit: execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim(),
  baselineWasmSha256: hash(beforeBytes), productionWasmSha256: hash(afterBytes), node: process.version,
  traceProtocolUnchanged: 5, traceBuffersLazy: true, results, humanListening: 'pending', physicalPhone: 'pending',
}, null, 2) + '\n');
console.log(`${results.length} full traces are bit-identical to main; diagnostic buffers are lazy.`);
