class LoudnessProcessor extends AudioWorkletProcessor {
    constructor({ processorOptions }) {
        super();
        const { module, pascalsPerUnit, channel, reducedMotion, diagnostics, sessionId } = processorOptions;
        this.sessionId = sessionId;
        this.wasm = new WebAssembly.Instance(module).exports;
        this.processor = this.wasm.processor_create(pascalsPerUnit === undefined ? 0 : 1, pascalsPerUnit ?? 2, Number(reducedMotion));
        if (!this.processor) throw new Error('Invalid microphone calibration');
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
            if (data.type === 'ack') this.pending = false;
            if (data.type === 'motion') this.wasm.processor_motion(this.processor, Number(Boolean(data.reduced)));
            if (data.type === 'calibrate' && !this.wasm.processor_calibrate(this.processor, data.dbSpl)) this.fail('Invalid calibration request.');
        };
    }

    process(inputs) {
        if (this.failed) return false;
        const channels = inputs[0];
        // Before the graph connects there is no input stream yet. Once capture
        // starts, a missing channel is a discontinuity, not measured silence.
        if (!channels?.length) {
            if (this.started) this.fail('The microphone input stopped. Restart listening.');
            return !this.failed;
        }
        const samples = channels[this.channel];
        if (!samples) { this.fail(`Input channel ${this.channel + 1} is unavailable.`); return false; }
        this.started = true;
        for (let offset = 0; offset < samples.length;) {
            const length = Math.min(samples.length - offset, this.input.length);
            for (let i = 0; i < length; i++) this.input[i] = samples[offset + i];
            if (!this.wasm.processor_process(this.processor, length, BigInt(currentFrame + offset))) {
                this.fail(this.analysisError());
                return false;
            }
            offset += length;
        }
        // At most one snapshot waits on the UI. The processor still consumes
        // every sample and every loudness frame while drawing is delayed.
        if (!this.pending && currentFrame - this.lastSent >= sampleRate / 240) {
            this.wasm.processor_snapshot(this.processor);
            const state = this.snapshot.slice();
            const extra = {}, transfer = [state.buffer];
            if (this.diagnostics) {
                const stride = this.wasm.processor_trace_stride(this.processor);
                const trace = new Float64Array(this.wasm.memory.buffer, this.wasm.processor_trace_ptr(this.processor), this.wasm.processor_trace_count(this.processor) * stride).slice();
                extra.traceVersion = this.wasm.processor_trace_version(this.processor);
                extra.trace = trace; extra.traceStride = stride;
                extra.traceDropped = this.wasm.processor_trace_dropped(this.processor);
                extra.audioTime = currentFrame / sampleRate;
                this.wasm.processor_trace_clear(this.processor);
                transfer.push(trace.buffer);
            }
            this.port.postMessage({ type: 'frame', sessionId: this.sessionId, ...extra, state, sones: this.wasm.processor_sones(this.processor), clipped: this.wasm.processor_clipped(this.processor), calibration: this.wasm.processor_calibration_result(this.processor) }, transfer);
            this.pending = true;
            this.lastSent = currentFrame;
        }
        return true;
    }

    analysisError() {
        const detail = this.wasm.processor_error_detail(this.processor);
        return ({
            1: 'Invalid audio block.', 2: `sample ${detail} is not finite`,
            3: `Audio sample clock jumped by ${detail} samples. Restart listening.`,
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
