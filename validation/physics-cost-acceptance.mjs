import assert from 'node:assert/strict';

// Evaluate the saved measurements as well as the in-memory WASM oracle.
export function evaluatePhysicsCost(result) {
  for (const field of ['physicsSha256', 'pcmSha256', 'paletteSha256'])
    assert.match(result[field] ?? '', /^[a-f0-9]{64}$/, `Missing workload identity: ${field}`);
  assert.equal(result.physicsHz, 120);
  assert(Number.isFinite(result.riseDurationMs) && result.riseDurationMs > 0);
  assert.equal(result.runs.length, 6);
  for (const cap of [.6, 20]) {
    const runs = result.runs.filter(run => run.gapCap === cap);
    assert.equal(runs.length, 3);
    for (const run of runs) {
      assert.equal(run.ticks, 1440);
      assert(Number.isFinite(run.totalMs) && run.totalMs > 0);
      assert(run.substeps > 0 && run.requestedSubsteps >= run.substeps);
      if (cap === .6) assert.equal(run.overloadTicks, 0, 'Capped generated workload overloaded');
    }
  }
  for (const height of [.927803, 2.596923]) {
    const pair = [.6, 20].map(cap => result.fullAttacks.find(run => run.height === height && run.gapCap === cap));
    assert(pair.every(Boolean), 'Missing matched full attack');
    const [capped, uncapped] = pair;
    assert.equal(capped.overloadTicks, 0);
    assert(capped.requestedSubsteps < uncapped.requestedSubsteps, 'Cap did not reduce attack integration work');
    assert.equal(capped.trace.length, 16);
    assert.equal(uncapped.trace.length, 16);
    for (const run of pair) {
      assert.equal(run.requestedSubsteps, run.trace.reduce((sum, row) => sum + row.substeps + row.excess, 0));
      assert.equal(run.overloadTicks, run.trace.filter(row => row.excess > 0).length);
    }
    for (let i = 0; i < 16; i++) {
      const a = capped.trace[i], b = uncapped.trace[i];
      assert.equal(a.ms, b.ms);
      assert(Number.isFinite(a.motion) && Number.isFinite(b.motion));
      assert(Math.abs(a.motion - b.motion) < 1e-6, 'Normalized attack timing changed');
    }
    const deadline = Math.ceil(result.riseDurationMs * result.physicsHz / 1000) - 1;
    assert.equal(capped.trace[deadline]?.motion, 1, 'Capped attack missed configured deadline');
    assert.equal(uncapped.trace[deadline]?.motion, 1, 'Uncapped attack missed configured deadline');
  }
}
