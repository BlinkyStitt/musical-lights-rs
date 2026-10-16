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
  assert.equal(read(null).youtubeLink, 'https://www.youtube.com/watch?v=6d4NOjyd2Ik');
  assert.equal(read({ version: 1, youtubeLink: '' }).youtubeLink, '');
  assert.deepEqual(read({ version: 1, directionOdds: [80, 180, .1, .6, 2], cameraAngle: -20, cameraMotion: false }).directionOdds, [80, 180, .1, .6, 2]);
  assert.equal(read({ version: 1, cameraMotion: false }).cameraMotion, false);
  const removed = read({version:1, mirrorCount:2048, depthMode:'auto', depthFade:.9});
  for (const key of ['mirrorCount','depthMode','depthFade']) assert.equal(removed[key], undefined);
  for (const depth of [.2,.48,2]) assert.equal(read({version:1,physics:[.6,12,16,.6,.4,depth,.02,.7]}).physics[5],depth);
  for (const depth of [.199,2.001,'1',null]) assert.equal(read({version:1,physics:[.6,12,16,.6,.4,depth,.02,.7]}).physics,undefined);
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

test('bar attack glow defaults brighter and restores only bounded numeric preferences', () => {
  const read = attackGlow => readSettings({ getItem() { return JSON.stringify({ version: 1, attackGlow }); } });
  assert.equal(read(undefined).attackGlow, 1);
  for (const value of [0, .8, 1, 2.5, 3]) assert.equal(read(value).attackGlow, value);
  for (const value of [-.05, 3.05, '1', null]) assert.equal(read(value).attackGlow, 1);
});

test('colored attack strength restores independently of the white edge strength', () => {
  const read = colorAttack => readSettings({ getItem() { return JSON.stringify({ version: 1, colorAttack, attackGlow: .8 }); } });
  assert.equal(read(undefined).colorAttack, 1);
  for (const value of [0, .5, 1, 2.5, 3]) assert.equal(read(value).colorAttack, value);
  for (const value of [-.05, 3.05, '1', null]) assert.equal(read(value).colorAttack, 1);
  assert.equal(read(2).attackGlow, .8);
});

test('saved Physics settings retain the complete configuration at 20 and 30 ms rises', () => {
  const read = physics => readSettings({ getItem() { return JSON.stringify({ version: 1, physics }); } });
  for (const rise of [.02, .03, 2]) {
    const physics = [.8, 12, 16, .6, .4, .5, rise, .7];
    assert.deepEqual(read(physics).physics, physics);
  }
  for (const rise of [.019, 2.001, null, '0.02']) {
    assert.equal(read([.8, 12, 16, .6, .4, .5, rise, .7]).physics, undefined);
  }
});

test('physics preferences accept the same Float32 boundaries as the WASM engine', () => {
  const read=physics=>readSettings({getItem:()=>JSON.stringify({version:1,physics})});
  for(const depth of [.2,.48,2]) {
    const physics=Array.from(new Float32Array([.4,12,8,.72,.12,depth,.02,.32]));
    assert.deepEqual(read(physics).physics,physics);
  }
  for(const value of [.3199,4.001]) assert.equal(read([.4,12,8,.72,.12,.48,.02,value]).physics,undefined);
});
