// Deterministic percussion for delivery/lifecycle checks. Real-music accuracy
// belongs to the independently labeled Rust fixtures, not this synthetic input.
// Use 100→150 for delivery: the existing estimator interprets the shared period
// of a 120→180 pulse transition as 60 BPM, both before and after this repair.
export function tempoPCM(seconds, bpm, rate = 48000) {
  return Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => {
    const time = i / rate, beat = Math.max(0, 1 - (time % (60 / bpm)) / .06);
    return .04 * beat * (Math.sin(2 * Math.PI * 80 * time) + .5 * Math.sin(2 * Math.PI * 1000 * time));
  });
}

export async function tempoMicrophone(page) {
  await page.addInitScript(`window.tempoPCM = ${tempoPCM.toString()};`);
  await page.addInitScript(() => {
    const Context = window.AudioContext, Node = window.AudioWorkletNode;
    window.tempoCapture = { contexts: [], nodes: [], tracks: [], packets: 0 };
    window.AudioContext = class extends Context {
      constructor(...args) { super(...args); tempoCapture.contexts.push(this); }
    };
    window.AudioWorkletNode = class extends Node {
      constructor(context, name, options) {
        super(context, name, options);
        if (name !== 'loudness-processor') return;
        tempoCapture.nodes.push(this);
        this.port.addEventListener('message', ({ data }) => {
          if (data.type === 'frame') { tempoCapture.last = data; tempoCapture.packets++; }
        });
      }
    };
    MediaDevices.prototype.getUserMedia = async () => {
      const context = tempoCapture.contexts.at(-1);
      const buffer = context.createBuffer(1, 48 * context.sampleRate, context.sampleRate);
      buffer.copyToChannel(tempoPCM(20, 100, context.sampleRate), 0);
      buffer.copyToChannel(tempoPCM(28, 150, context.sampleRate), 0, 20 * context.sampleRate);
      const source = context.createBufferSource(), destination = context.createMediaStreamDestination();
      source.buffer = buffer; source.connect(destination); source.start();
      const track = destination.stream.getAudioTracks()[0];
      Object.defineProperty(track, 'getSettings', { value: () => ({ sampleRate: 48000,
        autoGainControl: false, echoCancellation: false, noiseSuppression: false, deviceId: 'tempo-test-input' }) });
      tempoCapture.tracks.push(track);
      return destination.stream;
    };
  });
}
