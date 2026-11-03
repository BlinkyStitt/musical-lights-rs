import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { capturePerformanceEvidence } from '../performance-evidence.mjs';

test('failed numeric captures retain raw measurements before process cleanup fails', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'performance-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const raw = { numericPass: false, maxDebt: 495, frameIntervalsMs: [16.7, 216.6], physicsCosts: [1, 146] };
  await assert.rejects(capturePerformanceEvidence(directory, { build: 'test-build' }, async () => raw, {
    recordProcesses: async path => {
      await writeFile(path, '{"elapsedMs":1000,"schedstat":"120 80 4"}\n');
      return async () => {
        assert.deepEqual(JSON.parse(await readFile(join(directory, 'active-gap-performance.json'), 'utf8')),
          { build: 'test-build', ...raw, complete: true });
        throw new Error('process cleanup failed');
      };
    },
  }), /process cleanup failed/);
  assert.match(await readFile(join(directory, 'performance-processes.jsonl'), 'utf8'), /120 80 4/);
});

test('capture errors retain build identity and process evidence and stop sampling', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'performance-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let stopped = false;
  await assert.rejects(capturePerformanceEvidence(directory, { build: 'test-build' }, async () => {
    throw new Error('capture timed out');
  }, { recordProcesses: async path => {
    await writeFile(path, '{"elapsedMs":1000}\n');
    return async () => { stopped = true; };
  } }), /capture timed out/);
  assert.equal(stopped, true);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'active-gap-performance.json'), 'utf8')),
    { build: 'test-build', complete: false, error: 'capture timed out' });
  assert.match(await readFile(join(directory, 'performance-processes.jsonl'), 'utf8'), /1000/);
});

test('completed captures preserve raw evidence and return data to the unchanged acceptance gate', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'performance-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = { numericPass: true, frameIntervalsMs: [16.7] };
  assert.equal(await capturePerformanceEvidence(directory, { gpu: 'Intel' }, async () => data,
    { recordProcesses: async () => async () => {} }), data);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'active-gap-performance.json'), 'utf8')),
    { gpu: 'Intel', ...data, complete: true });
});
