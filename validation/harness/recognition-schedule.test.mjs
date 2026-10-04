import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SongRecognition, RecognitionCooldown, SongHistory } from '../../musical-leptos/src/recognition.js';

function fixture(t, { status = 200, result = { artist: 'Known artist', title: 'Known song' } } = {}) {
  let now = 0, serial = 0;
  const timers = new Map(), uploads = [], captures = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { const id = ++serial; timers.set(id, { at: now + delay, callback }); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
  globalThis.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor(stream, { mimeType }) { this.mimeType = mimeType; this.state = 'inactive'; }
    start() { this.state = 'recording'; captures.push(now); }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['clip']) }); this.onstop?.(); }
  };
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'MediaRecorder', previous); else delete globalThis.MediaRecorder; });
  t.mock.method(globalThis, 'fetch', async () => { uploads.push(now); return { ok: status === 200, status, json: async () => ({ result }) }; });
  const disk = new Map(), storage = { getItem: key => disk.get(key), setItem: (key, value) => disk.set(key, value), length: 0 };
  const control = Object.assign(Object.create(SongRecognition.prototype), {
    enabled: true, playing: true, input: { stream: {} }, closed: false, job: null,
    button: {}, status: { textContent: '', dataset: {} },
    ring: { dataset: {}, style: { setProperty() {} }, setAttribute() {} }, progress: {},
    cooldown: new RecognitionCooldown(storage), history: new SongHistory(storage),
    endpoint: () => 'https://fixture.invalid/recognize', renderHistory() {}, showSong() {},
  });
  const advance = async duration => {
    const end = now + duration;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].callback();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    }
    now = end;
  };
  t.after(() => control.cancel());
  return { control, captures, uploads, advance, timers };
}

test('enabled detection uploads once per minute and switching off cancels all future work', async t => {
  const f = fixture(t); f.control.schedule();
  await f.advance(130_000);
  assert.deepEqual(f.captures, [0, 60_000, 120_000]);
  assert.deepEqual(f.uploads, [10_000, 70_000, 130_000]);
  assert.equal(f.control.history.read().length, 3);
  assert.equal(f.control.button.checked, true); assert.equal(f.control.button.disabled, false);
  f.control.cancel(); await f.advance(180_000);
  assert.equal(f.uploads.length, 3); assert.equal(f.timers.size, 0); assert.equal(f.control.button.checked, false);
});
test('canceling a recording spends no request; an unavailable mic cannot schedule capture', async t => {
  const f = fixture(t); f.control.schedule(); await f.advance(5000);
  f.control.cancel(); await f.advance(120_000);
  assert.deepEqual(f.uploads, []);
  f.control.enabled = true; f.control.playing = false; f.control.schedule(); await f.advance(120_000);
  assert.deepEqual(f.captures, [0]);
});
test('no match continues periodically, but provider failures turn detection off without retrying', async t => {
  const f = fixture(t, { result: null }); f.control.schedule(); await f.advance(70_000);
  assert.deepEqual(f.uploads, [10_000, 70_000]); assert.equal(f.control.history.read().length, 0);
});
for (const status of [429, 502, 503]) {
  test(`HTTP ${status} turns detection off after one attempt`, async t => {
    const f = fixture(t, { status }); f.control.schedule(); await f.advance(180_000);
    assert.deepEqual(f.uploads, [10_000]); assert.equal(f.control.button.checked, false);
    assert.match(f.control.status.textContent, /turned off/); assert.equal(f.timers.size, 0);
  });
}
