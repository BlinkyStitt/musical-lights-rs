import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { endpoint, runLiveRecognition } from '../recognition-live.mjs';

const audio = Buffer.from([1, 2, 3]);
const song = { artist: 'Known artist', title: 'Known song' };
const options = { live: true, file: 'clip.wav', ...song };
function fixture(reply = { result: song }, status = 200) {
  const calls = [];
  return { calls, dependencies: { load: async () => audio, request: async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify(reply), { status });
  } } };
}

test('live smoke is off by default, before file access or network; CLI fails closed', async () => {
  const forbidden = async () => { assert.fail('must not access files or network'); };
  for (const live of [undefined, false, 'true']) {
    await assert.rejects(runLiveRecognition({ ...options, live }, { load: forbidden, request: forbidden }), /Live recognition is off/);
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../recognition-live.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /Live recognition is off/);
});

test('missing expectation, unsupported formats and invalid clip sizes spend no lookup', async () => {
  const f = fixture();
  for (const invalid of [{ artist: '' }, { title: ' ' }, { artist: 'x'.repeat(1001) }, { file: 'clip.mp3' }]) {
    await assert.rejects(runLiveRecognition({ ...options, ...invalid }, f.dependencies));
  }
  for (const length of [0, 512 * 1024 + 1]) {
    await assert.rejects(runLiveRecognition(options, { ...f.dependencies, load: async () => Buffer.alloc(length) }), /Clip must/);
  }
  assert.equal(f.calls.length, 0);
});

test('exact known match passes with one Worker POST, unchanged audio and auditable evidence', async () => {
  const f = fixture();
  const report = await runLiveRecognition(options, f.dependencies);
  assert.equal(report.status, 'passed'); assert.equal(report.workerRequests, 1);
  assert.equal(report.httpStatus, 200); assert.deepEqual(report.actual, song); assert.deepEqual(report.expected, song);
  assert.equal(report.clipSha256, createHash('sha256').update(audio).digest('hex'));
  assert.ok(Date.parse(report.finishedAt) >= Date.parse(report.startedAt));
  assert.equal(f.calls.length, 1);
  const [url, init] = f.calls[0];
  assert.equal(url, endpoint); assert.equal(init.method, 'POST'); assert.deepEqual(init.body, audio);
  assert.deepEqual(init.headers, { Origin: 'https://blink.stitthappens.com', 'Content-Type': 'audio/wav' });
  assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
  assert.ok(!JSON.stringify(report).includes('clip.wav'));
});

test('a no-match, wrong song, or malformed metadata cannot pass identification', async () => {
  for (const reply of [{ result: null }, { result: { ...song, title: 'Another song' } }, {}, { result: { artist: song.artist, title: ' ' } }]) {
    const f = fixture(reply);
    const report = await runLiveRecognition(options, f.dependencies);
    assert.equal(report.status, 'failed'); assert.ok(report.error); assert.equal(f.calls.length, 1);
  }
});

test('rate limits, exhausted provider, missing credentials and timeouts are never retried', async () => {
  for (const status of [429, 502, 503, 504]) {
    const f = fixture({ error: 'private upstream details' }, status);
    const report = await runLiveRecognition(options, f.dependencies);
    assert.equal(report.status, 'failed'); assert.equal(report.httpStatus, status); assert.equal(f.calls.length, 1);
    assert.ok(!JSON.stringify(report).includes('private upstream details'));
  }
  for (const failure of ['timeout', 'network', 'invalid JSON']) {
    let calls = 0;
    const report = await runLiveRecognition(options, { load: async () => audio, request: async () => {
      calls++;
      if (failure === 'invalid JSON') return new Response('private upstream details');
      throw new Error('private upstream details');
    } });
    assert.equal(report.status, 'failed'); assert.equal(calls, 1);
    assert.ok(!JSON.stringify(report).includes('private upstream details'));
  }
});
