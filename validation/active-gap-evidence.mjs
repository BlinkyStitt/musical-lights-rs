// Root-invoked, serial collectors against one verified build. Run on the GPU
// runner after correctness checks, separately from statistical benchmarks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeGapIdentity } from './active-gap-identity.mjs';

assert.equal(process.cwd(), fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, ''), 'Invoke from repository root');
const output = resolve(process.argv[2] ?? '.ci/active-gap');
await mkdir(output, { recursive: true });
const identity = await activeGapIdentity(), commands = [];
await writeFile(`${output}/identity.json`, JSON.stringify(identity, null, 2));
await writeFile(`${output}/result.json`, JSON.stringify({ complete: false }));
const exited = child => new Promise((resolve, reject) => {
  child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
});
async function command(name, args) {
  const log = await open(`${output}/${name}.log`, 'w');
  const receipt = { name, args, started: new Date().toISOString() };
  console.log(`Collecting ${name}`);
  try {
    Object.assign(receipt, await exited(spawn(process.execPath, args, { stdio: ['ignore', log.fd, log.fd] })));
    assert.equal(receipt.code, 0, `${name} failed; see ${output}/${name}.log`);
  } finally {
    await log.close(); receipt.ended = new Date().toISOString(); commands.push(receipt);
    await writeFile(`${output}/commands.json`, JSON.stringify(commands, null, 2));
  }
}
await command('cost', ['validation/physics-cost.mjs', 'musical-lights-physics/pkg/physics_bg.wasm', `${output}/cost.json`]);
const log = await open(`${output}/server.log`, 'w');
const server = spawn(process.execPath, ['server.mjs'], { cwd: 'validation', stdio: ['ignore', log.fd, log.fd] });
const stopped = exited(server);
try {
  let served;
  for (let i = 0; i < 50; i++) {
    assert.equal(server.exitCode, null, 'Evidence server stopped during startup');
    try {
      const response = await fetch('http://127.0.0.1:8101/build.json', { signal: AbortSignal.timeout(1000) });
      if (response.ok) { served = await response.json(); break; }
    } catch { /* Startup is polled; browser execution itself is never retried. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(served, identity.build, 'Evidence origin has a missing or mismatched build');
  await command('fullscreen', ['validation/fullscreen-timing.mjs', 'http://127.0.0.1:8101', `${output}/fullscreen.json`, '--expect-clean', '--hardware']);
  await command('latency', ['validation/active-gap-latency.mjs', 'http://127.0.0.1:8101', `${output}/latency.json`, '--hardware']);
  assert.deepEqual(await activeGapIdentity(), identity, 'Measured artifacts changed during collection');
  await writeFile(`${output}/result.json`, JSON.stringify({ complete: true, ...identity }, null, 2));
} finally {
  server.kill('SIGTERM'); await stopped; await log.close();
}
