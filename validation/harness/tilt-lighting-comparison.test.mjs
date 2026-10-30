import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareTimings } from '../tilt-lighting-comparison.mjs';

// Deliberately synthetic evidence: these exercise the report gate, not rendering.
function samples(kind) {
  const stats = { count: 1200, mean: 16.67, p50: 16.67, p95: 16.8, max: 33.3 };
  return [['forward', 'baseline'], ['forward', 'shading'], ['forward', 'shadows'],
    ['reverse', 'shadows'], ['reverse', 'shading'], ['reverse', 'baseline']].map(([round, mode]) => ({
    round, mode, rendererClass: kind,
    gpu: kind === 'software' ? 'ANGLE SwiftShader' : 'ANGLE Intel Iris',
    build: { version: 'a'.repeat(24) }, artifactSha256: 'b'.repeat(64),
    sources: { lighting: 'c'.repeat(64) }, instrumentation: { timing: 'd'.repeat(64) },
    browserVersion: '156.0.8078.4',
    canvas: [657, 304], viewport: [844, 390], resolution: 1, depth: .48,
    depthCopies: 0, banks: 9, balls: 8, camera: 20,
    workload: { source: 'generated', kind: 'exercise', state: 'playing', repeat: true,
      diagnostics: false, sampleRate: 48000, dbfs: -34, frequency: 1000, channel: 0, pascalsPerUnit: 2 },
    submittedFps: mode === 'shadows' ? 45 : 60, frameMs: { ...stats },
    cpuSubmissionMs: { ...stats }, simulationDebtMs: { ...stats }, snapshotAgeMs: { ...stats },
    timerAvailable: kind === 'hardware', gpuMs: kind === 'hardware' ? { ...stats } : null,
    discardedSimulationMs: 0, errors: [],
  }));
}

test('comparison reports both orders, all costs, unavailable timers and relative throughput', () => {
  const report = compareTimings(samples('software'), samples('hardware'));
  assert.equal(report.split('\n').filter(line => /^\| (forward|reverse)/.test(line)).length, 12);
  assert.match(report, /shading 0.0%, shadows -25.0%/);
  assert.match(report, /unavailable/);
  assert.match(report, /Snapshot age ms/);
  assert.match(report, /do not establish physical-phone acceptance/);
});

test('comparison rejects partial, duplicate, mislabeled, stale or unmatched evidence', () => {
  const cases = [
    [rows => rows.pop(), /all six/],
    [rows => { rows[5] = rows[0]; }, /duplicate variant/],
    [rows => { rows[0].gpu = 'llvmpipe'; }, /requires hardware/],
    [rows => { rows[0].rendererClass = 'software'; }, /wrong renderer/],
    [rows => { rows[1].artifactSha256 = 'e'.repeat(64); }, /artifactSha256/],
    [rows => { rows[1].instrumentation.timing = 'e'.repeat(64); }, /instrumentation/],
    [rows => { rows[2].sources.lighting = 'e'.repeat(64); }, /sources/],
    [rows => { rows[2].build.version = 'e'.repeat(24); }, /build/],
    [rows => { rows[3].canvas[0]++; }, /canvas/],
    [rows => { rows[3].workload.dbfs = -24; }, /audio changed/],
    [rows => { rows[3].workload.diagnostics = true; }, /diagnostics/],
    [rows => { rows[4].gpuMs = null; }, /GPU: missing samples/],
    [rows => { rows[4].snapshotAgeMs.mean = NaN; }, /Snapshot: invalid/],
    [rows => { rows[5].errors = ['context lost']; }, /context lost/],
  ];
  for (const [change, expected] of cases) {
    const hardware = samples('hardware');
    change(hardware);
    assert.throws(() => compareTimings(samples('software'), hardware), expected);
  }
});

test('comparison CLI fails closed and replaces stale success when hardware produced no samples', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tilt-comparison-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const software = join(directory, 'software.json'), hardware = join(directory, 'hardware.json');
  const output = join(directory, 'comparison.md');
  await writeFile(software, JSON.stringify(samples('software')));
  await writeFile(hardware, '[]');
  await writeFile(output, 'Old success');
  const result = spawnSync(process.execPath, [new URL('../tilt-lighting-comparison.mjs', import.meta.url).pathname, software, hardware, output], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hardware: expected all six samples/);
  assert.equal(await readFile(output, 'utf8'), 'Renderer comparison incomplete.\n');
});
