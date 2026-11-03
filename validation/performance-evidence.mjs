import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordPerformanceProcesses } from './performance-processes.mjs';

// Persist the browser result before cleanup or assertions can fail. A raw JSON
// file stays usable without extracting a large Playwright trace attachment.
export async function capturePerformanceEvidence(directory, metadata, capture,
  { recordProcesses = recordPerformanceProcesses } = {}) {
  const performancePath = join(directory, 'active-gap-performance.json');
  await writeFile(performancePath, JSON.stringify({ ...metadata, complete: false }));
  const stop = await recordProcesses(join(directory, 'performance-processes.jsonl'));
  try {
    let data;
    try { data = await capture(); }
    catch (error) {
      await writeFile(performancePath, JSON.stringify({ ...metadata, complete: false, error: error.message }));
      throw error;
    }
    await writeFile(performancePath, JSON.stringify({ ...metadata, ...data, complete: true }));
    return data;
  } finally { await stop(); }
}
