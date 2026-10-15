import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import init, { PhysicsSimulation } from '../../musical-lights-physics/pkg/physics.js';
import { replayReport } from '../replay-physics.mjs';
const wasm = await init({ module_or_path: await readFile(new URL('../../musical-lights-physics/pkg/physics_bg.wasm', import.meta.url)) });

test('the built WASM accepts protocol 14 scrolling and stops at its published phase', () => {
  const layout = PhysicsSimulation.layout();
  assert.equal(layout[18], 14, 'Rebuild the release WASM; native checks cannot validate a stale browser artifact');
  assert.equal(layout[0], 24);
  assert.equal(layout[4], 0, 'Adjacent bar colliders have no gap');
  assert.equal(layout[5], 0, 'Joined tips have no seam trough');
  assert.equal(layout[23], layout[20] + 1, 'Snapshots publish the authoritative spline coefficients');
  assert.equal(layout[24], 8, 'Rendering uses the same chord count as collision');
  assert.equal(layout[21], 8);
  assert.equal(layout[22], 62, 'Current audio attack edges are part of the recorded input');
  assert.equal(layout[9], 3 + 8 * layout[8]);
  assert.equal(layout[11] - layout[10], 8 * 24);
  const sim = new PhysicsSimulation(PhysicsSimulation.defaults(), new Float32Array(72).fill(.5));
  try {
    const input = new Float32Array(layout[22]); input[32] = .6; input[33] = 1;
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

test('built WASM transfers pigment only during audio attacks and replays their eligibility', async () => {
  const layout = Array.from(PhysicsSimulation.layout());
  const config = Array.from(PhysicsSimulation.defaults());
  const palette = Array.from({ length: 72 }, (_, i) => i % 3 === 0 ? Math.floor(i / 3) / 24 : .2);
  const runs = [];
  for (const attacking of [false, true]) {
    const sim = new PhysicsSimulation(new Float32Array(config), new Float32Array(palette));
    try {
      const snapshot = () => Array.from(new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12]));
      const pigments = () => Array.from(new Float32Array(wasm.memory.buffer, sim.pigments_ptr(), layout[21] * 9));
      const initial = snapshot(), initialPigments = pigments();
      const values = Array(layout[22]).fill(0); values.fill(1, 0, 24); values[32] = config[0];
      values.fill(attacking ? .5 : 0, 38);
      const inputs = [{ tick: 0, values }];
      sim.input(new Float32Array(values));
      let contacts = 0;
      for (let tick = 0; tick < 120; tick++) {
        sim.step();
        contacts += snapshot().slice(layout[10], layout[11]).reduce((sum, value) => sum + value, 0);
      }
      assert(contacts > 0, 'Raised bars must physically contact the balls');
      const finalSnapshot = snapshot();
      const colors = state => Array.from({ length: 8 }, (_, i) => state.slice(3 + i * layout[8] + 15, 3 + i * layout[8] + 18));
      if (attacking) {
        assert.notDeepEqual(colors(finalSnapshot), colors(initial));
        assert.notDeepEqual(pigments(), initialPigments);
        const report = { type: 'musical-lights-phone-report-v5', config, palette, layout, initialTempo: 120,
          inputs, finalTick: sim.tick(), finalSnapshot };
        assert((await replayReport(report)).every(result => result.matches));
        const missing = structuredClone(report); missing.inputs[0].values.fill(0, 38);
        await assert.rejects(replayReport(missing), /Physics replay differs/);
      } else {
        assert.deepEqual(colors(finalSnapshot), colors(initial));
        assert.deepEqual(pigments(), initialPigments);
      }
      // Attack eligibility changes pigment only, never the contact response.
      runs.push(finalSnapshot.filter((_, i) => i < 3 || i >= layout[9] || (i - 3) % layout[8] < 15));
      for (const invalid of [-.1, 1.1, NaN]) {
        values[38] = invalid;
        assert.throws(() => sim.input(new Float32Array(values)));
      }
    } finally { sim.free(); }
  }
  assert.deepEqual(runs[0], runs[1]);
});

test('ordered input tempo changes reproduce complete physical snapshots across render rates', async () => {
  const config = Array.from(PhysicsSimulation.defaults()), palette = Array(72).fill(.5);
  const layout = Array.from(PhysicsSimulation.layout());
  const values = Array(layout[22]).fill(0); values[0] = .3; values[32] = .6; values[33] = 1;
  const inputs = [{ tick: 0, values, tempo: 120 }, { tick: 50, values, tempo: 160 }, { tick: 120, values, tempo: 80 }];
  const sim = new PhysicsSimulation(new Float32Array(config), new Float32Array(palette));
  try {
    for (let tick = 0; tick < 200; tick++) {
      for (const event of inputs) if (event.tick === tick) {
        sim.set_tempo(event.tempo); sim.input(new Float32Array(event.values));
      }
      sim.step();
    }
    const report = { type: 'musical-lights-phone-report-v5', initialTempo: 120,
      config, palette, layout, inputs, finalTick: sim.tick(),
      finalSnapshot: Array.from(new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12])) };
    assert((await replayReport(report)).every(result => result.matches));
    const missing = { ...report, inputs: inputs.map(({ tempo, ...event }) => event) };
    await assert.rejects(replayReport(missing), /Physics replay differs/);
    await assert.rejects(replayReport({ ...report, type: 'musical-lights-phone-report-v3' }), /matching historical replay/);
  } finally { sim.free(); }
});

test('seeded loud-attack accents reproduce paired bar motion at every render rate', async () => {
  const config = Array.from(PhysicsSimulation.defaults()), palette = Array(72).fill(.5);
  const layout = Array.from(PhysicsSimulation.layout());
  const danceOptions = { odds: [60, 200, .05, .5, 1], scrollSpeed: 2, flight: .3, seed: 1 };
  const initialAccent = 1000;
  const values = Array(layout[22]).fill(0); values[0] = .3; values[32] = .6; values[33] = 1;
  const inputs = [{ tick: 0, values }, { tick: 60, values, accent: 1001 }, { tick: 100, values, accent: 1002 },
    { tick: 140, values, accent: 1003 }, { tick: 200, values, accent: 1003 }];
  const sim = new PhysicsSimulation(new Float32Array(config), new Float32Array(palette));
  try {
    sim.configure_dance(new Float64Array(danceOptions.odds), danceOptions.flight, danceOptions.seed, danceOptions.scrollSpeed);
    sim.accent(initialAccent);
    for (let tick = 0; tick < 400; tick++) {
      for (const event of inputs) if (event.tick === tick) {
        sim.input(new Float32Array(event.values));
        if (event.accent !== undefined) sim.accent(event.accent);
        if (tick === 60) assert.equal(sim.horizontal_direction(), -1, 'The first accepted seeded draw reverses');
        if (tick === 100) assert.equal(sim.horizontal_direction(), 1, 'The second accepted draw reverses again');
        if (tick === 140) assert.equal(sim.horizontal_direction(), 1, 'The third draw exceeds the tempo-scaled chance');
      }
      sim.step();
    }
    const report = { type: 'musical-lights-phone-report-v5', initialTempo: 120,
      config, palette, layout, danceOptions, initialAccent, inputs, finalTick: sim.tick(),
      finalSnapshot: Array.from(new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12])) };
    assert((await replayReport(report)).every(result => result.matches));
    const missing = { ...report, inputs: inputs.map(({ accent, ...event }) => event) };
    await assert.rejects(replayReport(missing), /Physics replay differs/);
  } finally { sim.free(); }
});
