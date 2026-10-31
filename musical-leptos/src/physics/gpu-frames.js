// Bound queued animation work without blocking the JavaScript thread. Keep a
// fence per slot so an older completed frame can release capacity while the
// newer frame is still running. Waiting for the latest fence drains both slots.
export class GpuFrames {
  constructor(gl) { this.gl = gl; this.fences = [null, null]; this.head = 0; this.queued = 0; }
  ready() {
    const gl = this.gl;
    if (gl.isContextLost()) { this.clear(); return false; }
    while (this.queued) {
      const fence = this.fences[this.head];
      const status = gl.clientWaitSync(fence, 0, 0);
      if (status === gl.WAIT_FAILED) throw Error('Graphics completion check failed');
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
        gl.deleteSync(fence); this.fences[this.head] = null;
        this.head = (this.head + 1) % 2; this.queued--;
      } else break;
    }
    return this.queued < 2;
  }
  submitted() {
    const gl = this.gl;
    if (gl.isContextLost()) { this.clear(); return; }
    if (this.queued >= 2) throw Error('Graphics frame budget exceeded');
    const next = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!next) throw Error('Graphics completion fence unavailable');
    this.fences[(this.head + this.queued) % 2] = next; this.queued++; gl.flush();
  }
  clear() {
    if (!this.gl.isContextLost()) for (const fence of this.fences) if (fence) this.gl.deleteSync(fence);
    this.fences.fill(null); this.head = 0; this.queued = 0;
  }
}
