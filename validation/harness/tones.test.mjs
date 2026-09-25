import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tonePCM } from '../../musical-leptos/src/tones.js';

test('exercise preserves its pattern and scales to the selected Float32 peak', () => {
  const unit = tonePCM('exercise', 1000, 1);
  for (const db of [-90, -60, -34, -12]) {
    const amplitude = 10 ** (db / 20), pcm = tonePCM('exercise', 1000, amplitude);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      assert(Math.abs(pcm[i] - unit[i] * amplitude) <= amplitude * 6e-8);
      peak = Math.max(peak, Math.abs(pcm[i]));
    }
    assert(Math.abs(peak - amplitude) <= amplitude * 6e-8, `${db}: peak ${peak}`);
    assert(peak < 1);
  }
});
