class MyWasmProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        this.wasmInstance = null;

        // console.log("options.processorOptions:", options.processorOptions);

        let [module, foobar] = options.processorOptions;

        // // TODO: this is wrong. i think we need a dedicated wasm module for the processor
        // WebAssembly.instantiate(module)
        //     .then(obj => {
        //         this.wasmInstance = obj.instance;
        //         console.log('WASM loaded in worklet');
        //     })
        //     .catch(err => console.error('Error instantiating WASM module in worklet:', err));
    }

    process(inputs, outputs, parameters) {
        if (this.wasmInstance) {
            // TODO: Call your WASM functions here to process audio. Then send it over this.port.postMessage()
        } else {
            // TODO: don't post here. we want to do this in a dedicated wasm instance instead
            this.port.postMessage(inputs[0][0]);
        }

        // browsers all handle this differently
        // chrome, return true or it stops immediatly
        // firefox, return true or it stops when there is no more input
        // false SHOULD be fine, but no...
        return true;
    }
}

registerProcessor("my-wasm-processor", MyWasmProcessor);
