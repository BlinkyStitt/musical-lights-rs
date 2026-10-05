import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { syntheticAudio, physicsReady, normalView } from '../physics-state.mjs';

const localBase = 'http://127.0.0.1:8101';
// Published-build checks still replace the endpoint with a same-origin mock.
// They never submit recordings to the real recognition Worker or AudD.
const base = (process.env.MUSICAL_LIGHTS_RECOGNITION_URL ?? localBase).replace(/\/$/, '');
const song = { artist: 'Artist, with "quotes"', title: 'A very long song title that keeps going across the narrow phone display and should scroll smoothly', album: 'Album' };

async function expireLookupCooldown(page) {
  // Advance only the cooldown's wall clock. Playwright's clock installation
  // replaces the fixture's accelerated recorder timers with real 10s timers.
  await page.evaluate(() => {
    const now = Date.now.bind(Date); Date.now = () => now() + 60_001;
  });
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).uncheck();
  await expect(page.getByRole('checkbox', { name: 'Identify song', exact: true })).toBeEnabled();
}

test('localhost development never uploads to the inherited production endpoint', async ({ page }) => {
  test.skip(base !== localBase, 'The development-origin guard is checked on localhost.');
  const outbound = [];
  await page.route('https://musical-lights-recognition.satoshiandkin.workers.dev/**', route => {
    outbound.push(route.request().url()); return route.abort();
  });
  await page.goto(base); await physicsReady(page);
  await expect(page.locator('.recognition-status')).toHaveText('Song recognition is not configured yet.');
  await expect(page.getByRole('checkbox', { name: 'Identify song', exact: true })).toBeDisabled();
  expect(outbound).toEqual([]);
});

async function setup(page, { realRecorder = false, allowUnavailable = false, captureMs = 300, status = 200, result = song, routePath = '/' } = {}) {
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
  await page.route(base + routePath, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(/name="musical-lights-recognition" content="[^"]*"/, 'name="musical-lights-recognition" content="/recognize"') });
  });
  if (!realRecorder) await page.addInitScript(captureMs => {
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
    window.setTimeout = (callback, ms, ...args) => timeout(callback, ms === 10_000 ? captureMs : ms, ...args);
  }, captureMs);
  const uploads = [];
  await page.route(base + '/recognize', async route => {
    uploads.push({ type: route.request().headers()['content-type'], data: route.request().postDataBuffer() });
    await route.fulfill({ status, json: { result } });
  });
  await page.goto(base + routePath); await physicsReady(page);
  await normalView(page);
  await expect(page.getByRole('checkbox', { name: 'Identify song', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  if (allowUnavailable && await page.evaluate(() => typeof MediaRecorder === 'undefined')) {
    await expect(page.getByRole('checkbox', { name: 'Identify song', exact: true })).toBeDisabled();
    await expect(page.locator('.recognition-status')).toHaveText('Song recognition is unavailable in this browser.');
    await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
  } else {
    await expect(page.getByRole('checkbox', { name: 'Identify song', exact: true })).toBeEnabled();
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
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.recognition-ring')).toHaveAttribute('data-phase', 'capture');
  await expect(page.locator('.recognition-ring')).toHaveAttribute('aria-label', 'Capturing ten seconds of microphone audio.');
  await expect(page.getByRole('checkbox', { name: 'Identify song', exact: true })).toBeChecked();
  await expect(page.locator('.song-title')).toHaveText(`${song.artist} — ${song.title}`, { timeout: 15000 });
  await expect(page.locator('.recognition-status')).toBeEmpty();
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
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
  await page.reload();
  await expect(page.getByText('Song history (1)', { exact: true })).toBeVisible();
});

for (const action of ['cancel', 'stop', 'route']) {
  test(`${action} during song capture cannot upload or stop an unrelated listening session`, async ({ page }) => {
    // Keep the production capture duration: a 300 ms mock can finish while CI
    // is still dispatching the cancellation gesture.
    const uploads = await setup(page, { captureMs: 10_000 });
    await page.getByRole('checkbox', { name: 'Identify song', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.recorder?.state)).toBe('recording');
    if (action === 'cancel') await page.getByRole('checkbox', { name: 'Identify song', exact: true }).uncheck();
    if (action === 'stop') await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
    if (action === 'route') await page.getByRole('link', { name: 'About', exact: true }).click();
    await page.waitForTimeout(500);
    expect(uploads).toHaveLength(0);
    expect(await page.evaluate(() => window.recorder.state)).toBe('inactive');
    if (action === 'cancel') await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
    if (action !== 'route') await expect(page.locator('.listening-toggle')).toBeEnabled();
  });
}

test('no match and service failure preserve the previous song and do not retry or create history', async ({ page }) => {
  const uploads = await setup(page);
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.song-title')).toHaveText(`${song.artist} — ${song.title}`);
  await expect(page.locator('.recognition-status')).toBeEmpty();
  let failures = 0;
  await page.route(base + '/recognize', async route => {
    failures++;
    await route.fulfill({ status: failures === 1 ? 200 : 429, json: { result: null } });
  });
  await expireLookupCooldown(page);
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.recognition-status')).toContainText('No song recognized');
  await expect(page.getByRole('checkbox', { name: 'Identify song', exact: true })).toBeEnabled();
  await expireLookupCooldown(page);
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.recognition-status')).toContainText('Wait a minute');
  await expect(page.getByRole('checkbox', { name: 'Identify song', exact: true })).toBeEnabled();
  await page.waitForTimeout(500);
  expect(failures).toBe(2); expect(uploads).toHaveLength(1);
  await expect(page.getByText('Song history (1)', { exact: true })).toBeVisible();
  await expect(page.locator('.song-title')).toHaveText(`${song.artist} — ${song.title}`);
});

test('a paid lookup blocks repeat recordings across reload until the minute expires', async ({ page }) => {
  const uploads = await setup(page);
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.song-title')).toHaveText(`${song.artist} — ${song.title}`);
  await expect(page.locator('.recognition-status')).toBeEmpty();
  await expect(page.getByRole('checkbox', { name: 'Identify song', exact: true })).toBeEnabled();
  await expect(page.locator('.recognition-ring')).toHaveAttribute('data-phase', 'waiting');
  await page.reload(); await physicsReady(page);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.mic-status')).toBeEmpty();
  await expect(page.getByRole('checkbox', { name: 'Identify song', exact: true })).toBeEnabled();
  expect(uploads).toHaveLength(1);
  expect(await page.evaluate(() => window.captureStarts)).toBe(0);
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).check();
  await page.waitForTimeout(300);
  expect(uploads).toHaveLength(1); expect(await page.evaluate(() => window.captureStarts)).toBe(0);
  await expireLookupCooldown(page);
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.song-title')).toHaveText(`${song.artist} — ${song.title}`);
  await expect(page.locator('.recognition-status')).toBeEmpty();
  expect(uploads).toHaveLength(2);
  expect(await page.evaluate(() => window.captureStarts)).toBe(1);
});

test('song title fits a phone, appears in fullscreen, and respects Reduced Motion', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await setup(page);
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.song-title')).toHaveText(`${song.artist} — ${song.title}`);
  await expect(page.locator('.recognition-status')).toBeEmpty();
  await expect(page.locator('.recognized-song')).toHaveClass(/song-overflow/);
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await expect(page.locator('.song-title')).toBeVisible();
  await expect(page.locator('.recognition-ring')).toBeVisible();
  await expect(page.locator('.recognition-cooldown, .cancel-recognition')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.song-title')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.song-title')).toHaveCSS('white-space', 'normal');
  // Also cover native fullscreen, without changing OS window dimensions.
  await expect.poll(() => page.evaluate(() => {
    const status = document.querySelector('.recognition-ring').getBoundingClientRect();
    const strip = document.querySelector('.recognized-song').getBoundingClientRect();
    return strip.bottom <= status.top;
  })).toBe(true);
});

for (const { result, routePath, colorScheme, name } of [
  { result: { artist: 'Daft Punk', title: 'One More Time' }, routePath: '/', colorScheme: 'dark', name: 'short' },
  { result: song, routePath: '/advanced', colorScheme: 'light', name: 'long' },
]) {
  test(`fullscreen ${name} song is a single continuous artist-title ticker without captions or exit hints`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' });
    // Exercise page fullscreen and rotation without resizing a native OS window.
    await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
    await setup(page, { result, routePath });
    const text = `${result.artist} — ${result.title}`;
    await page.getByRole('checkbox', { name: 'Identify song', exact: true }).check();
    await expect(page.locator('.recognized-song')).toHaveText(text);
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.locator('.song-title')).toHaveCSS('animation-name', 'song-scroll');
    await expect(page.locator('.song-title')).toHaveCSS('animation-direction', 'normal');
    await expect(page.locator('.song-title')).toHaveCount(1);
    await expect(page.locator('.song-caption, .fullscreen-hint')).toHaveCount(0);
    await expect(page.getByText(/^(Last recognized|Recognized|Click Exit fullscreen)$/)).toHaveCount(0);
    await expect(page.locator('.recognition-status')).toBeEmpty();

    for (const viewport of [{ width: 320, height: 720 }, { width: 568, height: 320 }]) {
      await page.setViewportSize(viewport);
      // Wait for ResizeObserver to update the measured travel after rotation.
      await expect.poll(() => page.locator('.song-title').evaluate(title => {
        const entry = parseFloat(getComputedStyle(title).getPropertyValue('--song-entry'));
        return entry === title.parentElement.clientWidth;
      })).toBe(true);
      const travel = await page.locator('.song-title').evaluate(title => {
        const animation = title.getAnimations()[0];
        animation.pause();
        const duration = animation.effect.getTiming().duration;
        const xAt = time => {
          animation.currentTime = time;
          return new DOMMatrixReadOnly(getComputedStyle(title).transform).m41;
        };
        const start = xAt(0), oneSecond = xAt(1000), twoSeconds = xAt(2000), nextLap = xAt(duration + 1000);
        animation.currentTime = 0;
        return { start, oneSecond, twoSeconds, nextLap };
      });
      expect(travel.start).toBeCloseTo(0, 1);
      expect(travel.oneSecond).toBeCloseTo(-45, 1);
      expect(travel.twoSeconds).toBeCloseTo(-90, 1);
      expect(travel.nextLap).toBeCloseTo(travel.oneSecond, 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath(`fullscreen-${name}-ticker-${viewport.width}.png`) });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.song-title')).toHaveCSS('animation-name', 'none');
    await expect(page.locator('.song-title')).toHaveCSS('white-space', 'normal');
    await expect(page.locator('.recognized-song')).toHaveText(text);
    await expect(page.locator('.song-title')).toBeInViewport({ ratio: 1 });
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await expect(page.locator('.recognized-song')).toHaveText(text);
  });
}

test('canceling an upload ignores late recognition and leaves listening active', async ({ page }) => {
  await setup(page);
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  await page.route(base + '/recognize', async route => {
    await delayed;
    await route.fulfill({ json: { result: song } }).catch(() => {}); // Request may already be aborted.
  });
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.recognition-ring')).toHaveAttribute('data-phase', 'upload');
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).uncheck();
  release();
  await page.waitForTimeout(400);
  await expect(page.getByText('Song history (0)', { exact: true })).toBeVisible();
  await expect(page.locator('.recognized-song')).toBeHidden();
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
});

test('hiding the page cancels capture without a lookup', async ({ page }) => {
  const uploads = await setup(page);
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.recorder?.state)).toBe('recording');
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
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
});

test('the song toggle is prominent above the lights on a narrow phone and usable in fullscreen', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 });
  // Keep the real capture window while checking layout and switching identification off.
  // Slow CI can outlast the shortened recording used by successful matches.
  const uploads = await setup(page, { captureMs: 10_000 });
  const identify = page.locator('.audio-controls').getByRole('checkbox', { name: 'Identify song', exact: true });
  await expect(identify).toBeInViewport();
  expect(await identify.evaluate(button => button.getBoundingClientRect().bottom <= document.querySelector('.spectrum-panel').getBoundingClientRect().top)).toBe(true);
  await expect(identify).toHaveCSS('font-weight', '700');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await expect(identify).toBeInViewport();
  await expect(identify).toBeEnabled();
  const exit = page.getByRole('button', { name: 'Exit fullscreen', exact: true });
  expect(await identify.evaluate(button => button.getBoundingClientRect().right <= innerWidth)).toBe(true);
  expect(await identify.evaluate(button => { const label = button.closest('label').getBoundingClientRect(), ring = document.querySelector('.recognition-ring').getBoundingClientRect(); return ring.left >= label.right && Math.abs((ring.top + ring.bottom - label.top - label.bottom) / 2) < 2; })).toBe(true);
  await identify.click();
  await expect(page.locator('.recognition-ring')).toHaveAttribute('data-phase', 'capture');
  await expect(page.locator('.recognition-ring')).toHaveAttribute('aria-label', 'Capturing ten seconds of microphone audio.');
  await expect(page.locator('.recognition-ring')).toBeInViewport();
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).uncheck();
  await expect(page.locator('.recognition-status')).toBeEmpty();
  await expect(page.locator('.recognition-ring')).toHaveAttribute('data-phase', 'off');
  await expect(page.locator('.recognition-ring')).toBeInViewport();
  await expect(identify).toBeEnabled();
  expect(uploads).toHaveLength(0);
  // The top-area exit gesture defers closing for 300 ms. A control click must
  // still leave fullscreen intact after that deferred gesture would complete.
  await page.waitForTimeout(350);
  await expect(exit).toBeVisible();
  await exit.click();
  await page.screenshot({ path: testInfo.outputPath('prominent-song-button-phone.png') });
});

test.describe('song controls with touch input', () => {
  test.use({ hasTouch: true });
  test('a top-area song-toggle tap identifies without closing fullscreen', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    const uploads = await setup(page);
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).tap();
    await page.getByRole('checkbox', { name: 'Identify song', exact: true }).tap();
    await expect(page.locator('.song-title')).toHaveText(`${song.artist} — ${song.title}`);
  await expect(page.locator('.recognition-status')).toBeEmpty();
    await page.waitForTimeout(350);
    await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
    expect(uploads).toHaveLength(1);
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'Fullscreen', exact: true })).toBeVisible();
  });
});

test('fullscreen overlays stay above wrapped song titles with Reduced Motion', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Model phone Safari's expanded page view while rotating the viewport.
  // Chromium cannot resize its OS window while in native fullscreen.
  await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
  await setup(page);
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).click();
  await expect(page.locator('.song-title')).toHaveText(`${song.artist} — ${song.title}`);
  await expect(page.locator('.recognition-status')).toBeEmpty();
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  for (const viewport of [{ width: 320, height: 720 }, { width: 568, height: 320 }, { width: 320, height: 720 }]) {
    await page.setViewportSize(viewport);
    await expect(page.locator('.song-title')).toHaveCSS('white-space', 'normal');
    await expect(page.locator('.song-title')).toHaveCSS('animation-name', 'none');
    await expect.poll(() => page.evaluate(() => {
      const status = document.querySelector('.recognition-ring').getBoundingClientRect();
        const strip = document.querySelector('.recognized-song').getBoundingClientRect();
      const title = document.querySelector('.song-title').getBoundingClientRect();
      return { statusBelowSong: strip.bottom <= status.top,
        titleInsideStrip: title.top >= strip.top && title.bottom <= strip.bottom,
        titleInsideViewport: title.left >= 0 && title.right <= innerWidth && title.top >= 0 && title.bottom <= innerHeight };
    })).toEqual({ statusBelowSong: true, titleInsideStrip: true, titleInsideViewport: true });
    for (const selector of ['.recognition-ring', '.recognized-song']) {
      await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(await page.locator('.song-title').evaluate(title => {
    const lines = document.createRange(); lines.selectNodeContents(title);
    return lines.getClientRects().length >= 3;
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('fullscreen-wrapped-song.png') });
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await expect(page.locator('.recognized-song')).toBeVisible();
  expect(await page.locator('.recognized-song').evaluate(strip => strip.getBoundingClientRect().top >= document.querySelector('.spectrum-panel').getBoundingClientRect().bottom)).toBe(true);
});

for (const reducedMotion of ['no-preference', 'reduce']) {
  test(`fullscreen microphone recovery stays readable over a song with motion ${reducedMotion}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({ reducedMotion });
    await setup(page);
    await page.getByRole('checkbox', { name: 'Identify song', exact: true }).click();
    await expect(page.locator('.song-title')).toHaveText(`${song.artist} — ${song.title}`);
  await expect(page.locator('.recognition-status')).toBeEmpty();
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    const strip = page.locator('.recognized-song');
    await expect(strip).toBeVisible();
    const clockStart = new Date('2026-01-01T00:00:00Z');
    await page.clock.install({ time: clockStart });
    // The installed clock runs between protocol calls. Pause in its future
    // before creating the notice, rather than racing the installation instant.
    await page.clock.pauseAt(new Date(clockStart.getTime() + 1000));
    await page.evaluate(() => {
      const track = window.recorder.stream.getAudioTracks()[0];
      track.stop();
      // stop() alone does not emit ended; model external microphone loss.
      track.dispatchEvent(new Event('ended'));
    });

    async function expectUncoveredNotice(selector, imageName) {
      const notice = page.locator(selector);
      await expect(notice).toBeInViewport({ ratio: 1 });
      const bounds = await notice.boundingBox(), songBounds = await strip.boundingBox();
      // This fixture actually overlaps the opaque song footer. Visibility
      // assertions alone would pass even if the footer covered the notice.
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(songBounds.y);
      const clip = { x: Math.ceil(bounds.x + 10), y: Math.ceil(bounds.y + 10),
        width: Math.floor(bounds.width - 20), height: Math.floor(bounds.height - 20) };
      const covered = await page.screenshot({ clip, animations: 'disabled', path: testInfo.outputPath(`${imageName}-with-song.png`) });
      // Preserve layout while removing only the footer's paint. A properly
      // stacked opaque recovery notice renders identically in both images.
      await strip.evaluate(element => { element.style.visibility = 'hidden'; });
      let uncovered;
      try {
        uncovered = await page.screenshot({ clip, animations: 'disabled', path: testInfo.outputPath(`${imageName}-without-song.png`) });
      } finally {
        await strip.evaluate(element => { element.style.removeProperty('visibility'); });
      }
      expect(covered.equals(uncovered), `${selector} must paint above the recognized song`).toBe(true);
    }

    await expect(page.locator('.audio-error')).toHaveText('Microphone input ended. Restart listening.');
    await expectUncoveredNotice('.audio-error', 'microphone-failure');
    await page.clock.runFor(4000);
    await expect(page.locator('.audio-error')).toBeEmpty();
    await expect(page.locator('.audio-stopped')).toHaveText('Audio stopped. Turn on Listening or use Play audio to restart.');
    await expectUncoveredNotice('.audio-stopped', 'microphone-restart');
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
    await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
    await expect(page.locator('.audio-stopped')).toBeEmpty();
    await expect(strip).toBeVisible();
  });
}

test('two opted-in tabs share one upload reservation without duplicate spending', async ({ page, context }) => {
  const second = await context.newPage();
  const firstUploads = await setup(page, { captureMs: 1200 });
  const secondUploads = await setup(second, { captureMs: 1200 });
  await Promise.all([
    page.getByRole('checkbox', { name: 'Identify song', exact: true }).check(),
    second.getByRole('checkbox', { name: 'Identify song', exact: true }).check(),
  ]);
  await expect.poll(() => firstUploads.length + secondUploads.length).toBe(1);
  await page.waitForTimeout(1500);
  expect(firstUploads.length + secondUploads.length).toBe(1);
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).uncheck();
  await second.getByRole('checkbox', { name: 'Identify song', exact: true }).uncheck();
  await second.close();
});

test('canceled pending microphone cannot replace recognition input after source switching', async ({ page }) => {
  const uploads = await setup(page, { routePath: '/advanced/' });
  const listening = page.getByRole('checkbox', { name: 'Listening', exact: true });
  await listening.uncheck();
  await page.evaluate(() => {
    window.pendingMicrophones = [];
    MediaDevices.prototype.getUserMedia = () => new Promise(resolve => {
      const destination = window.testContext.createMediaStreamDestination();
      pendingMicrophones.push({ stream: destination.stream, resolve });
    });
    window.recognitionInputs = [];
    document.querySelector('.audio-card').addEventListener('recognition-input', ({ detail }) => recognitionInputs.push(detail.stream));
  });
  await listening.check();
  await expect.poll(() => page.evaluate(() => pendingMicrophones.length)).toBe(1);
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.input-source').selectOption('microphone');
  await listening.check();
  await expect.poll(() => page.evaluate(() => pendingMicrophones.length)).toBe(2);
  await page.evaluate(() => pendingMicrophones[1].resolve(pendingMicrophones[1].stream));
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await page.evaluate(() => pendingMicrophones[0].resolve(pendingMicrophones[0].stream));
  await expect.poll(() => page.evaluate(() => pendingMicrophones[0].stream.getTracks()[0].readyState)).toBe('ended');
  expect(await page.evaluate(() => recognitionInputs.length)).toBe(1);
  await page.getByRole('checkbox', { name: 'Identify song', exact: true }).check();
  await expect.poll(() => uploads.length).toBe(1);
  expect(await page.evaluate(() => recorder.stream === pendingMicrophones[1].stream)).toBe(true);
  expect(await page.evaluate(() => recorder.stream.getAudioTracks()[0].readyState)).toBe('live');
  await expect(page.locator('.song-title')).toHaveText(`${song.artist} — ${song.title}`);
  await expect(listening).toBeChecked();
});
