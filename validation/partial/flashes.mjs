// Compare release builds; every trace value except attack timestamps must match.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { flashPCM, flashTrace, flashSummary } from './flash-fixtures.mjs';
import { tonePCM } from '../../musical-leptos/src/tones.js';

const before = new WebAssembly.Module(await readFile(process.argv[2] ?? '.cache/before-flash.wasm'));
const after = new WebAssembly.Module(await readFile('musical-lights-worklet/pkg/loudness.wasm'));
const cases = [];
const fixtures = [
  ...[150, 1000, 8600].flatMap(frequency => ['repeated', 'sustain', 'vibrato', 'tremolo', 'swell', 'masked', 'silence'].map(kind => ({
    name: `${kind}-${frequency}`, frequency, pcm: flashPCM(kind, frequency, kind === 'repeated' ? .006 : .02),
  }))),
  ...['stationary', 'two', 'bursts', 'exercise', 'silence'].map(kind => ({
    name: kind, frequency: 1000, pcm: tonePCM(kind).subarray(0, 4 * 48000),
  })),
];
for (const { name, frequency, pcm } of fixtures) {
  const old = flashTrace(before, pcm), current = flashTrace(after, pcm);
  assert.equal(old.length, current.length);
  for (let n = 0; n < current.length; n++) {
    for (let i = 0; i < old[n].length; i++) {
      if (i >= 369 && (i - 369) % 4 === 0) continue;
      assert.equal(current[n][i], old[n][i], `${name}, frame ${n}, trace column ${i}`);
    }
  }
  const band = frequency === 150 ? 1 : frequency === 8600 ? 21 : 8;
  cases.push({ name, frames: current.length, measurementsAndTargetsBitIdentical: true,
    before: flashSummary(old, band), after: flashSummary(current, band) });
}
const output = 'docs/flash-results';
await mkdir(output, { recursive: true });
await writeFile(`${output}/comparison.json`, JSON.stringify({ baseline: '513d615', physicalPhone: false, cases }, null, 2) + '\n');
console.log(JSON.stringify(cases, null, 2));
