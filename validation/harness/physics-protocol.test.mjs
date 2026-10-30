import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import init, { PhysicsSimulation } from '../../musical-lights-physics/pkg/physics.js';
import { replayReport } from '../replay-physics.mjs';
const wasm = await init({ module_or_path: await readFile(new URL('../../musical-lights-physics/pkg/physics_bg.wasm', import.meta.url)) });

test('the built WASM accepts protocol 22 scrolling and stops at its published phase', () => {
  const layout = PhysicsSimulation.layout();
  assert.equal(layout[18], 22, 'Rebuild the release WASM; native checks cannot validate a stale browser artifact');
  assert.equal(layout[0], 24);
  assert(Math.abs(layout[4] - .002) < 1e-8, 'Straight joins fill the former 2 mm gap');
  assert.equal(layout[5], 0, 'Flat tips have no seam trough');
  assert.equal(layout[21], 16);
  assert.equal(layout[22], 68, 'Audio attacks, depth and the attack-only paint policy are recorded inputs');
  assert.equal(layout.length, 32, 'The shared core supplies the seven swirl profile values');
  assert.equal(layout[9], 3 + 16 * layout[8]);
  assert.equal(layout[11] - layout[10], 16 * 24);
  const sim = new PhysicsSimulation(PhysicsSimulation.defaults(), new Float32Array(72).fill(.5));
  try {
    const input = new Float32Array(layout[22]); input[32] = .6; input[62] = .48; input[67] = .6; input[64] = 8; input[65] = .0264; input[66] = .192; input[33] = 1;
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
    assert.throws(() => sim.input(input), /scrolling, gravity, audio attacks and enclosure depth/);
  } finally { sim.free(); }
});

test('built WASM paints from physical contacts independently of audio and replays exactly', async () => {
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
      const values = Array(layout[22]).fill(0); values.fill(1, 0, 24); values[32] = config[0]; values[62] = config[5]; values[67] = .6; values[64] = 8; values[65] = .0264; values[66] = .192;
      values.fill(attacking ? .5 : 0, 38, 62);
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
      assert.notDeepEqual(colors(finalSnapshot), colors(initial));
      assert.notDeepEqual(pigments(), initialPigments);
      const report = { type: 'musical-lights-phone-report-v8', config, palette, layout, initialTempo: 120,
        inputs, finalTick: sim.tick(), finalSnapshot, finalPigments: Array.from(new Float32Array(wasm.memory.buffer, sim.pigments_ptr(), layout[21] * 9)) };
      assert((await replayReport(report)).every(result => result.matches));
      await assert.rejects(replayReport({ ...report, finalPigments: undefined }), /complete regional pigment/);
      const corrupted = structuredClone(report); corrupted.finalPigments[0] += .01;
      await assert.rejects(replayReport(corrupted), /Physics replay differs|complete regional pigment/);
      await assert.rejects(replayReport({ ...report, type: 'musical-lights-phone-report-v6' }), /historical replay/);
      const historical = structuredClone(report); historical.layout[18] = 20;
      await assert.rejects(replayReport(historical), /historical engine/);

      const quiet = structuredClone(report); quiet.inputs[0].values.fill(0, 38, 62);
      assert((await replayReport(quiet)).every(result => result.matches));
      // Audio changes neither the physical response nor contact painting.
      runs.push(finalSnapshot);
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
  const values = Array(layout[22]).fill(0); values[0] = .3; values[32] = .6; values[62] = config[5]; values[67] = .6; values[64] = 8; values[65] = .0264; values[66] = .192; values[33] = 1;
  const inputs = [{ tick: 0, values, tempo: 120 }, { tick: 50, values, tempo: 160 }, { tick: 120, values, tempo: 80 }];
  const sim = new PhysicsSimulation(new Float32Array(config), new Float32Array(palette));
  try {
    for (let tick = 0; tick < 200; tick++) {
      for (const event of inputs) if (event.tick === tick) {
        sim.set_tempo(event.tempo); sim.input(new Float32Array(event.values));
      }
      sim.step();
    }
    const report = { type: 'musical-lights-phone-report-v8', initialTempo: 120,
      config, palette, layout, inputs, finalTick: sim.tick(),
      finalSnapshot: Array.from(new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12])),
      finalPigments: Array.from(new Float32Array(wasm.memory.buffer, sim.pigments_ptr(), layout[21] * 9)) };
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
  const values = Array(layout[22]).fill(0); values[0] = .3; values[32] = .6; values[62] = config[5]; values[67] = .6; values[64] = 8; values[65] = .0264; values[66] = .192; values[33] = 1;
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
    const report = { type: 'musical-lights-phone-report-v8', initialTempo: 120,
      config, palette, layout, danceOptions, initialAccent, inputs, finalTick: sim.tick(),
      finalSnapshot: Array.from(new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12])),
      finalPigments: Array.from(new Float32Array(wasm.memory.buffer, sim.pigments_ptr(), layout[21] * 9)) };
    assert((await replayReport(report)).every(result => result.matches));
    const missing = { ...report, inputs: inputs.map(({ accent, ...event }) => event) };
    await assert.rejects(replayReport(missing), /Physics replay differs/);
  } finally { sim.free(); }
});

test('built WASM records live enclosure depth and replays shrink and expansion', async () => {
  const layout = Array.from(PhysicsSimulation.layout()), config = Array.from(PhysicsSimulation.defaults()), palette = Array(72).fill(.5);
  const values = Array(layout[22]).fill(0); values[32] = config[0]; values[62] = config[5]; values[67] = .6; values[64] = 8; values[65] = .0264; values[66] = .192;
  const inputs = [{tick:0, values:[...values]}, {tick:30, values:values.map((v,i)=>i===62?2:v)}, {tick:60, values:values.map((v,i)=>i===62?.2:v)}];
  const sim = new PhysicsSimulation(new Float32Array(config), new Float32Array(palette));
  try {
    for(let tick=0;tick<90;tick++) {
      const event=inputs.find(event=>event.tick===tick); if(event)sim.input(new Float32Array(event.values)); sim.step();
    }
    const finalSnapshot=Array.from(new Float32Array(wasm.memory.buffer,sim.snapshot_ptr(),layout[12]));
    assert(Math.abs(finalSnapshot[layout[17]+4]-.2)<1e-6);
    const report={type:'musical-lights-phone-report-v8',initialTempo:120,config,palette,layout,inputs,finalTick:sim.tick(),finalSnapshot,finalPigments:Array.from(new Float32Array(wasm.memory.buffer,sim.pigments_ptr(),layout[21]*9))};
    assert((await replayReport(report)).every(result=>result.matches));
    await assert.rejects(replayReport({...report,layout:layout.map((v,i)=>i===18?19:v)}), /engine|layout|matching|version/i);
  } finally {sim.free();}
});

test('built WASM starts every ball uniformly in its actual spawn-X band', () => {
  const layout=PhysicsSimulation.layout(), palette=Array.from({length:72},(_,i)=>i%3===0?Math.floor(i/3)/24:.2);
  const sim=new PhysicsSimulation(PhysicsSimulation.defaults(),new Float32Array(palette));
  try {
    const initial=new Float32Array(wasm.memory.buffer,sim.snapshot_ptr(),layout[12]);
    const pigments=new Float32Array(wasm.memory.buffer,sim.pigments_ptr(),layout[21]*9);
    for(const [i,band] of [6,18,10,2,6,22,2,14].entries()) {
      const x=initial[3+i*layout[8]], expected=Array.from(new Float32Array(palette.slice(band*3,band*3+3)));
      assert(x>=band*.05-1e-6&&x<(band+1)*.05+1e-6);
      assert.deepEqual(Array.from(initial.slice(3+i*layout[8]+15,3+i*layout[8]+18)),expected);
      for(let p=0;p<3;p++)assert.deepEqual(Array.from(pigments.slice(i*9+p*3,i*9+p*3+3)),expected);
    }
  } finally {sim.free();}
});


test('built WASM records attack-only paint policy and preserves physical replay', async () => {
  const layout = Array.from(PhysicsSimulation.layout()), config = Array.from(PhysicsSimulation.defaults());
  const palette = Array.from({ length: 72 }, (_, i) => i % 3 === 0 ? Math.floor(i / 3) / 24 : .2);
  const runs = [];
  for (const [required, attacking] of [[false, false], [true, false], [true, true]]) {
    const sim = new PhysicsSimulation(new Float32Array(config), new Float32Array(palette));
    try {
      const read = () => Array.from(new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12]));
      const initial = read();
      const values = Array(layout[22]).fill(0); values.fill(1, 0, 24);
      values[32] = config[0]; values[62] = config[5]; values[67] = .6; values[64] = 8; values[65] = .0264; values[66] = .192; values[63] = Number(required);
      values.fill(attacking ? .5 : 0, 38, 62); sim.input(new Float32Array(values));
      for (let tick = 0; tick < 120; tick++) sim.step();
      const finalSnapshot = read();
      const colors = state => Array.from({ length: 8 }, (_, i) => state.slice(3 + i * layout[8] + 15, 3 + i * layout[8] + 18));
      if (required && !attacking) assert.deepEqual(colors(finalSnapshot), colors(initial));
      else assert.notDeepEqual(colors(finalSnapshot), colors(initial));
      const report = { type: 'musical-lights-phone-report-v8', config, palette, layout, initialTempo: 120,
        inputs: [{ tick: 0, values: [...values] }], finalTick: sim.tick(), finalSnapshot, finalPigments: Array.from(new Float32Array(wasm.memory.buffer, sim.pigments_ptr(), layout[21] * 9)) };
      assert((await replayReport(report)).every(result => result.matches));
      if (required && !attacking) {
        const missing = structuredClone(report); missing.inputs[0].values[63] = 0;
        // A wrong paint policy must produce a different recorded color history.
        await assert.rejects(replayReport(missing), /Physics replay differs/);
      }
      runs.push(finalSnapshot.filter((_, i) => i < 3 || i >= layout[9] || (i - 3) % layout[8] < 15));
      for (const invalid of [-.1, 1.1, NaN]) {
        values[63] = invalid; assert.throws(() => sim.input(new Float32Array(values)));
      }
      assert.throws(() => sim.input(new Float32Array(63)), /Expected 68 simulation inputs/);
      assert.throws(() => sim.input(new Float32Array(67)), /Expected 68 simulation inputs/);
    } finally { sim.free(); }
  }
  assert.deepEqual(runs[0], runs[1]); assert.deepEqual(runs[1], runs[2]);
});

test('built WASM removes a settled ball without repacking survivors and replays the transition', async () => {
  const layout = Array.from(PhysicsSimulation.layout()), config = Array.from(PhysicsSimulation.defaults()), palette = Array(72).fill(.5);
  config[0] = .4; config[5] = .2; config[8] = 16;
  const sim = new PhysicsSimulation(new Float32Array(config), new Float32Array(palette));
  const snapshot = () => Array.from(new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12]));
  try {
    for (let i = 0; i < 600; i++) sim.step();
    const before = snapshot();
    const values = Array(layout[22]).fill(0);
    values[32] = config[0]; values[62] = config[5]; values[67] = .6; values.splice(64, 3, 15, config[9], config[10]);
    const inputs = [{ tick: sim.tick(), values }];
    sim.input(new Float32Array(values)); sim.step();
    const after = snapshot();
    assert.equal(after[layout[30]], 15);
    assert(after.slice(3 + 15 * layout[8], layout[9]).every(value => value === 0));
    for (let i = 0; i < 15; i++) {
      const offset = 3 + i * layout[8];
      const displacement = Math.hypot(...after.slice(offset, offset + 3).map((value, axis) => value - before[offset + axis]));
      const speed = Math.hypot(...before.slice(offset + 9, offset + 12));
      assert(displacement < speed * (after[0] - before[0]) + .005, `Survivor ${i} moved ${displacement} m after removal`);
    }
    const report = { type: 'musical-lights-phone-report-v8', layout, config, palette, initialTempo: 120, inputs,
      finalTick: sim.tick(), finalSnapshot: after,
      finalPigments: Array.from(new Float32Array(wasm.memory.buffer, sim.pigments_ptr(), layout[21] * 9)) };
    assert((await replayReport(report)).every(result => result.matches));
  } finally { sim.free(); }
});

test('variable ball inputs replay exactly and reject invalid engine settings', async () => {
  const layout = Array.from(PhysicsSimulation.layout()), config = Array.from(PhysicsSimulation.defaults()), palette = Array(72).fill(.5);
  const sim = new PhysicsSimulation(new Float32Array(config), new Float32Array(palette));
  const values = Array(layout[22]).fill(0); values[32] = .4; values[62] = .2; values[67] = .6;
  const inputs = [];
  try {
    for (const [count, small, big] of [[0, .0264, .192], [1, .1, .1], [16, .192, .192], [8, .0264, .192]]) {
      values.splice(64, 3, count, small, big);
      inputs.push({ tick: sim.tick(), values: [...values] });
      sim.input(new Float32Array(values));
      for (let i = 0; i < 12; i++) sim.step();
      const state = new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12]);
      assert.equal(state[layout[30]], count);
      for (let i = count; i < 16; i++) assert(state.slice(3 + i * layout[8], 3 + (i + 1) * layout[8]).every(v => v === 0));
    }
    const report = { type: 'musical-lights-phone-report-v8', layout, config, palette, initialTempo: 120, inputs,
      finalTick: sim.tick(), finalSnapshot: Array.from(new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12])),
      finalPigments: Array.from(new Float32Array(wasm.memory.buffer, sim.pigments_ptr(), layout[21] * 9)) };
    assert((await replayReport(report)).every(r => r.matches));
    await assert.rejects(replayReport({ ...report, type: 'musical-lights-phone-report-v7' }), /historical|format/);
    for (const invalid of [[17, .0264, .192], [-1, .0264, .192], [1.5, .0264, .192], [8, .2, .192], [8, .1, .09], [8, NaN, .192]]) {
      values.splice(64, 3, ...invalid);
      assert.throws(() => sim.input(new Float32Array(values)));
      const malformed = [...config]; malformed.splice(8, 3, ...invalid);
      assert.throws(() => new PhysicsSimulation(new Float32Array(malformed), new Float32Array(palette)));
    }
  } finally { sim.free(); }
});

test('capped tall full-band attacks request less integration without changing normalized rise timing', () => {
  const layout = PhysicsSimulation.layout(), runs = [];
  for (const cap of [.6, 20]) {
    const config = PhysicsSimulation.defaults(); config[0] = 2.596923; config[11] = cap;
    const sim = new PhysicsSimulation(config, new Float32Array(72).fill(.5));
    try {
      const input = new Float32Array(layout[22]); input[32] = config[0]; input[62] = config[5]; input[67] = cap; input.set(config.slice(8, 11), 64);
      sim.input(input); for (let tick = 0; tick < 120; tick++) sim.step();
      input.fill(1, 0, 24); sim.input(input);
      let requested = 0, overloads = 0; const motion = [];
      for (let tick = 0; tick < 16; tick++) {
        sim.step();
        const state = new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12]);
        requested += state[layout[15]] + state[layout[15]+1];
        overloads += Number(state[layout[15]+1] > 0); motion.push(state[layout[31]]);
      }
      runs.push({ cap, requested, overloads, motion });
    } finally { sim.free(); }
  }
  assert.equal(runs[0].overloads, 0);
  assert(runs[0].requested < runs[1].requested, JSON.stringify(runs));
  // Rapier uses f32 contact intervals; different substep counts can round
  // the normalized spline sample by an ulp. The attack deadline stays exact.
  for (let i = 0; i < runs[0].motion.length; i++) assert(Math.abs(runs[0].motion[i] - runs[1].motion[i]) < 1e-6);
  assert.equal(runs[0].motion[4], 1);
});
