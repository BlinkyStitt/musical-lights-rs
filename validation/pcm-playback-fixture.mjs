import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../musical-lights-worklet/processor.js', import.meta.url), 'utf8');
export function playbackFixture(pcm, repeat, frame = 0, receive = () => {}, resume = {}) {
  const realm = vm.createContext({ Float32Array, sampleRate: 48000, currentFrame: frame,
    AudioWorkletProcessor: class {}, registerProcessor: () => {} });
  vm.runInContext(code, realm);
  const Player = vm.runInContext('PCMPlayback', realm);
  const processor = new Player({ pcm, repeat, frame, sessionId: 1, ...resume }, { postMessage: data => receive(structuredClone(data)) });
  return {
    render(length) {
      const output = new Float32Array(length);
      processor.render(output);
      return output;
    },
    command(data) { processor.command(data); },
    get frame() { return processor.frame; },
  };
}
