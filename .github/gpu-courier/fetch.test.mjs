import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { receive } from './fetch.mjs';

const identity = { tested: 'a'.repeat(40), ref: 'refs/pull/9/merge', run: '123', attempt: '2' };
const baseline = {
  aud: 'ski-musical-gpu-return-v1', actor_id: '624221', repository_id: '736904496',
  runner_environment: 'github-hosted', event_name: 'pull_request', sha: identity.tested,
  ref: identity.ref, run_id: identity.run, run_attempt: identity.attempt, check_run_id: '321',
  job_workflow_sha: 'b'.repeat(40),
};
function oidc(overrides = {}) {
  return 'test.' + Buffer.from(JSON.stringify({ ...baseline, ...overrides })).toString('base64url') + '.test';
}
async function withOutput(body) {
  const directory = await mkdtemp(join(tmpdir(), 'gpu-hosted-fetch.'));
  try { await body(join(directory, 'gpu.zip')); } finally { await rm(directory, { recursive: true, force: true }); }
}
const data = (body = 'archive', length = '7') => new Response(body, {
  status: 200, headers: { 'Content-Type': 'application/zip', 'Content-Length': length },
});
test('only fixed HTTPS GET, no redirect, new OIDC after opaque pending, private exact output', async () => {
  await withOutput(async (output) => {
    let tokens = 0;
    let requests = 0;
    const actual = await receive({ getIDToken: async (aud) => {
      assert.equal(aud, baseline.aud);
      tokens++;
      return oidc();
    } }, identity, output, {
      fetch: async (url, init) => {
        assert.equal(url, 'https://gpu-artifacts.shorthair-fir.ts.net/v1/musical-gpu/result');
        assert.equal(init.redirect, 'error');
        assert.equal(init.method, 'GET');
        assert.equal(init.headers.Authorization, 'Bearer ' + oidc());
        return ++requests === 1 ? new Response('', {status: 404}) : data();
      },
      sleep: async () => {},
    });
    assert.deepEqual(actual, { check: '321', callee: 'b'.repeat(40) });
    assert.equal(tokens, 2);
    assert.equal(await readFile(output, 'utf8'), 'archive');
    assert.equal((await stat(output)).mode & 0o777, 0o600);
  });
});
test('foreign run identity makes no network request', async () => {
  let calls = 0;
  await assert.rejects(receive({ getIDToken: async () => oidc({ run_attempt: '1' }) },
    identity, '/not-written', { fetch: async () => { calls++; } }), /Wrong exact/);
  assert.equal(calls, 0);
});
test('truncation, redirect and overdeclared body do not become report files', async () => {
  for (const response of [data('short'), data('too much', '2'), new Response('', {status: 302})]) {
    await withOutput(async (output) => {
      await assert.rejects(receive({ getIDToken: async () => oidc() }, identity, output,
        { fetch: async () => response }));
      await assert.rejects(stat(output), { code: 'ENOENT' });
    });
  }
});
