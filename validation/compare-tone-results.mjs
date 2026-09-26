import { traceLayout } from './trace-layout.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const [before = '.cache/tones-before', after = '.cache/tones-after', output = 'docs/gain-stroke-results'] = process.argv.slice(2);
const old = JSON.parse(await readFile(`${before}/summary.json`, 'utf8'));
const current = JSON.parse(await readFile(`${after}/summary.json`, 'utf8'));
const report = [];
for (let i = 0; i < current.length; i++) {
  const a = old[i], b = current[i]; assert.equal(a.kind, b.kind); assert.equal(a.frames, b.frames);
  const schemaA = traceLayout(a.stride), schemaB = traceLayout(b.stride);
  const inputA = schemaA.emphasized ?? schemaA.measured, inputB = schemaB.emphasized ?? schemaB.measured;
  const bytesA = await readFile(`${before}/${a.kind}.f64`), bytesB = await readFile(`${after}/${b.kind}.f64`);
  const dataA = new Float64Array(bytesA.buffer, bytesA.byteOffset, bytesA.byteLength / 8);
  const dataB = new Float64Array(bytesB.buffer, bytesB.byteOffset, bytesB.byteLength / 8);
  let ratioError = 0, targetError = 0, oldRatioError = 0, retainedHeight = 0;
  for (let n = 0; n < b.frames; n++) {
    const startA = n * a.stride, startB = n * b.stride;
    assert.deepEqual(dataA.subarray(startA, startA + 266), dataB.subarray(startB, startB + 266), 'Measurement changed');
    if (schemaA.version >= 2 && schemaB.version >= 2)
      assert.deepEqual(dataA.subarray(startA + 266, startA + 315), dataB.subarray(startB + 266, startB + 315), 'Partial measurement changed');
    const bands = Array.from(dataB.subarray(startB + inputB, startB + inputB + 24));
    const peak = Math.max(...bands), main = bands.indexOf(peak), gain = dataB[startB + schemaB.gain];
    const scale = Math.min(gain, 1 / peak), targets = bands.map((_, j) => dataB[startB + schemaB.display + 2 + schemaB.step * j]);
    const heights = bands.map((_, j) => dataA[startA + schemaA.display + 2 + schemaA.step * j]);
    const oldBands = Array.from(dataA.subarray(startA + inputA, startA + inputA + 24));
    const oldPeak = Math.max(...oldBands), oldMain = oldBands.indexOf(oldPeak);
    const oldGain = dataA[startA + schemaA.gain];
    for (let j = 0; j < 24; j++) {
      targetError = Math.max(targetError, Math.abs(targets[j] - bands[j] * scale));
      retainedHeight = Math.max(retainedHeight, heights[j] - oldGain * oldBands[j] / (1 + oldGain * oldBands[j]));
      if (peak) {
        ratioError = Math.max(ratioError, Math.abs(targets[j] / targets[main] - bands[j] / peak));
        if (heights[oldMain] && oldPeak) oldRatioError = Math.max(oldRatioError, Math.abs(heights[j] / heights[oldMain] - oldBands[j] / oldPeak));
      }
    }
  }
  assert(ratioError < 2e-7, `${b.kind}: ratio error ${ratioError}`);
  assert(targetError < 2e-7, `${b.kind}: stale target ${targetError}`);
  report.push({ kind: b.kind, frames: b.frames, measurementBitIdentical: true, mapping: schemaB.mapping ?? 'proportional', maxNormalizedTargetError: ratioError,
    maxCurrentTargetError: targetError, maxOldNormalizedHeightError: oldRatioError, maxOldRetainedHeight: schemaA.step === 6 ? retainedHeight : null,
    before: a.checkpoints, after: b.checkpoints });
}
await mkdir(output, { recursive: true });
await writeFile(`${output}/comparison.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.map(({ before, after, ...summary }) => summary), null, 2));
