import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { timingIdentity } from './tilt-timing-evidence.mjs';
import { runtimeRoot } from './runtime-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function activeGapIdentity() {
  const identity = await timingIdentity(root), runtime = await runtimeRoot(`${root}/musical-leptos/dist`);
  for (const path of ['report.js', 'performance.js']) {
    const source = await readFile(`${root}/musical-leptos/src/physics/${path}`);
    assert.deepEqual(await readFile(`${runtime}/physics/${path}`), source, `Rebuild before measuring: stale ${path}`);
    identity.sources[`physics/${path}`] = digest(source);
  }
  for (const path of ['active-gap-identity.mjs', 'active-gap-sampler.mjs', 'active-gap-evidence.mjs',
    'tests/active-gap-performance.spec.mjs', 'physics-cost.mjs', 'physics-cost-acceptance.mjs',
    'fullscreen-timing.mjs', 'active-gap-latency.mjs', 'packet-render.mjs', 'gpu-renderer.mjs', 'replay-physics.mjs',
    'performance-processes.mjs', 'browser-stall.mjs'])
    identity.instrumentation[path] = digest(await readFile(`${root}/validation/${path}`));
  return identity;
}
