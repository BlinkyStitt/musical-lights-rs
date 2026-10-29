import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
  for (const path of ['tilt-lighting-timing.mjs', 'tilt-shadow-candidate.mjs', 'tilt-timing-evidence.mjs']) {
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
