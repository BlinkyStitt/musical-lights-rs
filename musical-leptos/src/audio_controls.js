// Engineering controls only. The ISO model and its 24 Bark bands stay fixed.
export const AUDIO_CONTROLS = Object.freeze([["Display gain target", 0.8, 0.1, 1, 0.05], ["Gain reduction time (s)", 2, 0.05, 60, 0.05], ["Gain recovery time (s)", 20, 0.05, 120, 0.05], ["Motion minimum cutoff (Hz)", 1, 0.1, 30, 0.1], ["Motion derivative cutoff (Hz)", 1, 0.1, 30, 0.1], ["Motion speed coefficient", 0.8, 0, 5, 0.05], ["Attack comparison (s)", 0.01, 0.002, 0.02, 0.002], ["Attack baseline (s)", 0.1, 0.02, 0.1, 0.002], ["Attack peak history (s)", 0.03, 0.002, 0.1, 0.002], ["Attack startup guard (s)", 0.25, 0, 2, 0.01], ["Attack novelty threshold", 0.01, 0.001, 1, 0.001], ["Attack relative rise", 0.15, 0.01, 1, 0.01], ["Attack minimum (sones)", 0.1, 0, 10, 0.01], ["Attack band prominence", 0.3, 0, 1, 0.01], ["Acoustic quiet rearm (s)", 0.01, 0.002, 0.2, 0.002], ["Minimum flash interval (s)", 0.16, 0.02, 2, 0.01], ["Flash quiet rearm (s)", 0.06, 0.002, 1, 0.002], ["Flash duration (s)", 0.18, 0.02, 1, 0.01], ["Tempo minimum (BPM)", 60, 60, 190, 1], ["Tempo maximum (BPM)", 200, 70, 200, 1], ["Tempo history (s)", 8, 4, 8, 0.5], ["Tempo smoothing (s)", 3, 0.1, 20, 0.1], ["Tempo silence fallback (s)", 2, 0.1, 10, 0.1], ["RMS integration time (s)", 0.125, 0.01, 2, 0.005], ["Background history (s)", 30, 1, 60, 1], ["Background percentile", 0.1, 0, 0.5, 0.01], ["Number updates per second", 10, 1, 30, 1], ["Display packets per second", 240, 30, 500, 10]]);
export const DEFAULT_AUDIO = Object.freeze(AUDIO_CONTROLS.map(row => row[1]));
export function validAudio(values) {
  return Array.isArray(values) && values.length === AUDIO_CONTROLS.length
    && values.every((v, i) => Number.isFinite(v) && v >= AUDIO_CONTROLS[i][2] && v <= AUDIO_CONTROLS[i][3])
    && values[18] < values[19] && values[8] <= values[7];
}
export const DEFAULT_VISUAL = Object.freeze([0, -60, 1, 1]);
export function validVisual(values) {
  return Array.isArray(values) && values.length === 4 && values.every(Number.isFinite)
    && [0, 1].includes(values[0]) && values[1] >= -90 && values[1] <= -20
    && [0, 1, 2, 3].includes(values[2]) && values[3] >= 1 / 64 && values[3] <= 64;
}
export const RENDER_CONTROLS = Object.freeze([
  ['resolution', 'Scene resolution scale', 1, .25, 1.5, .05],
  ['depthFade', 'Depth brightness retention', .72, .1, .99, .01],
  ['barGlow', 'Bar color emission', .08, 0, 1, .01],
  ['attackGlow', 'Bar attack glow', 1, 0, 3, .05],
  ['colorAttack', 'Colored attack light', 1, 0, 3, .05],
  ['ballGlow', 'Ball color emission', .12, 0, 1, .01],
  ['colorSpill', 'Colored light strength', .18, 0, 2, .01],
  ['attackLight', 'White attack light strength', .8, 0, 3, .05],
  ['lightRange', 'Local light range', .22, .05, 1, .01],
  ['sweepAngle', 'Camera sweep (degrees)', 10, 0, 40, 1],
  ['sweepSeconds', 'Camera sweep period (s)', 48, 4, 180, 1],
  ['scrollSpeed', 'Scroll columns per beat', 2, .25, 8, .25],
]);
export function mountAudioControls(presentation) {
  const { card, settings } = presentation;
  const host = card.querySelector('.audio-tuning');
  const help = document.createElement('p'); help.textContent = 'These controls change scheduling, readouts, and presentation. The ISO loudness model stays fixed. Audio settings apply live. Block and latency changes restart active audio.'; host.append(help);
  const status = document.createElement('p'); status.className = 'audio-settings-status'; status.setAttribute('role', 'status');
  presentation.listen(card, 'audio-settings-ack', ({ detail }) => {
    status.textContent = detail.accepted ? 'Audio settings applied.' : 'Audio settings rejected.';
  });
  const visualHost = document.createElement('div'); visualHost.className = 'visual-audio-controls'; host.append(visualHost);
  const gateRow = document.createElement('label'); gateRow.className = 'control-row'; gateRow.textContent = 'Microphone noise gate';
  const gate = document.createElement('input'); gate.type = 'checkbox'; gate.className = 'microphone-gate'; gate.checked = Boolean(settings.visual[0]); gateRow.append(gate); visualHost.append(gateRow);
  const floorRow = document.createElement('label'); floorRow.className = 'control-row'; floorRow.textContent = 'Noise floor (dBFS)';
  const floor = document.createElement('input'); Object.assign(floor, { type: 'number', min: -90, max: -20, step: 1, value: settings.visual[1], className: 'microphone-floor' }); floorRow.append(floor); visualHost.append(floorRow);
  const gainRow = document.createElement('label'); gainRow.className = 'control-row'; gainRow.textContent = 'Visual gain mode';
  const gain = document.createElement('select'); gain.className = 'visual-gain-mode';
  ['Off', 'Normal', 'Vivid', 'Lazy'].forEach((name, i) => { const option = document.createElement('option'); option.value = i; option.textContent = name; gain.append(option); }); gain.value = settings.visual[2]; gainRow.append(gain); visualHost.append(gainRow);
  const manualRow = document.createElement('label'); manualRow.className = 'control-row'; manualRow.textContent = 'Manual visual gain (×)';
  const manual = document.createElement('input'); Object.assign(manual, { type: 'number', min: 1 / 64, max: 64, step: 'any', value: settings.visual[3], className: 'manual-visual-gain' }); manualRow.append(manual); visualHost.append(manualRow);
  const syncVisual = () => { gate.checked = Boolean(settings.visual[0]); floor.value = settings.visual[1]; gain.value = settings.visual[2]; manual.value = settings.visual[3]; manual.disabled = settings.visual[2] !== 0; };
  syncVisual();
  for (const input of [gate, floor, gain, manual]) presentation.listen(input, 'change', () => {
    const values = [Number(gate.checked), Number(floor.value), Number(gain.value), Number(manual.value)];
    if (floor.value === '' || manual.value === '' || !floor.validity.valid || !manual.validity.valid || !validVisual(values)) { status.textContent = 'Use the displayed noise and gain limits.'; return; }
    settings.visual = values; syncVisual(); presentation.save();
  });
  const inputs = AUDIO_CONTROLS.map(([label, , min, max, step], i) => {
    const row = document.createElement('label'); row.className = 'control-row'; row.textContent = label;
    const input = document.createElement('input'); Object.assign(input, { type: 'number', min, max, step, value: settings.audio[i] });
    input.dataset.audioSetting = i; row.append(input); host.append(row);
    presentation.listen(input, 'change', () => {
      const values = inputs.map(input => Number(input.value));
      if (!inputs.every(input => input.value !== '' && input.validity.valid) || !validAudio(values)) { status.textContent = 'Use values in the displayed ranges, increasing tempo limits, and peak history no longer than baseline history.'; return; }
      status.textContent = 'Saved. Applying to active audio…'; settings.audio = values; presentation.save();
    }); return input;
  });
  const row = document.createElement('label'); row.className = 'control-row'; row.textContent = 'Audio block request';
  const quantum = document.createElement('select'); quantum.className = 'audio-quantum';
  const supported = typeof AudioContext !== 'undefined' && 'renderQuantumSize' in AudioContext.prototype;
  for (const value of ['default', 'hardware', 128, 256, 512, 1024]) {
    const option = document.createElement('option'); option.value = value;
    option.textContent = value === 'default' ? 'Browser Default (normally 128)' : value === 'hardware' ? 'Hardware' : `${value} samples`;
    option.disabled = value !== 'default' && !supported; quantum.append(option);
  }
  quantum.value = supported ? String(settings.quantum) : 'default'; row.append(quantum); host.prepend(row);
  presentation.listen(quantum, 'change', () => { settings.quantum = /^\d+$/.test(quantum.value) ? Number(quantum.value) : quantum.value; presentation.save(); });
  const latencyRow = document.createElement('label'); latencyRow.className = 'control-row'; latencyRow.textContent = 'Audio latency request';
  const latency = document.createElement('select'); latency.className = 'audio-latency';
  for (const value of ['interactive', 'balanced', 'playback', .01, .02, .04]) { const option = document.createElement('option'); option.value = value; option.textContent = typeof value === 'number' ? `${value * 1000} ms request` : value; latency.append(option); }
  latency.value = String(settings.latency); latencyRow.append(latency); host.prepend(latencyRow);
  presentation.listen(latency, 'change', () => { settings.latency = Number.isFinite(Number(latency.value)) ? Number(latency.value) : latency.value; presentation.save(); });
  const note = document.createElement('p'); note.textContent = 'Block and latency requests depend on browser support. They do not specify total microphone-to-screen delay. RMS uses exponential integration. Background is a readout only.'; host.append(note, status);
  const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset audio controls'; host.append(reset);
  presentation.listen(reset, 'click', () => { settings.audio = [...DEFAULT_AUDIO]; settings.visual = [...DEFAULT_VISUAL]; syncVisual(); settings.quantum = 'default'; settings.latency = 'interactive'; inputs.forEach((input, i) => { input.value = settings.audio[i]; }); quantum.value = 'default'; latency.value = 'interactive'; presentation.save(); });
  const renderHost = card.querySelector('.render-tuning');
  for (const [key, label, , min, max, step] of RENDER_CONTROLS) {
    const row = document.createElement('label'); row.className = 'control-row'; row.textContent = label;
    const input = document.createElement('input'); Object.assign(input, { type: 'number', min, max, step, value: settings[key] }); input.dataset.renderSetting = key; row.append(input); renderHost.append(row);
    if (key === 'attackGlow') input.title = 'White emission along attack edges. Raise this value for a brighter flash. Audio response settings control attack detection.';
    if (key === 'colorAttack') input.title = 'Bar-colored attack light on the bars and nearby surfaces. Louder bands produce brighter pulses. The white outline has its own Bar attack glow control.';
    presentation.listen(input, 'change', () => { if (input.value === '' || !input.validity.valid) return; settings[key] = Number(input.value); presentation.save(); });
  }
}

export function createAudioContext() {
    const saved = document.querySelector('.audio-card')?.preferences;
    const options = { sampleRate: 48000, latencyHint: saved?.latency ?? 'interactive' };
    if ('renderQuantumSize' in AudioContext.prototype) options.renderSizeHint = saved?.quantum ?? 'default';
    const context = new AudioContext(options);
    const card = document.querySelector('.audio-card');
    context.requestedAudioOptions = JSON.stringify([saved?.quantum ?? 'default', saved?.latency ?? 'interactive']);
    context.inputResume = card?.audioRestart;
    if (card) { delete card.audioRestart; card.activeAudioContext = context; }
    context.visualOptions = validVisual(saved?.visual) ? [...saved.visual] : [...DEFAULT_VISUAL];
    context.loudnessSettings = validAudio(saved?.audio) ? [...saved.audio] : [...DEFAULT_AUDIO];
    return context;
}
