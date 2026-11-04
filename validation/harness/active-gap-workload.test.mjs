import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { activeGapSeeds, setActiveGapSeed } from '../active-gap-workload.mjs';

test('each performance view reproduces its recorded failing NUC1 seed', () => {
  assert.deepEqual(activeGapSeeds, { normal: 3086797548,
    'portrait-fullscreen': 4156900579, 'landscape-fullscreen': 1360618947 });
  assert(Object.isFrozen(activeGapSeeds));
  for (const seed of Object.values(activeGapSeeds)) {
    let calls = 0;
    const crypto = { getRandomValues(values) { calls++; values.fill(7); return values; } };
    runInNewContext(`(${setActiveGapSeed.toString()})(seed)`, { seed, crypto, Uint32Array });
    for (let page = 0; page < 2; page++) {
      const values = new Uint32Array(1);
      assert.equal(crypto.getRandomValues(values), values);
      assert.equal(values[0], seed);
    }
    assert.equal(calls, 0);
    for (const values of [new Uint32Array(2), new Uint8Array(1), new Uint8Array(16)]) {
      assert.equal(crypto.getRandomValues(values), values);
      assert(values.every(value => value === 7));
    }
    assert.equal(calls, 3, 'Unrelated random requests must use the original implementation');
  }
});
