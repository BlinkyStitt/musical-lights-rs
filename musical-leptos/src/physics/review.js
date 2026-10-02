import { build } from './build.js';

export function playbackTiming(context) {
  const stamp = context.getOutputTimestamp?.();
  if (stamp?.contextTime > 0 && stamp.performanceTime > 0 && Number.isFinite(stamp.contextTime) && Number.isFinite(stamp.performanceTime)) {
    return { method: 'output-timestamp', confidence: 'output clock estimate', audioTime: stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000 };
  }
  const latency = [context.baseLatency, context.outputLatency].filter(value => Number.isFinite(value) && value >= 0);
  return { method: latency.length ? 'estimated-latency' : 'unverified', confidence: latency.length ? 'approximate' : 'unverified',
    audioTime: context.currentTime - latency.reduce((a, b) => a + b, 0), baseLatency: context.baseLatency, outputLatency: context.outputLatency };
}

async function pcmHash(buffer) {
  const bytes = new Uint8Array(buffer.length * buffer.numberOfChannels * 4);
  for (let i = 0; i < buffer.numberOfChannels; i++) bytes.set(new Uint8Array(buffer.getChannelData(i).buffer), i * buffer.length * 4);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}

export class ListeningReview {
  constructor(view) {
    this.view = view; this.card = view.card; this.closed = false; this.generation = 0;
    this.sessions = []; this.samples = []; this.removers = [];
    this.root = document.createElement('section'); this.root.className = 'listening-review';
    this.root.innerHTML = `<h2>Listening review</h2>
      <p>Local files stay in browser memory. PCM levels are preserved; output volume is not calibrated SPL. Music starts only when you turn on Listening.</p>
      <p>“Jazz Trumpet Loops Pack in F 90 bpm” by <a href="https://freesound.org/s/77711/">Mihai Sorohan</a> and “Vibe Ace” by <a href="https://freemusicarchive.org/music/Kevin_MacLeod/Jazz_Sampler/Vibe_Ace">Kevin MacLeod</a>, <a href="https://creativecommons.org/licenses/by/3.0/">CC BY 3.0</a>. Audit excerpts: mono 48 kHz, fixed peak 0.2; trumpet first 5.333 s, Vibe Ace 8–14 s.</p>
      <label class="control-row">Local audio file<input class="review-file" type="file" accept="audio/*"></label>
      <p class="review-status" role="status">Choose a review source in Input & calibration.</p>
      <button class="review-replay" type="button" disabled>Replay</button>
      <label class="control-row">Playback device<input class="review-device" placeholder="e.g. built-in speakers, headphones"></label>
      <label class="control-row">Listening notes<textarea class="review-notes" rows="4" placeholder="Describe accents, swells and decay; include playback times."></textarea></label>
      <button class="review-note" type="button">Add timestamped observation</button>
      <button class="review-export" type="button">Export listening notes</button>
      <p>With Diagnostic recording on, the plot shows separate raw partial sones, filtered targets and rendered height. Recording adds overhead and cannot qualify as phone FPS acceptance.</p>
      <canvas class="review-plot" width="900" height="260" aria-label="Diagnostic plot: raw partial sones, filtered targets, rendered height"></canvas>
      <p class="review-plot-key">Solid: raw partial sones / 10. Dashed: filtered target (0–1). Dotted: rendered height / enclosure height. No fitted gains or shifted traces.</p>`;
    this.card.querySelector('.diagnostics-controls').append(this.root);
    const input = this.card.querySelector('.calibration-controls');
    this.file = this.root.querySelector('.review-file'); input.append(this.file.closest('label'));
    this.source = this.card.querySelector('.input-source');
    this.card.querySelector('.capture-information').textContent = 'Live microphone capture; calibration is specific to the input.';
    this.listen(this.source, 'change', () => {
      this.generation++; this.buffer = null; this.identity = null;
      if (this.source.value !== 'local') { this.localFile = null; this.file.value = ''; }
      this.card.querySelector('.tone-audible').checked = !['microphone', 'generated'].includes(this.source.value);
      this.card.querySelector('.capture-information').textContent = this.source.value === 'microphone' ? 'Live microphone capture; calibration is specific to the input.' : 'Digital PCM · microphone off · stop Listening to change source or channel.';
    });
    this.listen(this.file, 'change', () => {
      this.generation++; this.buffer = null; this.identity = null;
      this.localFile = this.file.files?.[0] ?? null;
      this.status(this.localFile ? `${this.localFile.name} selected. Turn on Listening to decode and play.` : 'Choose a local audio file.');
    });
    this.listen(this.root.querySelector('.review-note'), 'click', () => {
      this.observations ??= [];
      this.observations.push({ timestamp: new Date().toISOString(), source: this.identity, playback: this.lastPlayback,
        device: this.root.querySelector('.review-device').value, notes: this.root.querySelector('.review-notes').value });
      this.status('Timestamped observation added.');
    });
    this.listen(this.root.querySelector('.review-export'), 'click', () => this.export());
    this.listen(this.card, 'audio-session', ({ detail }) => {
      const active = ['starting', 'playing', 'paused', 'ended', 'interrupted'].includes(detail.state);
      this.file.disabled = active; // Source and channel are also disabled by Rust signals.
      if (detail.sessionId !== this.sessionId) {
        this.sessionId = detail.sessionId;
        if (detail.source !== 'microphone') this.sessions.push({ ...detail, startedAt: new Date().toISOString(), playbackDevice: this.root.querySelector('.review-device').value, timing: [] });
        this.samples = [];
        if (this.sessions.length > 100) this.sessions.shift();
      }
      const session = this.sessions.at(-1);
      if (session && session.sessionId === detail.sessionId) Object.assign(session, detail);
      if (!active) { this.buffer = null; this.lastPlayback = null; }
    });
    this.listen(this.card, 'review-playback', ({ detail }) => {
      this.lastPlayback = detail;
      const session = this.sessions.at(-1);
      if (session && session.sessionId === detail.sessionId && session.timing.length < 1000) session.timing.push(detail);
    });
    this.listen(this.card, 'tone-trace', ({ detail }) => {
      if (detail.sessionId !== this.sessionId || !detail.trace || this.samples.length >= 5000) return;
      const trace = detail.trace, stride = detail.traceStride, row = trace.length - stride;
      if (row < 0) return;
      const v = this.view, b = 8; // Labelled 1 kHz source band; no normalized fitting.
      this.samples.push({ at: trace[row + 364], band: b, raw: trace[row + 291 + b], filtered: trace[row + 368 + 4 * b],
        rendered: v.current ? v.current[v.layout[9] + b] / v.height : 0, renderedAt: v.renderedAt });
      this.plot();
    });
  }
  listen(node, type, fn) { node.addEventListener(type, fn); this.removers.push(() => node.removeEventListener(type, fn)); }
  status(text) { if (!this.closed) this.root.querySelector('.review-status').textContent = text; }
  async decode(context) {
    const generation = this.generation, source = this.source.value;
    let buffer, identity;
    if (source === 'local') {
      if (!this.localFile) throw new Error('Choose a local audio file first.');
      const file = this.localFile;
      try { buffer = await context.decodeAudioData(await file.arrayBuffer()); }
      catch { throw new Error('This file could not be decoded as audio. Choose another file.'); }
      identity = { name: file.name, bytes: file.size, lastModified: file.lastModified, source: 'local' };
    } else {
      const base = new URL('../review/', import.meta.url);
      const metadataResponse = await fetch(new URL('clips.json', base));
      if (!metadataResponse.ok) throw new Error('Review clip metadata is unavailable.');
      const clips = await metadataResponse.json(), clip = clips.find(entry => entry.name === source);
      if (!clip) throw new Error('Choose a valid review source.');
      const response = await fetch(new URL(`${source}.f32`, base));
      if (!response.ok) throw new Error(`Review clip unavailable: HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== clip.samples * 4) throw new Error('Review clip has an invalid length.');
      buffer = context.createBuffer(1, clip.samples, clip.rate); buffer.copyToChannel(new Float32Array(bytes), 0);
      identity = { ...clip, source: 'licensed-excerpt' };
    }
    const pcmSha256 = await pcmHash(buffer);
    if (identity.pcmSha256 && identity.pcmSha256 !== pcmSha256) throw new Error('Review clip PCM hash does not match its metadata.');
    if (this.closed || generation !== this.generation || context.state === 'closed') throw new Error('Review source was replaced or closed.');
    this.buffer = buffer;
    this.identity = { ...identity, pcmSha256, rate: buffer.sampleRate, channels: buffer.numberOfChannels, samples: buffer.length, duration: buffer.duration };
    this.status(`${identity.name}: ${buffer.numberOfChannels} channel(s), ${buffer.sampleRate} Hz, ${buffer.duration.toFixed(3)} s. PCM levels preserved.`);
    return { buffer, identity: this.identity };
  }
  plot() {
    const canvas = this.root.querySelector('canvas'), ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const duration = Math.max(.1, this.samples.at(-1)?.at ?? 1);
    ctx.font = '14px sans-serif'; ctx.fillStyle = getComputedStyle(this.card).color; ctx.fillText('1 kHz source band · separate scales · time in seconds', 8, 18);
    for (const [field, scale, color, dash] of [['raw', .1, '#4477AA', []], ['filtered', 1, '#AA3377', [8, 4]], ['rendered', 1, '#228833', [2, 4]]]) {
      ctx.strokeStyle = color; ctx.setLineDash(dash); ctx.beginPath();
      this.samples.forEach((s, i) => { const x = s.at / duration * canvas.width, y = 240 - Math.min(1, s[field] * scale) * 200; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke();
    }
  }
  export() {
    const report = { type: 'musical-lights-listening-notes-v1', build, runtimeVersion: document.querySelector('meta[name="musical-lights-assets"]').content,
      exportedAt: new Date().toISOString(), userAgent: navigator.userAgent, clip: this.identity,
      playbackDevice: this.root.querySelector('.review-device').value, notes: this.root.querySelector('.review-notes').value,
      observations: this.observations ?? [], sessions: this.sessions, diagnosticSamples: this.samples,
      humanAcceptance: 'pending; observations are not an automatic pass', physicalPhoneAcceptance: 'pending' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `musical-lights-listening-${build}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  close() { this.closed = true; this.generation++; for (const remove of this.removers) remove(); this.buffer = this.localFile = this.identity = null; this.file.value = ''; this.sessions = []; this.samples = []; }
}
