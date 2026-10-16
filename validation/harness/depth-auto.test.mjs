import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSettings, SETTINGS_KEY } from '../../musical-leptos/src/presentation.js';
import { validAudio, DEFAULT_AUDIO } from '../../musical-leptos/src/audio_controls.js';
test('saved physical depth has one bounded representation without Auto or copy-count settings', () => {
  const read = saved => readSettings({ getItem(key) { assert.equal(key, SETTINGS_KEY); return JSON.stringify(saved); } });
  for (const depth of [.2, .48, 2]) {
    const physics = [.6,12,8,.72,.12,depth,.04,.32];
    const settings = read({ version:1, physics, mirrorCount:2048, depthMode:'auto' });
    assert.deepEqual(settings.physics, physics);
    assert.equal(settings.mirrorCount, undefined); assert.equal(settings.depthMode, undefined);
  }
  for (const depth of [.199,2.001,NaN]) {
    assert.equal(read({version:1,physics:[.6,12,8,.72,.12,depth,.04,.32]}).physics, undefined);
  }
});
test('audio preferences reject invalid controls without changing the model contract', () => {
  assert(validAudio([...DEFAULT_AUDIO]));
  for (let i = 0; i < DEFAULT_AUDIO.length; i++) { const values = [...DEFAULT_AUDIO]; values[i] = NaN; assert(!validAudio(values)); }
  const values = [...DEFAULT_AUDIO]; values[18] = 190; values[19] = 100; assert(!validAudio(values));
});
