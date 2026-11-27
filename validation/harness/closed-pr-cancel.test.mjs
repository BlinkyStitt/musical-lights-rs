import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/cache-cleanup.yml', import.meta.url), 'utf8');
const source = workflow.split('          script: |\n')[1].split('      - name:')[0];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const cancelClosedRuns = new AsyncFunction('context', 'github', source);

const repositoryId = 42;
const closedAt = '2026-11-26T12:00:00Z';
const closed = { number: 131, closed_at: closedAt, head: { ref: 'fix', repo: { id: repositoryId } } };
const association = { number: closed.number, base: { repo: { id: repositoryId } }, head: closed.head };
const originalRun = {
  event: 'pull_request', run_attempt: 1, status: 'in_progress',
  created_at: '2026-11-26T11:58:00Z', pull_requests: [association],
};

async function simulate(current, runs = []) {
  const queries = [];
  const cancelled = [];
  const listWorkflowRuns = () => {};
  const github = {
    rest: {
      pulls: { get: async ({ pull_number }) => {
        assert.equal(pull_number, closed.number);
        return { data: current };
      } },
      actions: { listWorkflowRuns, cancelWorkflowRun: async ({ run_id }) => cancelled.push(run_id) },
    },
    async paginate(method, options) {
      assert.equal(method, listWorkflowRuns);
      queries.push(options);
      return options.workflow_id === 'validate.yml' ? runs : [];
    },
  };
  const context = {
    repo: { owner: 'example', repo: 'musical-lights-rs' },
    payload: { repository: { id: repositoryId }, pull_request: closed },
  };
  await cancelClosedRuns(context, github);
  return { queries, cancelled };
}

test('delayed cleanup leaves reopened and subsequently closed PRs alone', async () => {
  for (const current of [
    { state: 'open', closed_at: null },
    { state: 'closed', closed_at: '2026-11-26T12:05:00Z' },
  ]) {
    const result = await simulate(current, [{ ...originalRun, id: 1 }]);
    assert.deepEqual(result, { queries: [], cancelled: [] });
  }
});

test('cleanup cancels only active first attempts for this PR created before closure', async () => {
  const candidates = [
    {},
    { status: 'queued' },
    { created_at: closedAt },
    { created_at: '2026-11-26T12:00:01Z' },
    { run_attempt: 2 },
    { status: 'completed' },
    { event: 'push' },
    { pull_requests: [{ ...association, number: 132 }] },
    { pull_requests: [{ ...association, head: { repo: { id: 123 } } }] },
    { pull_requests: [] },
  ];
  const result = await simulate(
    { state: 'closed', closed_at: closedAt },
    candidates.map((run, id) => ({ ...originalRun, ...run, id: id + 1 })),
  );
  assert.deepEqual(result.cancelled, [1, 2]);
  assert.equal(result.queries.length, 6);
  for (const query of result.queries) {
    assert.equal(query.event, 'pull_request');
    assert.equal(query.branch, closed.head.ref);
    assert.equal(query.created, `<${closedAt}`);
  }
});
