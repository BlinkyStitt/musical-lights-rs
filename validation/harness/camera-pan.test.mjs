import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraPan } from '../../musical-leptos/src/physics/camera-pan.js';
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
