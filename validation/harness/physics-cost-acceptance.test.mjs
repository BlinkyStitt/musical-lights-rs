import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePhysicsCost } from '../physics-cost-acceptance.mjs';

function fixture() {
  return { physicsSha256: 'a'.repeat(64), pcmSha256: 'b'.repeat(64), paletteSha256: 'c'.repeat(64),
    physicsHz: 120, riseDurationMs: 40,
    runs: [.6, 20].flatMap(gapCap => Array.from({ length: 3 }, () => ({ gapCap, ticks: 1440,
      totalMs: 100, substeps: 2000, requestedSubsteps: 2000, overloadTicks: 0 }))),
    fullAttacks: [.927803, 2.596923].flatMap(height => [.6, 20].map(gapCap => ({ height, gapCap,
      requestedSubsteps: (gapCap === .6 ? 2 : 4) * 16, overloadTicks: 0,
      trace: Array.from({ length: 16 }, (_, i) => ({ ms: (i + 1) * 1000 / 120,
        motion: Math.min(1, (i + 1) / 5), substeps: gapCap === .6 ? 2 : 4, excess: 0 })) }))) };
}
test('saved geometry cost rejects unmatched work, overloads, timing drift and late attacks', () => {
  evaluatePhysicsCost(fixture());
  for (const mutate of [
    f => { f.pcmSha256 = ''; },
    f => { f.runs.pop(); },
    f => { f.runs[0].ticks--; },
    f => { f.runs[0].overloadTicks++; },
    f => { f.fullAttacks[0].requestedSubsteps++; },
    f => { f.fullAttacks[0].trace[0].excess++; },
    f => { f.fullAttacks[0].trace[0].motion += .000002; },
    f => { f.fullAttacks.forEach(row => { row.trace[4].motion = .99; }); },
    f => { f.riseDurationMs = NaN; },
  ]) {
    const f = fixture(); mutate(f); assert.throws(() => evaluatePhysicsCost(f), undefined, mutate.toString());
  }
});
