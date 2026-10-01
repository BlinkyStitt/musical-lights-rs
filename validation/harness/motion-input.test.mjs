import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsInput } from '../../musical-leptos/src/physics.js';

async function fixture(orientation = () => Promise.resolve('granted')) {
  const window = new EventTarget();
  Object.assign(window, {
    screen: { orientation: { angle: 0 } },
    DeviceMotionEvent: { requestPermission: () => Promise.resolve('granted') },
    DeviceOrientationEvent: { requestPermission: orientation },
  });
  const shakes = [], tilts = [];
  const input = new PhysicsInput({ ownerDocument: { defaultView: window } },
    () => {}, (...v) => tilts.push(v), (...v) => shakes.push(v));
  input.startMotion();
  await new Promise(resolve => setImmediate(resolve));
  const send = (value, timestamp = 0) => {
    const event = Object.assign(new Event('devicemotion'), value);
    Object.defineProperty(event, 'timeStamp', { value: timestamp });
    window.dispatchEvent(event);
  };
  return { window, input, shakes, tilts, send };
}

test('shake permission works while tilt permission is pending, including depth-only readings', async () => {
  let resolve;
  const f = await fixture(() => new Promise(r => { resolve = r; }));
  f.send({ acceleration: { x: null, y: null, z: 8 } });
  assert.deepEqual(f.shakes, [[0, 0, 8, 0]]);
  f.input.close();
  resolve('granted');
  await new Promise(r => setImmediate(r));
  f.window.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta: 20, gamma: 20 }));
  f.send({ acceleration: { x: 8, y: 0, z: 0 } });
  assert.equal(f.shakes.length, 1);
  assert.equal(f.tilts.length, 0);
});

test('linear readings win over gravity and legacy screen orientation is retained', async () => {
  const f = await fixture();
  f.window.screen.orientation = undefined; f.window.orientation = -90;
  f.send({ acceleration: { x: 2, y: -3, z: 4 }, accelerationIncludingGravity: { x: 90, y: 90, z: 90 } });
  assert.deepEqual(f.shakes, [[2, -3, 4, -90]]);
  f.send({ acceleration: { x: NaN, y: null, z: Infinity } });
  assert.equal(f.shakes.length, 1);
  f.input.close();
});

test('gravity fallback ignores rest and resumes without a gravity kick, but responds to shakes', async () => {
  const f = await fixture();
  const send = (x, time) => f.send({ accelerationIncludingGravity: { x, y: 9.81, z: 0 } }, time);
  send(0, 0); send(0, 20); send(0, 40);
  assert.deepEqual(f.shakes, Array.from({ length: 3 }, () => [0, 0, 0, 0]));
  send(6, 60);
  assert.ok(f.shakes.at(-1)[0] > 5 && f.shakes.at(-1)[0] < 6);
  assert.equal(f.shakes.at(-1)[1], 0);
  send(6, 2000);
  assert.deepEqual(f.shakes.at(-1), [0, 0, 0, 0]);
  f.input.stopMotion(); f.input.startMotion();
  await new Promise(r => setImmediate(r));
  send(-9.81, 2020);
  assert.deepEqual(f.shakes.at(-1), [0, 0, 0, 0]);
  f.input.close();
});


test('rotation lock and absent orientation events do not gate motion readings', async () => {
  const f = await fixture(() => Promise.resolve('denied'));
  assert.equal(f.input.state, 'waiting');
  // Portrait remains locked at zero while only accelerometer events arrive.
  f.send({ accelerationIncludingGravity: { x: 0, y: 9.81, z: 0 } }, 0);
  f.send({ accelerationIncludingGravity: { x: -3, y: 9.81, z: 0 } }, 16);
  assert.equal(f.input.state, 'active');
  assert.equal(f.tilts.length, 0);
  assert.ok(f.shakes.at(-1)[0] < -2.8);
  assert.equal(f.shakes.at(-1)[3], 0);
  f.input.stopMotion();
  assert.equal(f.input.state, 'off');
  f.input.close();
});

test('denied permission is observable and can be requested again after a new gesture', async () => {
  const f = await fixture();
  f.input.stopMotion();
  f.window.DeviceMotionEvent.requestPermission = () => Promise.resolve('denied');
  f.input.startMotion();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.input.state, 'denied');
  f.send({ acceleration: { x: 2, y: 0, z: 0 } });
  assert.equal(f.shakes.length, 0);
  f.input.stopMotion();
  f.window.DeviceMotionEvent.requestPermission = () => Promise.resolve('granted');
  f.input.startMotion();
  await new Promise(resolve => setImmediate(resolve));
  f.send({ acceleration: { x: 2, y: 0, z: 0 } });
  assert.equal(f.input.state, 'active');
  f.input.close();
});

for (const motion of ['denied', 'unavailable', 'pending']) {
  test(`tilt-only session remains controllable when acceleration is ${motion}`, async () => {
    const f = await fixture();
    f.input.stopMotion();
    let resolveMotion;
    f.window.DeviceMotionEvent = motion === 'unavailable' ? undefined : {
      requestPermission: () => motion === 'pending' ? new Promise(resolve => { resolveMotion = resolve; }) : Promise.resolve('denied'),
    };
    const statuses = [];
    f.input.onStatus = (state, enabled) => statuses.push({ state, enabled });
    f.input.startMotion();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.input.enabled, true);
    assert.equal(statuses.at(-1).enabled, true);
    f.window.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta: 20, gamma: 30 }));
    assert.equal(f.tilts.length, 1);
    f.input.stopMotion();
    assert.deepEqual(statuses.at(-1), { state: 'off', enabled: false });
    resolveMotion?.('granted');
    await new Promise(resolve => setImmediate(resolve));
    f.window.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta: 60, gamma: 60 }));
    f.send({ acceleration: { x: 8, y: 0, z: 0 } });
    assert.equal(f.tilts.length, 1);
    assert.equal(f.shakes.length, 0);
    assert.equal(f.input.enabled, false);
    f.input.close();
  });
}
