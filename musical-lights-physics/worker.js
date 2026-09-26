import init, { PhysicsSimulation } from './physics.js';

let wasm, layout, stepMs;
const ready = init().then(instance => {
  wasm = instance; layout = PhysicsSimulation.layout(); stepMs = 1000 / layout[1];
  impulseTotals = new Float32Array(layout[14] - layout[10]);
});
const capacity = 50000;
let simulation, config, palette, buffer, timer, lastTime, origin;
let paused = true, debt = 0, maxDebt = 0, pending = [], request = null;
let input = new Float32Array(33), recording = null, recordingOverflow = false;
let costs = new Float32Array(capacity), costCount = 0, totalCost = 0, steps = 0;
let recordingStart = 0, initialTick = 0, impulseTotals;
let substepTotal = 0, maxSubsteps = 0, overloadTicks = 0, substepCosts = [];
const absoluteNow = () => performance.timeOrigin + performance.now();
const snapshot = () => new Float32Array(wasm.memory.buffer, simulation.snapshot_ptr(), layout[12]);

function schedule() { clearTimeout(timer); if (!paused) timer = setTimeout(run, 4); }
function run() {
  if (paused || !simulation) return;
  const now = absoluteNow();
  debt += now - lastTime;
  lastTime = now;
  // Keep all elapsed time. A slow worker reports debt and continues in bounded batches.
  let batch = 0;
  while (debt + 1e-6 >= stepMs && batch < 8) {
    while (pending.length && pending[0].tick <= simulation.tick()) {
      const event = pending.shift();
      input.set(event.values);
      simulation.input(input);
      if (recording) {
        if (recording.length < capacity) recording.push({ tick: simulation.tick(), timestamp: event.timestamp, values: Array.from(input) });
        else recordingOverflow = true;
      }
    }
    const start = performance.now();
    simulation.step();
    const cost = performance.now() - start;
    totalCost += cost; steps++;
    if (recording) {
      if (costCount < capacity) costs[costCount++] = cost;
      else recordingOverflow = true;
    }
    const state = snapshot();
    const substeps = state[layout[15]], excess = state[layout[15] + 1];
    substepTotal += substeps; maxSubsteps = Math.max(maxSubsteps, substeps);
    if (excess > 0) overloadTicks++;
    if (recording && substepCosts.length < capacity) substepCosts.push([simulation.tick(), substeps, excess, cost]);
    for (let i = 0; i < impulseTotals.length; i++) impulseTotals[i] += state[layout[10] + i];
    debt -= stepMs;
    batch++;
  }
  maxDebt = Math.max(maxDebt, debt);
  publish();
  schedule();
}
function publish() {
  if (!request || !buffer) return;
  const output = new Float32Array(buffer);
  output.set(snapshot());
  output.set(impulseTotals, layout[10]);
  impulseTotals.fill(0);
  postMessage({ type: 'snapshot', buffer, debt, maxDebt, steps, totalCost,
    tick: simulation.tick(), substepTotal, maxSubsteps, overloadTicks, timestamp: absoluteNow(), sequence: request.sequence }, [buffer]);
  buffer = null;
  request = null;
}
function reset(values) {
  simulation?.free();
  config = values ?? PhysicsSimulation.defaults();
  simulation = new PhysicsSimulation(config, palette);
  input = new Float32Array(33); input[32] = config[0];
  simulation.input(input);
  pending = []; debt = 0; maxDebt = 0; steps = 0; totalCost = 0;
  substepTotal = 0; maxSubsteps = 0; overloadTicks = 0; substepCosts = [];
  impulseTotals.fill(0); lastTime = origin = absoluteNow();
}
self.onmessage = async ({ data }) => {
  try {
    await ready;
    switch (data.type) {
      case 'init':
        palette = data.palette;
        config = PhysicsSimulation.defaults(); config[0] = data.height;
        reset(config); paused = data.paused;
        buffer = null;
        postMessage({ type: 'ready', config: Array.from(config), layout: Array.from(layout) });
        schedule(); break;
      case 'pulse': {
        if (data.buffer) buffer = data.buffer;
        request = data;
        const tick = Math.max(simulation.tick(), Math.ceil((data.timestamp - origin) / stepMs));
        if (pending.length >= 256) throw new Error('Physics input queue is full');
        pending.push({ tick, timestamp: data.timestamp, values: data.input });
        publish(); break;
      }
      case 'pause':
        if (data.paused === paused) break;
        if (!paused) run();
        paused = data.paused;
        if (!paused) { const now = absoluteNow(); origin += now - lastTime; lastTime = now; }
        schedule(); break;
      case 'reset':
        if (recording) throw new Error('Finish the phone test before resetting physics');
        reset(data.config); postMessage({ type: 'reset', config: Array.from(config) }); break;
      case 'record':
        reset(data.config); recording = []; costCount = 0; recordingOverflow = false;
        recordingStart = absoluteNow(); initialTick = simulation.tick();
        postMessage({ type: 'recording', timestamp: recordingStart, config: Array.from(config) }); break;
      case 'report':
        postMessage({ type: 'report', inputs: recording, physicsCosts: Array.from(costs.subarray(0, costCount)),
          recordingOverflow, substepTotal, maxSubsteps, overloadTicks, substepCosts, config: Array.from(config), initialTick, finalTick: simulation.tick(),
          elapsedMs: absoluteNow() - recordingStart, debt, maxDebt, discardedSimulationMs: 0, finalSnapshot: Array.from(snapshot()) });
        recording = null; break;
      default: throw new Error('Unknown physics worker message');
    }
  } catch (error) {
    paused = true; clearTimeout(timer);
    postMessage({ type: 'error', message: String(error) });
  }
};
