import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireInput, releaseInput } from '../../musical-leptos/src/audio_setup.js';

// Load the production modules through the same runtime asset URLs as the app.
// Only the generated build metadata and browser/audio dependencies are fixtures.
let assets;
before(async () => {
  assets = await mkdtemp(join(tmpdir(), 'musical-review-transport-'));
  await mkdir(join(assets, 'physics'));
  await copyFile(new URL('../../musical-leptos/src/tones.js', import.meta.url), join(assets, 'physics/tones.js'));
  await copyFile(new URL('../../musical-leptos/src/physics/review.js', import.meta.url), join(assets, 'physics/review.js'));
  await writeFile(join(assets, 'physics/build.js'), 'export const build = {};\n');
});
after(async () => { await rm(assets, { recursive: true, force: true }); });

function fixture(t, { kind = 'music', frequency = '1000', level = '-34', repeat = true } = {}) {
  const controls = Object.fromEntries(Object.entries({
    '.input-source': { value: kind }, '.tone-kind': { value: 'exercise' },
    '.tone-frequency': { value: frequency }, '.tone-level': { value: level },
    '.tone-repeat': { checked: repeat }, '.tone-audible': { checked: false },
    '.tone-pause': {}, '.review-replay': {}, '.tone-status': {},
  }).map(([key, values]) => [key, Object.assign(new EventTarget(), values)]));
  const card = Object.assign(new EventTarget(), { dataset: {}, isConnected: true,
    querySelector: selector => controls[selector] });
  const pcm = Float32Array.from({ length: 288000 }, (_, i) => i % 2 ? -.125 : .125);
  const decoded = { numberOfChannels: 1, length: pcm.length, sampleRate: 48000, getChannelData: () => pcm };
  let decodes = 0, microphoneRequests = 0;
  card.review = { decode: async () => { decodes++; return { buffer: decoded, identity: { name: 'Six second clip' } }; } };
  const baseURI = pathToFileURL(assets + '/').href;
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({}) }));
  const global = (key, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  };
  global('document', { baseURI, querySelector: selector => selector === '.audio-card' ? card : { content: baseURI } });
  global('navigator', { mediaDevices: { getUserMedia: () => { microphoneRequests++; assert.fail('Digital sources must not request a microphone'); } } });
  const timers = new Set();
  t.mock.method(globalThis, 'setInterval', callback => { timers.add(callback); return callback; });
  t.mock.method(globalThis, 'clearInterval', callback => timers.delete(callback));
  const node = () => ({ gain: { value: 1 }, offset: { value: 0 }, playbackRate: { value: 1 }, connect() {}, disconnect() {}, start() {}, stop() {} });
  const stream = {}, sources = [];
  const context = Object.assign(new EventTarget(), {
    currentTime: 10, sampleRate: 48000, state: 'running', baseLatency: 0, outputLatency: .2,
    destination: node(), createGain: node, createConstantSource: node,
    createMediaStreamDestination: () => ({ ...node(), stream }),
    createBuffer: (channels, length, rate) => ({ duration: length / rate, copyToChannel: data => assert.deepEqual(data, pcm) }),
    createBufferSource: () => { const source = node(); sources.push(source); return source; },
  });
  let playback;
  card.addEventListener('review-playback', ({ detail }) => { playback = detail; });
  t.after(() => { releaseInput(stream); assert.equal(timers.size, 0); });
  return { context, card, sources, controls, decodes: () => decodes, microphoneRequests: () => microphoneRequests,
    click: selector => controls[selector].dispatchEvent(new Event('click')),
    read: time => { context.currentTime = time; for (const timer of timers) timer(); return playback; } };
}

for (const kind of ['music', 'trumpet', 'local']) {
  test(`${kind} ignores empty and invalid generated-tone parameters and preserves decoded PCM`, async t => {
    for (const [frequency, level] of [['', ''], ['NaN', 'NaN'], ['19', '0']]) {
      const f = fixture(t, { kind, frequency, level });
      const stream = await acquireInput(f.context, 0);
      assert.equal(f.decodes(), 1); assert.equal(f.microphoneRequests(), 0);
      assert.equal(f.read(10).state, 'playing');
      releaseInput(stream);
    }
  });
}

test('generated input rejects invalid frequency and level before creating a source', async t => {
  for (const [frequency, level] of [['', '-34'], ['1000', ''], ['NaN', '-34'], ['1000', 'NaN'], ['19', '-34'], ['1000', '0']]) {
    const f = fixture(t, { kind: 'generated', frequency, level });
    await assert.rejects(acquireInput(f.context, 0), /Choose a level/);
    assert.equal(f.decodes(), 0); assert.equal(f.sources.length, 0);
    assert.equal(f.card.dataset.audioState, 'stopped');
  }
});

function position(result, processing, output, state = 'playing') {
  assert.ok(Math.abs(result.processingSeconds - processing) < 1e-10, JSON.stringify(result));
  assert.ok(Math.abs(result.outputSeconds - output) < 1e-10, JSON.stringify(result));
  assert.equal(result.state, state);
}

test('output clock crosses repeat boundaries after the audible iteration finishes', async t => {
  const f = fixture(t); await acquireInput(f.context, 0);
  position(f.read(10), 0, 0);
  position(f.read(16.1), .1, 5.9);
  position(f.read(16.3), .3, .1);
  position(f.read(22.1), .1, 5.9);
  assert.equal(f.read(22.3).method, 'estimated-latency');
  f.context.getOutputTimestamp = () => ({ contextTime: 21.9, performanceTime: performance.now() });
  const result = f.read(22.1);
  assert.ok(Math.abs(result.outputSeconds - 5.9) < .001);
  assert.equal(result.method, 'output-timestamp');
  delete f.context.getOutputTimestamp; delete f.context.baseLatency; delete f.context.outputLatency;
  const unverified = f.read(22.3); position(unverified, .3, .3);
  assert.equal(unverified.confidence, 'unverified');
});

test('natural end allows output to drain to the endpoint without sticking at duration minus latency', async t => {
  const f = fixture(t, { repeat: false }); await acquireInput(f.context, 0);
  f.context.currentTime = 16; f.sources[0].onended();
  position(f.read(16.1), 6, 5.9, 'ended');
  position(f.read(16.3), 6, 6, 'ended');
  position(f.read(20), 6, 6, 'ended');
  f.click('.tone-pause'); // Replay after completion.
  position(f.read(20.1), .1, 6);
  position(f.read(20.3), .3, .1);
});

test('output follows the preceding timeline segment during pause, resume, replay and repeat changes', async t => {
  const f = fixture(t); await acquireInput(f.context, 0);
  f.context.currentTime = 12; f.click('.tone-pause');
  position(f.read(12.1), 2, 1.9, 'paused');
  position(f.read(13), 2, 2, 'paused');
  f.click('.tone-pause');
  position(f.read(13.1), 2.1, 2);
  position(f.read(13.3), 2.3, 2.1);
  f.context.currentTime = 17.1; // Processing has wrapped; output is in the preceding iteration.
  f.controls['.tone-repeat'].checked = false;
  f.controls['.tone-repeat'].dispatchEvent(new Event('change'));
  position(f.read(17.1), .1, 5.9);
  position(f.read(17.3), .3, .1);
  f.context.currentTime = 18; f.click('.review-replay');
  position(f.read(18.1), .1, .9);
  position(f.read(18.3), .3, .1);
});
