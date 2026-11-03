import { runtimeRoot } from './runtime-assets.mjs';
import { evaluatePhysicsCost } from './physics-cost-acceptance.mjs';
import { traceLayout } from './trace-layout.mjs';
// Deterministic 12-second generated-audio workload, including portrait/landscape
// resize transitions. Run each engine in a separate Node process so its WASM
// module and warmup cannot be confused with another revision.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import init, { PhysicsSimulation } from '../musical-lights-physics/pkg/physics.js';
import { tonePCM } from '../musical-leptos/src/tones.js';
import { hsluvToLinear } from '../musical-leptos/src/physics/pigment.js';
import { flashTrace } from './partial/flash-fixtures.mjs';
const [path, output] = process.argv.slice(2);
if (!path || !output) throw new Error('Usage: node validation/physics-cost.mjs PHYSICS_WASM OUTPUT_JSON');
const pcm = new Float32Array(48000 * 12), loop = tonePCM('exercise');
pcm.set(loop); pcm.set(loop, loop.length);
const rows = flashTrace(new WebAssembly.Module(await readFile(`${await runtimeRoot('musical-leptos/dist')}/loudness/loudness.wasm`)), pcm);
const schema = traceLayout(rows[0].length);
const bytes = await readFile(path);
const wasm = await init({ module_or_path: bytes });
const layout = PhysicsSimulation.layout(), runs = [];
const anchors = [12, 38, 85, 127, 192, 258, 285], stops = [0, 1/6, 2/6, 3/6, 4/6, 5/6, 1];
const palette = Float32Array.from(Array.from({ length: 24 }, (_, i) => {
  const t = i/23, k = Math.min(5, stops.findIndex((v,j) => j < 6 && t <= stops[j+1]));
  const h = anchors[k] + (anchors[k+1]-anchors[k])*(t-stops[k])/(stops[k+1]-stops[k]);
  const rgb = hsluvToLinear([h,100,58]), peak = Math.max(...rgb);
  return rgb.map(v => v/peak);
}).flat());
for (const gapCap of [.6, 20]) for (let run = 0; run < 3; run++) {
  const config = PhysicsSimulation.defaults(); config[11] = gapCap;
  const sim = new PhysicsSimulation(config, palette);
  const input = new Float32Array(layout[22]); input.set(config.slice(8, 11), 64); input[33] = 1; input[62] = PhysicsSimulation.defaults()[5]; input[67] = gapCap;
  let totalMs = 0, maxTickMs = 0, substeps = 0, requestedSubsteps = 0, overloadTicks = 0;
  for (let tick = 0; tick < 1440; tick++) {
    if (tick % 2 === 0) {
      input[32] = [.927803, 2.596923, .554502, 2.596923, .927803][Math.min(4, Math.floor(tick / 288))];
      const row = rows[Math.min(rows.length - 1, Math.floor(tick / 120 / .002))];
      for (let i = 0; i < 24; i++) input[i] = row[schema.display + schema.header + schema.filtered + schema.step * i];
      sim.input(input);
    }
    const start = performance.now(); sim.step(); const cost = performance.now() - start;
    totalMs += cost; maxTickMs = Math.max(maxTickMs, cost);
    const state = new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12]);
    substeps += state[layout[15]]; requestedSubsteps += state[layout[15]] + state[layout[15] + 1];
    if (state[layout[15] + 1] > 0) overloadTicks++;
  }
  runs.push({ gapCap, requestedSubsteps, overloadTicks, totalMs, maxTickMs, substeps, ticks: sim.tick() }); sim.free();
}
const result = { node: process.version, platform: process.platform, cpu: cpus()[0].model,
  paletteSha256: createHash('sha256').update(new Uint8Array(palette.buffer)).digest('hex'),
  palette: 'production peak-scaled HSLuv rainbow (100, 58)',
  physicsSha256: createHash('sha256').update(bytes).digest('hex'),
  pcmSha256: createHash('sha256').update(new Uint8Array(pcm.buffer)).digest('hex'),
  protocol: layout[18], bands: layout[0], balls: PhysicsSimulation.defaults()[8],
  durationSeconds: 12, riseDurationMs: PhysicsSimulation.defaults()[6] * 1000, physicsHz: layout[1], runs,
  cpuByCap: [.6,20].map(gapCap => ({gapCap, medianCpuMs:runs.filter(r=>r.gapCap===gapCap).map(r=>r.totalMs).sort((a,b)=>a-b)[1]})) };
// Reproduce the full-height attack separately from the generated-audio workload.
// Preserve real targets and the configured rise duration; record overload rather
// than treating a capped tick as a successful performance acceptance result.
result.fullAttacks = [];
for (const height of [.927803, 2.596923]) for (const gapCap of [.6, 20]) {
  const config = PhysicsSimulation.defaults(); config[0] = height; config[11] = gapCap;
  const sim = new PhysicsSimulation(config, palette);
  const input = new Float32Array(layout[22] ?? 34); input.set(config.slice(8, 11), 64); input[32] = height; input[62] = config[5]; input[67] = config[11];
  sim.input(input);
  for (let tick = 0; tick < 120; tick++) sim.step();
  input.fill(1, 0, 24); sim.input(input);
  const trace = [];
  for (let tick = 1; tick <= 16; tick++) {
    sim.step();
    const snapshot = new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12]);
    trace.push({ ms: tick * 1000 / layout[1], top: snapshot[layout[9]], baseline: snapshot[layout[17]+5], activeTop: snapshot[layout[9]]-snapshot[layout[17]+5],
      motion: snapshot[layout[31]], travel: snapshot[layout[17]+6], velocity: snapshot[layout[14]], substeps: snapshot[layout[15]], excess: snapshot[layout[15] + 1] });
  }
  result.fullAttacks.push({ height, gapCap, requestedSubsteps: trace.reduce((s,r)=>s+r.substeps+r.excess,0), overloadTicks: trace.filter(row => row.excess > 0).length,
    maxRequestedSubsteps: Math.max(...trace.map(row => row.substeps + row.excess)), trace });
  sim.free();
}
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, fullAttacks: result.fullAttacks.map(({ trace, ...summary }) => summary) }));

evaluatePhysicsCost(result);
