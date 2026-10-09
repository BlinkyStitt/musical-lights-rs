import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireInput, releaseInput } from '../../musical-leptos/src/audio_setup.js';

function fixture(t) {
  const install = (name, value) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name]; });
  };
  const inputEvents = [], permissionEvents = [];
  const card = Object.assign(new EventTarget(), { dataset: {}, isConnected: true,
    querySelector: selector => selector === '.input-source' ? { value: 'microphone' } : null });
  card.addEventListener('recognition-input', ({ detail }) => inputEvents.push(detail.stream));
  card.addEventListener('microphone-access', ({ detail }) => permissionEvents.push(detail));
  install('document', { baseURI: 'https://fixture.invalid/', querySelector: selector => selector === '.audio-card' ? card : { content: '/assets/' + 'a'.repeat(24) + '/' } });
  install('location', { href: 'https://fixture.invalid/' });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ version: 'a'.repeat(24) }) }));
  let arrived;
  const requests = [];
  install('navigator', { mediaDevices: { getUserMedia: () => new Promise(resolve => { requests.push(resolve); arrived(); }) } });
  const context = () => Object.assign(new EventTarget(), { state: 'suspended', sampleRate: 48000 });
  const stream = () => {
    const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  // Do not adopt the acquisition promise while waiting for the request to arrive.
  const pending = async ctx => {
    const requested = new Promise(resolve => { arrived = resolve; });
    const result = acquireInput(ctx, 0).then(value => ({ value }), error => ({ error }));
    await requested;
    return { result };
  };
  return { card, inputEvents, permissionEvents, requests, context, stream, pending };
}

test('late superseded microphone cannot replace the newer recognition input', async t => {
  const f = fixture(t), old = f.stream(), current = f.stream();
  const first = await f.pending(f.context());
  const second = await f.pending(f.context());
  f.requests[1](current);
  assert.equal((await second.result).value, current);
  const activeState = { ...f.card.dataset };
  f.requests[0](old);
  const canceled = await first.result;
  assert.match(canceled.error?.message ?? '', /closed/);
  assert.deepEqual(f.inputEvents, [current]);
  assert.deepEqual(f.card.dataset, activeState);
  assert.equal(old.getTracks()[0].readyState, 'ended');
  assert.equal(current.getTracks()[0].readyState, 'live');
  assert.deepEqual(f.permissionEvents, ['requesting', 'requesting', 'granted']);
  releaseInput(current);
});

for (const cancellation of ['context closed', 'route detached']) {
  test(`canceled acquisition stops its late stream without publishing: ${cancellation}`, async t => {
    const f = fixture(t), ctx = f.context(), old = f.stream();
    const request = await f.pending(ctx);
    if (cancellation === 'context closed') ctx.state = 'closed'; else f.card.isConnected = false;
    f.requests[0](old);
    const canceled = await request.result;
    assert.match(canceled.error?.message ?? '', /closed/);
    assert.deepEqual(f.inputEvents, []);
    assert.deepEqual(f.permissionEvents, ['requesting']);
    assert.equal(old.getTracks()[0].readyState, 'ended');
  });
}

test('closing a pending microphone publishes stopped before acquisition resolves', async t => {
  const f = fixture(t), ctx = f.context(), stream = f.stream(), states = [];
  f.card.addEventListener('audio-session', ({ detail }) => states.push(detail.state));
  const request = await f.pending(ctx);
  ctx.state = 'closed'; ctx.dispatchEvent(new Event('statechange'));
  assert.equal(f.card.dataset.audioState, 'stopped');
  assert.deepEqual(states, ['starting', 'stopped']);
  f.requests[0](stream); await request.result;
  assert.deepEqual(states, ['starting', 'stopped']);
  assert.equal(stream.getTracks()[0].readyState, 'ended');
});
