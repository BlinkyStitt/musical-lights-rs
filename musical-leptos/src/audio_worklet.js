class WasmProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        let [module, handle] = options.processorOptions;

        console.log("module:", module);
        console.log("handle:", handle);

        // // TODO: we aren't allowed to do this because they are read-only
        // bindgen.TextDecoder = globalThis.TextDecoder;
        // bindgen.TextEncoder = globalThis.TextEncoder;

        // // TODO: this currently fails because TextDecoder is not available inside an AudioWorklet
        // // TODO: some examples use message passing for the wasm setup
        // bindgen.initSync(module);
        // this.processor = bindgen.WasmAudioProcessor.unpack(handle);
    }
    process(inputs, outputs) {
        // let sum = inputs[0][0].reduce((accumulator, currentValue) => accumulator + currentValue, 0);
        // console.log("sum:", sum);

        return true;

        // return this.processor.process(inputs[0][0]);
    }
}

registerProcessor("WasmProcessor", WasmProcessor);
