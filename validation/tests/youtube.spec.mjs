import { test, expect } from '@playwright/test';
import { physicsReady, syntheticAudio } from '../physics-state.mjs';
const origin = 'http://127.0.0.1:8101';

async function setup(page, path = '/') {
  await syntheticAudio(page);
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { value: false });
    window.micRequests = 0;
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => { window.micRequests++; return acquire(...args); };
    let type = 'auto'; window.audioTypes = [];
    Object.defineProperty(navigator, 'audioSession', { configurable: true, value: { get type() { return type; }, set type(value) { type = value; window.audioTypes.push(value); } } });
    window.YT = { Player: class {
      constructor(frame, options) { this.frame = frame; this.options = options; window.videoPlayer = this; setTimeout(() => options.events.onReady({ target: this }), 0); }
      playVideo() { this.options.events.onStateChange({ data: 1 }); }
      pauseVideo() { this.options.events.onStateChange({ data: 2 }); }
      destroy() { this.destroyed = true; this.frame.remove(); }
    } };
  });
  await page.route('https://www.youtube-nocookie.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="background:#142b40;color:white">Mock YouTube player</body>' }));
  await page.route('https://www.youtube.com/**', route => route.abort());
  await page.goto(origin + path); await physicsReady(page);
}
async function load(page) {
  await page.getByRole('button', { name: 'Video', exact: true }).click();
  await page.locator('.youtube-link').fill('https://youtu.be/abcDEF012_-?t=1m23s');
  await page.getByRole('button', { name: 'Load video', exact: true }).click();
  await expect(page.locator('.youtube-status')).toBeEmpty();
  await expect(page.locator('.youtube-frame iframe')).toBeVisible();
}
for (const path of ['/', '/advanced/']) {
  test(`YouTube loads without microphone capture and reserves fullscreen regions on ${path}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 }); await setup(page, path); await load(page);
    expect(await page.evaluate(() => window.micRequests)).toBe(0);
    await expect(page.locator('.youtube-frame iframe')).toHaveAttribute('src', /start=83/);
    await expect(page.locator('.youtube-frame iframe')).toHaveAttribute('credentialless', '');
    await expect(page.locator('.youtube-frame iframe')).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    await page.evaluate(() => window.videoPlayer.playVideo());
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
    expect(await page.evaluate(() => window.micRequests)).toBe(1);
    expect(await page.evaluate(() => document.querySelector('.audio-card').presentation.videoPlaying)).toBe(true);
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(async () => page.evaluate(() => {
        const video = document.querySelector('.youtube-frame').getBoundingClientRect(), scene = document.querySelector('.balloon-layer').getBoundingClientRect(), controls = document.querySelector('.audio-controls').getBoundingClientRect();
        const portrait = innerHeight > innerWidth;
        return { minimum: video.width >= 200 && video.height >= 200, bounded: scene.bottom <= controls.top, separated: portrait ? video.bottom <= scene.top : video.right <= scene.left, fits: document.documentElement.scrollWidth <= innerWidth };
      })).toEqual({ minimum: true, bounded: true, separated: true, fits: true });
      await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeInViewport({ ratio: 1 });
      await expect.poll(() => page.evaluate(() => {
        const v = document.querySelector('#dancinglights').physics;
        return Math.abs(v.current[1] - v.height);
      })).toBeLessThan(.005);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: testInfo.outputPath(`youtube-${viewport.width}.png`) });
    }
    expect(await page.evaluate(() => window.videoPlayer.destroyed ?? false)).toBe(false);
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await page.getByRole('link', { name: 'About', exact: true }).click();
    expect(await page.evaluate(() => window.videoPlayer.destroyed)).toBe(true);
    expect(await page.evaluate(() => navigator.audioSession.type)).toBe('auto');
  });
}
test('speaker playback and microphone capture share an audio session, and stopping Listening leaves playback active', async ({ page }) => {
  await setup(page); await load(page); await page.evaluate(() => window.videoPlayer.playVideo());
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('playback');
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('play-and-record');
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('playback');
  expect(await page.evaluate(() => window.videoPlayer.destroyed ?? false)).toBe(false);
  await page.getByRole('button', { name: 'Video', exact: true }).click();
  await page.locator('.youtube-link').fill('https://example.com/video');
  await page.getByRole('button', { name: 'Load video', exact: true }).click();
  await expect(page.locator('.youtube-status')).toContainText('Use a link to one YouTube video');
  // A rejected replacement must not invalidate the current player's callbacks.
  await page.evaluate(() => window.videoPlayer.pauseVideo());
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('auto');
});
test('help labels explain state without toggling; preferences restore without starting capture', async ({ page }) => {
  await setup(page); await page.locator('[data-help="listening-toggle"]').click();
  await expect(page.locator('.control-help')).toContainText('Microphone: off');
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).not.toBeChecked();
  await page.keyboard.press('Escape'); await expect(page.locator('.control-help')).toBeHidden();
  await page.locator('.display-controls > summary').click(); await page.locator('.direction-chance').fill('24'); await page.locator('.direction-chance').dispatchEvent('change');
  await page.locator('.camera-motion').uncheck(); await page.locator('.camera-rotation').fill('25'); await page.locator('.scroll-lights').uncheck();
  await page.reload(); await physicsReady(page); await page.locator('.display-controls > summary').click();
  await expect(page.locator('.direction-chance')).toHaveValue('24');
  await expect(page.locator('.camera-motion')).not.toBeChecked(); await expect(page.locator('.scroll-lights')).not.toBeChecked();
  await expect(page.locator('.camera-rotation')).toHaveValue('25');
  expect(await page.evaluate(() => window.micRequests)).toBe(0);
});
test('camera slider tracks the rendered view and Reduced Motion removes automatic motion', async ({ page }) => {
  await setup(page);
  await expect.poll(() => page.evaluate(() => Math.abs(Number(document.querySelector('.camera-rotation').value) - document.querySelector('#dancinglights').physics.rotation))).toBeLessThan(1);
  await page.evaluate(() => { window.cameraBefore = document.querySelector('#dancinglights').physics.rotation; });
  await expect.poll(() => page.evaluate(() => Math.abs(document.querySelector('#dancinglights').physics.rotation - window.cameraBefore)), { timeout: 3000 }).toBeGreaterThan(.2);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.rotation)).toBe(0);
  await expect(page.locator('.camera-rotation')).toHaveValue('0');
});
