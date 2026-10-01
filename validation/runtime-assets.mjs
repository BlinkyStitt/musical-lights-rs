import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Historical previews predate the versioned runtime layout.
export async function runtimeRoot(dist) {
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(dist, 'build.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return resolve(dist); throw error; }
  if (!/^[a-f0-9]{24}$/.test(manifest.version)) throw new Error('Invalid runtime version');
  return resolve(dist, 'assets', manifest.version);
}
