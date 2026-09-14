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
    this.host = view.card.querySelector('.physics-controls');
    this.removers = [];
    this.invalid = [];
    this.intervals = new Float32Array(60000); this.renderCosts = new Float32Array(60000);
    this.count = 0; this.costCount = 0; this.progress = [];
    const fields = [
      ['Gravity (m/s²)', 1, 0, 30, .01], ['Density (kg/m³)', 2, 1, 20000, 1],
      ['Restitution (ratio)', 3, 0, 1, .01], ['Friction (ratio)', 4, 0, 2, .01],
      ['Enclosure depth (m)', 5, .2, 2, .01], ['Bar rise speed (m/s)', 6, .01, 5, .01],
      ['Bar fall speed (m/s)', 7, .01, 5, .01],
    ];
    this.host.innerHTML = `<summary>Physics prototype and phone test</summary>
      <p>These values are starting assumptions. Apply physical settings with Reset. Camera changes keep the simulation.</p>
      <div class="physics-fields">${fields.map(([name, index, min, max, step]) => `<label>${name}<input data-config="${index}" type="number" min="${min}" max="${max}" step="${step}" value="${Number(view.config[index].toPrecision(6))}"></label>`).join('')}</div>
      <label>Camera rotation (degrees)<input class="camera-rotation" type="range" min="-40" max="40" value="0"></label>
      <button type="button" class="physics-reset">Apply settings and reset</button>
      <p><a href="/phone">Open the phone test page</a></p>
      <label><input type="checkbox" class="generated-audio"> Use generated audio through the audio processor on the next Start listening</label>
      <p>iPhone 16e, Safari. Set Low Power Mode to off. Each test has 15 seconds of warmup, then five minutes of measurement. Test normal view, portrait fullscreen, and landscape fullscreen.</p>
      <label>iOS version<input class="ios-version" placeholder="Enter the iOS version" required></label>
      <label>View<select class="phone-mode"><option value="normal">Normal view</option><option value="portrait-fullscreen">Portrait fullscreen</option><option value="landscape-fullscreen">Landscape fullscreen</option></select></label>
      <label><input class="low-power-off" type="checkbox"> Low Power Mode is off</label>
      <button type="button" class="phone-start">Start five-minute test</button>
      <button type="button" class="phone-finish" disabled>End test early</button>
      <p class="phone-progress" role="status"></p>
      <label><input class="phone-smooth" type="checkbox"> I confirm that the motion looked smooth</label>
      <button type="button" class="phone-export" disabled>Export test report</button>`;
    this.query('.generated-audio').checked = location.pathname.replace(/\/$/, '') === '/phone';
    if (location.pathname.replace(/\/$/, '') === '/phone') this.host.open = true;
    this.listen('.camera-rotation', 'input', event => view.setCamera(Number(event.target.value)));
    this.listen('.physics-reset', 'click', () => {
      if (this.active) return;
      const config = this.readConfig();
      if (config) view.worker.postMessage({ type: 'reset', config });
    });
    this.listen('.phone-start', 'click', () => this.start());
    this.listen('.phone-finish', 'click', () => this.finish(true));
    this.listen('.phone-export', 'click', () => this.export());
    this.listen('.phone-smooth', 'change', () => this.showResult());
  }
  query(selector) { return this.host.querySelector(selector); }
  listen(selector, type, listener) { const node = this.query(selector); node.addEventListener(type, listener); this.removers.push(() => node.removeEventListener(type, listener)); }
  readConfig() {
    const config = [...this.view.config]; config[0] = this.view.height;
    for (const node of this.host.querySelectorAll('[data-config]')) {
      if (!node.reportValidity()) return null;
      config[Number(node.dataset.config)] = Number(node.value);
    }
    return config;
  }
  start() {
    if (this.active) return;
    const progress = this.query('.phone-progress');
    const mode = this.query('.phone-mode').value;
    const expanded = this.view.card.hasAttribute('data-expanded');
    if (!this.query('.ios-version').value.trim() || !this.query('.low-power-off').checked) {
      progress.textContent = 'Enter the iOS version and confirm that Low Power Mode is off.'; return;
    }
    if (!this.view.card.querySelector('.stop-listening') || this.view.card.dataset.audioSource !== 'generated') {
      progress.textContent = 'Select generated audio, then press Start listening before the test.'; return;
    }
    if ((mode === 'normal' && expanded)
      || (mode === 'portrait-fullscreen' && innerWidth > innerHeight)
      || (mode === 'landscape-fullscreen' && innerWidth <= innerHeight)) {
      progress.textContent = 'Set the selected view before starting the test.'; return;
    }
    if (mode !== 'normal' && !expanded) this.view.card.querySelector('.fullscreen-button').click();
    const config = this.readConfig(); if (!config) return;
    this.active = true; this.invalid = []; this.result = null; this.count = 0; this.costCount = 0; this.progress = [];
    this.previous = null; this.startMs = null; this.lastProgress = 0;
    this.metadata = { build, userAgent: navigator.userAgent, ios: this.query('.ios-version').value.trim(),
      device: 'iPhone 16e (user test)', lowPowerMode: 'off (user confirmed)', mode,
      viewport: [innerWidth, innerHeight], pixelRatio: this.view.renderer.getPixelRatio(),
      cameraDegrees: this.view.rotation, warmupSeconds: 15, measurementSeconds: 300,
      audioSource: 'generated → MediaStream → AudioWorklet → loudness WASM',
      startedAt: new Date().toISOString(), config, layout: this.view.layout, palette: Array.from(this.view.palette) };
    this.query('.phone-start').disabled = true; this.query('.phone-finish').disabled = false;
    this.query('.physics-reset').disabled = true; this.query('.phone-export').disabled = true;
    this.query('.phone-smooth').checked = false;
    this.view.worker.postMessage({ type: 'record', config });
    progress.textContent = 'Warming up for 15 seconds…';
    this.host.open = false;
    if (mode === 'normal') this.view.card.scrollIntoView({ block: 'start' });
  }
  frame(now, cost) {
    if (!this.active || this.startMs == null) return;
    const elapsed = now - this.startMs;
    if (elapsed < 15000) { this.previous = null; this.metadata.viewport = [innerWidth, innerHeight]; return; }
    if (this.costCount < this.renderCosts.length) this.renderCosts[this.costCount++] = cost;
    else this.invalidate('Render report capacity exceeded');
    if (this.previous != null) {
      if (this.count < this.intervals.length) this.intervals[this.count++] = now - this.previous;
      else this.invalidate('Frame report capacity exceeded');
    }
    this.previous = now;
    if (!this.view.card.querySelector('.stop-listening')) this.invalidate('Audio stopped during test');
    const expanded = this.view.card.hasAttribute('data-expanded');
    if (expanded !== (this.metadata.mode !== 'normal') || innerWidth !== this.metadata.viewport[0]
      || innerHeight !== this.metadata.viewport[1]) this.invalidate('View changed during test');
    if (now - this.lastProgress > 1000) {
      this.query('.phone-progress').textContent = `Recording: ${Math.floor((elapsed - 15000) / 1000)} / 300 seconds. Physics delay ${this.view.metrics.debt.toFixed(1)} ms.`;
      this.progress.push({ elapsedMs: elapsed - 15000, tick: this.view.metrics.physicsSteps, debtMs: this.view.metrics.debt });
      this.lastProgress = now;
    }
    if (elapsed >= 315000) this.finish(false);
  }
  receive(data) {
    if (data.type === 'recording') {
      this.startMs = data.timestamp - performance.timeOrigin;
      // Reset snapshots across the simulation epoch. Keep the transfer pool intact.
      if (this.view.previous) this.view.spare = this.view.previous;
      this.view.previous = null;
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
      this.result = { ...this.metadata, ...data, type: 'musical-lights-phone-report-v1',
        frameIntervalsMs: intervals, renderCostsMs: Array.from(this.renderCosts.subarray(0, this.costCount)),
        summary: { fps, frameIntervalMs: frames, renderCostMs: render, physicsStepMs: physics, over25Fraction: over25 },
        invalidReasons: this.invalid, simulationProgress: this.progress, debtGrowthMs, simulationLagMs,
        numericPass: Boolean(frames && intervals.reduce((a, b) => a + b, 0) >= 299000
          && fps >= 59 && frames.p95 <= 18.5 && over25 < .01 && data.debt < 2 * stepMs
          && data.discardedSimulationMs === 0 && simulationLagMs >= -stepMs && simulationLagMs < 3 * stepMs
          && debtGrowthMs !== null && debtGrowthMs <= stepMs && data.maxDebt < 100 && !data.recordingOverflow && !this.invalid.length),
      };
      this.query('.phone-export').disabled = false; this.host.open = true; this.showResult();
    }
  }
  invalidate(reason) { if (this.active && !this.invalid.includes(reason)) this.invalid.push(reason); }
  finish(early) {
    if (!this.active) return;
    if (early) this.invalidate('Test ended before five minutes');
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
  close() { for (const remove of this.removers) remove(); this.active = false; this.host.replaceChildren(); }
}
