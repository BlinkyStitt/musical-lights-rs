import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

test('stroke exports retain the original eight-ball workload and match every measured tick', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stroke-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'strokes.json');
  // The real report asserts active body count against its declared configuration
  // for each stroke and reversal tick. A mismatch must fail this subprocess.
  await promisify(execFile)(process.execPath, ['validation/stroke-report.mjs', output], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 30000,
  });
  const rows = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(rows.map(row => row.height), [.4, .6, 1.2, 2]);
  for (const row of rows) {
    assert.equal(row.balls, 8); assert.equal(row.config[8], row.balls);
    assert.equal(row.strokes.length, 4); assert.equal(row.reversalTrace.length, 48);
    for (const stroke of row.strokes) {
      assert.equal(stroke.trace.length, stroke.level > 0 ? 12 : 48);
      if (stroke.level > 0) assert(stroke.arrivalMs <= 50);
      else assert(stroke.arrivalMs > 50 && stroke.arrivalMs <= 400);
    }
    assert(row.reversalMs <= 50); assert(row.reversalArrivalMs <= 400);
  }
});
