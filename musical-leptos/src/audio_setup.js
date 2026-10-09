const profiles = new WeakMap();
const sessions = new WeakMap();
let nextSession = 0;

// Safari needs resume inside the gesture, before requestFullscreen consumes
// activation. No input is connected yet; suspend again before graph setup.
export function suspendForStartup(context) {
    const primer = context.createBufferSource();
    primer.buffer = context.createBuffer(1, 1, context.sampleRate);
    primer.connect(context.destination);
    // Starting a scheduled source unlocks Safari synchronously. resume alone
    // defers its activation check until fullscreen has consumed the gesture.
    primer.start();
    return context.resume().then(() => context.suspend()).finally(() => primer.disconnect());
}

function beginSession(context, card, source) {
    const session = { sessionId: ++nextSession, source, sampleRate: context.sampleRate,
        diagnostics: card.querySelector('.tone-trace')?.checked === true, state: 'starting', repeat: false };
    card.dataset.audioSession = String(session.sessionId);
    card.dataset.audioSource = source;
    card.dataset.toneDiagnostics = String(session.diagnostics);
    session.publish = (state, reason) => {
        if (card.dataset.audioSession !== String(session.sessionId) || session.closed) return;
        session.state = state;
        card.dataset.audioState = state;
        const status = card.querySelector('.mic-session-status');
        if (status) status.textContent = source === 'microphone' ? ({ starting: 'Starting microphone…', interrupted: 'Microphone interrupted.', stopped: reason === 'cleanup' ? '' : 'Microphone stopped.' }[state] ?? '') : '';
        const { publish, close, ...detail } = session;
        card.dispatchEvent(new CustomEvent('audio-session', { detail: { ...detail, reason } }));
    };
    if (source !== 'microphone') card.presentation?.player?.pauseVideo();
    session.publish('starting', 'start');
    let stateBeforeInterruption = 'starting';
    const stateChanged = () => {
        // A canceled acquisition may never return. Closing its context ends
        // ownership now, before a late getUserMedia result can arrive.
        if (context.state === 'closed') { session.close(); return; }
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

// A tab can outlive the Pages artifact it booted from. Check only at session
// start (or a failed module load), never interrupt a running audio graph.
async function requireCurrentRuntime(context) {
    const card = document.querySelector('.audio-card');
    const assets = document.querySelector('meta[name="musical-lights-assets"]').content;
    let version;
    try {
        const check = new URL('build.json', document.baseURI);
        check.searchParams.set('check', Date.now());
        const response = await fetch(check, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        if (response.ok) ({ version } = await response.json());
    } catch { /* Cached modules may still work when the version check is offline. */ }
    if (context.state === 'closed' || !card?.isConnected) throw new Error('Audio session has closed');
    if (!/^[a-f0-9]{24}$/.test(version) || assets.endsWith(`/assets/${version}/`)) return;
    const reload = new URL(location.href);
    reload.searchParams.set('__ml_build', version);
    let link = card.querySelector('.runtime-update');
    if (!link) {
        link = document.createElement('a');
        link.className = 'runtime-update';
        // Bypass the Leptos router: this must load a new document and runtime.
        link.rel = 'external';
        link.textContent = 'Reload updated app';
        card.querySelector('.recovery-notices').append(link);
    }
    link.href = reload.href;
    throw new Error('An updated app is available. Reload it, then start listening again.');
}

export async function prepareProcessor(context, stream, channel, reducedMotion) {
    const session = sessions.get(stream);
    if (!session || session.closed) throw new Error('Audio session has closed');
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings();
    const raw = session.source === 'microphone' && ['autoGainControl', 'echoCancellation', 'noiseSuppression'].every(key => settings[key] === false);
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
    Object.assign(session, { channel: session.selectedChannel ?? channel, pascalsPerUnit: pascalsPerUnit ?? 2, calibrated: pascalsPerUnit !== undefined });
    session.publish(session.state, 'processor ready');
    let module;
    try {
        const moduleUrl = new URL(document.querySelector('meta[name="musical-lights-assets"]').content + 'loudness/loudness.wasm', document.baseURI);
        const response = await fetch(moduleUrl);
        if (!response.ok) throw new Error(`Cannot load audio analysis: HTTP ${response.status}`);
        module = await WebAssembly.compile(await response.arrayBuffer());
        await context.audioWorklet.addModule(new URL(document.querySelector('meta[name="musical-lights-assets"]').content + 'loudness/processor.js', document.baseURI));
    } catch (error) {
        // Cover a deployment after the session preflight but before either load.
        await requireCurrentRuntime(context);
        throw error;
    }
    if (session.closed) throw new Error('Audio session has closed');
    const node = new AudioWorkletNode(context, 'loudness-processor', {
        channelCountMode: 'max', channelInterpretation: 'discrete',
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { module, pascalsPerUnit, channel: session.source === 'microphone' ? channel : 0, reducedMotion,
            diagnostics: session.diagnostics, sessionId: session.sessionId },
    });
    const card = document.querySelector('.audio-card');
    const trace = event => {
        if (!session.closed && event.data.sessionId === session.sessionId && event.data.trace)
            card.dispatchEvent(new CustomEvent('tone-trace', { detail: {
                ...event.data, receivedAt: performance.timeOrigin + performance.now(), receivedAudioTime: context.currentTime,
            } }));
        if (event.data.type === 'frame' && isCurrentProcessorMessage(node, event.data)) {
            card.dispatchEvent(new CustomEvent('audio-tempo', { detail: { bpm: event.data.tempo, confidence: event.data.tempoConfidence, accentSequence: event.data.accentSequence } }));
        }
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
    let running = context.state === 'running';
    const contextChanged = () => {
      if (context.state === 'running') running = true;
      else if (running && context.state !== 'closed') fail('Audio playback was interrupted. Turn on Listening to restart.');
    };
    context.addEventListener('statechange', contextChanged);
    track.addEventListener('ended', ended);
    track.addEventListener('mute', muted);
    node.addEventListener('processorerror', crashed);
    const digitalSource = generatedSources.get(stream)?.source;
    digitalSource?.addEventListener('processorerror', crashed);
    const monitor = setInterval(() => {
        if (JSON.stringify(track.getSettings()) !== JSON.stringify(settings)) {
            fail('Microphone settings changed. Restart and calibrate this input again.');
        }
    }, 500);
    profiles.set(node, { key, settings, track, raw, session, calibrated: pascalsPerUnit !== undefined,
        release: () => { context.removeEventListener('statechange', contextChanged); node.port.removeEventListener('message', trace); clearInterval(monitor); track.removeEventListener('ended', ended); track.removeEventListener('mute', muted); node.removeEventListener('processorerror', crashed); digitalSource?.removeEventListener('processorerror', crashed); },
    });
    if (session.source !== 'microphone') generatedSources.get(stream)?.playback.connect(node);
    return node;
}

export function inputIsGenerated(stream) { return sessions.get(stream)?.source !== 'microphone'; }

export function captureStatus(node) {
    const profile = profiles.get(node);
    if (!profile) return 'Uncalibrated';
    if (profile.session.source !== 'microphone') return `${profile.session.source === 'generated' ? 'Generated test signal' : 'Digital review PCM'} · microphone off · channel ${profile.session.channel + 1}`;
    if (!profile.raw) return 'Uncalibrated · capture processing is unverified';
    return profile.calibrated ? 'Calibrated for this input' : 'Uncalibrated · estimated perceived loudness';
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
export function forgetCalibration(node) {
    const profile = profiles.get(node);
    if (!profile || profile.session.source !== 'microphone') return;
    try { localStorage.removeItem(`musical-lights-calibration:${profile.key}`); } catch { /* Nothing else is removed. */ }
    profile.calibrated = false;
}
export function canCalibrate(node) { return profiles.get(node)?.raw ?? false; }
export function releaseProcessor(node) { profiles.get(node)?.release(); profiles.delete(node); }
export function isCurrentProcessorMessage(node, data) {
    const session = profiles.get(node)?.session;
    return session && !session.closed && data.sessionId === session.sessionId
        && document.querySelector('.audio-card')?.dataset.audioSession === String(session.sessionId);
}

const generatedSources = new WeakMap();
// Bridge the review controls to the single Rust audio-session owner. Review
// updates file/source state first, then starts inside the same user gesture.
export class InputControls {
    constructor(card, onChange) {
        this.card = card;
        this.change = ({ detail }) => onChange(detail.source, detail.play);
        card.addEventListener('review-input', this.change);
    }
    close() { this.card.removeEventListener('review-input', this.change); }
}
export async function acquireInput(context, selectedChannel) {
    const card = /** @type {HTMLElement} */ (document.querySelector('.audio-card'));
    const sourceKind = card.querySelector('.input-source')?.value ?? 'microphone';
    const generated = sourceKind === 'generated', digital = sourceKind !== 'microphone';
    const session = beginSession(context, card, sourceKind);
    session.selectedChannel = selectedChannel;
    try {
        await requireCurrentRuntime(context);
        if (!digital) {
            const ownsInput = () => !session.closed && context.state !== 'closed' && card.isConnected
                && card.dataset.audioSession === String(session.sessionId);
            const permission = state => {
                if (ownsInput())
                    card.dispatchEvent(new CustomEvent('microphone-access', { detail: state }));
            };
            permission('requesting');
            let stream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: {
                    autoGainControl: false, echoCancellation: false, noiseSuppression: false,
                }});
            } catch (error) {
                // NotAllowedError also covers dismissed prompts and OS restrictions.
                permission(error.name === 'NotAllowedError' ? 'not-allowed' : 'unknown');
                throw error;
            }
            // getUserMedia cannot be aborted. A canceled request can resolve
            // after a replacement session, so discard it before any consumer
            // (especially recognition) sees the stream.
            if (!ownsInput()) {
                for (const track of stream.getTracks()) track.stop();
                throw new Error('Audio session has closed');
            }
            permission('granted');
            sessions.set(stream, session);
            card.dispatchEvent(new CustomEvent('recognition-input', { detail: { stream } }));
            return stream;
        }
        const { tonePCM, toneCases, toneState } = await import(new URL(document.querySelector('meta[name="musical-lights-assets"]').content + 'physics/tones.js', document.baseURI)).catch(async error => {
            await requireCurrentRuntime(context);
            throw error;
        });
        const query = selector => card.querySelector(selector);
        if (!card.review || !query('.tone-pause')) throw new Error('Advanced controls are still loading. Turn on Listening again.');
        const kind = query('.tone-kind')?.value ?? 'exercise';
        const frequency = Number(query('.tone-frequency')?.value ?? 1000);
        const db = Number(query('.tone-level')?.value ?? -34);
        let buffer, identity;
        if (generated) {
            if (!Number.isFinite(db) || db < -90 || db > -12 || !Number.isFinite(frequency) || frequency < 20 || frequency > 15500)
                throw new Error('Choose a level from −90 to −12 dBFS and a frequency from 20 to 15500 Hz.');
            if (selectedChannel !== 0) throw new Error('Test tones have one channel. Choose input channel 1.');
            const pcm = tonePCM(kind, frequency, 10 ** (db / 20), context.sampleRate);
            buffer = context.createBuffer(1, pcm.length, context.sampleRate); buffer.copyToChannel(pcm, 0);
        } else {
            const decoded = await card.review.decode(context);
            identity = decoded.identity;
            if (selectedChannel >= decoded.buffer.numberOfChannels) throw new Error(`Input channel ${selectedChannel + 1} is unavailable in this file.`);
            buffer = context.createBuffer(1, decoded.buffer.length, decoded.buffer.sampleRate);
            buffer.copyToChannel(decoded.buffer.getChannelData(selectedChannel), 0);
        }
        if (context.state === 'closed' || !card.isConnected) throw new Error('Audio session has closed');
        const { playbackTiming } = await import(new URL(document.querySelector('meta[name="musical-lights-assets"]').content + 'physics/review.js', document.baseURI));
        if (context.state === 'closed' || !card.isConnected) throw new Error('Audio session has closed');
        const destination = context.createMediaStreamDestination();
        const playback = context.createGain(); playback.connect(destination);
        const monitor = context.createGain(); monitor.gain.value = query('.tone-audible')?.checked ? 1 : 0;
        monitor.connect(context.destination); playback.connect(monitor);
        Object.assign(session, generated ? { kind, frequency, dbfs: db, peakAmplitude: 10 ** (db / 20) } : { clip: identity });
        Object.assign(session, {
            audioStart: context.currentTime, repeat: query('.tone-repeat')?.checked ?? true });
        await context.audioWorklet.addModule(new URL(document.querySelector('meta[name="musical-lights-assets"]').content + 'loudness/pcm-playback.js', document.baseURI)).catch(async error => {
            await requireCurrentRuntime(context);
            throw error;
        });
        if (context.state === 'closed' || !card.isConnected) throw new Error('Audio session has closed');
        const source = new AudioWorkletNode(context, 'pcm-playback', {
            numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
            processorOptions: { pcm: buffer.getChannelData(0), repeat: session.repeat },
        });
        source.connect(playback);
        let paused = false, ended = false, sequence = 0, acknowledged = -1, acknowledgedFrame = -1;
        // Output may still be in a preceding loop or transport state. Map its
        // context clock through the timeline before wrapping/clamping position.
        const timeline = [];
        const markPosition = (position, time, running, repeat) => timeline.push({ time, position, running, repeat });
        const positionAt = time => {
            const segment = timeline.findLast(segment => segment.time <= time);
            if (!segment) return 0;
            const elapsed = segment.position + (segment.running ? time - segment.time : 0);
            return segment.repeat && segment.running ? elapsed % buffer.duration : Math.min(elapsed, buffer.duration);
        };
        source.port.onmessage = ({ data }) => {
            if (session.closed || data.type !== 'transport' || data.sequence < acknowledged || data.frame < acknowledgedFrame) return;
            acknowledged = data.sequence; acknowledgedFrame = data.frame;
            markPosition(data.positionFrame / context.sampleRate, data.frame / context.sampleRate, data.state === 'playing', data.repeat);
            if (data.sequence !== sequence || data.state !== 'ended') return;
            ended = true;
            session.publish('ended', 'natural end');
            query('.tone-pause').textContent = 'Replay';
        };
        const command = (type, detail = {}) => source.port.postMessage({ type, ...detail, sequence: ++sequence });
        const start = () => {
            command('restart');
            session.publish(context.state === 'running' ? 'playing' : 'starting', 'source start');
        };
        const listeners = [];
        const listen = (selector, type, callback) => {
            const node = query(selector); if (!node) return;
            node.addEventListener(type, callback); listeners.push(() => node.removeEventListener(type, callback));
        };
        listen('.tone-pause', 'click', () => {
            if (ended) {
                paused = false; ended = false;
                start();
            } else if (paused) {
                paused = false;
                command('resume');
                session.publish(context.state === 'running' ? 'playing' : 'interrupted', 'resume');
            } else {
                paused = true; command('pause');
                session.publish('paused', 'pause');
            }
            query('.tone-pause').textContent = paused ? 'Resume playback' : 'Pause playback';
        });
        listen('.review-replay', 'click', () => {
            paused = false; ended = false; start();
            query('.tone-pause').textContent = 'Pause playback';
        });
        listen('.tone-repeat', 'change', () => {
            session.repeat = query('.tone-repeat').checked; command('repeat', { repeat: session.repeat });
            session.publish(session.state, 'repeat changed');
        });
        listen('.tone-audible', 'change', () => { monitor.gain.value = query('.tone-audible').checked ? 1 : 0; });
        // The constructor starts at sample zero. Do not send an initial restart
        // that could arrive after the first render quantum and duplicate PCM.
        markPosition(0, context.currentTime, true, session.repeat);
        session.publish(context.state === 'running' ? 'playing' : 'starting', 'source start');
        query('.tone-pause').disabled = false; query('.review-replay').disabled = false;
        const timer = setInterval(() => {
            if (session.closed) return;
            const at = positionAt(context.currentTime);
            const state = generated ? toneState(kind, at, frequency, 10 ** (db / 20)) : null;
            const timing = playbackTiming(context);
            card.dispatchEvent(new CustomEvent('review-playback', { detail: { sessionId: session.sessionId, recordedAt: new Date().toISOString(), processingSeconds: at, outputSeconds: positionAt(timing.audioTime), state: session.state, ...timing } }));
            const status = query('.tone-status');
            if (status) status.textContent = state ? `${kind}: ${state.frequencies.map(f => f.toFixed(1)).join(' + ') || 'no tone'} Hz, ${state.amplitude ? (20 * Math.log10(state.amplitude)).toFixed(1) : '−∞'} dBFS peak, ${at.toFixed(1)} / ${toneCases[kind]} s (${session.state})` : `${identity.name}: ${at.toFixed(2)} / ${buffer.duration.toFixed(2)} s (${session.state}) · ${timing.confidence}`;
        }, 100);
        const stream = destination.stream;
        sessions.set(stream, session);
        generatedSources.set(stream, { source, playback, release: () => {
            clearInterval(timer); for (const remove of listeners) remove();
            source.port.onmessage = null; source.port.close();
            source.disconnect(); playback.disconnect(); monitor.disconnect(); destination.disconnect();
            if (card.dataset.audioSession === String(session.sessionId) && query('.tone-pause')) {
                query('.tone-pause').disabled = true; query('.tone-pause').textContent = 'Pause playback'; query('.review-replay').disabled = true;
                card.review.buffer = null;
            }
        } });
        return stream;
    } catch (error) { session.close(); throw error; }
}
export function releaseInput(stream) {
    sessions.get(stream)?.close(); sessions.delete(stream);
    generatedSources.get(stream)?.release(); generatedSources.delete(stream);
}
