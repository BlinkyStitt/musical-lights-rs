import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTube, readSettings, SETTINGS_KEY } from '../../musical-leptos/src/presentation.js';

test('YouTube links select one video and preserve start times without accepting arbitrary origins', () => {
  for (const url of ['https://youtu.be/abcDEF012_-?t=1m23s', 'https://www.youtube.com/watch?v=abcDEF012_-&t=83', 'https://m.youtube.com/shorts/abcDEF012_-?start=83', 'https://www.youtube.com/embed/abcDEF012_-?start=83']) {
    assert.deepEqual(parseYouTube(url), { id: 'abcDEF012_-', start: 83 });
  }
  for (const url of ['javascript:alert(1)', 'https://youtube.com.evil.test/watch?v=abcDEF012_-', 'https://evil.test/abcDEF012_-', 'https://www.youtube.com/playlist?list=123', 'https://user:pass@youtube.com/watch?v=abcDEF012_-']) assert.throws(() => parseYouTube(url));
});
test('stored display settings restore valid preferences without restoring live permissions', () => {
  const read = saved => readSettings({ getItem(key) { assert.equal(key, SETTINGS_KEY); return JSON.stringify(saved); } });
  assert.equal(read({ version: 1, chance: 42, cameraAngle: -20, cameraMotion: false }).chance, 42);
  assert.equal(read({ version: 1, cameraMotion: false }).cameraMotion, false);
  assert.equal(read({ version: 1, chance: -1, flight: 99, cameraAngle: '20' }).chance, 10);
  assert.equal(read({ version: 1, physics: [0.6, -1, 8, .72, .12, .24, .04, .32] }).physics, undefined);
  assert.equal(read({ version: 2, chance: 99 }).chance, 10);
  assert.equal(read({ version: 1, listening: true, identify: true }).listening, undefined);
  assert.equal(readSettings({ getItem() { throw Error('denied'); } }).flight, 30);
});
