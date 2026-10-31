import test from 'node:test';
import assert from 'node:assert/strict';
import { packetRenderCrossings, packetRenderSummary } from '../packet-render.mjs';
const point = (at, level) => ({ at, levels: [level] });

test('a missed short pulse cannot borrow the next attacks rendered response', () => {
  const crossings = packetRenderCrossings([point(0, .11), point(20, 0), point(1000, .2)],
    [point(-10, 0), point(90, .095), point(1090, .2)], 1);
  assert.equal(crossings[0].status, 'not-observed-before-next-attack');
  assert.equal(crossings[0].delayMs, null); assert.equal(crossings[0].peakRenderedLevel, .095);
  assert.equal(crossings[1].delayMs, 90);
  assert.deepEqual(packetRenderSummary(crossings), { crossings: 2, matched: 1,
    alreadyAbove: 0, notObserved: 1, captureEnded: 0, medianMs: 90, p95Ms: 90 });
});

test('already visible and unobserved final attacks remain explicit without invented delays', () => {
  const crossings = packetRenderCrossings([point(0, .2), point(10, 0), point(100, .2)],
    [point(-10, .2), point(20, 0), point(120, .05)], 1);
  assert.equal(crossings[0].status, 'already-visible');
  assert.equal(crossings[1].status, 'not-observed-before-capture-end');
  assert.equal(crossings[1].delayMs, null);
  assert.deepEqual(packetRenderSummary(crossings), { crossings: 2, matched: 0,
    alreadyAbove: 1, notObserved: 1, captureEnded: 1, medianMs: null, p95Ms: null });
});
