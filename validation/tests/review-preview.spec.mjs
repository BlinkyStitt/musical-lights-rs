// Explicit artifact generation; these recordings are not FPS or listening passes.
import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { physicsReady } from '../physics-state.mjs';

test('record identical music with scrolling enabled and disabled', async ({ page }) => {
  test.skip(process.env.MUSICAL_REVIEW_PREVIEWS !== '1', 'Run explicitly to refresh review artifacts');
  const output = 'docs/advanced-results', results = [];
  await mkdir(output, { recursive: true });
  for (const scrolling of [true, false]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      const create = AudioContext.prototype.createMediaStreamDestination;
      AudioContext.prototype.createMediaStreamDestination = function () {
        const destination = create.call(this);
        window.previewAudio = destination.stream; return destination;
      };
      const resume = AudioContext.prototype.resume;
      AudioContext.prototype.resume = async function () {
        if (window.previewAudio && !window.previewRecorder) {
          // Hold the initial suspended graph while the viewport expands. This
          // records from the source's real zero sample without aligning traces.
          await new Promise(resolve => { window.previewResume = resolve; });
          const canvas = document.querySelector('#dancinglights canvas');
          const stream = canvas.captureStream(60);
          stream.addTrack(window.previewAudio.getAudioTracks()[0]);
          window.previewRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9,opus' });
          window.previewChunks = [];
          previewRecorder.ondataavailable = event => { if (event.data.size) previewChunks.push(event.data); };
          window.previewRecordingAt = performance.now(); previewRecorder.start();
        }
        return resume.call(this);
      };
    });
    await page.goto('http://127.0.0.1:8101/advanced/'); await physicsReady(page);
    await page.locator('.scroll-lights').setChecked(scrolling);
    await page.locator('.input-source').selectOption('music');
    await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
    await page.locator('.tone-repeat').uncheck();
    await page.locator('.listening-toggle').check();
    await page.waitForFunction(() => window.previewResume);
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
      const graph = document.querySelector('#dancinglights'), v = graph.physics, box = graph.getBoundingClientRect();
      return v.canvasWidth === box.width && v.canvasHeight === box.height;
    })).toBe(true);
    await page.evaluate(() => window.previewResume());
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
    await expect.poll(() => page.evaluate(() => document.querySelector('.audio-card').dataset.audioState), { timeout: 12000 }).toBe('ended');
    const recording = await page.evaluate(async () => {
      await new Promise(resolve => { previewRecorder.onstop = resolve; previewRecorder.stop(); });
      const bytes = new Uint8Array(await new Blob(previewChunks).arrayBuffer());
      const v = document.querySelector('#dancinglights').physics;
      return { bytes: Array.from(bytes), identity: document.querySelector('.audio-card').review.identity,
        sessions: document.querySelector('.audio-card').review.sessions, recordingStartedAtPerformanceMs: previewRecordingAt,
        config: v.config, viewport: [innerWidth, innerHeight], userAgent: navigator.userAgent };
    });
    const name = `music-scrolling-${scrolling ? 'on' : 'off'}`;
    await writeFile(`${output}/${name}.webm`, Buffer.from(recording.bytes));
    await page.screenshot({ path: `${output}/${name}.png` });
    const { bytes, ...metadata } = recording; results.push({ scrolling, ...metadata });
    await page.keyboard.press('Escape'); await page.locator('.listening-toggle').uncheck();
  }
  expect(results[0].identity.pcmSha256).toBe(results[1].identity.pcmSha256);
  expect(results[0].identity.samples).toBe(results[1].identity.samples);
  await writeFile(`${output}/previews.json`, JSON.stringify({
    generatedAt: new Date().toISOString(), build: await page.evaluate(() => fetch(document.querySelector('meta[name="musical-lights-assets"]').content + 'physics/build.js').then(r => r.text())),
    recording: 'Actual production WebGL canvas and digital source stream; VP9/Opus capture. Output clocks remain estimates; no fitted gain or trace shift.',
    humanListening: 'pending', physicalPhone: 'pending', fpsAcceptance: false, results,
  }, null, 2) + '\n');
});
