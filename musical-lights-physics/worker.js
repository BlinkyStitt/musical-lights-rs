import init, { PhysicsSimulation } from './physics.js';

let wasm, layout, stepMs;
const ready = init().then(instance => {
  wasm = instance; layout = PhysicsSimulation.layout(); stepMs = 1000 / layout[1];
  impulseTotals = new Float32Array(layout[14] - layout[10]);
});
const capacity = 50000;
let simulation, config, palette, buffer, timer, lastTime, origin;
let paused = true, debt = 0, maxDebt = 0, pending = [], publishedTick = -2;
let input = new Float32Array(38), recording = null, recordingOverflow = false;
let costs = null, costCount = 0, totalCost = 0, steps = 0;
let tempo = 120, initialTempo = 120;
let danceOptions = null, lastAccent = 0, initialAccent = 0;
let recordingStart = 0, initialTick = 0, impulseTotals;
let schedulingGap = 0, maxSchedulingGap = 0, batchMs = 0, maxStepMs = 0;
let batchTicks = 0, batchSubsteps = 0, batchMaxSubsteps = 0;
let substepTotal = 0, maxSubsteps = 0, overloadTicks = 0, substepCosts = [];
const absoluteNow = () => performance.timeOrigin + performance.now();
const snapshot = () => new Float32Array(wasm.memory.buffer, simulation.snapshot_ptr(), layout[12]);

// MessageChannel yields to queued inputs without the nested-timer 4 ms clamp.
const catchup = new MessageChannel();
let scheduled = 0;
catchup.port1.onmessage = ({ data }) => { if (data === scheduled) run(); };
function schedule() {
  clearTimeout(timer);
  const generation = ++scheduled;
  if (paused) return;
  if (debt >= stepMs) catchup.port2.postMessage(generation);
  else timer = setTimeout(() => { if (generation === scheduled) run(); }, Math.min(4, stepMs - debt));
}
function run() {
  if (paused || !simulation) return;
  const now = absoluteNow();
  schedulingGap = now - lastTime; maxSchedulingGap = Math.max(maxSchedulingGap, schedulingGap);
  const batchStart = performance.now();
  debt += schedulingGap;
  lastTime = now;
  // Keep all elapsed time. Bound batches by both ticks and execution time so
  // expensive contact steps cannot delay fresh snapshots for eight whole ticks.
  // A single tick is indivisible; any remaining debt continues after yielding.
  let batch = 0;
  batchSubsteps = 0; batchMaxSubsteps = 0;
  while (debt + 1e-6 >= stepMs && batch < 8 && (batch === 0 || performance.now() - batchStart < stepMs)) {
    while (pending.length && pending[0].tick <= simulation.tick()) {
      const event = pending.shift();
      input.set(event.values);
      if (event.tempo !== undefined && event.tempo !== tempo) {
        tempo = event.tempo; simulation.set_tempo(tempo);
      }
      simulation.input(input);
      if (event.accent !== undefined && event.accent !== lastAccent) {
        lastAccent = event.accent; simulation.accent(lastAccent);
      }
      if (recording) {
        if (recording.length < capacity) recording.push({ tick: simulation.tick(), timestamp: event.timestamp, values: Array.from(input), tempo: event.tempo, accent: event.accent });
        else recordingOverflow = true;
      }
    }
    const start = performance.now();
    simulation.step();
    const cost = performance.now() - start;
    totalCost += cost; steps++; maxStepMs = Math.max(maxStepMs, cost);
    if (recording) {
      if (costCount < capacity) costs[costCount++] = cost;
      else recordingOverflow = true;
    }
    const state = snapshot();
    const substeps = state[layout[15]], excess = state[layout[15] + 1];
    batchSubsteps += substeps; batchMaxSubsteps = Math.max(batchMaxSubsteps, substeps);
    substepTotal += substeps; maxSubsteps = Math.max(maxSubsteps, substeps);
    if (excess > 0) overloadTicks++;
    if (recording && substepCosts.length < capacity) substepCosts.push([simulation.tick(), substeps, excess, cost]);
    for (let i = 0; i < impulseTotals.length; i++) impulseTotals[i] += state[layout[10] + i];
    debt -= stepMs;
    batch++;
  }
  batchMs = performance.now() - batchStart;
  batchTicks = batch;
  // Include execution time when deciding whether the next batch is overdue.
  const finished = absoluteNow(); debt += finished - lastTime; lastTime = finished;
  maxDebt = Math.max(maxDebt, debt);
  publish();
  schedule();
}
function publish() {
  // Publish each 120 Hz physics tick, independently of render callbacks.
  // Bars use the newest position; one in-flight buffer still bounds the queue.
  // One transferred buffer bounds queued snapshots even if the main thread stalls.
  if (!buffer || simulation.tick() < publishedTick + 1) return;
  publishedTick = simulation.tick();
  const output = new Float32Array(buffer);
  output.set(snapshot());
  output.set(impulseTotals, layout[10]);
  impulseTotals.fill(0);
  postMessage({ type: 'snapshot', buffer, horizontalDirection: simulation.horizontal_direction(), pigments: new Float32Array(wasm.memory.buffer, simulation.pigments_ptr(), layout[21] * 9).slice(), schedulingGap, maxSchedulingGap, batchMs, batchTicks, batchSubsteps, batchMaxSubsteps, maxStepMs, debt, maxDebt, steps, totalCost,
    tick: simulation.tick(), substepTotal, maxSubsteps, overloadTicks, timestamp: absoluteNow() }, [buffer]);
  buffer = null;
}
function reset(values) {
  simulation?.free();
  config = values ?? PhysicsSimulation.defaults();
  simulation = new PhysicsSimulation(config, palette);
  input = new Float32Array(38); input[32] = config[0];
  simulation.input(input);
  simulation.set_tempo(tempo);
  if (danceOptions) simulation.configure_dance(new Float64Array(danceOptions.odds), danceOptions.flight, danceOptions.seed);
  initialAccent = lastAccent; simulation.accent(initialAccent);
  pending = []; publishedTick = -2; debt = 0; maxDebt = 0; steps = 0; totalCost = 0;
  schedulingGap = 0; maxSchedulingGap = 0; batchMs = 0; maxStepMs = 0;
  batchTicks = 0; batchSubsteps = 0; batchMaxSubsteps = 0;
  substepTotal = 0; maxSubsteps = 0; overloadTicks = 0; substepCosts = [];
  impulseTotals.fill(0); lastTime = origin = absoluteNow();
}
self.onmessage = async ({ data }) => {
  try {
    await ready;
    switch (data.type) {
      case 'init': {
        palette = data.palette;
        const defaults = Array.from(PhysicsSimulation.defaults());
        config = new Float32Array(defaults); config[0] = data.height;
        if (data.config?.length === 8) { config = new Float32Array(data.config); config[0] = data.height; }
        danceOptions = data.danceOptions ?? { odds: [60, 200, .05, .5, 1], flight: .3, seed: 1 };
        reset(config); paused = data.paused;
        buffer = null;
        postMessage({ type: 'ready', config: Array.from(config), defaults, layout: Array.from(layout) });
        schedule(); break;
      }
      case 'snapshot':
        if (buffer) throw new Error('Snapshot buffer ownership was duplicated');
        buffer = data.buffer;
        publish(); break;
      case 'pulse': {
        const tick = Math.max(simulation.tick(), Math.ceil((data.timestamp - origin) / stepMs));
        if (pending.length >= 256) throw new Error('Physics input queue is full');
        // Record the final visual inputs, including the core's listening floor.
        // Raw audio and filtered snapshots remain owned by the audio processor.
        if (data.listening) for (let i = 0; i < 24; i++)
          data.input[i] = PhysicsSimulation.listening_level(data.input[i], i, data.timestamp / 1000, data.input[31] === 1);
        pending.push({ tick, timestamp: data.timestamp, values: data.input, tempo: data.tempo, accent: data.accent });
        break;
      }
      case 'dance':
        if (recording) throw new Error('Finish recording before changing dance settings');
        danceOptions = data.options;
        simulation.configure_dance(new Float64Array(danceOptions.odds), danceOptions.flight, danceOptions.seed);
        break;
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
        reset(data.config); recording = []; initialTempo = tempo; costs = new Float32Array(capacity); costCount = 0; recordingOverflow = false;
        recordingStart = absoluteNow(); initialTick = simulation.tick();
        postMessage({ type: 'recording', timestamp: recordingStart, config: Array.from(config) }); break;
      case 'report':
        postMessage({ type: 'report', inputs: recording, initialTempo, danceOptions, initialAccent, physicsCosts: Array.from(costs.subarray(0, costCount)),
          recordingOverflow, substepTotal, maxSubsteps, overloadTicks, substepCosts, config: Array.from(config), initialTick, finalTick: simulation.tick(),
          elapsedMs: absoluteNow() - recordingStart, debt, maxDebt, discardedSimulationMs: 0, finalSnapshot: Array.from(snapshot()) });
        recording = null; costs = null; substepCosts = []; break;
      default: throw new Error('Unknown physics worker message');
    }
  } catch (error) {
    paused = true; clearTimeout(timer);
    postMessage({ type: 'error', message: String(error) });
  }
};
