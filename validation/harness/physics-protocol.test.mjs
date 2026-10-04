import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import init, { PhysicsSimulation } from '../../musical-lights-physics/pkg/physics.js';
import { replayReport } from '../replay-physics.mjs';
const wasm = await init({ module_or_path: await readFile(new URL('../../musical-lights-physics/pkg/physics_bg.wasm', import.meta.url)) });

test('the built WASM accepts protocol 8 scrolling and stops at its published phase', () => {
  const layout = PhysicsSimulation.layout();
  assert.equal(layout[18], 8, 'Rebuild the release WASM; native checks cannot validate a stale browser artifact');
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
    // Two columns per beat at 120 BPM. With no eligible accents, the
    // direction must remain positive through the old reversal boundary.
    assert(Math.abs(phase() - 7.52) < .001);
    input[33] = 0; sim.input(input);
    for (let i = 0; i < 30; i++) sim.step();
    const stopped = phase();
    for (let i = 0; i < 30; i++) sim.step();
    assert.equal(phase(), stopped);
    input[33] = 3;
    assert.throws(() => sim.input(input), /scrolling and gravity enablement/);
  } finally { sim.free(); }
});

test('optional tempo events reproduce complete physical snapshots across render rates', async () => {
  const config = Array.from(PhysicsSimulation.defaults()), palette = Array(72).fill(.5);
  const layout = Array.from(PhysicsSimulation.layout());
  const simulate = events => {
    const sim = new PhysicsSimulation(new Float32Array(config), new Float32Array(palette));
    try {
      const values = Array(38).fill(0); values[0] = .3; values[32] = .6; values[33] = 1;
      sim.input(new Float32Array(values));
      for (let tick = 0; tick < 200; tick++) {
        for (const event of events) if (event.tick === tick) sim.set_tempo(event.bpm);
        sim.step();
      }
      return { config, palette, layout, finalTick: sim.tick(), inputs: [{ tick: 0, values }],
        finalSnapshot: Array.from(new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12])) };
    } finally { sim.free(); }
  };
  const tempoEvents = [{ tick: 0, bpm: 120 }, { tick: 50, bpm: 160 }, { tick: 120, bpm: 80 }];
  const changing = { ...simulate(tempoEvents), tempoEvents };
  assert((await replayReport(changing)).every(result => result.matches));
  // A constant-tempo recording has no tempo changes to apply.
  assert((await replayReport(simulate([]))).every(result => result.matches));
  const missing = { ...changing }; delete missing.tempoEvents;
  await assert.rejects(replayReport(missing), /Physics replay differs/);
});

test('seeded acoustic direction events reproduce floor and ceiling motion at every render rate', async () => {
  const config = Array.from(PhysicsSimulation.defaults()), palette = Array(72).fill(.5);
  const layout = Array.from(PhysicsSimulation.layout());
  const danceOptions = { chance: 1, flight: .3, seed: 1 };
  const initialAccent = 1000;
  const motionEvents = [{ tick: 60, sequence: 1001 }, { tick: 100, sequence: 1002 },
    { tick: 140, sequence: 1003 }, { tick: 200, sequence: 1003 }];
  const values = Array(38).fill(0); values[0] = .3; values[32] = .6; values[33] = 1;
  const sim = new PhysicsSimulation(new Float32Array(config), new Float32Array(palette));
  try {
    sim.configure_dance(danceOptions.chance, danceOptions.flight, danceOptions.seed);
    sim.accent(initialAccent); sim.input(new Float32Array(values));
    for (let tick = 0; tick < 400; tick++) {
      for (const event of motionEvents) if (event.tick === tick) sim.accent(event.sequence);
      sim.step();
    }
    assert.equal(sim.ceiling_bars(), true, 'The third seeded draw flips the vertical bars');
    const report = { config, palette, layout, danceOptions, initialAccent, motionEvents,
      finalTick: sim.tick(), inputs: [{ tick: 0, values }],
      finalSnapshot: Array.from(new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12])) };
    assert((await replayReport(report)).every(result => result.matches));
    const missing = { ...report }; delete missing.motionEvents;
    await assert.rejects(replayReport(missing), /Physics replay differs/);
  } finally { sim.free(); }
});
