import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareTimings, performanceFailures } from '../tilt-lighting-comparison.mjs';

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

test('performance gate rejects slow shipped shading, including a shared baseline slowdown', () => {
  const software = samples('software'), hardware = samples('hardware');
  for (const row of hardware) row.submittedFps = 58;
  assert.match(performanceFailures(software, hardware).join('\n'), /hardware forward shading: 58.00 FPS/);
  assert.match(performanceFailures(software, hardware).join('\n'), /hardware reverse shading: 58.00 FPS/);
  for (const row of software) row.submittedFps = 6;
  assert.match(performanceFailures(software, hardware).join('\n'), /software forward shading: 6.00 FPS/);
});

test('performance gate checks hardware frame p95 and tolerates its exact limits', () => {
  const software = samples('software'), hardware = samples('hardware');
  for (const row of hardware.filter(row => row.mode === 'shading')) {
    row.submittedFps = 59;
    row.frameMs.p95 = 18.5;
  }
  for (const row of software.filter(row => row.mode === 'shading')) row.submittedFps = 7;
  // Match the low software baseline so the relative check also passes.
  for (const row of software.filter(row => row.mode === 'baseline')) row.submittedFps = 7;
  assert.deepEqual(performanceFailures(software, hardware), []);
  hardware.find(row => row.mode === 'shading').frameMs.p95 = 18.51;
  assert.match(performanceFailures(software, hardware).join('\n'), /p95 frame 18.51 ms exceeds 18.5 ms/);
});

test('performance gate detects a repeated tilt regression but ignores one noisy order and the shadow candidate', () => {
  const software = samples('software'), hardware = samples('hardware');
  const shading = software.filter(row => row.mode === 'shading');
  for (const row of shading) row.submittedFps = 54;
  assert.deepEqual(performanceFailures(software, hardware), []);
  shading[0].submittedFps = 50;
  assert.deepEqual(performanceFailures(software, hardware), []);
  shading[1].submittedFps = 50;
  assert.match(performanceFailures(software, hardware).join('\n'), /software shading is more than 10% slower/);
  for (const row of hardware.filter(row => row.mode === 'shadows')) row.submittedFps = 1;
  assert.doesNotMatch(performanceFailures(software, hardware).join('\n'), /hardware/);
});

test('performance failure exits nonzero and retains the measured report', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tilt-performance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const software = join(directory, 'software.json'), hardware = join(directory, 'hardware.json');
  const output = join(directory, 'comparison.md');
  const gpu = samples('hardware');
  gpu.find(row => row.mode === 'shading').submittedFps = 40;
  await writeFile(software, JSON.stringify(samples('software')));
  await writeFile(hardware, JSON.stringify(gpu));
  const result = spawnSync(process.execPath, [new URL('../tilt-lighting-comparison.mjs', import.meta.url).pathname, software, hardware, output], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /performance gate failed/);
  assert.match(await readFile(output, 'utf8'), /hardware forward shading: 40.00 FPS/);
});
