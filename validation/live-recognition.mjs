// Separate, explicitly enabled, one-request service check. Never imported by
// browser/harness tests. Supply a known public/licensed ten-second recording.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
if (process.env.RUN_LIVE_RECOGNITION !== '1') throw Error('Set RUN_LIVE_RECOGNITION=1 to authorize one real AudD lookup.');
const [path, endpoint] = process.argv.slice(2);
if (!path || !endpoint) throw Error('Usage: RUN_LIVE_RECOGNITION=1 node validation/live-recognition.mjs PUBLIC_SAMPLE.wav HTTPS_ENDPOINT');
assert.equal(new URL(endpoint).protocol, 'https:');
const bytes = await readFile(path); assert(bytes.length > 0 && bytes.length <= 512 * 1024);
const response = await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://blink.stitthappens.com' }, body: new Blob([bytes], { type: 'audio/wav' }), credentials: 'omit', signal: AbortSignal.timeout(30_000) });
assert.equal(response.status, 200); const body = await response.json();
assert(body.result === null || typeof body.result.artist === 'string' && typeof body.result.title === 'string');
console.log(JSON.stringify({ requests: 1, recordedAt: new Date().toISOString(), result: body.result }, null, 2));
