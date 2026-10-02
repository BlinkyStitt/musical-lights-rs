import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';

const origin = 'https://blink.stitthappens.com';
const song = { artist: 'Artist', title: 'Song', album: 'Album' };
async function fixture(t, { reply = { status: 'success', result: song }, upstreamStatus = 200, token = true } = {}) {
  const calls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modulesRoot: fileURLToPath(new URL('../build/', import.meta.url)),
    modules: [
      { type: 'ESModule', path: fileURLToPath(new URL('../build/index.js', import.meta.url)) },
      { type: 'CompiledWasm', path: fileURLToPath(new URL('../build/index_bg.wasm', import.meta.url)) },
    ],
    compatibilityDate: '2026-10-01',
    bindings: { ALLOWED_ORIGINS: origin, ...(token ? { AUDD_API_TOKEN: 'fixture-secret-never-returned' } : {}) },
    ratelimits: {
      PER_IP: { namespace_id: '1001', simple: { limit: 2, period: 60 } },
      TOTAL: { namespace_id: '1002', simple: { limit: 20, period: 60 } },
    },
    outboundService: async request => {
      assert.equal(request.url, 'https://api.audd.io/');
      const form = await request.formData();
      calls.push({ token: form.get('api_token'), file: form.get('file') });
      return new Response(JSON.stringify(reply), { status: upstreamStatus, headers: { 'Content-Type': 'application/json' } });
    },
  }));
  t.after(() => mf.dispose());
  return { calls, send: (options = {}) => mf.dispatchFetch('https://worker.test/recognize', {
    method: 'POST', body: new Uint8Array([1, 2, 3]), ...options,
    headers: { Origin: origin, 'Content-Type': 'audio/mp4', 'CF-Connecting-IP': '192.0.2.1', ...options.headers },
  }) };
}
test('forwards one named audio file with a server-only token and returns bounded metadata', async t => {
  const f = await fixture(t); const response = await f.send();
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { result: song });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].token, 'fixture-secret-never-returned');
  assert.equal(f.calls[0].file.name, 'sample.m4a');
  assert.deepEqual([...new Uint8Array(await f.calls[0].file.arrayBuffer())], [1, 2, 3]);
});
test('preflight, rejected origins, wrong method, invalid type and oversized bodies never reach AudD', async t => {
  const f = await fixture(t);
  assert.equal((await f.send({ method: 'OPTIONS', body: undefined })).status, 204);
  assert.equal((await f.send({ headers: { Origin: 'https://other.test' } })).status, 403);
  assert.equal((await f.send({ method: 'GET', body: undefined })).status, 405);
  assert.equal((await f.send({ headers: { 'Content-Type': 'application/json' } })).status, 415);
  assert.equal((await f.send({ body: new Uint8Array(512 * 1024 + 1) })).status, 413);
  assert.equal(f.calls.length, 0);
});
test('missing token fails closed without contacting AudD', async t => {
  const f = await fixture(t, { token: false });
  assert.equal((await f.send()).status, 503); assert.equal(f.calls.length, 0);
});
test('no match is successful and does not fabricate a song', async t => {
  const f = await fixture(t, { reply: { status: 'success', result: null } });
  assert.deepEqual(await (await f.send()).json(), { result: null });
});
for (const options of [{ reply: { status: 'error', error: 'fixture-secret-never-returned' } }, { upstreamStatus: 401 }, { reply: { status: 'success', result: { artist: 'Artist', title: '' } } }]) {
  test(`upstream failures are sanitized: ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, options); const response = await f.send();
    assert.equal(response.status, 502); assert.ok(!(await response.text()).includes('fixture-secret-never-returned'));
    assert.equal(f.calls.length, 1);
  });
}
test('per-IP limit rejects the third request without a third paid lookup', async t => {
  const f = await fixture(t);
  assert.equal((await f.send()).status, 200); assert.equal((await f.send()).status, 200);
  const limited = await f.send(); assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '60'); assert.equal(f.calls.length, 2);
});
