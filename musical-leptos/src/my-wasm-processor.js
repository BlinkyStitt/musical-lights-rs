// Browser input blocks can change length or disappear between callbacks.
class MyWasmProcessor extends AudioWorkletProcessor {
    process(inputs, outputs) {
        const channels = inputs[0]?.[0]?.length ? inputs[0] : [];
        const frames = channels[0]?.length || outputs[0]?.[0]?.length || 0;
        if (frames === 0) return true;
        const mono = new Float32Array(frames);
        for (let i = 0; i < frames && channels.length > 0; i++) {
            // Accumulate in JS's f64 number, then round once to float PCM.
            // Finite input above nominal full scale remains valid.
            let sum = 0;
            for (const channel of channels) sum += channel[i];
            mono[i] = sum / channels.length;
        }
        // No input means a silent render quantum, which still advances the
        // filter and envelope state. Outputs remain silent to avoid feedback.
        this.port.postMessage(mono, [mono.buffer]);
        return true;
    }
}
registerProcessor("my-wasm-processor", MyWasmProcessor);
