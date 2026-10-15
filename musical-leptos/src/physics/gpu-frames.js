// Bound queued animation work without blocking the JavaScript thread. A fence
// covers every command before it, so retaining only the latest fence is enough.
export class GpuFrames {
  constructor(gl) { this.gl = gl; this.fence = null; this.queued = 0; }
  ready() {
    const gl = this.gl;
    if (gl.isContextLost()) { this.fence = null; this.queued = 0; return false; }
    if (this.fence) {
      const status = gl.clientWaitSync(this.fence, 0, 0);
      if (status === gl.WAIT_FAILED) throw Error('Graphics completion check failed');
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
        gl.deleteSync(this.fence); this.fence = null; this.queued = 0;
      }
    }
    return this.queued < 2;
  }
  submitted() {
    const gl = this.gl;
    if (gl.isContextLost()) { this.fence = null; this.queued = 0; return; }
    if (this.queued >= 2) throw Error('Graphics frame budget exceeded');
    const next = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!next) throw Error('Graphics completion fence unavailable');
    if (this.fence) gl.deleteSync(this.fence);
    this.fence = next; this.queued++; gl.flush();
  }
  clear() {
    if (this.fence && !this.gl.isContextLost()) this.gl.deleteSync(this.fence);
    this.fence = null; this.queued = 0;
  }
}
