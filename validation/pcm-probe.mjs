// Observe the actual input to the release processor without replacing its
// analysis. The bounded prefix diagnoses decoded-file versus render-graph PCM.
export async function observePCM(page, source) {
  const registration = "registerProcessor('loudness-processor', LoudnessProcessor);";
  if (!source.includes(registration)) throw Error('Release processor registration changed');
  const observed = source.replace(registration, `
    class ObservedProcessor extends LoudnessProcessor {
      constructor(options) {
        super(options);
        this.observedInput = new Float32Array(24576);
        this.observedLength = 0;
        const post = this.port.postMessage.bind(this.port);
        this.port.postMessage = (message, transfer) => {
          if (message.type === 'frame' && this.observedLength === this.observedInput.length && !this.observationSent) {
            message.observedPCM = this.observedInput;
            transfer.push(this.observedInput.buffer);
            this.observationSent = true;
          }
          post(message, transfer);
        };
      }
      process(inputs) {
        const samples = inputs[0]?.[this.channel];
        if (samples && !this.observationSent && this.observedLength < this.observedInput.length) {
          const n = Math.min(samples.length, this.observedInput.length - this.observedLength);
          this.observedInput.set(samples.subarray(0, n), this.observedLength);
          this.observedLength += n;
        }
        return super.process(inputs);
      }
    }
    registerProcessor('loudness-processor', ObservedProcessor);
  `);
  await page.addInitScript(observed => {
    const add = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = async function(url, options) {
      if (!new URL(url, document.baseURI).pathname.endsWith('/loudness/processor.js')) return add.call(this, url, options);
      const blob = URL.createObjectURL(new Blob([observed], { type: 'text/javascript' }));
      try { return await add.call(this, blob, options); }
      finally { URL.revokeObjectURL(blob); }
    };
  }, observed);
}
