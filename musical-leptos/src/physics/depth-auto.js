// Select depth from observed frame intervals. No hardware inference.
export const STARTUP_DEPTH_CANDIDATES = Object.freeze([1, 2, 4, 8, 16, 32]);
export const DEPTH_CANDIDATES = Object.freeze([0, 6, 8, 16, 32, 64, 128, 256, 512, 1024, 2048]);
export function depthPass(intervals, period) {
  if (intervals.length < 60 || !Number.isFinite(period) || period <= 0) return false;
  const sorted = [...intervals].sort((a, b) => a - b);
  const mean = intervals.reduce((sum, n) => sum + n, 0) / intervals.length;
  return period / mean >= .95 && sorted[Math.ceil(sorted.length * .95) - 1] < period * 1.25
    && intervals.filter(n => n > period * 1.5).length / intervals.length <= .05;
}
export class AutoDepth {
  constructor(apply, finish, start, candidates = DEPTH_CANDIDATES) { this.apply = apply; this.finish = finish; this.start = start; this.candidates = candidates; this.index = -1; this.last = null; this.samples = []; this.windowAt = null; this.settleUntil = start + 500; this.best = candidates[0]; this.apply(0); }
  get baseline() { return this.index === -1; }
  cancel() { this.done = true; }
  sample(now) {
    if (this.done) return;
    if (now - this.start >= 25000) { this.complete(); return; }
    if (this.last == null) { this.last = now; return; }
    const interval = now - this.last; this.last = now;
    if (now < this.settleUntil) return;
    if (this.windowAt == null) { this.windowAt = now; return; }
    this.samples.push(interval);
    if (this.index === -1) {
      if (this.samples.length >= 30 && now - this.windowAt >= 1000) {
        const sorted = [...this.samples].sort((a, b) => a - b);
        this.period = sorted[Math.floor(sorted.length / 4)]; this.next(now);
      }
      return;
    }
    if (this.samples.length < 60 || now - this.windowAt < 1250) return;
    // Confirm a failed window without reallocating the current scene.
    if (!depthPass(this.samples, this.period)) {
      if (++this.failures === 2) this.complete();
      else { this.samples = []; this.windowAt = now; }
      return;
    }
    this.best = this.candidates[this.index];
    if (this.index === this.candidates.length - 1) this.complete(); else this.next(now);
  }
  next(now) { this.index++; this.samples = []; this.windowAt = null; this.settleUntil = now + 500; this.failures = 0; this.apply(this.candidates[this.index]); }
  complete() { this.done = true; this.apply(this.best); this.finish({ count: this.best, hz: 1000 / (this.period || 1000 / 60) }); }
}
