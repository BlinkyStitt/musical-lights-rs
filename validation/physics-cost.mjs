import { runtimeRoot } from './runtime-assets.mjs';
// Deterministic 12-second generated-audio workload, including portrait/landscape
// resize transitions. Run each engine in a separate Node process so its WASM
// module and warmup cannot be confused with another revision.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import init, { PhysicsSimulation } from '../musical-lights-physics/pkg/physics.js';
import { tonePCM } from '../musical-leptos/src/tones.js';
import { flashTrace } from './partial/flash-fixtures.mjs';
const [path, output] = process.argv.slice(2);
if (!path || !output) throw new Error('Usage: node validation/physics-cost.mjs PHYSICS_WASM OUTPUT_JSON');
const pcm = new Float32Array(48000 * 12), loop = tonePCM('exercise');
pcm.set(loop); pcm.set(loop, loop.length);
const rows = flashTrace(new WebAssembly.Module(await readFile(`${await runtimeRoot('musical-leptos/dist')}/loudness/loudness.wasm`)), pcm);
const bytes = await readFile(path);
const wasm = await init({ module_or_path: bytes });
const layout = PhysicsSimulation.layout(), runs = [];
for (let run = 0; run < 3; run++) {
  const sim = new PhysicsSimulation(PhysicsSimulation.defaults(), new Float32Array(72).fill(.5));
  const input = new Float32Array(layout[22] ?? 34); input[33] = 1;
  let totalMs = 0, maxTickMs = 0, substeps = 0;
  for (let tick = 0; tick < 1440; tick++) {
    if (tick % 2 === 0) {
      input[32] = [.927803, 2.596923, .554502, 2.596923, .927803][Math.min(4, Math.floor(tick / 288))];
      const row = rows[Math.min(rows.length - 1, Math.floor(tick / 120 / .002))];
      for (let i = 0; i < 24; i++) input[i] = row[368 + 4 * i];
      sim.input(input);
    }
    const start = performance.now(); sim.step(); const cost = performance.now() - start;
    totalMs += cost; maxTickMs = Math.max(maxTickMs, cost);
    substeps += new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12])[layout[15]];
  }
  runs.push({ totalMs, maxTickMs, substeps, ticks: sim.tick() }); sim.free();
}
const result = { node: process.version, platform: process.platform, cpu: cpus()[0].model,
  physicsSha256: createHash('sha256').update(bytes).digest('hex'),
  pcmSha256: createHash('sha256').update(new Uint8Array(pcm.buffer)).digest('hex'),
  protocol: layout[18], bands: layout[0], balls: layout[21] ?? layout[0],
  durationSeconds: 12, physicsHz: layout[1], runs,
  medianCpuMs: runs.map(run => run.totalMs).sort((a, b) => a - b)[1] };
// Reproduce the full-height attack separately from the generated-audio workload.
// Preserve real targets and the controller's 40 ms travel; record overload rather
// than treating a capped tick as a successful performance acceptance result.
result.fullAttacks = [];
for (const height of [.927803, 2.596923]) {
  const config = PhysicsSimulation.defaults(); config[0] = height;
  const sim = new PhysicsSimulation(config, new Float32Array(72).fill(.5));
  const input = new Float32Array(layout[22] ?? 34); input[32] = height;
  sim.input(input);
  for (let tick = 0; tick < 120; tick++) sim.step();
  input.fill(1, 0, 24); sim.input(input);
  const trace = [];
  for (let tick = 1; tick <= 16; tick++) {
    sim.step();
    const snapshot = new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12]);
    trace.push({ ms: tick * 1000 / layout[1], top: snapshot[layout[9]],
      velocity: snapshot[layout[14]], substeps: snapshot[layout[15]], excess: snapshot[layout[15] + 1] });
  }
  result.fullAttacks.push({ height, overloadTicks: trace.filter(row => row.excess > 0).length,
    maxRequestedSubsteps: Math.max(...trace.map(row => row.substeps + row.excess)), trace });
  sim.free();
}
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, fullAttacks: result.fullAttacks.map(({ trace, ...summary }) => summary) }));
