// Browser input blocks can change length or disappear between callbacks.
class MyWasmProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const channels = inputs[0];
        if (!channels || channels.length === 0 || channels[0].length === 0) {
            this.port.postMessage(null);
            return true;
        }
        const mono = new Float32Array(channels[0].length);
        for (const channel of channels) {
            for (let i = 0; i < mono.length; i++) {
                mono[i] += channel[i] / channels.length;
            }
        }
        this.port.postMessage(mono, [mono.buffer]);
        return true;
    }
}
registerProcessor("my-wasm-processor", MyWasmProcessor);
