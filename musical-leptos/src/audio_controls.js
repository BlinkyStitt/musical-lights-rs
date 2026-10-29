// Engineering controls only. The ISO model and its 24 Bark bands stay fixed.
export const AUDIO_CONTROLS = Object.freeze([["Display gain target", 0.8, 0.1, 1, 0.05], ["Gain reduction time (s)", 2, 0.05, 60, 0.05], ["Gain recovery time (s)", 20, 0.05, 120, 0.05], ["Motion minimum cutoff (Hz)", 1, 0.1, 30, 0.1], ["Motion derivative cutoff (Hz)", 1, 0.1, 30, 0.1], ["Motion speed coefficient", 0.8, 0, 5, 0.05], ["Attack comparison (s)", 0.01, 0.002, 0.02, 0.002], ["Attack baseline (s)", 0.1, 0.02, 0.1, 0.002], ["Attack peak history (s)", 0.03, 0.002, 0.1, 0.002], ["Attack startup guard (s)", 0.25, 0, 2, 0.01], ["Attack novelty threshold", 0.01, 0.001, 1, 0.001], ["Attack relative rise", 0.15, 0.01, 1, 0.01], ["Attack minimum (sones)", 0.1, 0, 10, 0.01], ["Attack band prominence", 0.3, 0, 1, 0.01], ["Acoustic quiet rearm (s)", 0.01, 0.002, 0.2, 0.002], ["Minimum flash interval (s)", 0.16, 0.02, 2, 0.01], ["Flash quiet rearm (s)", 0.06, 0.002, 1, 0.002], ["Flash duration (s)", 0.18, 0.02, 1, 0.01], ["Tempo minimum (BPM)", 60, 60, 190, 1], ["Tempo maximum (BPM)", 200, 70, 200, 1], ["Tempo history (s)", 8, 4, 8, 0.5], ["Tempo smoothing (s)", 3, 0.1, 20, 0.1], ["Tempo silence fallback (s)", 2, 0.1, 10, 0.1], ["RMS integration time (s)", 0.125, 0.01, 2, 0.005], ["Background history (s)", 30, 1, 60, 1], ["Background percentile", 0.1, 0, 0.5, 0.01], ["Number updates per second", 10, 1, 30, 1], ["Display packets per second", 240, 30, 500, 10]]);
export const DEFAULT_AUDIO = Object.freeze(AUDIO_CONTROLS.map(row => row[1]));
export function validAudio(values) {
  return Array.isArray(values) && values.length === AUDIO_CONTROLS.length
    && values.every((v, i) => Number.isFinite(v) && v >= AUDIO_CONTROLS[i][2] && v <= AUDIO_CONTROLS[i][3])
    && values[18] < values[19] && values[8] <= values[7];
}
export const DEFAULT_VISUAL = Object.freeze([0, .1, 1, 1]);
export function validVisual(values) {
  return Array.isArray(values) && values.length === 4 && values.every(Number.isFinite)
    && [0, 1].includes(values[0]) && values[1] > 0
    && [0, 1, 2, 3].includes(values[2]) && values[3] >= 1 / 64 && values[3] <= 64;
}
// Saved fields recover independently; live updates still validate atomically.
export function recoverVisual(saved) {
  const values = [...DEFAULT_VISUAL];
  const validGate = Array.isArray(saved) && [0, 1].includes(saved[0]) && Number.isFinite(saved[1]) && saved[1] > 0;
  if (validGate) { values[0] = saved[0]; values[1] = saved[1]; }
  if (Array.isArray(saved) && [0, 1, 2, 3].includes(saved[2])) values[2] = saved[2];
  if (Array.isArray(saved) && Number.isFinite(saved[3]) && saved[3] >= 1 / 64 && saved[3] <= 64) values[3] = saved[3];
  return { values, gateReset: !validGate };
}

export const RENDER_CONTROLS = Object.freeze([
  ['resolution', 'Scene resolution scale', 1, .25, 1.5, .05],
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
  const status = document.createElement('p'); status.className = 'audio-settings-status'; status.id = 'audio-settings-status'; status.setAttribute('role', 'status');
  const activeFloor = () => card.activeAudioContext?.acceptedVisual?.[1] ?? (card.activeAudioContext ? 'unavailable' : settings.visual[1]);
  // Invalid local edits send no processor revision. Keep their errors visible
  // while acknowledgments and lifecycle events update the accepted state.
  let visualInvalid = false, audioInvalid = false, processorStatus = '';
  const renderStatus = () => {
    status.textContent = visualInvalid
      ? `Rejected: use a finite positive activation floor and gain from 1/64 to 64. Active floor: ${activeFloor()} sones. Correct the value and try again.`
      : audioInvalid ? 'Use values in the displayed ranges, increasing tempo limits, and peak history no longer than baseline history.' : processorStatus;
  };
  const updateStatus = message => { processorStatus = message; renderStatus(); };
  presentation.listen(card, 'audio-settings-ack', ({ detail }) => {
    updateStatus(detail.accepted ? `Applied. Activation floor: ${detail.visual?.[1] ?? settings.visual[1]} sones.` : `Rejected: ${detail.reason ?? 'Invalid settings.'} Active floor: ${detail.visual?.[1] ?? 'unavailable'} sones. Enter a finite positive floor and valid gain, then try again.`);
  });
  const visualHost = document.createElement('div'); visualHost.className = 'visual-audio-controls'; host.append(visualHost);
  const gateRow = document.createElement('label'); gateRow.className = 'control-row'; gateRow.textContent = 'Microphone activation gate';
  const gate = document.createElement('input'); gate.type = 'checkbox'; gate.className = 'microphone-gate'; gate.checked = Boolean(settings.visual[0]); gateRow.append(gate); visualHost.append(gateRow);
  const floorRow = document.createElement('label'); floorRow.className = 'control-row'; floorRow.textContent = 'Activation floor (sones)';
  const floor = document.createElement('input'); Object.assign(floor, { type: 'number', min: 0, step: 'any', value: settings.visual[1], className: 'microphone-floor' }); floorRow.append(floor); visualHost.append(floorRow);
  const gateStatus = document.createElement('output'); gateStatus.className = 'microphone-gate-status'; gateStatus.setAttribute('role', 'status'); gateStatus.textContent = 'Activation gate: unavailable';
  const background = document.createElement('output'); background.className = 'activation-background'; background.setAttribute('aria-live', 'off'); background.textContent = 'Background estimate: unavailable';
  const guide = document.createElement('p'); guide.id = 'activation-guide';
  guide.textContent = 'Turn on Listening, observe the background while the room is quiet, adjust the floor for this room and microphone, enable the activation gate, then test with sound. Uncalibrated sones are estimates; calibration is optional. This is a manual floor, independent of visual gain. It does not remove fans during music. Raw meters and the decorative listening wave continue when closed. The 100 ms closing hold is separate from the bars’ gradual decay; the 2 ms analysis cadence is not total input-to-screen delay.';
  floor.setAttribute('aria-describedby', `${guide.id} ${status.id}`);
  const helpButton = document.createElement('button'); helpButton.type = 'button'; helpButton.className = 'activation-help'; helpButton.textContent = 'Activation floor help'; helpButton.dataset.explanation = guide.textContent;
  helpButton.setAttribute('aria-expanded', 'false');
  for (const event of ['focus', 'click']) presentation.listen(helpButton, event, () => presentation.showHelp(helpButton, 'activation-floor'));
  presentation.listen(helpButton, 'pointerenter', event => { if (event.pointerType === 'mouse') presentation.showHelp(helpButton, 'activation-floor'); });
  presentation.listen(helpButton, 'pointerleave', event => { if (event.pointerType === 'mouse' && !presentation.popup.matches(':hover') && document.activeElement !== helpButton) presentation.hideHelp(); });
  presentation.listen(helpButton, 'blur', () => presentation.hideHelp());
  visualHost.append(background, gateStatus, helpButton, guide);
  const resetNotice = document.createElement('p'); resetNotice.className = 'gate-reset-notice'; resetNotice.setAttribute('role', 'status');
  if (settings.gateReset) resetNotice.textContent = 'Saved activation gate reset to disabled / 0.1 sones because its floor was missing, invalid, or in legacy dBFS. Valid gain settings were retained. Choose a positive floor, then enable the gate.';
  visualHost.append(resetNotice, status);
  const savedStatus = () => {
    const context = card.activeAudioContext;
    const same = context?.acceptedVisual && JSON.stringify([context.requestedAudio, context.requestedVisual]) === JSON.stringify([settings.audio, settings.visual])
      && JSON.stringify([context.loudnessSettings, context.acceptedVisual]) === JSON.stringify([settings.audio, settings.visual]);
    updateStatus(!context || context.audioRetired || context.state === 'closed' ? 'Saved for next start.'
      : same ? `Applied. Activation floor: ${context.acceptedVisual[1]} sones.` : 'Applying audio settings…');
  };
  presentation.listen(card, 'audio-session', ({ detail }) => {
    if (detail.state === 'starting') updateStatus('Applying audio settings…');
    if (detail.state !== 'playing') {
      gateStatus.textContent = 'Activation gate: unavailable'; background.textContent = 'Background estimate: unavailable';
      if (detail.state === 'stopped') updateStatus('Saved for next start.');
    }
  });
  presentation.listen(card, 'audio-gate', ({ detail }) => {
    const text = `Activation gate: ${['disabled', 'open', 'closed', 'digital bypass'][detail.state] ?? 'unavailable'}`;
    if (gateStatus.textContent !== text) gateStatus.textContent = text;
    if (background.textContent !== detail.background) background.textContent = detail.background;
  });
  const gainRow = document.createElement('label'); gainRow.className = 'control-row'; gainRow.textContent = 'Visual gain mode';
  const gain = document.createElement('select'); gain.className = 'visual-gain-mode';
  ['Off', 'Normal', 'Vivid', 'Lazy'].forEach((name, i) => { const option = document.createElement('option'); option.value = i; option.textContent = name; gain.append(option); }); gain.value = settings.visual[2]; gainRow.append(gain); visualHost.append(gainRow);
  const manualRow = document.createElement('label'); manualRow.className = 'control-row'; manualRow.textContent = 'Manual visual gain (×)';
  const manual = document.createElement('input'); Object.assign(manual, { type: 'number', min: 1 / 64, max: 64, step: 'any', value: settings.visual[3], className: 'manual-visual-gain' }); manualRow.append(manual); visualHost.append(manualRow);
  const syncVisual = () => { gate.checked = Boolean(settings.visual[0]); floor.value = settings.visual[1]; gain.value = settings.visual[2]; manual.value = settings.visual[3]; manual.disabled = settings.visual[2] !== 0; };
  syncVisual();
  for (const input of [gate, floor, gain, manual]) presentation.listen(input, 'change', () => {
    const values = [Number(gate.checked), Number(floor.value), Number(gain.value), Number(manual.value)];
    visualInvalid = floor.value === '' || manual.value === '' || !floor.validity.valid || !manual.validity.valid || !validVisual(values);
    if (visualInvalid) { floor.setAttribute('aria-invalid', String(!Number.isFinite(values[1]) || values[1] <= 0 || floor.value === '')); manual.setAttribute('aria-invalid', String(manual.value === '' || !manual.validity.valid)); renderStatus(); return; }
    floor.removeAttribute('aria-invalid'); manual.removeAttribute('aria-invalid'); resetNotice.textContent = '';
    settings.visual = values; syncVisual(); savedStatus(); presentation.save();
  });
  const inputs = AUDIO_CONTROLS.map(([label, , min, max, step], i) => {
    const row = document.createElement('label'); row.className = 'control-row'; row.textContent = label;
    const input = document.createElement('input'); Object.assign(input, { type: 'number', min, max, step, value: settings.audio[i] });
    input.dataset.audioSetting = i; row.append(input); host.append(row);
    presentation.listen(input, 'change', () => {
      const values = inputs.map(input => Number(input.value));
      audioInvalid = !inputs.every(input => input.value !== '' && input.validity.valid) || !validAudio(values);
      if (audioInvalid) { renderStatus(); return; }
      settings.audio = values; savedStatus(); presentation.save();
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
  const note = document.createElement('p'); note.textContent = 'Block and latency requests depend on browser support. They do not specify total microphone-to-screen delay. RMS uses exponential integration. Background is a readout only.'; host.append(note);
  const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset audio controls'; host.append(reset);
  presentation.listen(reset, 'click', () => { settings.audio = [...DEFAULT_AUDIO]; settings.visual = [...DEFAULT_VISUAL]; syncVisual(); visualInvalid = audioInvalid = false; floor.removeAttribute('aria-invalid'); manual.removeAttribute('aria-invalid'); resetNotice.textContent = ''; settings.quantum = 'default'; settings.latency = 'interactive'; inputs.forEach((input, i) => { input.value = settings.audio[i]; }); quantum.value = 'default'; latency.value = 'interactive'; savedStatus(); presentation.save(); });
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
    context.visualOptions = recoverVisual(saved?.visual).values;
    context.requestedVisual = [...context.visualOptions];
    context.loudnessSettings = validAudio(saved?.audio) ? [...saved.audio] : [...DEFAULT_AUDIO];
    context.requestedAudio = [...context.loudnessSettings];
    return context;
}
