import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Presentation, parseYouTube, readSettings, SETTINGS_KEY, validDirectionOdds } from '../../musical-leptos/src/presentation.js';
import { localPoint, placeDialog, viewportBounds } from '../../musical-leptos/src/screen.js';

test('switch help responds to touch, hover and keyboard without activating the action, and releases listeners', () => {
  const anchor = Object.assign(new EventTarget(), { dataset: {}, setAttribute() {} });
  const shown = [];
  const presentation = Object.assign(Object.create(Presentation.prototype), {
    removers: [], showHelp: (node, key) => shown.push({ node, key }), hideHelp: () => shown.push('hidden'),
  });
  presentation.mountHelp(anchor, 'listening-toggle');
  const send = (type, fields = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), fields);
    anchor.dispatchEvent(event);
    return event;
  };
  send('pointerenter', { pointerType: 'touch' });
  assert.equal(shown.length, 0, 'a touch hover must wait for the tap');
  send('pointerenter', { pointerType: 'mouse' });
  send('focus');
  assert.equal(send('click').defaultPrevented, true);
  for (const key of ['Enter', ' ']) assert.equal(send('keydown', { key }).defaultPrevented, true);
  assert.deepEqual(shown, Array.from({ length: 5 }, () => ({ node: anchor, key: 'listening-toggle' })));
  assert.equal(send('keydown', { key: 'Tab' }).defaultPrevented, false);
  send('blur');
  assert.equal(shown.at(-1), 'hidden');
  for (const remove of presentation.removers) remove();
  send('click'); send('focus'); send('keydown', { key: 'Enter' });
  assert.equal(shown.length, 6, 'removed toolbar help cannot respond after route cleanup');
});

test('compact toolbar help preserves native toggle gestures and releases listeners', () => {
  let toolbar = true;
  const input = Object.assign(new EventTarget(), { closest: () => toolbar ? {} : null });
  const shown = [];
  const presentation = Object.assign(Object.create(Presentation.prototype), {
    removers: [], showHelp(node, key) { this.anchor = node; shown.push(key); }, hideHelp() { this.anchor = null; shown.push('hidden'); },
  });
  presentation.mountToolbarHelp(input, 'motion-button');
  const send = (type, fields = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), fields);
    input.dispatchEvent(event); return event;
  };
  send('pointerenter', { pointerType: 'touch' });
  assert.deepEqual(shown, []);
  send('focus'); send('pointerenter', { pointerType: 'mouse' });
  assert.deepEqual(shown, ['motion-button', 'motion-button']);
  assert.equal(send('click').defaultPrevented, false);
  assert.equal(send('keydown', { key: ' ' }).defaultPrevented, false);
  send('blur'); assert.equal(shown.at(-1), 'hidden');
  toolbar = false; send('focus'); send('pointerenter', { pointerType: 'mouse' });
  assert.equal(shown.length, 3, 'Settings retains its separate text help');
  for (const remove of presentation.removers) remove();
  toolbar = true; send('focus'); send('pointerenter', { pointerType: 'mouse' });
  assert.equal(shown.length, 3);
});

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


test('inverse pointer mapping and top-layer placement agree in all four display turns', () => {
  for (let turn = 0; turn < 4; turn++) {
    const width = turn % 2 ? 800 : 400, height = turn % 2 ? 400 : 800;
    const card = { displayQuarterTurn: turn, hasAttribute: () => true, clientWidth: width, clientHeight: height,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 800 }) };
    for (const [x, y] of [[0, 0], [width * .2, height * .7], [width, height]]) {
      const [px, py] = [[x, y], [height - y, x], [width - x, height - y], [y, width - x]][turn];
      const point = localPoint(card, px, py);
      assert.ok(Math.abs(point.x - x) < 1e-9);
      assert.ok(Math.abs(point.y - y) < 1e-9);
    }
    const dialog = { style: {} };
    placeDialog(card, dialog, { left: 8, top: 8, width: width - 16, height: height / 2 - 8 });
    assert.equal(dialog.style.transform, turn ? `rotate(${turn * 90}deg)` : 'none');
    const origin = localPoint(card, parseFloat(dialog.style.left), parseFloat(dialog.style.top));
    assert.ok(Math.abs(origin.x - 8) < 1e-9 && Math.abs(origin.y - 8) < 1e-9);
    const visible = viewportBounds(card, { offsetLeft: 0, offsetTop: 0, width: 400, height: 500 });
    assert.ok(visible.left >= 0 && visible.top >= 0 && visible.right <= width && visible.bottom <= height);
  }
});

test('camera preferences tolerate legacy, malformed and unavailable storage independently', () => {
  const read = saved => readSettings({ getItem: () => JSON.stringify(saved) });
  const defaults = { cameraAngle: 0, cameraZoom: 100, cameraX: 50, cameraY: 50 };
  for (const settings of [read({ version: 1 }), read({ version: 2, cameraZoom: 25 }), readSettings(), readSettings({ getItem: () => '{' })]) {
    for (const [id, value] of Object.entries(defaults)) assert.equal(settings[id], value);
  }
  for (const [id, min, max] of [['cameraAngle', -40, 40], ['cameraZoom', 25, 200], ['cameraX', 0, 100], ['cameraY', 0, 100]]) {
    for (const value of [min, max, (min + max) / 2]) assert.equal(read({ version: 1, [id]: value })[id], value);
    for (const value of [min - 1, max + 1, null, '50']) assert.equal(read({ version: 1, [id]: value })[id], defaults[id]);
  }
  const mixed = read({ version: 1, cameraAngle: 17, cameraZoom: 24, cameraX: 12.345, cameraY: 90 });
  assert.equal(mixed.cameraAngle, 17); assert.equal(mixed.cameraZoom, 100);
  assert.equal(mixed.cameraX, 12.345); assert.equal(mixed.cameraY, 90);
});

test('ball preferences migrate independently and reject malformed diameter intervals', () => {
  const read = saved => readSettings({ getItem: () => JSON.stringify(saved) });
  const physics = [.6, 12, 16, .6, .4, .5, .04, .7];
  const migrated = read({ version: 1, physics, cameraAngle: 12, cameraZoom: 135, cameraX: 20, cameraY: 80 });
  assert.deepEqual(migrated.balls, [8, 2.64, 19.2]);
  assert.deepEqual(migrated.physics, physics); assert.equal(migrated.cameraAngle, 12);
  assert.deepEqual([migrated.cameraZoom, migrated.cameraX, migrated.cameraY], [135, 20, 80]);
  for (const balls of [[0, 2.64, 19.2], [16, 19.2, 19.2], [1, 2.64, 2.64]])
    assert.deepEqual(read({ version: 1, balls, cameraZoom: 135 }).balls, balls);
  for (const balls of [[17, 2.64, 19.2], [1.5, 2.64, 19.2], [8, 10, 9], [8, 2.63, 19.2], [8, 2.64, 19.21], [8, null, 19.2]])
    assert.deepEqual(read({ version: 1, balls }).balls, [8, 2.64, 19.2]);
});

test('saved sones gate recovers independently from each gain field and other preferences', async () => {
  const { recoverVisual, validVisual } = await import('../../musical-leptos/src/audio_controls.js');
  for (const floor of [undefined, null, -60, 0, '0.1', NaN, Infinity]) {
    const saved = [1, floor, 3, 2];
    assert.deepEqual(recoverVisual(saved), { values: [0, .1, 3, 2], gateReset: true });
    const restored = readSettings({ getItem: () => JSON.stringify({ version: 1, visual: saved, youtubeLink: '', cameraAngle: 17 }) });
    assert.deepEqual(restored.visual, [0, .1, 3, 2]); assert.equal(restored.gateReset, true);
    assert.equal(restored.youtubeLink, ''); assert.equal(restored.cameraAngle, 17);
    assert(!validVisual(saved));
  }
  for (const floor of [Number.MIN_VALUE, .00001, Number.MAX_VALUE]) {
    assert(validVisual([1, floor, 0, 64]));
    assert.deepEqual(recoverVisual([1, floor, 99, 2]), { values: [1, floor, 1, 2], gateReset: false });
    assert.deepEqual(recoverVisual([1, floor, 3, -1]), { values: [1, floor, 3, 1], gateReset: false });
  }
  assert.deepEqual(recoverVisual([9, .1, 0, 2]).values, [0, .1, 0, 2]);
});
