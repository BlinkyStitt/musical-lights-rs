// Opt-in network smoke test. This does not establish physical iPhone audio routing.
import { test, expect } from '@playwright/test';
import { physicsReady, syntheticAudio } from '../physics-state.mjs';

test('live YouTube iframe reaches playback without opening the microphone', async ({ page }) => {
  test.skip(process.env.ML_LIVE_YOUTUBE !== '1', 'Invoke separately with ML_LIVE_YOUTUBE=1');
  test.setTimeout(60000);
  await syntheticAudio(page);
  await page.addInitScript(() => {
    window.micRequests = 0;
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => { window.micRequests++; return acquire(...args); };
  });
  await page.route('**/recognize', route => route.abort());
  await page.goto('http://127.0.0.1:8101/'); await physicsReady(page);
  await page.getByRole('button', { name: 'Video', exact: true }).click();
  // Google uses this video in its official iframe API example.
  await page.locator('.youtube-link').fill('https://www.youtube.com/watch?v=M7lc1UVf-VE');
  await page.getByRole('button', { name: 'Load video', exact: true }).click();
  await expect(page.locator('.youtube-status')).toBeEmpty({ timeout: 20000 });
  const frame = page.frameLocator('.youtube-frame iframe');
  await frame.getByRole('button', { name: /^Play/ }).first().click();
  await expect.poll(() => page.evaluate(() => document.querySelector('.audio-card').presentation.player.getPlayerState()), { timeout: 20000 }).toBe(1);
  expect(await page.evaluate(() => window.micRequests)).toBe(0);
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).not.toBeChecked();
  await page.screenshot({ path: test.info().outputPath('live-youtube.png') });
});
