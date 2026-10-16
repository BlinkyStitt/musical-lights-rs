import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuFrames } from '../../musical-leptos/src/physics/gpu-frames.js';
function context() {
  return {
    WAIT_FAILED: 1, ALREADY_SIGNALED: 2, CONDITION_SATISFIED: 3, TIMEOUT_EXPIRED: 4,
    SYNC_GPU_COMMANDS_COMPLETE: 5, status: 4, lost: false, serial: 0, polls: [], deleted: [], flushes: 0,
    isContextLost() { return this.lost; },
    clientWaitSync(...args) { this.polls.push(args); return this.status; },
    fenceSync(condition, flags) { assert.equal(condition, this.SYNC_GPU_COMMANDS_COMPLETE); assert.equal(flags, 0); return ++this.serial; },
    deleteSync(fence) { this.deleted.push(fence); },
    flush() { this.flushes++; },
  };
}
test('two queued frames use one fence and zero-time completion polls', () => {
  const gl = context(), budget = new GpuFrames(gl);
  assert(budget.ready()); budget.submitted(); assert(budget.ready()); budget.submitted();
  assert.equal(budget.ready(), false); assert.equal(budget.ready(), false);
  assert.equal(budget.queued, 2); assert.equal(budget.fence, 2);
  assert.deepEqual(gl.deleted, [1]); assert.equal(gl.flushes, 2);
  assert(gl.polls.every(args => args[1] === 0 && args[2] === 0));
  assert.throws(() => budget.submitted(), /budget exceeded/);
  gl.status = gl.CONDITION_SATISFIED;
  assert(budget.ready()); assert.equal(budget.queued, 0); assert.equal(budget.fence, null);
  budget.submitted(); gl.status = gl.ALREADY_SIGNALED; assert(budget.ready());
  assert.deepEqual(gl.deleted, [1, 2, 3]);
});
test('context loss discards invalid fences and cleanup releases a live fence once', () => {
  const gl = context(), budget = new GpuFrames(gl);
  budget.submitted(); gl.lost = true;
  assert.equal(budget.ready(), false); budget.clear(); budget.submitted();
  assert.deepEqual(gl.deleted, []); assert.equal(budget.queued, 0);
  gl.lost = false; assert(budget.ready()); budget.submitted(); budget.clear(); budget.clear();
  assert.deepEqual(gl.deleted, [2]); assert.equal(budget.queued, 0);
});
test('completion and allocation failures remain visible errors', () => {
  const gl = context(), budget = new GpuFrames(gl);
  budget.submitted(); gl.status = gl.WAIT_FAILED;
  assert.throws(() => budget.ready(), /completion check failed/);
  budget.clear(); gl.fenceSync = () => null;
  assert.throws(() => budget.submitted(), /fence unavailable/);
});
