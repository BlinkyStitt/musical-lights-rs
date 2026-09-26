const profiles = new WeakMap();
const sessions = new WeakMap();
let nextSession = 0;

function beginSession(context, card, source) {
    const session = { sessionId: ++nextSession, source, sampleRate: context.sampleRate,
        diagnostics: card.querySelector('.tone-trace')?.checked === true, state: 'starting', repeat: false };
    card.dataset.audioSession = String(session.sessionId);
    card.dataset.audioSource = source;
    card.dataset.toneDiagnostics = String(session.diagnostics);
    session.publish = (state, reason) => {
        if (card.dataset.audioSession !== String(session.sessionId) || session.closed) return;
        session.state = state;
        const { publish, close, ...detail } = session;
        card.dispatchEvent(new CustomEvent('audio-session', { detail: { ...detail, reason } }));
    };
    session.publish('starting', 'start');
    let stateBeforeInterruption = 'starting';
    const stateChanged = () => {
        if (context.state !== 'running') {
            if (session.state !== 'interrupted') stateBeforeInterruption = session.state;
            session.publish('interrupted', context.state);
        } else if (session.state === 'starting' || session.state === 'interrupted') {
            session.publish(['paused', 'ended'].includes(stateBeforeInterruption) ? stateBeforeInterruption : 'playing', 'context running');
        }
    };
    context.addEventListener('statechange', stateChanged);
    session.close = () => {
        session.publish('stopped', 'cleanup'); session.closed = true;
        context.removeEventListener('statechange', stateChanged);
    };
    return session;
}

export async function prepareProcessor(context, stream, channel, reducedMotion) {
    const session = sessions.get(stream);
    if (!session || session.closed) throw new Error('Audio session has closed');
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
    Object.assign(session, { channel, pascalsPerUnit: pascalsPerUnit ?? 2, calibrated: pascalsPerUnit !== undefined });
    session.publish(session.state, 'processor ready');
    const moduleUrl = new URL('loudness/loudness.wasm', document.baseURI);
    const response = await fetch(moduleUrl);
    if (!response.ok) throw new Error(`Cannot load audio analysis: HTTP ${response.status}`);
    const module = await WebAssembly.compile(await response.arrayBuffer());
    await context.audioWorklet.addModule(new URL('loudness/processor.js', document.baseURI));
    if (session.closed) throw new Error('Audio session has closed');
    const node = new AudioWorkletNode(context, 'loudness-processor', {
        channelCountMode: 'max', channelInterpretation: 'discrete',
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { module, pascalsPerUnit, channel, reducedMotion,
            diagnostics: session.diagnostics, sessionId: session.sessionId },
    });
    const card = document.querySelector('.audio-card');
    const trace = event => {
        if (!session.closed && event.data.sessionId === session.sessionId && event.data.trace)
            card.dispatchEvent(new CustomEvent('tone-trace', { detail: {
                ...event.data, receivedAt: performance.timeOrigin + performance.now(), receivedAudioTime: context.currentTime,
            } }));
        if (event.data.type === 'error') session.publish('interrupted', event.data.message);
    };
    node.port.addEventListener('message', trace);
    const fail = message => {
        if (session.closed) return;
        session.publish('interrupted', message);
        node.port.dispatchEvent(new MessageEvent('message', { data: { type: 'error', sessionId: session.sessionId, message } }));
    };
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
    profiles.set(node, { key, settings, track, raw, session, calibrated: pascalsPerUnit !== undefined,
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
export function isCurrentProcessorMessage(node, data) {
    const session = profiles.get(node)?.session;
    return session && !session.closed && data.sessionId === session.sessionId
        && document.querySelector('.audio-card')?.dataset.audioSession === String(session.sessionId);
}

const generatedSources = new WeakMap();
export async function acquireInput(context) {
    const card = document.querySelector('.audio-card');
    const generated = card.querySelector('.generated-audio')?.checked === true;
    const session = beginSession(context, card, generated ? 'generated' : 'microphone');
    try {
        if (!generated) {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: {
                autoGainControl: false, echoCancellation: false, noiseSuppression: false,
            }});
            sessions.set(stream, session);
            return stream;
        }
        const { tonePCM, toneCases, toneState } = await import(new URL('physics/tones.js', document.baseURI));
        const query = selector => card.querySelector(selector);
        const kind = query('.tone-kind')?.value ?? 'exercise';
        const frequency = Number(query('.tone-frequency')?.value ?? 1000);
        const db = Number(query('.tone-level')?.value ?? -34);
        if (!Number.isFinite(db) || db < -90 || db > -12 || !Number.isFinite(frequency) || frequency < 20 || frequency > 15500)
            throw new Error('Choose a level from −90 to −12 dBFS and a frequency from 20 to 15500 Hz.');
        const pcm = tonePCM(kind, frequency, 10 ** (db / 20), context.sampleRate);
        const buffer = context.createBuffer(1, pcm.length, context.sampleRate);
        buffer.copyToChannel(pcm, 0);
        const destination = context.createMediaStreamDestination();
        const playback = context.createGain(); playback.connect(destination);
        const monitor = context.createGain(); monitor.gain.value = query('.tone-audible')?.checked ? 1 : 0;
        monitor.connect(context.destination); playback.connect(monitor);
        Object.assign(session, { kind, frequency, dbfs: db, peakAmplitude: 10 ** (db / 20),
            audioStart: context.currentTime, repeat: query('.tone-repeat')?.checked ?? true });
        let source, startedAt = context.currentTime, offset = 0, paused = false, ended = false, generation = 0;
        const watchEnd = current => {
            const token = ++generation;
            current.onended = () => {
                if (session.closed || source !== current || token !== generation) return;
                ended = true; offset = buffer.duration;
                session.publish('ended', 'natural end');
                query('.tone-pause').textContent = 'Restart tone';
            };
        };
        const start = () => {
            if (source) { source.onended = null; source.disconnect(); }
            const current = context.createBufferSource(); source = current;
            current.buffer = buffer; current.loop = session.repeat;
            current.connect(playback);
            watchEnd(current);
            startedAt = context.currentTime; current.start(0, offset);
            session.publish(context.state === 'running' ? 'playing' : 'starting', 'source start');
        };
        const listeners = [];
        const listen = (selector, type, callback) => {
            const node = query(selector); if (!node) return;
            node.addEventListener(type, callback); listeners.push(() => node.removeEventListener(type, callback));
        };
        listen('.tone-pause', 'click', () => {
            if (ended) {
                offset = 0; paused = false; ended = false;
                playback.gain.value = 1; start();
            } else if (paused) {
                paused = false; startedAt = context.currentTime;
                watchEnd(source);
                source.playbackRate.value = 1; playback.gain.value = 1;
                session.publish(context.state === 'running' ? 'playing' : 'interrupted', 'resume');
            } else {
                offset = session.repeat ? (offset + context.currentTime - startedAt) % buffer.duration : Math.min(buffer.duration, offset + context.currentTime - startedAt);
                paused = true; watchEnd(source);
                // Keep the render graph connected and its sample clock running.
                // A zero playback rate holds position; mute the held sample so
                // analysis receives silence rather than a DC signal.
                source.playbackRate.value = 0; playback.gain.value = 0;
                session.publish('paused', 'pause');
            }
            query('.tone-pause').textContent = paused ? 'Resume tone' : 'Pause tone';
        });
        listen('.tone-repeat', 'change', () => {
            session.repeat = query('.tone-repeat').checked; source.loop = session.repeat;
            session.publish(session.state, 'repeat changed');
        });
        listen('.tone-audible', 'change', () => { monitor.gain.value = query('.tone-audible').checked ? 1 : 0; });
        start(); query('.tone-pause').disabled = false;
        const timer = setInterval(() => {
            if (session.closed) return;
            const elapsed = offset + (paused || ended ? 0 : context.currentTime - startedAt);
            const at = session.repeat && !ended ? elapsed % buffer.duration : Math.min(elapsed, buffer.duration);
            const state = toneState(kind, at, frequency, 10 ** (db / 20));
            const status = query('.tone-status');
            if (status) status.textContent = `${kind}: ${state.frequencies.map(f => f.toFixed(1)).join(' + ') || 'no tone'} Hz, ${state.amplitude ? (20 * Math.log10(state.amplitude)).toFixed(1) : '−∞'} dBFS peak, ${at.toFixed(1)} / ${toneCases[kind]} s (${session.state})`;
        }, 100);
        const stream = destination.stream;
        sessions.set(stream, session);
        generatedSources.set(stream, () => {
            clearInterval(timer); for (const remove of listeners) remove();
            source.onended = null; if (!ended) source.stop();
            source.disconnect(); playback.disconnect(); monitor.disconnect(); destination.disconnect();
            if (card.dataset.audioSession === String(session.sessionId) && query('.tone-pause')) {
                query('.tone-pause').disabled = true; query('.tone-pause').textContent = 'Pause tone';
            }
        });
        return stream;
    } catch (error) { session.close(); throw error; }
}
export function releaseInput(stream) {
    sessions.get(stream)?.close(); sessions.delete(stream);
    generatedSources.get(stream)?.(); generatedSources.delete(stream);
}
