import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cgroupV2Directories, recordPerformanceProcesses } from '../performance-processes.mjs';

test('native evidence follows the process cgroup and every visible parent quota', () => {
  const mount = '46 43 0:29 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw';
  assert.deepEqual(cgroupV2Directories('0::/system.slice/runner.service\n', mount),
    ['/sys/fs/cgroup/system.slice/runner.service', '/sys/fs/cgroup/system.slice', '/sys/fs/cgroup']);
  assert.deepEqual(cgroupV2Directories('0::/\n', mount), ['/sys/fs/cgroup']);
  assert.deepEqual(cgroupV2Directories('0::/jobs/one/child', '46 43 0:29 /jobs/one /quota\\040mount rw - cgroup2 cgroup2 rw'),
    ['/quota mount/child', '/quota mount']);
  assert.throws(() => cgroupV2Directories('0::/jobs/other', '46 43 0:29 /jobs/one /quota rw - cgroup2 cgroup2 rw'), /outside/);
  assert.throws(() => cgroupV2Directories('0::/../../unmounted', mount), /Cannot map/);
});

test('native performance evidence persists during capture and stops after the in-flight sample', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'performance-processes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'capture.jsonl');
  await writeFile(file, 'stale evidence\n');
  let calls = 0, release, started;
  const second = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const stop = await recordPerformanceProcesses(file, { intervalMs: 1, sample: async () => {
    const sequence = ++calls;
    if (sequence === 2) { started(); await gate; }
    return { sequence, processes: [{ pid: 123, tasks: [{ schedstat: '120 80 4' }] }] };
  } });
  await second;
  assert.equal(JSON.parse((await readFile(file, 'utf8')).trim()).sequence, 1);
  const stopped = stop();
  assert.equal(calls, 2);
  release(); await stopped;
  const rows = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.sequence), [1, 2, 3]);
  for (const row of rows) {
    assert(Number.isFinite(Date.parse(row.at)));
    assert(row.elapsedMs >= 0 && row.sampleDurationMs >= 0);
    assert.equal(row.processes[0].tasks[0].schedstat, '120 80 4');
  }
});

test('native sampler failure remains an error and retains completed evidence', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'performance-processes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'capture.jsonl');
  let calls = 0, failed;
  const failure = new Promise(resolve => { failed = resolve; });
  const stop = await recordPerformanceProcesses(file, { intervalMs: 1, sample: async () => {
    if (++calls === 2) { failed(); throw new Error('native sampling unavailable'); }
    return { sequence: calls };
  } });
  await failure;
  await assert.rejects(stop(), /native sampling unavailable/);
  assert.equal(calls, 2);
  assert.equal(JSON.parse((await readFile(file, 'utf8')).trim()).sequence, 1);
});
