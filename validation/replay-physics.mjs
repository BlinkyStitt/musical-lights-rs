// Replay exported physical input at several render rates using the same WASM module.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import init, { PhysicsSimulation } from '../musical-lights-physics/pkg/physics.js';

export async function replayReport(report) {
  const wasm = await init({ module_or_path: await readFile(new URL('../musical-lights-physics/pkg/physics_bg.wasm', import.meta.url)) });
  const results = [];
  for (const fps of [30, 60, 120]) {
    const sim = new PhysicsSimulation(new Float32Array(report.config), new Float32Array(report.palette));
    let cursor = 0;
    while (sim.tick() < report.finalTick) {
      for (let i = 0; i < report.layout[1] / fps && sim.tick() < report.finalTick; i++) {
        while (cursor < report.inputs.length && report.inputs[cursor].tick === sim.tick()) sim.input(new Float32Array(report.inputs[cursor++].values));
        sim.step();
      }
    }
    const actual = Array.from(new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), report.layout[12]));
    const matches = actual.every((value, i) => value === report.finalSnapshot[i]);
    results.push({ fps, matches, ticks: sim.tick(), inputs: cursor });
    sim.free();
  }
  if (results.some(result => !result.matches)) throw new Error(`Physics replay differs: ${JSON.stringify(results)}`);
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await replayReport(JSON.parse(await readFile(process.argv[2], 'utf8'))), null, 2));
}
