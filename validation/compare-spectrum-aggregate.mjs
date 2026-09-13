// Compare the actual release ABI against a clean pre-change release.
// Usage: node compare-spectrum-aggregate.mjs BASELINE.wasm CURRENT.wasm
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const paths = process.argv.slice(2);
if (paths.length !== 2) throw new Error('Expected baseline and current WASM paths');
const processors = await Promise.all(paths.map(async path => {
  const bytes = await readFile(path);
  const wasm = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
  const handle = wasm.processor_create(0, 2, 0);
  assert(handle);
  return { wasm, handle, input: new Float32Array(wasm.memory.buffer, wasm.processor_input(handle), 128),
    sha256: createHash('sha256').update(bytes).digest('hex') };
}));
const [baseline, current] = processors;
assert.equal(baseline.wasm.processor_snapshot_length(baseline.handle), 146);
assert.equal(current.wasm.processor_snapshot_length(current.handle), 1588);
const samples = 48000 * 100;
let seed = 1, compared = 0;
try {
  for (let first = 0; first < samples; first += 128) {
    for (let i = 0; i < 128; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const t = (first + i) / 48000;
      const amplitude = [0, .002, .02, .05, .01][Math.floor(t / 4) % 5];
      baseline.input[i] = amplitude * (Math.sin(2 * Math.PI * 220 * t) +
        .4 * Math.sin(2 * Math.PI * 1000 * t) + .2 * (seed / 2 ** 32 - .5));
    }
    current.input.set(baseline.input);
    const snapshots = processors.map(({ wasm, handle }) => {
      wasm.processor_motion(handle, Math.floor(first / 480000) % 2);
      assert.equal(wasm.processor_process(handle, 128, BigInt(first)), 1);
      const pointer = wasm.processor_snapshot(handle);
      return Buffer.from(wasm.memory.buffer, pointer, 146 * 8);
    });
    assert(snapshots[0].equals(snapshots[1]), `Aggregate state changed at sample ${first}`);
    assert.equal(baseline.wasm.processor_sones(baseline.handle), current.wasm.processor_sones(current.handle));
    compared++;
  }
  console.log(JSON.stringify({ baselineSha256: baseline.sha256, currentSha256: current.sha256,
    samples, audioSeconds: 100, quantum: 128, comparedSnapshots: compared,
    aggregateValues: 146, bitIdentical: true,
    workload: 'Deterministic tones and noise; silence and four amplitudes; Reduced Motion toggles every 10 seconds' }, null, 2));
} finally {
  for (const { wasm, handle } of processors) wasm.processor_destroy(handle);
}
