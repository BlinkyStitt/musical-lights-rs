// Reproducible production-WASM measurements and audible review material.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { flashPCM, flashTrace, flashSummary } from './flash-fixtures.mjs';
import { heldOut, corpusPCM } from './audit-corpus.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const wasm = await readFile('musical-lights-worklet/pkg/loudness.wasm');
const baseline = await readFile('.cache/before-flash.wasm');
const module = new WebAssembly.Module(wasm), before = new WebAssembly.Module(baseline);
const directory = 'docs/audio-audit-results'; await mkdir(directory, { recursive: true });
const fixtures = [
  ...[150, 8600].map(f => ({ name: `recovered-${f}`, pcm: flashPCM('repeated', f, .006), expected: 2, provenance: 'development regression' })),
  ...heldOut.map(f => ({ ...f, pcm: corpusPCM(f), provenance: 'held-out synthetic; expectations frozen in audit-corpus.mjs before first run' })),
];
for (const [name, source, offset] of [['trumpet', 'sorohanro_-_solo-trumpet-06', 0], ['music', 'Kevin_MacLeod_-_Vibe_Ace', 8]]) {
  const raw = await readFile(`.cache/audio-audit/${name}.f32`);
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4).slice();
  const peak = pcm.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  fixtures.push({ name, pcm: pcm.map(x => .2 * x / peak), provenance: {
    repository: 'https://github.com/librosa/data', revision: '38f4b06556fa0ff1acda5e677d8ba05d1bc0fff0',
    source: `audio/${source}.ogg`, sourceSha256: hash(await readFile(`.cache/audio-audit/${source}.ogg`)),
    license: 'CC-BY-3.0', transformation: `FFmpeg mono average, 48 kHz, seconds ${offset}–${offset + pcm.length / 48000}, fixed peak 0.2`,
    humanAnnotations: 'pending; no onset truth labels or perceptual pass claimed',
  } });
}
const cases = [];
for (const { pcm, ...fixture } of fixtures) {
  const rows = flashTrace(module, pcm), old = flashTrace(before, pcm);
  // Measurements, gain and both targets are exact before/after invariants.
  for (let n = 0; n < rows.length; n++) {
    assert.deepEqual(rows[n].slice(0, 316), old[n].slice(0, 316));
    for (let b = 0; b < 24; b++) {
      assert.equal(rows[n][367 + b * 4], old[n][367 + b * 4]);
      assert.equal(rows[n][368 + b * 4], old[n][368 + b * 4]);
    }
  }
  const bands = Array.from({ length: 24 }, (_, band) => ({ band, ...flashSummary(rows, band),
    acoustic: [...new Set(rows.map(r => r[463 + band]).filter(at => at >= 0))], suppressed: rows.at(-1)[487 + band] }));
  const attacks = bands.flatMap(b => b.attacks), acoustic = bands.flatMap(b => b.acoustic);
  if (fixture.expected !== undefined) assert.equal(attacks.length, fixture.expected, fixture.name);
  if (fixture.expectedAcoustic !== undefined) assert.equal(acoustic.length, fixture.expectedAcoustic, fixture.name);
  const strongest = bands.reduce((a, b) => a.peakTarget > b.peakTarget ? a : b).band;
  const inputPeak = Math.max(...rows.map(r => r[367 + strongest * 4]));
  const first = column => rows.find(r => r[column] >= .9 * inputPeak)?.[364] ?? null;
  const inputCrossing = first(367 + strongest * 4), filteredCrossing = first(368 + strongest * 4);
  const filteredDelayMs = inputCrossing === null || filteredCrossing === null ? null : (filteredCrossing - inputCrossing) * 1000;
  const filteredPeakRatio = bands[strongest].peakFiltered / inputPeak;
  const pcmBytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  await writeFile(`${directory}/${fixture.name}.f32`, pcmBytes);
  const view = data => data.filter((_, i) => i % 5 === 0).map(r => [r[364], ...Array.from({ length: 24 }, (_, b) => [r[368 + 4 * b], r[369 + 4 * b]]).flat()]);
  await writeFile(`${directory}/${fixture.name}.json`, JSON.stringify({ before: view(old), after: view(rows) }));
  cases.push({ ...fixture, pcmSha256: hash(pcmBytes), samples: pcm.length, rate: 48000, measurementsAndTargetsBitIdentical: true,
    strongestBandFiltered90DelayMs: filteredDelayMs, filteredPeakRatio, bands: bands.filter(b => b.peakTarget > .001 || b.acoustic.length) });
}
const sourceFiles = ['musical-lights-core/src/audio/browser.rs', 'musical-lights-core/src/audio/partial/mod.rs', 'musical-lights-worklet/src/lib.rs', 'validation/partial/audit-corpus.mjs'];
const report = { baselineCommit: '513d6159f960f1436aab087563e2f94b74584dc1', baselineWasmSha256: hash(baseline), wasmSha256: hash(wasm),
  sourceSha256: Object.fromEntries(await Promise.all(sourceFiles.map(async p => [p, hash(await readFile(p))]))),
  node: process.version, ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0], rust: execFileSync('rustc', ['+nightly-2026-09-10', '--version'], { encoding: 'utf8' }).trim(),
  assumedPascalsPerUnit: 2, physicalPhone: 'unavailable; pending', humanListening: 'pending',
  detector: { candidateMs: 60, floorSones: .1, relativeProminence: .3, crestLookbackMs: 10, crestTolerance: .05, acousticQuietMs: 10,
    visualQuietMs: 60, visualIntervalMs: 160, fadeMs: 120, fade: 'linear', reducedIntensity: .5 },
  cases };
await writeFile(`${directory}/audit.json`, JSON.stringify(report, null, 2) + '\n');
console.log(`Recorded ${cases.length} cases; all expected synthetic counts and measurement invariants pass.`);
