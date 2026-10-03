// Explicit, single-request check of the deployed Worker and its real AudD account.
// This is deliberately outside Playwright and all routine validation commands.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const endpoint = 'https://musical-lights-recognition.satoshiandkin.workers.dev/recognize';
const origin = 'https://blink.stitthappens.com';
const types = { '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.ogg': 'audio/ogg' };
const usage = 'Usage: node validation/recognition-live.mjs --live --file clip.wav --artist "Known artist" --title "Known title"';
const bounded = value => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 1000;

export async function runLiveRecognition(options, { request = fetch, load = readFile } = {}) {
  // Check intent before touching a file or the network. Missing settings never
  // fall back to a provider demo, token, or synthetic audio that cannot match.
  if (options.live !== true) throw new Error(`Live recognition is off; --live permits at most one lookup. ${usage}`);
  if (!options.file || !bounded(options.artist) || !bounded(options.title)) throw new Error(usage);
  const contentType = types[extname(options.file).toLowerCase()];
  if (!contentType) throw new Error('Use a WAV, M4A/MP4, WebM or Ogg clip supported by the Worker.');
  const audio = await load(options.file);
  if (!audio.length || audio.length > 512 * 1024) throw new Error('Clip must contain 1–524288 bytes; prepare a short excerpt before running.');
  const expected = { artist: options.artist, title: options.title };
  const report = {
    endpoint, clipSha256: createHash('sha256').update(audio).digest('hex'), bytes: audio.length,
    expected, startedAt: new Date().toISOString(), workerRequests: 1, status: 'failed',
  };
  try {
    // No retry, redirect, preflight or second clip. The Worker itself dispatches
    // at most one AudD lookup. HTTP errors and timeouts also spend this attempt.
    const response = await request(endpoint, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': contentType }, body: audio,
      redirect: 'error', signal: AbortSignal.timeout(25_000),
    });
    report.httpStatus = response.status;
    if (response.status !== 200) {
      report.error = `Worker returned HTTP ${response.status}; no retry was made.`;
    } else {
      const { result } = await response.json();
      if (result === null) report.error = 'No song matched; this does not confirm identification.';
      else if (!result || !bounded(result.artist) || !bounded(result.title)) report.error = 'Worker returned invalid song metadata.';
      else {
        report.actual = { artist: result.artist, title: result.title };
        if (result.artist === expected.artist && result.title === expected.title) report.status = 'passed';
        else report.error = 'Recognized artist/title differs from the expected song.';
      }
    }
  } catch {
    // Do not print upstream bodies, credentials, or arbitrary exception text.
    report.error = 'Request failed, timed out, or returned invalid JSON; no retry was made.';
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      live: { type: 'boolean', default: false }, file: { type: 'string' },
      artist: { type: 'string' }, title: { type: 'string' },
    } });
    const report = await runLiveRecognition(values);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
