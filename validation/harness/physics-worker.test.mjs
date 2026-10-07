import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import init, { PhysicsSimulation } from '../../musical-lights-physics/pkg/physics.js';
import { replayReport } from '../replay-physics.mjs';
const wasm = await init({ module_or_path: await readFile(new URL('../../musical-lights-physics/pkg/physics_bg.wasm', import.meta.url)) });
const source = (await readFile(new URL('../../musical-lights-physics/worker.js', import.meta.url), 'utf8')).replace(/^import .*;\n/, '');

async function worker(config = Array.from(PhysicsSimulation.defaults())) {
  let now = 1000;
  const messages = [], self = {};
  const context = { self, PhysicsSimulation, init: async () => wasm,
    Float32Array, performance: { timeOrigin: 0, now: () => now },
    MessageChannel: class { constructor() { this.port1 = {}; this.port2 = { postMessage() {} }; } },
    setTimeout() {}, clearTimeout() {}, postMessage: data => messages.push(structuredClone(data)) };
  runInNewContext(source, context);
  const send = data => self.onmessage({ data });
  await send({ type: 'init', height: .6, config, palette: new Float32Array(72).fill(.5),
    danceOptions: { odds: [60, 200, .05, .5, 1], flight: .3, seed: 1 }, paused: false });
  const ready = messages.at(-1);
  return { ready, send, messages,
    advance: ms => { now += ms; runInNewContext('while (debt + (absoluteNow() - lastTime) >= stepMs) run()', context); },
    close: () => runInNewContext('simulation.free()', context) };
}

test('worker ready separates restored settings from factory defaults', async () => {
  const config = Array.from(PhysicsSimulation.defaults()); config[2] = 16; config[6] = .08;
  const w = await worker(config);
  try {
    assert.equal(w.ready.config[2], 16); assert(Math.abs(w.ready.config[6] - .08) < 1e-8);
    assert.equal(w.ready.defaults[2], 8); assert(Math.abs(w.ready.defaults[6] - .04) < 1e-8);
    assert.deepEqual(w.ready.defaults, Array.from(PhysicsSimulation.defaults()));
  } finally { w.close(); }
});

for (const [name, flag, disabled] of [['scrolling', 33, 0], ['Reduced Motion', 31, 1]]) {
  test(`production worker preserves same-tick input/accent order around ${name}`, async () => {
    const w = await worker();
    try {
      await w.send({ type: 'record', config: w.ready.config });
      const values = Array(38).fill(0); values[0] = .3; values[32] = .6; values[33] = 1;
      const off = [...values]; off[flag] = disabled;
      await w.send({ type: 'pulse', timestamp: 1000, input: values, tempo: 160, accent: 1 });
      await w.send({ type: 'pulse', timestamp: 1000, input: off, tempo: 80, accent: 2 });
      w.advance(500);
      await w.send({ type: 'pulse', timestamp: 1500, input: values, tempo: 120, accent: 3 });
      w.advance(1500);
      await w.send({ type: 'report' });
      const recorded = w.messages.at(-1);
      assert.equal(recorded.type, 'report'); assert.equal(recorded.recordingOverflow, false);
      assert.equal(recorded.inputs[0].tick, recorded.inputs[1].tick);
      assert.deepEqual(recorded.inputs.map(e => e.accent), [1, 2, 3]);
      assert.deepEqual(recorded.inputs.map(e => e.tempo), [160, 80, 120]);
      assert.equal(recorded.motionEvents, undefined); assert.equal(recorded.tempoEvents, undefined);
      const report = { ...recorded, type: 'musical-lights-phone-report-v5', palette: Array(72).fill(.5), layout: w.ready.layout };
      assert((await replayReport(report)).every(result => result.matches));
      // Losing the first eligible draw reproduces the old split-list ordering result.
      const reordered = structuredClone(report);
      delete reordered.inputs[0].accent;
      await assert.rejects(replayReport(reordered), /Physics replay differs/);
    } finally { w.close(); }
  });
}
