import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import init, { PhysicsSimulation } from '../../musical-lights-physics/pkg/physics.js';
const wasm = await init({ module_or_path: await readFile(new URL('../../musical-lights-physics/pkg/physics_bg.wasm', import.meta.url)) });

test('the built WASM accepts protocol 7 scrolling and stops at its published phase', () => {
  const layout = PhysicsSimulation.layout();
  assert.equal(layout[18], 7, 'Rebuild the release WASM; native checks cannot validate a stale browser artifact');
  assert.equal(layout[0], 24);
  assert.equal(layout[21], 8);
  assert.equal(layout[9], 3 + 8 * layout[8]);
  assert.equal(layout[11] - layout[10], 8 * 24);
  const sim = new PhysicsSimulation(PhysicsSimulation.defaults(), new Float32Array(72).fill(.5));
  try {
    const input = new Float32Array(layout[22] ?? 34); input[32] = .6; input[33] = 1;
    sim.input(input);
    for (let i = 0; i < 240; i++) sim.step();
    const phase = () => new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12])[layout[20]];
    assert(Math.abs(phase() - (55.5 / 80 * 4) * Math.sin((2 - .060) * Math.PI / 8)) < .001);
    input[33] = 0; sim.input(input);
    for (let i = 0; i < 30; i++) sim.step();
    const stopped = phase();
    for (let i = 0; i < 30; i++) sim.step();
    assert.equal(phase(), stopped);
    input[33] = 3;
    assert.throws(() => sim.input(input), /scrolling and gravity enablement/);
  } finally { sim.free(); }
});
