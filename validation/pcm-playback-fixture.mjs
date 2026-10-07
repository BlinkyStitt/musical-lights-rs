import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../musical-lights-worklet/pcm-playback.js', import.meta.url), 'utf8');
export function playbackFixture(pcm, repeat, frame = 0, receive = () => {}) {
  let Processor;
  const realm = vm.createContext({ Float32Array, sampleRate: 48000, currentFrame: frame,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => receive(structuredClone(data)) }; } },
    registerProcessor: (_name, Type) => { Processor = Type; } });
  vm.runInContext(code, realm);
  const processor = new Processor({ processorOptions: { pcm, repeat } });
  return {
    render(length) {
      const output = new Float32Array(length);
      processor.process([], [[output]]); realm.currentFrame += length;
      return output;
    },
    command(data) { processor.port.onmessage({ data }); },
    get frame() { return realm.currentFrame; },
  };
}
