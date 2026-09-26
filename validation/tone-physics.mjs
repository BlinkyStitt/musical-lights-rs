import { traceLayout } from './trace-layout.mjs';
// Replay the measured targets at 60 Hz into the actual before/after physics WASM.
// Model rows remain on their original 2 ms grid. Each physical row names its source.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const baseline = await import('../.cache/baseline-physics/physics.js');
const current = await import('../musical-lights-physics/pkg/physics.js');
const reports = [];
for (const [label, api, modulePath] of [['before', baseline, '.cache/baseline-physics'], ['after', current, 'musical-lights-physics/pkg']]) {
  const wasm = await api.default({ module_or_path: await readFile(`${modulePath}/physics_bg.wasm`) });
  const directory = `.cache/tones-${label}`;
  const cases = JSON.parse(await readFile(`${directory}/summary.json`, 'utf8'));
  const layout = api.PhysicsSimulation.layout();
  for (const { kind, frames, stride, transport } of cases) {
    const bytes = await readFile(`${directory}/${kind}.f64`), rows = new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
    const schema = traceLayout(stride);
    const config = api.PhysicsSimulation.defaults();
    const sim = new api.PhysicsSimulation(config, new Float32Array(72).fill(.5));
    const input = new Float32Array(33); input[32] = config[0];
    const output = new Float64Array(Math.floor(frames * .002 * 120) * 54);
    let rowIndex = 0, source = 0, maxDelay = 0, maxSubsteps = 0, overloadTicks = 0;
    const start = performance.now();
    for (let tick = 0; tick < output.length / 54; tick++) {
      if (tick % 2 === 0) {
        source = Math.min(frames - 1, Math.floor(tick / 120 / .002));
        for (let i = 0; i < 24; i++) input[i] = rows[source * stride + schema.display + (schema.header ?? 2) + (schema.filtered ?? 0) + i * schema.step];
        sim.input(input);
      }
      sim.step();
      const state = new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12]);
      const at = (tick + 1) / 120;
      output[rowIndex++] = at; output[rowIndex++] = source;
      output.set(state.subarray(layout[9], layout[10]), rowIndex); rowIndex += 24;
      if (label === 'after') {
        output.set(state.subarray(layout[14], layout[15]), rowIndex);
        output.set(state.subarray(layout[15], layout[15] + 4), rowIndex + 24);
        maxSubsteps = Math.max(maxSubsteps, state[layout[15]]);
        overloadTicks += Number(state[layout[15] + 1] > 0);
      }
      rowIndex += 28;
      maxDelay = Math.max(maxDelay, at - rows[source * stride + schema.sample] / 48000);
      for (let i = 0; i < 24; i++) {
        const j = 3 + i * layout[8], [x, y, z] = state.subarray(j, j + 3);
        assert(x >= 0 && x <= layout[2] && y >= 0 && Math.abs(z) <= config[5] / 2, `${label}/${kind}: ball ${i} escaped at ${at}`);
      }
    }
    await writeFile(`${directory}/${kind}-physics.f64`, new Uint8Array(output.buffer));
    const report = { label, kind, ticks: sim.tick(), renderHz: 60, physicsHz: 120,
      maxSourceAgeMs: maxDelay * 1000, maxSubsteps, overloadTicks, simulationCpuMs: performance.now() - start, ballsContained: true };
    reports.push(report); console.log(report); sim.free();
  }
}
await writeFile('docs/gain-stroke-results/tone-physics.json', JSON.stringify(reports, null, 2) + '\n');
