import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runtimeRoot } from './runtime-assets.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Bind measurements to the served artifact as well as the separately injected
// prototype. A manifest alone cannot detect stale copied lighting code.
export async function timingIdentity(root = process.cwd(), expectedBuild) {
  const dist = resolve(root, 'musical-leptos/dist');
  const build = JSON.parse(await readFile(resolve(dist, 'build.json'), 'utf8'));
  if (expectedBuild !== undefined) assert.equal(build.version, expectedBuild, 'Unexpected timing build');
  const runtime = await runtimeRoot(dist);
  const snippets = (await readdir(resolve(runtime, 'snippets'), { recursive: true }))
    .filter(path => /^musical-leptos-[^/]+\/src\/physics\.js$/.test(path));
  assert.equal(snippets.length, 1, 'Expected one wasm-bindgen physics input module');
  const sources = {};
  for (const path of ['physics.js', 'physics/view.js', 'physics/lighting.js']) {
    const source = await readFile(resolve(root, 'musical-leptos/src', path));
    const built = path === 'physics.js' ? resolve(runtime, 'snippets', snippets[0]) : resolve(runtime, path);
    assert.deepEqual(await readFile(built), source, `Rebuild before timing: stale ${path}`);
    sources[path] = sha256(source);
  }
  const artifact = createHash('sha256');
  for (const path of (await readdir(dist, { recursive: true })).sort()) {
    // Directory entries have no bytes; include every regular artifact file.
    const bytes = await readFile(resolve(dist, path)).catch(error => {
      if (error.code === 'EISDIR') return null;
      throw error;
    });
    if (bytes !== null) artifact.update(path).update('\0').update(sha256(bytes));
  }
  const instrumentation = {};
  for (const path of ['tilt-lighting-timing.mjs', 'tilt-shadow-candidate.mjs', 'tilt-timing-evidence.mjs']) {
    instrumentation[path] = sha256(await readFile(resolve(root, 'validation', path)));
  }
  return { build, artifactSha256: artifact.digest('hex'), sources, instrumentation };
}
