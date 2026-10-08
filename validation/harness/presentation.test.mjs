import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTube, readSettings, SETTINGS_KEY, validDirectionOdds } from '../../musical-leptos/src/presentation.js';

test('YouTube links select one video and preserve start times without accepting arbitrary origins', () => {
  for (const url of ['https://youtu.be/abcDEF012_-?t=1m23s', 'https://www.youtube.com/watch?v=abcDEF012_-&t=83', 'https://m.youtube.com/shorts/abcDEF012_-?start=83', 'https://www.youtube.com/embed/abcDEF012_-?start=83']) {
    assert.deepEqual(parseYouTube(url), { id: 'abcDEF012_-', start: 83 });
  }
  for (const url of ['javascript:alert(1)', 'https://youtube.com.evil.test/watch?v=abcDEF012_-', 'https://evil.test/abcDEF012_-', 'https://www.youtube.com/playlist?list=123', 'https://user:pass@youtube.com/watch?v=abcDEF012_-']) assert.throws(() => parseYouTube(url));
});
test('stored display settings restore valid preferences without restoring live permissions', () => {
  const read = saved => readSettings({ getItem(key) { assert.equal(key, SETTINGS_KEY); return JSON.stringify(saved); } });
  assert.deepEqual(read({ version: 1, directionOdds: [80, 180, .1, .6, 2], cameraAngle: -20, cameraMotion: false }).directionOdds, [80, 180, .1, .6, 2]);
  assert.equal(read({ version: 1, cameraMotion: false }).cameraMotion, false);
  for (const mirrorCount of [0, 1, 8, 17]) assert.equal(read({ version: 1, mirrorCount }).mirrorCount, mirrorCount);
  for (const mirrorCount of [-1, 18, 1.5, '8']) assert.equal(read({ version: 1, mirrorCount }).mirrorCount, 3);
  assert.deepEqual(read({ version: 1, directionOdds: [200, 60, .5, .05, 1], flight: 99, cameraAngle: '20' }).directionOdds, [60, 200, .05, .5, 1]);
  assert.equal(read({ version: 1, physics: [0.6, -1, 8, .72, .12, .24, .04, .32] }).physics, undefined);
  assert.deepEqual(read({ version: 2, directionOdds: [80, 180, .1, .6, 2] }).directionOdds, [60, 200, .05, .5, 1]);
  assert.equal(read({ version: 1, listening: true, identify: true }).listening, undefined);
  assert.equal(readSettings({ getItem() { throw Error('denied'); } }).flight, 30);
});

test('direction endpoints and curve reject inverted, non-finite and out-of-music-range configurations', () => {
  for (const v of [[60, 200, .05, .5, 1], [80, 180, 0, 1, .25]]) assert(validDirectionOdds(v));
  for (const v of [[59, 200, .05, .5, 1], [60, 201, .05, .5, 1], [60, 60, .05, .5, 1], [60, 200, .6, .5, 1], [60, 200, .05, .5, 0], [60, 200, .05, .5, NaN]]) assert(!validDirectionOdds(v));
});
