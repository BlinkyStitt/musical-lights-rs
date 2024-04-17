// TODO: this worked for wasm-audio-worklet. why doesn't it work for me?

registerProcessor("WasmProcessor", class WasmProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        console.log("WasmProcessor options:", options);

        // "memory" here is empty and so initSync failed with "cannot clone memory". at least i think something like that is happening
        let [module, handle] = options.processorOptions;
        bindgen.initSync(module);
        this.processor = bindgen.WasmAudioProcessor.unpack(handle);
    }
    process(inputs, outputs) {
        // TODO: do we want to sum the inputs or the outputs?
        let sum = outputs[0][0].reduce((accumulator, currentValue) => accumulator + currentValue, 0);
        console.log("sum:", sum);

        return this.processor.process(outputs[0][0]);
    }
});
