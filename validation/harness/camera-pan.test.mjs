import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraPan, CameraParameters, CAMERA_PARAMETERS, CAMERA_DEFAULTS } from '../../musical-leptos/src/physics/camera-pan.js';
const key = (key, rest = {}) => ({ key, ...rest });
test('WASD moves only within the main box and has frame-independent speed', () => {
  const a = new CameraPan(), b = new CameraPan();
  assert(a.press(key('d'))); assert(b.press(key('D')));
  for (let i = 0; i < 100; i++) a.step(.01);
  b.step(1);
  assert(Math.abs(a.x - b.x) < 1e-12); assert(Math.abs(a.x - .85) < 1e-12);
  for (let i = 0; i < 100; i++) a.step(.1);
  assert.equal(a.x, 1); a.press(key('w'));
  for (let i = 0; i < 100; i++) a.step(.1);
  assert.equal(a.y, 1); a.clear(); a.press(key('a')); a.press(key('s'));
  for (let i = 0; i < 100; i++) a.step(.1);
  assert.equal(a.x, 0); assert.equal(a.y, 0);
  a.reset(); assert.equal(a.x, .5); assert.equal(a.y, .5); assert.equal(a.keys.size, 0);
});
test('opposite keys cancel, diagonal speed stays bounded and interrupted input clears', () => {
  const pan = new CameraPan(); pan.press(key('w')); pan.press(key('s'));
  assert.equal(pan.step(.1), false); pan.release(key('s')); pan.press(key('d')); pan.step(.1);
  assert(Math.abs(Math.hypot(pan.x - .5, pan.y - .5) - .035) < 1e-12);
  const x = pan.x; pan.clear(); assert.equal(pan.step(.1), false); assert.equal(pan.x, x);
  pan.press(key('a')); pan.step(5); assert.equal(pan.x, 0);
  assert.equal(pan.step(NaN), false); assert.equal(pan.step(-1), false);
});
test('typing, composition, modifiers and browser shortcuts do not move the camera', () => {
  const pan = new CameraPan();
  for (const props of [{altKey:true},{ctrlKey:true},{metaKey:true},{shiftKey:true},{isComposing:true},{defaultPrevented:true}, {target:{closest:()=>true}}]) {
    assert.equal(pan.press(key('w', props)), false);
  }
  assert.equal(pan.press(key('ArrowUp')), false); assert.equal(pan.keys.size, 0);
});

test('shared camera parameters reject invalid values and keep effective overrides separate', () => {
  const camera = new CameraParameters({ cameraZoom: 25, cameraX: 0, cameraY: 100, cameraAngle: -40 });
  for (const p of Object.values(CAMERA_PARAMETERS)) {
    assert(camera.set(p.id, p.min)); assert(camera.set(p.id, p.max));
    for (const invalid of [NaN, Infinity, -Infinity, null, '50', p.min - .001, p.max + .001]) {
      assert.equal(camera.set(p.id, invalid), false); assert.equal(camera.get(p.id), p.max);
    }
    assert.equal(camera.effective(p.id, p.min), p.min);
    assert.equal(camera.get(p.id), p.max);
    assert.equal(camera.effective(p.id, NaN), p.max);
  }
  assert.equal(camera.set('__proto__', 1), false);
  assert.equal(camera.set('unknown', 1), false);
  camera.reset(); assert.deepEqual(camera.values, CAMERA_DEFAULTS);
  const pan = new CameraPan(camera); pan.press(key('d')); pan.step(.5);
  assert.equal(camera.get('cameraX'), 67.5);
  camera.set('cameraY', 25); assert.equal(pan.y, .25);
  pan.reset(); assert.equal(camera.get('cameraX'), 50); assert.equal(camera.get('cameraY'), 50);
});
test('keyboard completion and interruptions flush once movement has stopped', () => {
  const pan = new CameraPan(); let stops = 0; pan.onStop = () => stops++;
  pan.press(key('w')); pan.press(key('d')); pan.step(.2);
  assert.equal(stops, 0); pan.release(key('w')); assert.equal(stops, 0);
  pan.release(key('d')); assert.equal(stops, 1);
  pan.press(key('a')); pan.clear(); assert.equal(stops, 2); assert.equal(pan.keys.size, 0);
});
