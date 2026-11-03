import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuFrames } from '../../musical-leptos/src/physics/gpu-frames.js';
function context() {
  return {
    WAIT_FAILED: 1, ALREADY_SIGNALED: 2, CONDITION_SATISFIED: 3, TIMEOUT_EXPIRED: 4,
    SYNC_GPU_COMMANDS_COMPLETE: 5, status: 4, lost: false, serial: 0, polls: [], deleted: [], flushes: 0,
    isContextLost() { return this.lost; },
    clientWaitSync(...args) { this.polls.push(args); return this.statuses?.get(args[0]) ?? this.status; },
    fenceSync(condition, flags) { assert.equal(condition, this.SYNC_GPU_COMMANDS_COMPLETE); assert.equal(flags, 0); return ++this.serial; },
    deleteSync(fence) { this.deleted.push(fence); },
    flush() { this.flushes++; },
  };
}
test('two outstanding frames block with zero-time completion polls', () => {
  const gl = context(), budget = new GpuFrames(gl);
  assert(budget.ready()); budget.submitted(); assert(budget.ready()); budget.submitted();
  assert.equal(budget.ready(), false); assert.equal(budget.ready(), false);
  assert.equal(budget.queued, 2);
  assert.deepEqual(gl.deleted, []); assert.equal(gl.flushes, 2);
  assert(gl.polls.every(args => args[1] === 0 && args[2] === 0));
  assert.throws(() => budget.submitted(), /budget exceeded/);
  gl.status = gl.CONDITION_SATISFIED;
  assert(budget.ready()); assert.equal(budget.queued, 0);
  budget.submitted(); gl.status = gl.ALREADY_SIGNALED; assert(budget.ready());
  assert.deepEqual(gl.deleted, [1, 2, 3]);
});
test('completed oldest frames free one slot without waiting for newer work', () => {
  const gl = context(), budget = new GpuFrames(gl);
  gl.statuses = new Map();
  budget.submitted(); budget.submitted();
  // Sustain a pipeline whose newest frame always takes another callback to
  // finish. Retaining only its fence would skip every third submission.
  for (let completed = 1; completed <= 120; completed++) {
    gl.statuses.set(completed, gl.CONDITION_SATISFIED);
    assert(budget.ready(), `completed frame ${completed} must release a slot`);
    assert.equal(budget.queued, 1);
    assert.equal(gl.deleted.at(-1), completed);
    budget.submitted(); assert.equal(budget.queued, 2);
    assert.equal(budget.ready(), false);
  }
  assert.equal(gl.serial, 122);
  assert(gl.polls.every(args => args[1] === 0 && args[2] === 0));
  budget.clear();
  assert.equal(new Set(gl.deleted).size, 122);
  assert.equal(gl.deleted.length, 122);
});
test('context loss discards invalid fences and cleanup releases a live fence once', () => {
  const gl = context(), budget = new GpuFrames(gl);
  budget.submitted(); budget.submitted(); gl.lost = true;
  assert.equal(budget.ready(), false); budget.clear(); budget.submitted();
  assert.deepEqual(gl.deleted, []); assert.equal(budget.queued, 0);
  gl.lost = false; assert(budget.ready()); budget.submitted(); budget.submitted(); budget.clear(); budget.clear();
  assert.deepEqual(gl.deleted, [3, 4]); assert.equal(budget.queued, 0);
});
test('completion and allocation failures remain visible errors', () => {
  const gl = context(), budget = new GpuFrames(gl);
  budget.submitted(); gl.status = gl.WAIT_FAILED;
  assert.throws(() => budget.ready(), /completion check failed/);
  budget.clear(); gl.fenceSync = () => null;
  assert.throws(() => budget.submitted(), /fence unavailable/);
});
