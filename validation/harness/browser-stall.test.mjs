import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { nativeProcessSnapshot } from '../browser-stall.mjs';
import { traceRequest } from '../server-trace.mjs';

test('native sampling retains descendants and wait evidence without unrelated processes', async () => {
  const proc = await mkdtemp(path.join(tmpdir(), 'browser-proc-'));
  try {
    for (const [pid, parent] of [[10, 1], [11, 10], [12, 11], [20, 1]]) {
      const task = path.join(proc, String(pid), 'task', String(pid));
      await mkdir(task, { recursive: true });
      await writeFile(path.join(proc, String(pid), 'status'), `Name:\tfixture\nPPid:\t${parent}\n`);
      await writeFile(path.join(task, 'comm'), 'web-process\n');
      await writeFile(path.join(task, 'wchan'), 'futex_wait');
      // Unavailable stack/syscall evidence must remain explicit in the artifact.
    }
    const sample = await nativeProcessSnapshot(10, proc);
    assert.deepEqual(sample.map(p => p.pid).sort(), [10, 11, 12]);
    for (const p of sample) {
      assert.equal(p.tasks[0].wait, 'futex_wait');
      assert.deepEqual(p.tasks[0].stack, { error: 'ENOENT' });
      assert.deepEqual(p.tasks[0].syscall, { error: 'ENOENT' });
    }
  } finally { await rm(proc, { recursive: true, force: true }); }
});

test('server evidence distinguishes completed and interrupted HTTP requests', { timeout: 5000 }, async t => {
  const events = [];
  let pending, aborted;
  const started = new Promise(resolve => { pending = resolve; });
  const closed = new Promise(resolve => { aborted = resolve; });
  const server = createServer((request, response) => {
    traceRequest(request, response, server.address().port, line => events.push(JSON.parse(line)));
    if (request.url === '/pending') { response.once('close', aborted); pending(); }
    else response.writeHead(200).end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve, reject) => {
    get(url + '/complete', response => { response.resume(); response.on('end', resolve); }).on('error', reject);
  });
  assert.deepEqual(events.filter(e => e.path === '/complete').map(e => e.event), ['request', 'finish', 'close']);
  const request = get(url + '/pending');
  request.on('error', () => {}); // Intentional client cancellation.
  await started;
  request.destroy();
  await closed;
  assert.deepEqual(events.filter(e => e.path === '/pending').map(e => e.event), ['request', 'close']);
  assert.equal(events.at(-1).complete, false);
  assert.equal(events.find(e => e.event === 'finish').status, 200);
  for (const e of events) {
    assert.ok(Number.isFinite(Date.parse(e.at)) && e.elapsedMs >= 0);
    assert.ok(!('headers' in e) && !('body' in e));
  }
});
