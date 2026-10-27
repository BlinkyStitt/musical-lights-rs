import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import init, { PhysicsSimulation } from '../../musical-lights-physics/pkg/physics.js';
import { replayReport } from '../replay-physics.mjs';
const wasm = await init({ module_or_path: await readFile(new URL('../../musical-lights-physics/pkg/physics_bg.wasm', import.meta.url)) });

test('the built WASM accepts protocol 20 scrolling and stops at its published phase', () => {
  const layout = PhysicsSimulation.layout();
  assert.equal(layout[18], 20, 'Rebuild the release WASM; native checks cannot validate a stale browser artifact');
  assert.equal(layout[0], 24);
  assert(Math.abs(layout[4] - .002) < 1e-8, 'Straight joins fill the former 2 mm gap');
  assert.equal(layout[5], 0, 'Flat tips have no seam trough');
  assert.equal(layout[21], 8);
  assert.equal(layout[22], 64, 'Audio attacks, depth and the attack-only paint policy are recorded inputs');
  assert.equal(layout.length, 30, 'The shared core supplies the seven swirl profile values');
  assert.equal(layout[9], 3 + 8 * layout[8]);
  assert.equal(layout[11] - layout[10], 8 * 24);
  const sim = new PhysicsSimulation(PhysicsSimulation.defaults(), new Float32Array(72).fill(.5));
  try {
    const input = new Float32Array(layout[22]); input[32] = .6; input[62] = .48; input[33] = 1;
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
      const values = Array(layout[22]).fill(0); values.fill(1, 0, 24); values[32] = config[0]; values[62] = config[5];
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
      const report = { type: 'musical-lights-phone-report-v6', config, palette, layout, initialTempo: 120,
        inputs, finalTick: sim.tick(), finalSnapshot, finalPigments: Array.from(new Float32Array(wasm.memory.buffer, sim.pigments_ptr(), 72)) };
      assert((await replayReport(report)).every(result => result.matches));
      await assert.rejects(replayReport({ ...report, finalPigments: undefined }), /complete regional pigment/);
      const corrupted = structuredClone(report); corrupted.finalPigments[0] += .01;
      await assert.rejects(replayReport(corrupted), /Physics replay differs|complete regional pigment/);
      await assert.rejects(replayReport({ ...report, type: 'musical-lights-phone-report-v5' }), /historical replay/);
      const historical = structuredClone(report); historical.layout[18] = 19;
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
  const values = Array(layout[22]).fill(0); values[0] = .3; values[32] = .6; values[62] = config[5]; values[33] = 1;
  const inputs = [{ tick: 0, values, tempo: 120 }, { tick: 50, values, tempo: 160 }, { tick: 120, values, tempo: 80 }];
  const sim = new PhysicsSimulation(new Float32Array(config), new Float32Array(palette));
  try {
    for (let tick = 0; tick < 200; tick++) {
      for (const event of inputs) if (event.tick === tick) {
        sim.set_tempo(event.tempo); sim.input(new Float32Array(event.values));
      }
      sim.step();
    }
    const report = { type: 'musical-lights-phone-report-v6', initialTempo: 120,
      config, palette, layout, inputs, finalTick: sim.tick(),
      finalSnapshot: Array.from(new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12])),
      finalPigments: Array.from(new Float32Array(wasm.memory.buffer, sim.pigments_ptr(), 72)) };
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
  const values = Array(layout[22]).fill(0); values[0] = .3; values[32] = .6; values[62] = config[5]; values[33] = 1;
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
    const report = { type: 'musical-lights-phone-report-v6', initialTempo: 120,
      config, palette, layout, danceOptions, initialAccent, inputs, finalTick: sim.tick(),
      finalSnapshot: Array.from(new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12])),
      finalPigments: Array.from(new Float32Array(wasm.memory.buffer, sim.pigments_ptr(), 72)) };
    assert((await replayReport(report)).every(result => result.matches));
    const missing = { ...report, inputs: inputs.map(({ accent, ...event }) => event) };
    await assert.rejects(replayReport(missing), /Physics replay differs/);
  } finally { sim.free(); }
});

test('built WASM records live enclosure depth and replays shrink and expansion', async () => {
  const layout = Array.from(PhysicsSimulation.layout()), config = Array.from(PhysicsSimulation.defaults()), palette = Array(72).fill(.5);
  const values = Array(layout[22]).fill(0); values[32] = config[0]; values[62] = config[5];
  const inputs = [{tick:0, values:[...values]}, {tick:30, values:values.map((v,i)=>i===62?2:v)}, {tick:60, values:values.map((v,i)=>i===62?.2:v)}];
  const sim = new PhysicsSimulation(new Float32Array(config), new Float32Array(palette));
  try {
    for(let tick=0;tick<90;tick++) {
      const event=inputs.find(event=>event.tick===tick); if(event)sim.input(new Float32Array(event.values)); sim.step();
    }
    const finalSnapshot=Array.from(new Float32Array(wasm.memory.buffer,sim.snapshot_ptr(),layout[12]));
    assert(Math.abs(finalSnapshot[layout[17]+4]-.2)<1e-6);
    const report={type:'musical-lights-phone-report-v6',initialTempo:120,config,palette,layout,inputs,finalTick:sim.tick(),finalSnapshot,finalPigments:Array.from(new Float32Array(wasm.memory.buffer,sim.pigments_ptr(),72))};
    assert((await replayReport(report)).every(result=>result.matches));
    await assert.rejects(replayReport({...report,layout:layout.map((v,i)=>i===18?13:v)}), /engine|layout|matching|version/i);
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
      values[32] = config[0]; values[62] = config[5]; values[63] = Number(required);
      values.fill(attacking ? .5 : 0, 38, 62); sim.input(new Float32Array(values));
      for (let tick = 0; tick < 120; tick++) sim.step();
      const finalSnapshot = read();
      const colors = state => Array.from({ length: 8 }, (_, i) => state.slice(3 + i * layout[8] + 15, 3 + i * layout[8] + 18));
      if (required && !attacking) assert.deepEqual(colors(finalSnapshot), colors(initial));
      else assert.notDeepEqual(colors(finalSnapshot), colors(initial));
      const report = { type: 'musical-lights-phone-report-v6', config, palette, layout, initialTempo: 120,
        inputs: [{ tick: 0, values: [...values] }], finalTick: sim.tick(), finalSnapshot, finalPigments: Array.from(new Float32Array(wasm.memory.buffer, sim.pigments_ptr(), 72)) };
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
      assert.throws(() => sim.input(new Float32Array(63)), /Expected 64 simulation inputs/);
    } finally { sim.free(); }
  }
  assert.deepEqual(runs[0], runs[1]); assert.deepEqual(runs[1], runs[2]);
});
