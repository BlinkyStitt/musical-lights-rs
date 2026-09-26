import { readFile, writeFile } from 'node:fs/promises';
import init, { PhysicsSimulation } from '../musical-lights-physics/pkg/physics.js';
import assert from 'node:assert/strict';
const wasm = await init({ module_or_path: await readFile('musical-lights-physics/pkg/physics_bg.wasm') });
const layout = PhysicsSimulation.layout(), results = [];
for (const height of [.4, .6, 1.2, 2]) {
  const config = PhysicsSimulation.defaults(); config[0] = height;
  const sim = new PhysicsSimulation(config, new Float32Array(72).fill(.5));
  const state = () => new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12]);
  const input = new Float32Array(33); input[32] = height;
  let maxSubsteps = 0, overload = 0;
  const strokes = [];
  for (const level of [1, 0, 1, 0]) {
    input.fill(level, 0, 24); sim.input(input);
    const trace = []; let arrival;
    for (let tick = 1; tick <= 12; tick++) {
      sim.step(); const s = state();
      maxSubsteps = Math.max(maxSubsteps, s[layout[15]]);
      overload += Number(s[layout[15] + 1] > 0);
      const top = s[layout[9]], target = .003 + level * (s[layout[17]+1] - .003);
      if (arrival == null && Math.abs(top - target) <= (s[layout[17]+1] - .003) * .01) arrival = tick * 1000 / 120;
      trace.push({ ms: tick * 1000 / 120, top, velocity: s[layout[14]], substeps: s[layout[15]], excess: s[layout[15] + 1] });
    }
    assert(arrival <= 50); assert(Math.abs(state()[layout[14]]) < 1e-5);
    strokes.push({ level, arrivalMs: arrival, trace });
  }
  input.fill(1, 0, 24); sim.input(input);
  for (let tick = 0; tick < 2; tick++) sim.step();
  input.fill(0, 0, 24); sim.input(input);
  let reversalMs, reversalArrivalMs;
  const reversalTrace = [];
  for (let tick = 1; tick <= 24; tick++) {
    sim.step(); const s = state();
    if (reversalMs == null && s[layout[14]] < 0) reversalMs = tick * 1000 / 120;
    if (reversalArrivalMs == null && Math.abs(s[layout[9]] - .003) < (s[layout[17]+1] - .003) * .01) reversalArrivalMs = tick * 1000 / 120;
    reversalTrace.push({ ms: tick * 1000 / 120, top: s[layout[9]], velocity: s[layout[14]] });
  }
  results.push({ height, balls: 24, config: Array.from(config), maxSubsteps, overloadTicks: overload, reversalMs, reversalArrivalMs, reversalTrace, strokes });
  sim.free();
}
await writeFile(process.argv[2] ?? 'docs/gain-stroke-results/strokes.json', JSON.stringify(results, null, 2) + '\n');
console.log(results.map(r => ({ height: r.height, arrival: r.strokes.map(s => s.arrivalMs), maxSubsteps: r.maxSubsteps, overloadTicks: r.overloadTicks, reversalMs: r.reversalMs, reversalArrivalMs: r.reversalArrivalMs })));
