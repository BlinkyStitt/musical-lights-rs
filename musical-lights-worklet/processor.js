// One worklet owns digital PCM output and its analysis. Count the samples that
// this producer actually renders; the browser's worklet currentFrame can lag a
// quantum when its audio-graph lock is busy, despite continuous PCM. Anchor this
// sequence to the suspended context clock before playback starts.
class PCMPlayback {
    constructor({ pcm, repeat, frame, sessionId, positionFrame = 0, paused = false, ended = false }, port) {
        this.port = port;
        this.sessionId = sessionId;
        if (!Number.isSafeInteger(frame) || frame < 0) throw Error('Invalid playback clock');
        this.frame = frame;
        if (!(pcm instanceof Float32Array) || !pcm.length || sampleRate !== 48000) throw Error('Invalid playback PCM');
        this.pcm = pcm;
        if (!Number.isInteger(positionFrame) || positionFrame < 0 || positionFrame > pcm.length) throw Error('Invalid playback position');
        this.cursor = positionFrame === pcm.length && repeat && !ended ? 0 : positionFrame;
        this.repeat = Boolean(repeat);
        this.paused = Boolean(paused);
        this.ended = Boolean(ended) || this.cursor === pcm.length;
        this.sequence = 0;
        this.pending = true;
    }
    command(data) {
        this.sequence = data.sequence;
        if (data.type === 'restart') { this.cursor = 0; this.paused = false; this.ended = false; }
        else if (data.type === 'pause') this.paused = true;
        else if (data.type === 'resume') this.paused = false;
        else if (data.type === 'repeat') this.repeat = Boolean(data.repeat);
        else return;
        this.pending = true;
    }

    publish(frame) {
        this.port.postMessage({ type: 'transport', sessionId: this.sessionId, sequence: this.sequence, frame,
            positionFrame: this.cursor, repeat: this.repeat,
            state: this.ended ? 'ended' : this.paused ? 'paused' : 'playing' });
    }
    render(output) {
        const firstSample = this.frame;
        if (this.pending) { this.publish(firstSample); this.pending = false; }
        // Keep one connected mono source during pauses and after completion.
        // Transport commands never replace nodes or stop the analysis clock.
        for (let i = 0; i < output.length; i++) {
            output[i] = this.paused || this.ended ? 0 : this.pcm[this.cursor++];
            if (this.cursor === this.pcm.length && !this.ended) {
                if (this.repeat) this.cursor = 0;
                else { this.ended = true; this.publish(firstSample + i + 1); }
            }
        }
        this.frame += output.length;
        return firstSample;
    }
}


class LoudnessProcessor extends AudioWorkletProcessor {
    constructor({ processorOptions }) {
        super();
        const { module, pascalsPerUnit, channel, reducedMotion, diagnostics, sessionId, settings, visual, microphone, playback } = processorOptions;
        this.sessionId = sessionId;
        this.playback = playback ? new PCMPlayback({ ...playback, sessionId }, this.port) : null;
        this.wasm = new WebAssembly.Instance(module).exports;
        this.processor = this.wasm.processor_create(pascalsPerUnit === undefined ? 0 : 1, pascalsPerUnit ?? 2, Number(reducedMotion));
        if (!this.processor) throw new Error('Invalid microphone calibration');
        this.wasm.processor_source(this.processor, Number(Boolean(microphone)));
        if (visual) new Float64Array(this.wasm.memory.buffer, this.wasm.processor_visual_ptr(this.processor), 4).set(visual);
        if (settings) {
            const values = new Float64Array(this.wasm.memory.buffer, this.wasm.processor_settings_ptr(this.processor), this.wasm.processor_settings_length(this.processor));
            if (settings.length !== values.length) throw new Error('Invalid audio settings');
            values.set(settings);
            if (!this.wasm.processor_configure(this.processor)) throw new Error('Invalid audio settings');
        }
        this.messageHz = settings?.[27] ?? 240;
        this.revision = 0;
        this.requestedRevision = 1;
        this.settingsUpdate = { revision: 1, settings, visual };
        this.activeSettings = null; this.activeVisual = null;
        this.diagnostics = Boolean(diagnostics);
        this.wasm.processor_trace_enable(this.processor, Number(this.diagnostics));
        this.channel = channel;
        this.input = new Float32Array(this.wasm.memory.buffer, this.wasm.processor_input(this.processor), this.wasm.processor_capacity(this.processor));
        this.snapshot = new Float64Array(this.wasm.memory.buffer, this.wasm.processor_snapshot(this.processor), this.wasm.processor_snapshot_length(this.processor));
        this.pending = false;
        this.started = false;
        this.failed = false;
        this.lastSent = -Infinity;
        this.port.onmessage = ({ data }) => {
            if (data.type === 'restart' || data.type === 'pause' || data.type === 'resume' || data.type === 'repeat') {
                this.playback?.command(data); return;
            }
            if (data.type === 'settings') {
                if (data.sessionId !== this.sessionId || !Number.isInteger(data.revision)
                    || data.revision <= this.requestedRevision || data.revision > 0xffffffff) return;
                let accepted = false;
                if (Array.isArray(data.settings) && data.settings.length === this.wasm.processor_settings_length(this.processor)
                    && Array.isArray(data.visual) && data.visual.length === 4
                    && data.settings.every(Number.isFinite) && data.visual.every(Number.isFinite)) {
                    new Float64Array(this.wasm.memory.buffer, this.wasm.processor_settings_ptr(this.processor), data.settings.length).set(data.settings);
                    new Float64Array(this.wasm.memory.buffer, this.wasm.processor_visual_ptr(this.processor), 4).set(data.visual);
                    accepted = Boolean(this.wasm.processor_update(this.processor, data.revision));
                }
                if (accepted) {
                    this.requestedRevision = data.revision;
                    this.settingsUpdate = { revision: data.revision, settings: data.settings, visual: data.visual };
                } else this.port.postMessage({ type: 'settings-ack', sessionId: this.sessionId, revision: data.revision, accepted: false, reason: 'Invalid audio or visual settings.', settings: this.activeSettings, visual: this.activeVisual });
                return;
            }
            if (data.type === 'ack') this.pending = false;
            if (data.type === 'motion') this.wasm.processor_motion(this.processor, Number(Boolean(data.reduced)));
            if (data.type === 'calibrate' && !this.wasm.processor_calibrate(this.processor, data.dbSpl)) this.fail('Invalid calibration request.');
        };
    }

    process(inputs, outputs) {
        if (this.failed) return false;
        if (this.playback) {
            const samples = outputs[0][0];
            const firstSample = this.playback.render(samples);
            return this.analyze(samples, firstSample);
        }
        const channels = inputs[0];
        // Before the graph connects there is no input stream yet. Once capture
        // starts, a missing channel is a discontinuity, not measured silence.
        if (!channels?.length) {
            if (this.started) this.fail('The microphone input stopped. Restart listening.');
            return !this.failed;
        }
        const samples = channels[this.channel];
        if (!samples) { this.fail(`Input channel ${this.channel + 1} is unavailable.`); return false; }
        return this.analyze(samples, currentFrame);
    }

    analyze(samples, blockStartSample) {
        if (!this.started) this.inputStartSample = blockStartSample;
        this.started = true;
        for (let offset = 0; offset < samples.length;) {
            const length = Math.min(samples.length - offset, this.input.length);
            for (let i = 0; i < length; i++) this.input[i] = samples[offset + i];
            const firstSample = BigInt(blockStartSample + offset);
            if (!this.wasm.processor_process(this.processor, length, firstSample)) {
                // Reject the discontinuous block first, then explicitly start a
                // new analysis segment at that same sample index. Playback and
                // capture keep running. Never fill clock intervals with synthetic or replayed PCM.
                if (!this.wasm.processor_recover_discontinuity(this.processor)
                    || !this.wasm.processor_process(this.processor, length, firstSample)) {
                    this.fail(this.analysisError());
                    return false;
                }
            }
            offset += length;
        }
        const revision = this.wasm.processor_revision(this.processor);
        if (revision !== this.revision) {
            this.revision = revision;
            if (this.settingsUpdate?.revision === revision) {
                this.activeSettings = this.settingsUpdate.settings;
                this.activeVisual = this.settingsUpdate.visual;
                this.messageHz = this.activeSettings?.[27] ?? 240;
            }
            this.port.postMessage({ type: 'settings-ack', sessionId: this.sessionId, revision, accepted: true, settings: this.activeSettings, visual: this.activeVisual });
        }
        // At most one snapshot waits on the UI. The processor still consumes
        // every sample and every loudness frame while drawing is delayed.
        if (!this.pending && blockStartSample - this.lastSent >= sampleRate / this.messageHz) {
            this.wasm.processor_snapshot(this.processor);
            const state = this.snapshot.slice();
            const readouts = new Float64Array(this.wasm.memory.buffer, this.wasm.processor_readouts(this.processor), 4).slice();
            const extra = { readouts, gateState: revision ? this.wasm.processor_gate_state(this.processor) : null, revision, quantum: samples.length, accentSequence: this.wasm.processor_accent_sequence(this.processor), tempo: this.wasm.processor_tempo(this.processor), tempoConfidence: this.wasm.processor_tempo_confidence(this.processor) }, transfer = [state.buffer];
            if (this.diagnostics) {
                const stride = this.wasm.processor_trace_stride(this.processor);
                const trace = new Float64Array(this.wasm.memory.buffer, this.wasm.processor_trace_ptr(this.processor), this.wasm.processor_trace_count(this.processor) * stride).slice();
                extra.traceVersion = this.wasm.processor_trace_version(this.processor);
                extra.trace = trace; extra.traceStride = stride;
                extra.traceDropped = this.wasm.processor_trace_dropped(this.processor);
                extra.audioTime = blockStartSample / sampleRate;
                extra.inputStartSample = this.inputStartSample;
                this.wasm.processor_trace_clear(this.processor);
                transfer.push(trace.buffer);
            }
            const continuity = {
                segment: this.wasm.processor_segment(this.processor),
                missingSamples: Number(this.wasm.processor_missing_samples(this.processor)),
                overlapSamples: Number(this.wasm.processor_overlap_samples(this.processor)),
                expectedSample: Number(this.wasm.processor_gap_expected(this.processor)),
                receivedSample: Number(this.wasm.processor_gap_received(this.processor)),
                calibrationCancellations: this.wasm.processor_calibration_cancellations(this.processor),
            };
            this.port.postMessage({ type: 'frame', sessionId: this.sessionId, ...extra, continuity, state, sones: this.wasm.processor_sones(this.processor), clipped: this.wasm.processor_clipped(this.processor), calibration: this.wasm.processor_calibration_result(this.processor) }, transfer);
            this.pending = true;
            this.lastSent = blockStartSample;
        }
        return true;
    }

    analysisError() {
        const detail = this.wasm.processor_error_detail(this.processor);
        return ({
            1: 'Invalid audio block.', 2: `sample ${detail} is not finite`,
            3: `Audio sample clock jumped by ${detail} samples (expected ${this.wasm.processor_gap_expected(this.processor)}, received ${this.wasm.processor_gap_received(this.processor)}). Restart listening.`,
            4: `Third-octave band ${detail} exceeds the model’s 120 dB SPL limit.`,
            5: 'Audio analysis stopped. Restart listening.',
            6: 'Calibration signal clipped. Reduce input gain and restart.',
            7: 'The calibration reference is silent or invalid.',
        })[this.wasm.processor_error(this.processor)];
    }

    fail(message) {
        this.failed = true;
        this.port.postMessage({ type: 'error', sessionId: this.sessionId, message });
    }
}

registerProcessor('loudness-processor', LoudnessProcessor);
