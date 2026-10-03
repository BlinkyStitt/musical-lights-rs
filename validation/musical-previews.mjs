// Shareable previews with identical licensed audio. Recording/encoding is not
// a phone FPS workload or a measurement of audiovisual/output-device latency.
import { assertBrowserEnvironment } from './browser-environment.mjs';
assertBrowserEnvironment();
import { chromium } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { staticPreview } from './static-preview.mjs';
import checkBrowserStartup from './browser-startup.mjs';
const output = 'docs/musical-motion-results', origin = 'https://musical-lights.test';
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'musical-previews-'));
const finishAudit = await checkBrowserStartup({ filteredProjects: [{ name: 'chromium', use: { browserName: 'chromium' } }] });
const ffmpeg = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
const sharedAudio = join(temporary, 'shared-audio.m4a');
try {
  // Encode once, then copy these exact audio packets into both videos. No gain.
  ffmpeg(['-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', 'musical-leptos/public/review/trumpet.f32', '-t', '4', '-c:a', 'aac', '-b:a', '192k', sharedAudio]);
  const browser = await chromium.launch(), previews = [];
  try {
    for (const scrolling of [true, false]) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, recordVideo: { dir: temporary, size: { width: 1100, height: 800 } } });
      // Expanded page view keeps the recorder viewport fixed; native headless
      // fullscreen can change Chromium's capture surface to 800 by 600.
      await context.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
      await staticPreview(context, origin);
      const videoStart = performance.now(), page = await context.newPage();
      await page.setViewportSize({ width: 1100, height: 800 });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/advanced/`);
      await page.waitForFunction(() => document.querySelector('#dancinglights')?.physics?.current);
      await page.locator('.input-source').selectOption('trumpet');
      await page.waitForFunction(() => document.querySelector('.audio-card').dataset.audioState === 'playing' && !document.querySelector('.review-replay').disabled);
      await page.locator('.display-controls > summary').click();
      await page.locator('.camera-rotation').fill('25');
      await page.locator('.scroll-lights').setChecked(scrolling);
      await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(3500);
      // Replay is hidden in fullscreen; dispatch its native click in this
      // development recorder after the already-authorized digital session starts.
      await page.locator('.review-replay').evaluate(button => button.click());
      const startSeconds = (performance.now() - videoStart) / 1000;
      await page.waitForTimeout(4000);
      const identity = await page.evaluate(() => document.querySelector('.audio-card').review.identity);
      const recording = page.video(); await context.close();
      const path = `${output}/${scrolling ? 'scrolling' : 'stationary'}-with-audio.mp4`;
      ffmpeg(['-ss', String(startSeconds), '-i', await recording.path(), '-i', sharedAudio, '-t', '4', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-metadata', 'artist=Mihai Sorohan', '-metadata', 'comment=Jazz Trumpet Loops Pack in F 90 bpm; CC BY 3.0 https://freesound.org/s/77711/ https://creativecommons.org/licenses/by/3.0/', '-movflags', '+faststart', path]);
      const audioPacketSha256 = ffmpeg(['-i', path, '-map', '0:a:0', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', '-']).trim();
      assert.deepEqual(errors, []);
      previews.push({ path, scrolling, identity, audioPacketSha256, audiovisualTiming: 'approximate recording-start clock; not latency evidence', fpsAcceptanceWorkload: false, fullscreen: 'expanded page view', viewport: { width: 1100, height: 800 } });
    }
  } finally { await browser.close(); }
  assert.equal(previews[0].identity.pcmSha256, previews[1].identity.pcmSha256);
  assert.equal(previews[0].audioPacketSha256, previews[1].audioPacketSha256);
  const build = JSON.parse(await readFile('musical-leptos/dist/build.json', 'utf8'));
  await writeFile(`${output}/video-previews.json`, JSON.stringify({ build, previews }, null, 2) + '\n');
  console.log('Both MP4 previews contain identical audio packets from the licensed trumpet excerpt.');
} finally { await rm(temporary, { recursive: true, force: true }); await finishAudit(); }
