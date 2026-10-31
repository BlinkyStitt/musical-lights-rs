import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { requireHardwareRenderer } from './gpu-renderer.mjs';

const order = [
  ['forward', 'baseline'], ['forward', 'shading'], ['forward', 'shadows'],
  ['reverse', 'shadows'], ['reverse', 'shading'], ['reverse', 'baseline'],
];
const identityKeys = ['build', 'artifactSha256', 'sources', 'instrumentation', 'browserVersion'];
const sceneKeys = ['canvas', 'viewport', 'resolution', 'depth', 'depthCopies', 'banks', 'balls', 'camera'];
const audioKeys = ['source', 'kind', 'state', 'repeat', 'diagnostics', 'sampleRate', 'dbfs', 'frequency', 'channel', 'pascalsPerUnit'];
const softwareRenderer = /swiftshader|llvmpipe|softpipe|software/i;

function distribution(value, label) {
  assert(value && Number.isInteger(value.count) && value.count > 0, `${label}: missing samples`);
  for (const key of ['mean', 'p50', 'p95', 'max']) {
    assert(Number.isFinite(value[key]) && value[key] >= 0, `${label}: invalid ${key}`);
  }
  return ['mean', 'p50', 'p95', 'max'].map(key => value[key].toFixed(2)).join(' / ');
}

// Limits apply to the shipped shading mode. The shadow candidate is informative.
// The software floor covers both current GPU runners, whose CPUs differ greatly.
const hardwareMinFps = 59;
const hardwareMaxP95FrameMs = 18.5;
const softwareMinFps = 7;
const maxRepeatableShadingRegression = 0.10;

export function performanceFailures(software, hardware) {
  const failures = [];
  for (const [kind, rows] of [['software', software], ['hardware', hardware]]) {
    const regressions = [];
    for (const round of ['forward', 'reverse']) {
      const baseline = rows.find(row => row.round === round && row.mode === 'baseline');
      const shading = rows.find(row => row.round === round && row.mode === 'shading');
      const minimum = kind === 'hardware' ? hardwareMinFps : softwareMinFps;
      if (shading.submittedFps < minimum) failures.push(`${kind} ${round} shading: ${shading.submittedFps.toFixed(2)} FPS is below ${minimum} FPS`);
      if (kind === 'hardware' && shading.frameMs.p95 > hardwareMaxP95FrameMs) failures.push(`${kind} ${round} shading: p95 frame ${shading.frameMs.p95.toFixed(2)} ms exceeds ${hardwareMaxP95FrameMs} ms`);
      regressions.push(shading.submittedFps / baseline.submittedFps < 1 - maxRepeatableShadingRegression);
    }
    if (regressions.every(Boolean)) failures.push(`${kind} shading is more than ${maxRepeatableShadingRegression * 100}% slower than baseline in both orders`);
  }
  return failures;
}

export function compareTimings(software, hardware) {
  const reference = software?.[0];
  assert(reference, 'Missing software comparison');
  assert.match(reference.build?.version ?? '', /^[a-f0-9]{24}$/, 'Missing build version');
  assert.match(reference.artifactSha256 ?? '', /^[a-f0-9]{64}$/, 'Missing artifact digest');
  for (const field of ['sources', 'instrumentation']) {
    assert(reference[field] && Object.keys(reference[field]).length > 0, `Missing ${field}`);
    for (const digest of Object.values(reference[field])) assert.match(digest, /^[a-f0-9]{64}$/);
  }
  const lines = [
    '# Tilt lighting renderer comparison', '',
    `Build: ${reference.build.version}; artifact SHA256: ${reference.artifactSha256}.`, '',
    'Frame intervals include skipped submissions. CPU submission is not GPU completion.',
    'Timing values are mean / p50 / p95 / maximum in milliseconds.', '',
  ];
  for (const [kind, rows] of [['software', software], ['hardware', hardware]]) {
    assert(Array.isArray(rows) && rows.length === order.length, `${kind}: expected all six samples`);
    lines.push(`## ${kind}`, '',
      `Renderer: ${rows[0].gpu}; Chromium ${rows[0].browserVersion}.`, '',
      '| Order | Variant | Submitted FPS | Frame ms | CPU ms | GPU ms | Debt ms | Snapshot age ms | Discarded ms |',
      '| --- | --- | ---: | --- | --- | --- | --- | --- | ---: |');
    rows.forEach((row, index) => {
      assert.deepEqual([row.round, row.mode], order[index], `${kind}: missing or duplicate variant`);
      assert.equal(row.rendererClass, kind, `${kind}: wrong renderer class`);
      assert.equal(row.gpu, rows[0].gpu, `${kind}: renderer changed`);
      if (kind === 'hardware') requireHardwareRenderer(row.gpu);
      else assert(typeof row.gpu === 'string' && softwareRenderer.test(row.gpu), 'Expected verified software renderer');
      for (const key of [...identityKeys, ...sceneKeys]) {
        assert.notEqual(reference[key], undefined, `Missing ${key}`);
        assert.deepEqual(row[key], reference[key], `Comparison changed: ${key}`);
      }
      for (const key of audioKeys) {
        assert.notEqual(reference.workload?.[key], undefined, `Missing audio ${key}`);
        assert.deepEqual(row.workload?.[key], reference.workload[key], `Comparison audio changed: ${key}`);
      }
      assert.equal(row.workload.diagnostics, false);
      assert.deepEqual(row.errors, []);
      assert(Number.isFinite(row.submittedFps) && row.submittedFps > 0, 'Invalid submitted FPS');
      assert(Number.isFinite(row.discardedSimulationMs) && row.discardedSimulationMs >= 0, 'Invalid discarded time');
      assert.equal(typeof row.timerAvailable, 'boolean');
      const gpu = row.timerAvailable ? distribution(row.gpuMs, 'GPU') : 'unavailable';
      lines.push(`| ${row.round} | ${row.mode} | ${row.submittedFps.toFixed(2)} | ${distribution(row.frameMs, 'Frame')} | ${distribution(row.cpuSubmissionMs, 'CPU')} | ${gpu} | ${distribution(row.simulationDebtMs, 'Debt')} | ${distribution(row.snapshotAgeMs, 'Snapshot')} | ${row.discardedSimulationMs.toFixed(2)} |`);
    });
    lines.push('');
    for (const round of ['forward', 'reverse']) {
      const baseline = rows.find(row => row.round === round && row.mode === 'baseline');
      const changes = ['shading', 'shadows'].map(mode => {
        const row = rows.find(row => row.round === round && row.mode === mode);
        return `${mode} ${((row.submittedFps / baseline.submittedFps - 1) * 100).toFixed(1)}%`;
      });
      lines.push(`${round}: submitted throughput relative to baseline: ${changes.join(', ')}.`);
    }
    lines.push('');
  }
  const failures = performanceFailures(software, hardware);
  lines.push('## Performance gate', '',
    `Shading must reach ${hardwareMinFps} FPS with p95 frame intervals at most ${hardwareMaxP95FrameMs} ms on hardware, and ${softwareMinFps} FPS on software. A shading slowdown over ${maxRepeatableShadingRegression * 100}% in both orders fails on either renderer.`, '',
    failures.length ? `FAILED:\n${failures.map(failure => `- ${failure}`).join('\n')}` : 'PASSED', '',
    'The shadow candidate is informational. These host samples do not establish physical-phone acceptance.', '');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [software, hardware, output] = process.argv.slice(2);
  assert(software && hardware && output, 'Usage: node validation/tilt-lighting-comparison.mjs SOFTWARE.json HARDWARE.json OUTPUT.md');
  // A failed comparison must not leave a stale successful assessment behind.
  await writeFile(output, 'Renderer comparison incomplete.\n');
  const softwareRows = JSON.parse(await readFile(software, 'utf8'));
  const hardwareRows = JSON.parse(await readFile(hardware, 'utf8'));
  const summary = compareTimings(softwareRows, hardwareRows);
  await writeFile(output, summary);
  console.log(summary);
  assert.equal(performanceFailures(softwareRows, hardwareRows).length, 0, 'Tilt lighting performance gate failed; see comparison report');
}
