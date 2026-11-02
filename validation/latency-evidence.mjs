import { writeFile } from 'node:fs/promises';

// Persist each case before startup and before the next browser can fail. Capture
// writes raw samples into this same result before validating or closing it.
export async function captureLatencyEvidence(output, results, metadata, capture) {
  const result = { ...metadata, complete: false };
  results.push(result);
  const save = () => writeFile(output, JSON.stringify(results, null, 2) + '\n');
  await save();
  try {
    await capture(result);
    result.complete = true;
  } catch (error) {
    result.error = error.message;
    await save();
    throw error;
  }
  await save();
  return result;
}
