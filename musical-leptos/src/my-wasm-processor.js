
class MyWasmProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        console.log("options.processorOptions:", options.processorOptions);

        let [module, foobar] = options.processorOptions;

        // Fetch, compile, and instantiate the WebAssembly module
        WebAssembly.instantiateStreaming(module)
            .then(results => {
                // `results` is an object with both the module and its instance
                console.log('WebAssembly module instantiated successfully');

                // Exported functions can now be called
                const exports = results.instance.exports;
                // const result = exports.yourExportedFunction();
                // console.log('Result from your function:', result);

                console.log("exports:", exports);
            })
            .catch(error => {
                console.error('Error instantiating WebAssembly module:', error);
            });
    }
    process(inputs, outputs, parameters) {
        // TODO: send it over a channel to a regular worker? i'm stumped and just want it working even if it isn't real time

        // TODO: this seems to be ignored
        return true;

        // return this.processor.process(inputs[0][0]);
    }
}

registerProcessor("my-wasm-processor", MyWasmProcessor);
