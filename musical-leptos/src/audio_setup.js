const profiles = new WeakMap();

export async function prepareProcessor(context, stream, channel, reducedMotion) {
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings();
    const raw = ['autoGainControl', 'echoCancellation', 'noiseSuppression'].every(key => settings[key] === false);
    const key = JSON.stringify([settings, channel, context.sampleRate]);
    let profile;
    if (raw && settings.deviceId) {
        let stored;
        try { stored = localStorage.getItem(`musical-lights-calibration:${key}`); } catch { /* Session calibration still works when storage is unavailable. */ }
        if (stored) {
            try { profile = JSON.parse(stored); } catch { /* An invalid saved profile requires calibration again. */ }
        }
    }
    const pressure = profile?.pascalsPerUnit;
    const pascalsPerUnit = Number.isFinite(pressure) && pressure > 0 ? pressure : undefined;
    const moduleUrl = new URL('loudness/loudness.wasm', document.baseURI);
    const response = await fetch(moduleUrl);
    if (!response.ok) throw new Error(`Cannot load audio analysis: HTTP ${response.status}`);
    const module = await WebAssembly.compile(await response.arrayBuffer());
    await context.audioWorklet.addModule(new URL('loudness/processor.js', document.baseURI));
    const diagnostics = document.querySelector('.tone-trace')?.checked === true;
    document.querySelector('.audio-card').dataset.toneDiagnostics = String(diagnostics);
    const node = new AudioWorkletNode(context, 'loudness-processor', {
        channelCountMode: 'max', channelInterpretation: 'discrete',
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { module, pascalsPerUnit, channel, reducedMotion,
            diagnostics },
    });
    const card = document.querySelector('.audio-card');
    const trace = event => {
        if (event.data.trace) card.dispatchEvent(new CustomEvent('tone-trace', { detail: {
            ...event.data, receivedAt: performance.timeOrigin + performance.now(), receivedAudioTime: context.currentTime,
        } }));
    };
    node.port.addEventListener('message', trace);
    const fail = message => node.port.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message } }));
    const ended = () => fail('Microphone input ended. Restart listening.');
    const muted = () => fail('Microphone input was interrupted. Restart listening.');
    const crashed = () => fail('Audio processor failed. Restart listening.');
    track.addEventListener('ended', ended);
    track.addEventListener('mute', muted);
    node.addEventListener('processorerror', crashed);
    const monitor = setInterval(() => {
        if (JSON.stringify(track.getSettings()) !== JSON.stringify(settings)) {
            fail('Microphone settings changed. Restart and calibrate this input again.');
        }
    }, 500);
    profiles.set(node, { key, settings, track, raw, calibrated: pascalsPerUnit !== undefined,
        release: () => { node.port.removeEventListener('message', trace); clearInterval(monitor); track.removeEventListener('ended', ended); track.removeEventListener('mute', muted); node.removeEventListener('processorerror', crashed); },
    });
    return node;
}

export function captureStatus(node) {
    const profile = profiles.get(node);
    if (!profile) return 'Uncalibrated';
    if (!profile.raw) return 'Uncalibrated · capture processing is unverified';
    return profile.calibrated ? 'Calibrated for this input' : 'Uncalibrated · relative light activity';
}

export function saveCalibration(node, pascalsPerUnit) {
    const profile = profiles.get(node);
    if (!profile || !profile.raw || !Number.isFinite(pascalsPerUnit) || pascalsPerUnit <= 0) {
        throw new Error('Calibration requires fixed input gain and audio processing switched off.');
    }
    // A profile only applies to the exact capture settings used to measure it.
    if (JSON.stringify(profile.track.getSettings()) !== JSON.stringify(profile.settings)) {
        throw new Error('Capture settings changed during calibration. Restart listening.');
    }
    profile.calibrated = true;
    if (profile.settings.deviceId) {
        try { localStorage.setItem(`musical-lights-calibration:${profile.key}`, JSON.stringify({ pascalsPerUnit })); } catch { /* Valid for this session only. */ }
    }
}

export function canCalibrate(node) { return profiles.get(node)?.raw ?? false; }

export function releaseProcessor(node) { profiles.get(node)?.release(); profiles.delete(node); }

const generatedSources = new WeakMap();
export async function acquireInput(context) {
    const generated = document.querySelector('.generated-audio')?.checked === true;
    document.querySelector('.audio-card').dataset.audioSource = generated ? 'generated' : 'microphone';
    if (!generated) return navigator.mediaDevices.getUserMedia({ audio: {
        autoGainControl: false, echoCancellation: false, noiseSuppression: false,
    }});
    const { tonePCM, toneCases, toneState } = await import(new URL('physics/tones.js', document.baseURI));
    const destination = context.createMediaStreamDestination();
    const card = document.querySelector('.audio-card');
    const kind = card.querySelector('.tone-kind')?.value ?? 'exercise';
    const frequency = Number(card.querySelector('.tone-frequency')?.value ?? 1000);
    const db = Number(card.querySelector('.tone-level')?.value ?? -34);
    const pcm = tonePCM(kind, frequency, 10 ** (db / 20), context.sampleRate);
    const buffer = context.createBuffer(1, pcm.length, context.sampleRate);
    buffer.copyToChannel(pcm, 0);
    const monitor = context.createGain(); monitor.gain.value = 0;
    monitor.connect(context.destination);
    let source, startedAt = context.currentTime, offset = 0, paused = false;
    const query = selector => card.querySelector(selector);
    const start = () => {
        source = context.createBufferSource(); source.buffer = buffer;
        source.loop = query('.tone-repeat')?.checked ?? true;
        source.connect(destination); source.connect(monitor);
        startedAt = context.currentTime; source.start(0, offset);
    };
    const listeners = [];
    const listen = (selector, type, callback) => {
        const node = query(selector); if (!node) return;
        node.addEventListener(type, callback); listeners.push(() => node.removeEventListener(type, callback));
    };
    listen('.tone-pause', 'click', () => {
        if (paused) { start(); paused = false; }
        else { offset = (offset + context.currentTime - startedAt) % buffer.duration; source.stop(); source.disconnect(); paused = true; }
        query('.tone-pause').textContent = paused ? 'Resume tone' : 'Pause tone';
    });
    listen('.tone-repeat', 'change', () => { source.loop = query('.tone-repeat').checked; });
    listen('.tone-audible', 'change', () => { monitor.gain.value = query('.tone-audible').checked ? 1 : 0; });
    monitor.gain.value = query('.tone-audible')?.checked ? 1 : 0;
    card.dispatchEvent(new CustomEvent('tone-session', { detail: { kind, frequency, dbfs: db, sampleRate: context.sampleRate, audioStart: context.currentTime, repeat: query('.tone-repeat')?.checked ?? true } }));
    start();
    if (query('.tone-pause')) query('.tone-pause').disabled = false;
    const timer = setInterval(() => {
        const elapsed = offset + (paused ? 0 : context.currentTime - startedAt);
        const at = source.loop ? elapsed % buffer.duration : Math.min(elapsed, buffer.duration);
        const state = toneState(kind, at, frequency, 10 ** (db / 20));
        const status = query('.tone-status');
        if (status) status.textContent = `${kind}: ${state.frequencies.map(f => f.toFixed(1)).join(' + ') || 'no tone'} Hz, ${state.amplitude ? (20 * Math.log10(state.amplitude)).toFixed(1) : '−∞'} dBFS peak, ${at.toFixed(1)} / ${toneCases[kind]} s${paused ? ' (paused)' : ''}`;
    }, 100);
    const stream = destination.stream;
    generatedSources.set(stream, () => {
        clearInterval(timer); for (const remove of listeners) remove();
        if (!paused) source.stop(); source.disconnect(); monitor.disconnect(); destination.disconnect();
        if (query('.tone-pause')) { query('.tone-pause').disabled = true; query('.tone-pause').textContent = 'Pause tone'; }
    });
    return stream;
}
export function releaseInput(stream) { generatedSources.get(stream)?.(); generatedSources.delete(stream); }
