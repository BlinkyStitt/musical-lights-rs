// Output time already includes device latency. Never subtract it a second time.
export class PlaybackClock {
  constructor(audio, started) { this.audio = audio; this.started = started; this.elapsed = -Infinity; }
  read(now = performance.now()) {
    const audio = this.audio;
    const latency = name => Number.isFinite(audio[name]) && audio[name] >= 0 ? audio[name] : null;
    const baseLatency = latency('baseLatency'), outputLatency = latency('outputLatency');
    if (audio.state !== 'running') return { ...this.last, elapsed: this.elapsed, paused: true };
    let timestamp;
    try { timestamp = audio.getOutputTimestamp?.(); } catch { /* Explicit estimated fallback below. */ }
    const valid = timestamp && Number.isFinite(timestamp.contextTime) && timestamp.contextTime >= 0
      && Number.isFinite(timestamp.performanceTime) && timestamp.performanceTime > 0
      && Math.abs(now - timestamp.performanceTime) <= 1000;
    const method = valid ? 'output-timestamp' : baseLatency != null || outputLatency != null ? 'estimated-latency' : 'unverified';
    const position = valid ? timestamp.contextTime + (now - timestamp.performanceTime) / 1000
      : audio.currentTime - (baseLatency ?? 0) - (outputLatency ?? 0);
    this.elapsed = position - this.started;
    this.last = { elapsed: this.elapsed, method, baseLatency, outputLatency, paused: false };
    return this.last;
  }
}
