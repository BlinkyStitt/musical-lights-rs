import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionStatus } from '../../musical-leptos/src/physics.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(query) {
  const window = new EventTarget();
  window.document = new EventTarget();
  window.navigator = { permissions: { query } };
  const updates = [];
  const permissions = new PermissionStatus(window, () => updates.push(true));
  return { window, permissions, updates };
}

test('permission queries tolerate absent, rejected and pending APIs without granting access', async () => {
  for (const query of [undefined, () => { throw new TypeError('unsupported'); }, () => new Promise(() => {})]) {
    const { permissions } = fixture(query);
    await flush();
    assert.deepEqual(permissions.states, { microphone: 'unknown', accelerometer: 'unknown', gyroscope: 'unknown' });
    permissions.close();
  }
});

test('late queries cannot overwrite an actual access result or a newer refresh', async () => {
  const pending = [];
  const { window, permissions } = fixture(({ name }) => new Promise(resolve => pending.push({ name, resolve })));
  permissions.set('microphone', 'granted');
  const result = state => Object.assign(new EventTarget(), { state });
  pending[0].resolve(result('prompt'));
  await flush();
  assert.equal(permissions.states.microphone, 'granted');
  window.dispatchEvent(new Event('pageshow'));
  pending[3].resolve(result('denied'));
  pending[1].resolve(result('granted'));
  await flush();
  assert.equal(permissions.states.microphone, 'denied');
  assert.equal(permissions.states.accelerometer, 'unknown');
  permissions.close();
});

test('revocation remains observable after acquisition, and cleanup removes all observers', async () => {
  const states = { microphone: 'prompt', accelerometer: 'prompt', gyroscope: 'prompt' };
  const statuses = [];
  let subscriptions = 0, calls = 0;
  const { window, permissions, updates } = fixture(async ({ name }) => {
    assert.ok(Object.hasOwn(states, name));
    calls++;
    const status = new EventTarget();
    Object.defineProperties(status, { name: { value: name }, state: { get: () => states[name] } });
    const add = status.addEventListener.bind(status), remove = status.removeEventListener.bind(status);
    status.addEventListener = (...args) => { subscriptions++; add(...args); };
    status.removeEventListener = (...args) => { subscriptions--; remove(...args); };
    statuses.push(status);
    return status;
  });
  await flush();
  permissions.set('microphone', 'granted');
  states.microphone = 'denied';
  statuses.find(status => status.name === 'microphone').dispatchEvent(new Event('change'));
  assert.deepEqual(permissions.states, { microphone: 'denied', accelerometer: 'prompt', gyroscope: 'prompt' });
  window.document.hidden = true;
  window.dispatchEvent(new Event('focus'));
  assert.equal(calls, 3);
  window.document.hidden = false;
  window.document.dispatchEvent(new Event('visibilitychange'));
  await flush();
  assert.equal(calls, 6);
  assert.equal(subscriptions, 3);
  permissions.close();
  assert.equal(subscriptions, 0);
  const count = updates.length;
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('pageshow'));
  window.document.dispatchEvent(new Event('visibilitychange'));
  for (const status of statuses) status.dispatchEvent(new Event('change'));
  await flush();
  assert.equal(calls, 6);
  assert.equal(updates.length, count);
});

test('closing during a query cannot install an observer or publish a status', async () => {
  const pending = [];
  const status = Object.assign(new EventTarget(), { state: 'granted' });
  status.addEventListener = () => assert.fail('late subscription');
  const { permissions, updates } = fixture(() => new Promise(done => { pending.push(done); }));
  permissions.close();
  const count = updates.length;
  assert.equal(pending.length, 3);
  for (const resolve of pending) resolve(status);
  await flush();
  assert.equal(updates.length, count);
});
