import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('real PCM only emits dance cues on new loud attacks and preserves snapshots across chunk sizes', async () => {
  const { instance: { exports: core } } = await WebAssembly.instantiate(await readFile(
    new URL('../../musical-lights-worklet/pkg/loudness.wasm', import.meta.url)));
  const rate = 48000, pcm = new Float32Array(rate * 3);
  for (let i = 0; i < pcm.length; i++) {
    const t = i / rate;
    const amplitude = t >= .3 && t < .55 ? .02 : t >= 1.1 && t < 1.35 ? .005 : t >= 2 && t < 2.25 ? .05 : 0;
    pcm[i] = amplitude * Math.sin(2 * Math.PI * 1000 * t);
  }
  function process(chunk) {
    const handle = core.processor_create(0, 0, 0), checkpoints = [];
    try {
      for (let i = 0; i < pcm.length; i += chunk) {
        const count = Math.min(chunk, pcm.length - i);
        new Float32Array(core.memory.buffer, core.processor_input(handle), count).set(pcm.subarray(i, i + count));
        assert.equal(core.processor_process(handle, count, BigInt(i)), 1);
        if ([rate, rate * 2, rate * 3].includes(i + count)) checkpoints.push(core.processor_accent_sequence(handle));
      }
      return { checkpoints, sones: core.processor_sones(handle),
        snapshot: Array.from(new Float64Array(core.memory.buffer, core.processor_snapshot(handle), core.processor_snapshot_length(handle))) };
    } finally { core.processor_destroy(handle); }
  }
  const small = process(96), large = process(480);
  assert(small.checkpoints[0] > 0, 'The first loud attack must reach the motion policy');
  assert.equal(small.checkpoints[1], small.checkpoints[0], 'The quieter attack must not draw');
  assert(small.checkpoints[2] > small.checkpoints[1], 'The louder attack must draw');
  assert.deepEqual(large, small, 'Raw loudness, filtered targets, and cue ordinals depend on PCM, not callback size');
});
