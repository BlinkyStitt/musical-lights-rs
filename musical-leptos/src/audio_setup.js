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
    const node = new AudioWorkletNode(context, 'loudness-processor', {
        channelCountMode: 'max', channelInterpretation: 'discrete',
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { module, pascalsPerUnit, channel, reducedMotion },
    });
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
        release: () => { clearInterval(monitor); track.removeEventListener('ended', ended); track.removeEventListener('mute', muted); node.removeEventListener('processorerror', crashed); },
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
    const destination = context.createMediaStreamDestination();
    const sources = [];
    const envelopes = [];
    // Broad spectral peaks and changing tone levels exercise the real PCM analysis pipeline.
    const frequencies = [50,150,250,350,450,570,700,840,1000,1170,1370,1600,1850,2150,2500,2900,3400,4050,4800,5800,7000,8600,10700,13700];
    for (let i = 0; i < frequencies.length; i++) {
        const oscillator = context.createOscillator(), gain = context.createGain();
        oscillator.frequency.value = frequencies[i]; oscillator.connect(gain); gain.connect(destination);
        const curve = new Float32Array(96);
        for (let j = 0; j < curve.length; j++) curve[j] = j < 20 ? .025 : (j + i * 3) % 23 < 6 ? .02 : .0002;
        envelopes.push({ gain: gain.gain, curve });
        oscillator.start(); sources.push(oscillator, gain);
    }
    // Keep a bounded lookahead for repeated phone tests without an audio cutoff.
    let next = context.currentTime;
    const schedule = () => {
        next = Math.max(next, context.currentTime);
        while (next < context.currentTime + 12) {
            for (const { gain, curve } of envelopes) gain.setValueCurveAtTime(curve, next, 6);
            next += 6;
        }
    };
    schedule();
    const timer = setInterval(schedule, 2500);
    const stream = destination.stream;
    generatedSources.set(stream, () => {
        clearInterval(timer);
        for (const source of sources) { if (source instanceof OscillatorNode) source.stop(); source.disconnect(); }
        destination.disconnect();
    });
    return stream;
}
export function releaseInput(stream) { generatedSources.get(stream)?.(); generatedSources.delete(stream); }
