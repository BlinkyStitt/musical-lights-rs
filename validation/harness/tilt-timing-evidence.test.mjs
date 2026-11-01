import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { timingIdentity } from '../tilt-timing-evidence.mjs';

test('timing evidence rejects stale lighting and binds artifact and prototype bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tilt-timing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = '0123456789abcdef01234567';
  const write = async (path, value) => {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, value);
  };
  await write('musical-leptos/dist/build.json', JSON.stringify({ version }));
  for (const path of ['physics.js', 'physics/view.js', 'physics/lighting.js']) {
    await write(`musical-leptos/src/${path}`, path);
    const built = path === 'physics.js' ? 'snippets/musical-leptos-179150a477811b85/src/physics.js' : path;
    await write(`musical-leptos/dist/assets/${version}/${built}`, path);
  }
  for (const path of ['tilt-lighting-timing.mjs', 'tilt-shadow-candidate.mjs', 'tilt-timing-evidence.mjs', 'performance-processes.mjs', 'browser-stall.mjs']) {
    await write(`validation/${path}`, path);
  }
  const original = await timingIdentity(root, version);
  assert.deepEqual(await timingIdentity(root, version), original);
  await assert.rejects(timingIdentity(root, 'another-build'), /Unexpected timing build/);
  await write('musical-leptos/src/physics/lighting.js', 'changed lighting');
  await assert.rejects(timingIdentity(root), /Rebuild before timing: stale physics\/lighting.js/);
  await write('musical-leptos/src/physics/lighting.js', 'physics/lighting.js');
  await write('musical-leptos/src/physics.js', 'changed sensor input');
  await assert.rejects(timingIdentity(root), /Rebuild before timing: stale physics\.js/);
  await write('musical-leptos/src/physics.js', 'physics.js');
  await write(`musical-leptos/dist/assets/${version}/engine.wasm`, 'changed compiled engine');
  const changedArtifact = await timingIdentity(root);
  assert.notEqual(changedArtifact.artifactSha256, original.artifactSha256);
  assert.deepEqual(changedArtifact.instrumentation, original.instrumentation);
  await write('validation/tilt-shadow-candidate.mjs', 'changed prototype');
  const changedPrototype = await timingIdentity(root);
  assert.notEqual(changedPrototype.instrumentation['tilt-shadow-candidate.mjs'], original.instrumentation['tilt-shadow-candidate.mjs']);
  assert.equal(changedPrototype.artifactSha256, changedArtifact.artifactSha256);
});

// Reject before browser startup. The command must still retain process evidence
// and a failure receipt, without leaving a sampler alive after the rejection.
test('a rejected tilt build retains process samples and its original failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tilt-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'musical-leptos/dist'), { recursive: true });
  await writeFile(join(root, 'musical-leptos/dist/build.json'), JSON.stringify({ version: '0'.repeat(24) }));
  const output = join(root, 'hardware.json');
  await assert.rejects(promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../tilt-lighting-timing.mjs', import.meta.url)), output, '--build', '1'.repeat(24)],
    { cwd: root, timeout: 10000 }), /Unexpected timing build/);
  const failure = JSON.parse(await readFile(`${output}.failure.json`, 'utf8'));
  assert.match(failure.error, /Unexpected timing build/);
  assert.equal(failure.completedSamples, 0);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), []);
  const samples = (await readFile(`${output}.processes.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(samples.length, 2, 'Keep both start and final process samples after failure');
  for (const sample of samples) assert.equal(sample.platform, process.platform);
  assert.ok(samples[1].elapsedMs >= samples[0].elapsedMs);
});
