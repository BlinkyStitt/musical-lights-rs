// Observe the actual input to the release processor without replacing its
// analysis. The bounded prefix diagnoses decoded-file versus render-graph PCM.
import { flashTrace } from './partial/flash-fixtures.mjs';

// WebKit's audio render thread flushes f32 subnormals to zero. Run the same
// independent, decoded-PCM oracle there as well as in Node, without rounding or
// normalizing either trace. This runs after live collection, not during FPS checks.
export async function workletPCMTrace(page, pcm, firstSample) {
  const source = `
    const assert = { equal(actual, expected) {
      if (!Object.is(actual, expected)) throw new Error('PCM oracle assertion: ' + actual + ' != ' + expected);
    } };
    ${flashTrace.toString()}
    class PCMReference extends AudioWorkletProcessor {
      constructor({ processorOptions }) { super(); this.options = processorOptions; }
      process() {
        try {
          const { module, pcm, firstSample } = this.options;
          const rows = flashTrace(module, pcm, false, { firstSample });
          this.port.postMessage({ rows: rows.map(row => Array.from(row)) });
        } catch (error) { this.port.postMessage({ error: error.message }); }
        return false;
      }
    }
    registerProcessor('pcm-reference', PCMReference);
  `;
  return page.evaluate(async ({ source, pcm, firstSample }) => {
    await document.querySelector('.audio-card').activeAudioContext.suspend();
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const response = await fetch(base + 'loudness/loudness.wasm');
    if (!response.ok) throw new Error('Cannot load PCM oracle WASM: ' + response.status);
    const module = await WebAssembly.compile(await response.arrayBuffer());
    const context = new AudioContext({ sampleRate: 48000 });
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      await context.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(context, 'pcm-reference', {
        processorOptions: { module, pcm: Float32Array.from(pcm), firstSample },
      });
      const result = new Promise((resolve, reject) => {
        node.port.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.rows);
        node.onprocessorerror = () => reject(new Error('PCM oracle processor failed'));
      });
      node.connect(context.destination);
      await context.resume();
      return await result;
    } finally { URL.revokeObjectURL(url); await context.close(); }
  }, { source, pcm, firstSample });
}

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
