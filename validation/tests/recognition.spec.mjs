import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { syntheticAudio, physicsReady } from '../physics-state.mjs';

const base = 'http://127.0.0.1:8101';
const song = { artist: 'Artist, with "quotes"', title: 'A very long song title that keeps going across the narrow phone display and should scroll smoothly', album: 'Album' };

async function setup(page, { realRecorder = false, allowUnavailable = false, status = 200, result = song } = {}) {
  await syntheticAudio(page);
  await page.addInitScript(() => {
    MediaDevices.prototype.getUserMedia = async () => {
      const context = window.testContext;
      const destination = context.createMediaStreamDestination();
      const tone = context.createOscillator();
      tone.frequency.value = 440; tone.connect(destination); tone.start();
      window.recognitionTone = tone;
      return destination.stream;
    };
    const send = window.fetch;
    window.fetch = (url, init) => {
      if (String(url).endsWith('/recognize') && init?.body instanceof Blob) {
        // WebKit's interception protocol omits Blob request bodies. Inspect the
        // real encoded Blob passed to fetch, without replacing the recorder.
        window.uploadedAudio = { size: init.body.size, type: init.body.type };
      }
      return send(url, init);
    };
  });
  // Set the deployment configuration before application initialization.
  await page.route(base + '/', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(/name="musical-lights-recognition" content="[^"]*"/, 'name="musical-lights-recognition" content="/recognize"') });
  });
  if (!realRecorder) await page.addInitScript(() => {
    window.captureStarts = 0;
    window.MediaRecorder = class {
      static isTypeSupported(type) { return type === 'audio/mp4'; }
      constructor(stream, options) { this.stream = stream; this.mimeType = options.mimeType; this.state = 'inactive'; window.recorder = this; }
      start() { this.state = 'recording'; window.captureStarts++; }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) });
        this.onstop?.();
      }
    };
    const timeout = window.setTimeout;
    window.setTimeout = (callback, ms, ...args) => timeout(callback, ms === 10_000 ? 300 : ms, ...args);
  });
  const uploads = [];
  await page.route(base + '/recognize', async route => {
    uploads.push({ type: route.request().headers()['content-type'], data: route.request().postDataBuffer() });
    await route.fulfill({ status, json: { result } });
  });
  await page.goto(base); await physicsReady(page);
  await expect(page.getByRole('button', { name: 'Identify song', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  if (allowUnavailable && await page.evaluate(() => typeof MediaRecorder === 'undefined')) {
    await expect(page.getByRole('button', { name: 'Identify song', exact: true })).toBeDisabled();
    await expect(page.locator('.recognition-status')).toHaveText('Song recognition is unavailable in this browser.');
    await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole('button', { name: 'Identify song', exact: true })).toBeEnabled();
  }
  return uploads;
}

test('native recording identifies on demand and exports timestamps, or reports an unavailable platform API', async ({ page, browserName }) => {
  // The pinned Linux WebKit build omits MediaRecorder. macOS WebKit and
  // Chromium must still exercise native encoding; all platforms test the UI.
  const allowUnavailable = process.platform === 'linux' && browserName === 'webkit';
  const uploads = await setup(page, { realRecorder: true, allowUnavailable });
  if (allowUnavailable && await page.evaluate(() => typeof MediaRecorder === 'undefined')) {
    await page.waitForTimeout(600);
    expect(uploads).toHaveLength(0);
    await expect(page.getByText('Song history (0)', { exact: true })).toBeVisible();
    return;
  }
  await page.waitForTimeout(600);
  expect(uploads).toHaveLength(0);
  await page.getByRole('button', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.recognition-status')).toHaveText('Listening for 10 seconds…');
  await expect(page.getByRole('button', { name: 'Identify song', exact: true })).toBeDisabled();
  await expect(page.locator('.recognition-status')).toContainText('Recognized ', { timeout: 15000 });
  expect(uploads).toHaveLength(1);
  expect(await page.evaluate(() => window.uploadedAudio.size)).toBeGreaterThan(100);
  expect(uploads[0].type).toMatch(/^audio\/(mp4|webm|ogg)/);
  await expect(page.locator('.song-title')).toHaveText(`${song.artist} — ${song.title}`);
  await page.getByText('Song history (1)', { exact: true }).click();
  for (const format of ['CSV', 'JSON']) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: `Export ${format}`, exact: true }).click();
    const data = await readFile(await (await download).path(), 'utf8');
    if (format === 'JSON') {
      const { detections } = JSON.parse(data); expect(detections).toHaveLength(1);
      expect(detections[0].artist).toBe(song.artist);
      expect(Date.parse(detections[0].sampleEndedAt) - Date.parse(detections[0].sampleStartedAt)).toBeGreaterThanOrEqual(9500);
      expect(Date.parse(detections[0].recognizedAt)).toBeGreaterThanOrEqual(Date.parse(detections[0].sampleEndedAt));
    } else expect(data).toContain('"Artist, with ""quotes"""');
  }
  await page.waitForTimeout(600); expect(uploads).toHaveLength(1);
  await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
  await page.reload();
  await expect(page.getByText('Song history (1)', { exact: true })).toBeVisible();
});

for (const action of ['cancel', 'stop', 'route']) {
  test(`${action} during song capture cannot upload or stop an unrelated listening session`, async ({ page }) => {
    const uploads = await setup(page);
    await page.getByRole('button', { name: 'Identify song', exact: true }).click();
    if (action === 'cancel') await page.getByRole('button', { name: 'Cancel identification' }).click();
    if (action === 'stop') await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
    if (action === 'route') await page.getByRole('link', { name: 'About', exact: true }).click();
    await page.waitForTimeout(500);
    expect(uploads).toHaveLength(0);
    expect(await page.evaluate(() => window.recorder.state)).toBe('inactive');
    if (action === 'cancel') await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toBeVisible();
  });
}

test('no match and service failure preserve the previous song and do not retry or create history', async ({ page }) => {
  const uploads = await setup(page);
  await page.getByRole('button', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.recognition-status')).toContainText('Recognized ');
  let failures = 0;
  await page.route(base + '/recognize', async route => {
    failures++;
    await route.fulfill({ status: failures === 1 ? 200 : 429, json: { result: null } });
  });
  await page.getByRole('button', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.recognition-status')).toContainText('No song recognized');
  await page.getByRole('button', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.recognition-status')).toContainText('Wait a minute');
  await page.waitForTimeout(500);
  expect(failures).toBe(2); expect(uploads).toHaveLength(1);
  await expect(page.getByText('Song history (1)', { exact: true })).toBeVisible();
  await expect(page.locator('.song-title')).toHaveText(`${song.artist} — ${song.title}`);
});

test('song title fits a phone, appears in fullscreen, and respects Reduced Motion', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await setup(page);
  await page.getByRole('button', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.recognition-status')).toContainText('Recognized ');
  await expect(page.locator('.recognized-song')).toHaveClass(/song-overflow/);
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await expect(page.locator('.song-title')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.song-title')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.song-title')).toHaveCSS('white-space', 'normal');
});

test('canceling an upload ignores late recognition and leaves listening active', async ({ page }) => {
  await setup(page);
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  await page.route(base + '/recognize', async route => {
    await delayed;
    await route.fulfill({ json: { result: song } }).catch(() => {}); // Request may already be aborted.
  });
  await page.getByRole('button', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.recognition-status')).toHaveText('Identifying song…');
  await page.getByRole('button', { name: 'Cancel identification' }).click();
  release();
  await page.waitForTimeout(400);
  await expect(page.getByText('Song history (0)', { exact: true })).toBeVisible();
  await expect(page.locator('.recognized-song')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toBeVisible();
});

test('hiding the page cancels capture without a lookup', async ({ page }) => {
  const uploads = await setup(page);
  await page.getByRole('button', { name: 'Identify song', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(400);
  expect(uploads).toHaveLength(0);
  expect(await page.evaluate(() => window.recorder.state)).toBe('inactive');
  await expect(page.locator('.recognition-status')).toContainText('canceled');
});


test('a missing recorder disables recognition without disabling listening or history', async ({ page }) => {
  await page.addInitScript(() => { window.MediaRecorder = undefined; });
  const uploads = await setup(page, { realRecorder: true, allowUnavailable: true });
  expect(uploads).toHaveLength(0);
  await expect(page.getByText('Song history (0)', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toBeVisible();
});
