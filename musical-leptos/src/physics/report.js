import { ListeningReview } from './review.js';
import { settingSwitch } from './controls.js';
import { build } from './build.js';

const summarize = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { count: values.length, mean, p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
};
export class PhoneReport {
  constructor(view) {
    this.view = view;
    this.host = view.card.querySelector('.diagnostics-controls');
    this.physicsHost = view.card.querySelector('.physics-controls');
    this.defaults = [...view.defaults];
    this.removers = [];
    this.invalid = [];
    this.intervals = null; this.renderCosts = null;
    this.count = 0; this.costCount = 0; this.progress = [];
    const fields = [
      ['Gravity (m/s²)', 1, 0, 30, .01], ['Density (kg/m³)', 2, 1, 20000, 1],
      ['Bounce (ratio)', 3, 0, 1, .01], ['Friction (ratio)', 4, 0, 2, .01],
      ['Enclosure depth (m)', 5, .2, 2, .01], ['Large attack duration (ms)', 6, 40, 2000, 10],
      ['Reduced Motion attack duration (ms)', 7, 320, 4000, 10],
    ];
    this.physicsHost.innerHTML = `<summary>Physics</summary>
      <p>Apply settings to reset the balls and bars. Current enclosure dimensions are retained.</p>
      <p>Vertical walls have no friction and at least 0.55 bounce. These controls set the other surfaces and balls.</p>
      <div class="physics-fields">${fields.map(([name, index, min, max, step]) => `<label class="control-row">${name}<input data-config="${index}" type="number" min="${min}" max="${max}" step="${step}" value="${Number((view.config[index] * (index >= 6 ? 1000 : 1)).toPrecision(6))}"></label>`).join('')}</div>
      <button type="button" class="physics-reset">Apply settings and reset</button>
      <button type="button" class="physics-defaults">Restore defaults and reset</button>`;
    this.host.innerHTML = `<summary>Diagnostics</summary>
      <p>Test tones and listening review use the same analysis and renderer as microphone capture. Selecting music starts playback with the microphone off; use Play audio for test tones.</p>
      <p class="diagnostic-fps" aria-label="Frame rate"></p>
      <p class="sensor-readings" aria-label="Sensor readings"></p>
      <label>Test tone<select class="tone-kind"><option value="exercise">Changing 24-tone exercise</option><option value="stationary">Stationary tone (60 s)</option><option value="stepped">Step through all 24 bands (48 s)</option><option value="sweep">Continuous sweep (24 s)</option><option value="two">Two tones (30 s)</option><option value="volume">Volume steps (90 s)</option><option value="bursts">Short bursts (8 s)</option><option value="silence">Silence (3 s)</option></select></label>
      <label>Frequency (Hz)<input class="tone-frequency" type="number" min="20" max="15500" value="1000"></label>
      <label>Input level (dBFS peak)<input class="tone-level" type="number" min="-90" max="-12" value="-34"></label>
      ${settingSwitch("Repeat", "tone-repeat", true)}
      ${settingSwitch("Audible playback", "tone-audible")}
      <button type="button" class="tone-pause" disabled>Pause playback</button>
      <p class="tone-status" role="status" hidden>Select Test tones, then Play audio. Levels describe generated PCM, not calibrated sound pressure.</p>
      ${settingSwitch("Diagnostic recording", "tone-trace")}
      <p>Recording starts with the next audio session (up to 100 seconds). Turn it off for phone FPS acceptance.</p>
      <button type="button" class="tone-export" disabled>Export tone trace</button>
      <p class="tone-trace-status" role="status"></p>
      <p>Enter the actual phone model and browser. Set Low Power Mode to off. Each test has 15 seconds of warmup, then five minutes of measurement. Test normal view, portrait fullscreen, and landscape fullscreen.</p>
      <label>Phone model<input class="phone-device" placeholder="e.g. iPhone 16e" required></label>
      <label>Browser<input class="phone-browser" placeholder="e.g. Safari" required></label>
      <label>iOS version<input class="ios-version" placeholder="Enter the iOS version" required></label>
      <label>View<select class="phone-mode"><option value="normal">Normal view</option><option value="portrait-fullscreen">Portrait fullscreen</option><option value="landscape-fullscreen">Landscape fullscreen</option></select></label>
      <label><input class="low-power-off" type="checkbox"> Low Power Mode is off</label>
      <button type="button" class="phone-start">Start five-minute test</button>
      <button type="button" class="phone-finish" disabled>End test early</button>
      <p class="phone-progress" role="status"></p>
      <label><input class="phone-smooth" type="checkbox"> I confirm that the motion looked smooth</label>
      <button type="button" class="phone-export" disabled>Export test report</button>`;
    this.listen('.physics-defaults', 'click', () => {
      if (this.active) return;
      const config = [...this.defaults]; config[0] = view.height;
      for (const node of this.physicsHost.querySelectorAll('[data-config]')) {
        const index = Number(node.dataset.config); node.value = Number((config[index] * (index >= 6 ? 1000 : 1)).toPrecision(6));
      }
      view.worker.postMessage({ type: 'reset', config });
    });
    this.listen('.physics-reset', 'click', () => {
      if (this.active) return;
      const config = this.readConfig();
      if (config) view.worker.postMessage({ type: 'reset', config });
    });
    this.review = new ListeningReview(view); view.card.review = this.review;
    const transport = this.query('.playback-controls');
    for (const selector of ['.tone-pause', '.review-replay', '.tone-repeat', '.tone-audible']) {
      const node = this.query(selector); transport.append(node.closest('.setting-switch') ?? node);
    }
    transport.after(this.query('.tone-status'));
    this.toneChunks = []; this.toneRows = 0; this.toneDropped = 0; this.tonePhysics = [];
    const trace = ({ detail }) => {
      if (detail.sessionId !== this.toneMetadata?.sessionId || this.audioState?.state === 'stopped') return;
      const count = detail.trace.length / detail.traceStride;
      if (this.toneRows + count <= 50000) {
        this.toneChunks.push({ sessionId: detail.sessionId, receivedAt: detail.receivedAt, receivedAudioTime: detail.receivedAudioTime,
          workletAudioTime: detail.audioTime, stride: detail.traceStride, values: detail.trace });
        this.toneRows += count;
      } else this.toneDropped += count;
      this.toneWorkletDropped = detail.traceDropped;
      if (view.current && this.tonePhysics.length < 25000) {
        this.tonePhysics.push({ receivedAt: detail.receivedAt, renderedAt: view.renderedAt, alpha: view.renderAlpha,
          currentTick: view.current[2], previousTick: view.previous?.[2],
          tops: Array.from(view.current.slice(view.layout[9], view.layout[10])),
          velocities: Array.from(view.current.slice(view.layout[14], view.layout[15])),
          targets: Array.from(view.input.slice(0, 24)), scrollingEnabled: view.input[33] === 1, scrollPhase: view.current[view.layout[20]], renderedPhase: view.renderedPhase, debtMs: view.metrics.debt,
          barBase: view.renderedCeilingBars ? 'ceiling' : 'floor',
          renderedTops: Array.from({ length: 24 }, (_, i) => view.renderedHeight(i)) });
      }
      this.query('.tone-export').disabled = false;
      this.query('.tone-trace-status').textContent = `${this.toneRows} model frames recorded; ${this.toneDropped + this.toneWorkletDropped} dropped. Diagnostics add recording cost; turn off for phone FPS acceptance.`;
    };
    const session = ({ detail }) => {
      if (detail.sessionId < (this.audioState?.sessionId ?? 0)) return;
      if (detail.sessionId !== this.audioState?.sessionId) {
        this.toneChunks = []; this.toneRows = 0; this.toneDropped = 0; this.toneWorkletDropped = 0; this.tonePhysics = [];
        this.query('.tone-export').disabled = true;
        this.query('.tone-trace-status').textContent = '';
      }
      this.toneMetadata = detail; this.audioState = detail;
      const active = detail.state !== 'stopped';
      for (const selector of ['.tone-kind', '.tone-frequency', '.tone-level', '.tone-trace']) this.query(selector).disabled = active;
      if (this.active && (!this.acceptanceWorkload() || detail.sessionId !== this.metadata.sessionId))
        this.invalidate(`Audio workload changed: ${detail.reason ?? detail.state}`);
    };
    view.card.addEventListener('audio-session', session);
    this.removers.push(() => view.card.removeEventListener('audio-session', session));
    view.card.addEventListener('tone-trace', trace);
    this.removers.push(() => view.card.removeEventListener('tone-trace', trace));
    this.listen('.tone-export', 'click', () => {
      const header = { build, type: 'musical-lights-tone-trace-v6', layout: view.layout, config: view.config,
        rows: this.toneRows, dropped: this.toneDropped + (this.toneWorkletDropped ?? 0), physics: this.tonePhysics,
        rowLayout: 'ISO sample index, ISO total sones, 240 ISO specific values, 24 ISO integrals, partial window end sample, 24 instantaneous partial sones, 24 short-term partial sones, shared gain, 24 spectral novelty values, 24 log-magnitude sums, 99-value browser presentation transport, 24 acoustic event timestamps, 24 visual suppression counts',
        displayMapping: 'Unweighted partial loudness; one shared gain and headroom scale. Browser motion: shared One Euro coefficient, minimum/derivative cutoff 1 Hz, beta 0.8. White: pressure-scaled spectral novelty, rising partial loudness above 0.1 sone, acoustic prominence and a bounded rise crest within 60 ms; independent of display gain. Acoustic events are separate from the 160 ms visual interval and 60 ms quiet rearming. 180 ms linear pulse. Filtered targets and flashes are presentation, not sones.',
        measurementTiming: 'ISO: 2 ms grid and 1 ms lookahead. Partial: causal 2048-sample Hann at 48 kHz, 96-sample hop; window center 21.33 ms before end; GM2002 short-term attack/release. Transport, physics and render timestamps are separate.',
        tone: this.toneMetadata };
      const parts = [JSON.stringify(header).slice(0, -1), ',"chunks":['];
      this.toneChunks.forEach((chunk, i) => parts.push((i ? ',' : '') + JSON.stringify({ ...chunk, values: Array.from(chunk.values) })));
      parts.push(']}');
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/json' })), link = document.createElement('a');
      link.href = url; link.download = `musical-lights-tones-${build}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    this.listen('.phone-start' , 'click', () => this.start());
    this.listen('.phone-finish', 'click', () => this.finish(true));
    this.listen('.phone-export', 'click', () => this.export());
    this.listen('.phone-smooth', 'change', () => this.showResult());
  }
  query(selector) { return this.view.card.querySelector(selector); }
  listen(selector, type, listener) { const node = this.query(selector); node.addEventListener(type, listener); this.removers.push(() => node.removeEventListener(type, listener)); }
  readConfig() {
    const config = [...this.view.config]; config[0] = this.view.height;
    for (const node of this.physicsHost.querySelectorAll('[data-config]')) {
      if (!node.reportValidity()) return null;
      const index = Number(node.dataset.config);
      config[index] = Number(node.value) / (index >= 6 ? 1000 : 1);
    }
    return config;
  }
  acceptanceWorkload() {
    const audio = this.audioState;
    return audio?.source === 'generated' && audio.kind === 'exercise'
      && audio.state === 'playing' && audio.repeat && !audio.diagnostics;
  }
  start() {
    if (this.active) return;
    const progress = this.query('.phone-progress');
    if (this.view.card.dataset.toneDiagnostics === 'true') { progress.textContent = 'Turn off diagnostic recording and restart audio before measuring phone FPS.'; return; }
    const mode = this.query('.phone-mode').value;
    const expanded = this.view.card.hasAttribute('data-expanded');
    if (!this.query('.phone-device').value.trim() || !this.query('.phone-browser').value.trim() || !this.query('.ios-version').value.trim() || !this.query('.low-power-off').checked) {
      progress.textContent = 'Enter the phone model, browser and iOS version and confirm that Low Power Mode is off.'; return;
    }
    if (!this.acceptanceWorkload()) {
      progress.textContent = 'Start the repeating 24-tone exercise with diagnostics off before the test.'; return;
    }
    if ((mode === 'normal' && expanded)
      || (mode === 'portrait-fullscreen' && innerWidth > innerHeight)
      || (mode === 'landscape-fullscreen' && innerWidth <= innerHeight)) {
      progress.textContent = 'Set the selected view before starting the test.'; return;
    }
    if (mode !== 'normal' && !expanded) this.view.card.querySelector('.fullscreen-button').click();
    const config = this.readConfig(); if (!config) return;
    this.intervals = new Float32Array(60000); this.renderCosts = new Float32Array(60000);
    for (const selector of ['.direction-chance', '.flight-height', '.camera-motion', '.display-reset']) this.query(selector).disabled = true;
    this.active = true; this.invalid = []; this.result = null; this.count = 0; this.costCount = 0; this.progress = [];
    this.previous = null; this.startMs = null; this.lastProgress = 0;
    this.maxSnapshotAgeMs = 0;
    this.metadata = { build, sessionId: this.audioState.sessionId, workload: { ...this.audioState }, userAgent: navigator.userAgent, ios: this.query('.ios-version').value.trim(),
      device: this.query('.phone-device').value.trim(), browser: this.query('.phone-browser').value.trim(), lowPowerMode: 'off (user confirmed)', mode,
      viewport: [innerWidth, innerHeight], pixelRatio: this.view.renderer.getPixelRatio(),
      cameraDegrees: this.view.cameraBase, cameraMotion: this.view.settings.cameraMotion, scrolling: this.view.card.querySelector('.scroll-lights').checked, warmupSeconds: 15, measurementSeconds: 300,
      audioSource: 'generated PCM → AudioWorklet → loudness WASM',
      startedAt: new Date().toISOString(), config, layout: this.view.layout, palette: Array.from(this.view.palette) };
    this.query('.phone-start').disabled = true; this.query('.phone-finish').disabled = false;
    this.query('.physics-reset').disabled = true; this.query('.phone-export').disabled = true;
    this.query('.phone-smooth').checked = false;
    this.view.worker.postMessage({ type: 'record', config });
    progress.textContent = 'Warming up for 15 seconds…';
    this.host.open = false;
    if (mode === 'normal') this.view.card.scrollIntoView({ block: 'start' });
  }
  frame(frameTime, cost) {
    const now = performance.now();
    if (!this.lastDiagnostic || now - this.lastDiagnostic > 1000) {
      const elapsed = now - (this.fpsAt ?? now), frames = this.view.metrics.frames - (this.fpsFrames ?? 0);
      this.query('.diagnostic-fps').textContent = elapsed > 0 ? `${(frames * 1000 / elapsed).toFixed(0)} FPS` : '— FPS';
      this.fpsAt = now; this.fpsFrames = this.view.metrics.frames; this.lastDiagnostic = now;
      const readings = this.view.motion.readings;
      this.query('.sensor-readings').textContent = `Motion permission/state: ${this.view.motion.state}; ${readings.motionEvents} acceleration events, ${readings.orientationEvents} tilt events; reading age: ${readings.at == null ? 'unavailable' : (now - readings.at).toFixed(0) + ' ms'}; gravity vector (m/s²): ${JSON.stringify(Array.from(this.view.input.slice(34, 37)))}; screen angle: ${readings.screenAngle ?? 'unavailable'} degrees; gravity-inclusive (m/s²): ${JSON.stringify(readings.gravity ?? null)}; linear acceleration (m/s²): ${JSON.stringify(readings.linear ?? null)}; tilt: ${readings.beta ?? '—'} / ${readings.gamma ?? '—'} degrees.`;
    }
    if (!this.active) return;
    if (this.view.card.querySelector('.scroll-lights').checked !== this.metadata.scrolling) this.invalidate('Scrolling changed during test');
    if (!this.acceptanceWorkload() || this.audioState.sessionId !== this.metadata.sessionId)
      this.invalidate('Audio workload changed during test');
    if (this.startMs == null) return;
    const elapsed = now - this.startMs;
    if (elapsed < 15000) { this.previous = null; this.metadata.viewport = [innerWidth, innerHeight]; return; }
    this.maxSnapshotAgeMs = Math.max(this.maxSnapshotAgeMs, this.view.metrics.snapshotAgeMs);
    if (this.costCount < this.renderCosts.length) this.renderCosts[this.costCount++] = cost;
    else this.invalidate('Render report capacity exceeded');
    if (this.previous != null) {
      if (this.count < this.intervals.length) this.intervals[this.count++] = frameTime - this.previous;
      else this.invalidate('Frame report capacity exceeded');
    }
    this.previous = frameTime;

    const expanded = this.view.card.hasAttribute('data-expanded');
    if (expanded !== (this.metadata.mode !== 'normal') || innerWidth !== this.metadata.viewport[0]
      || innerHeight !== this.metadata.viewport[1]) this.invalidate('View changed during test');
    if (now - this.lastProgress > 1000) {
      this.query('.phone-progress').textContent = `Recording: ${Math.floor((elapsed - 15000) / 1000)} / 300 seconds. Physics delay ${this.view.metrics.debt.toFixed(1)} ms.`;
      this.progress.push({ elapsedMs: elapsed - 15000, tick: this.view.metrics.physicsSteps, debtMs: this.view.metrics.debt, snapshotAgeMs: this.view.metrics.snapshotAgeMs });
      this.lastProgress = now;
    }
    if (elapsed >= 315000) this.finish(false);
  }
  receive(data) {
    if (data.type === 'recording') {
      this.startMs = data.timestamp - performance.timeOrigin;
    }
    if (data.type === 'report') {
      const intervals = Array.from(this.intervals.subarray(0, this.count));
      const frames = summarize(intervals), render = summarize(Array.from(this.renderCosts.subarray(0, this.costCount)));
      const fps = frames ? 1000 / frames.mean : 0;
      const over25 = intervals.filter(x => x > 25).length / Math.max(1, intervals.length);
      const warmupSteps = 15 * this.view.layout[1];
      const physics = summarize(data.physicsCosts.slice(warmupSteps));
      const firstDebt = summarize(this.progress.slice(0, 10).map(sample => sample.debtMs));
      const lastDebt = summarize(this.progress.slice(-10).map(sample => sample.debtMs));
      const debtGrowthMs = firstDebt && lastDebt ? lastDebt.mean - firstDebt.mean : null;
      const stepMs = 1000 / this.view.layout[1];
      const simulationLagMs = data.elapsedMs - (data.finalTick - data.initialTick) * stepMs;
      const firstProgress = this.progress[0], lastProgress = this.progress.at(-1);
      const snapshotProgressDriftMs = firstProgress && lastProgress
        ? lastProgress.elapsedMs - firstProgress.elapsedMs - (lastProgress.tick - firstProgress.tick) * stepMs : null;
      this.result = { ...this.metadata, ...data, type: 'musical-lights-phone-report-v4',
        frameIntervalsMs: intervals, renderCostsMs: Array.from(this.renderCosts.subarray(0, this.costCount)),
        summary: { fps, frameIntervalMs: frames, renderCostMs: render, physicsStepMs: physics, over25Fraction: over25 },
        invalidReasons: this.invalid, simulationProgress: this.progress, debtGrowthMs, simulationLagMs,
        maxSnapshotAgeMs: this.maxSnapshotAgeMs, snapshotProgressDriftMs,
        numericPass: Boolean(frames && intervals.reduce((a, b) => a + b, 0) >= 299000
          && fps >= 59 && frames.p95 <= 18.5 && over25 < .01 && data.debt < 2 * stepMs
          && data.discardedSimulationMs === 0 && simulationLagMs >= -stepMs && simulationLagMs < 3 * stepMs
          && snapshotProgressDriftMs !== null && Math.abs(snapshotProgressDriftMs) < 3 * stepMs && this.maxSnapshotAgeMs < 100
          && debtGrowthMs !== null && debtGrowthMs <= stepMs && data.maxDebt < 100 && !data.recordingOverflow && !this.invalid.length),
      };
      this.query('.phone-export').disabled = false; this.host.open = true; this.showResult();
    }
  }
  invalidate(reason) { if (this.active && !this.invalid.includes(reason)) this.invalid.push(reason); }
  finish(early) {
    if (!this.active) return;
    if (early) this.invalidate('Test ended before five minutes');
    for (const selector of ['.direction-chance', '.flight-height', '.camera-motion', '.display-reset']) this.query(selector).disabled = false;
    this.active = false; this.view.worker.postMessage({ type: 'report' });
    this.query('.phone-start').disabled = false; this.query('.phone-finish').disabled = true;
    this.query('.physics-reset').disabled = false;
  }
  showResult() {
    if (!this.result) return;
    this.result.smoothMotionConfirmed = this.query('.phone-smooth').checked;
    this.result.accepted = this.result.numericPass && this.result.smoothMotionConfirmed;
    this.query('.phone-progress').textContent = `${this.result.summary.fps.toFixed(1)} FPS. ${this.result.accepted ? 'Passed' : 'Not accepted'}. ${this.result.invalidReasons.join('. ')}`;
  }
  export() {
    this.showResult(); if (!this.result) return;
    const blob = new Blob([JSON.stringify(this.result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `musical-lights-${build}-${this.result.mode}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  close() { this.review.close(); delete this.view.card.review; for (const remove of this.removers) remove(); this.active = false; this.intervals = this.renderCosts = null; this.toneChunks = []; this.tonePhysics = []; this.host.replaceChildren(); this.physicsHost.replaceChildren(); }
}
