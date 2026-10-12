import { test, expect } from '@playwright/test';
import { physicsReady, scrollingIntersections } from '../physics-state.mjs';

const origin = 'http://127.0.0.1:8101';

test('phone opens expanded without capture and allows scrolling to notices, song and Exit in short landscape', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => { window.micRequests = 0; MediaDevices.prototype.getUserMedia = async () => { window.micRequests++; throw Error('Unexpected automatic capture'); }; });
    for (const route of ['/', '/advanced/']) {
      await page.goto(origin + route); await physicsReady(page);
      await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
      expect(await page.evaluate(() => [window.micRequests, document.fullscreenElement])).toEqual([0, null]);
      await page.evaluate(() => {
        const card = document.querySelector('.audio-card'); card.classList.add('video-active');
        const panel = card.querySelector('.video-panel'); panel.hidden = false;
        panel.querySelector('.youtube-frame').innerHTML = '<iframe title="Layout fixture" src="about:blank"></iframe>';
        card.querySelector('#dancinglights').physics.notice.show('Graphics recovery notice.', 'Graphics recovery notice.');
        const title = card.querySelector('.recognized-song'); title.hidden = false;
        title.querySelector('.song-title').textContent = 'An artist with a long name — A long song title '.repeat(4);
      });
      for (const viewport of [{ width: 393, height: 852 }, { width: 568, height: 320 }]) {
        await page.setViewportSize(viewport);
        const selectors = ['label:has(.listening-toggle)', 'label:has(.identify-song)',
          'label:has(.motion-button)', 'label:has(.scroll-lights)', '.fullscreen-button',
          '.physics-status', '.frame-rate', '.camera-rotation'];
        expect(await scrollingIntersections(page, selectors)).toEqual(Object.fromEntries(selectors.map(selector => [selector, 1])));
        expect(await page.evaluate(() => {
          const camera = document.querySelector('.camera-controls').getBoundingClientRect();
          const controls = document.querySelector('.audio-controls').getBoundingClientRect();
          const slider = document.querySelector('.camera-rotation'), box = slider.getBoundingClientRect();
          return { separate: camera.bottom <= controls.top, touchSize: box.height >= 44,
            aligned: Math.abs(box.y + box.height / 2 - camera.y - camera.height / 2) < 1,
            touchable: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === slider };
        })).toEqual({ separate: true, touchSize: true, aligned: true, touchable: true });
        await page.locator('.camera-rotation').fill('30');
        await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.cameraBase)).toBe(30);
        await page.keyboard.press('ArrowLeft');
        await expect.poll(() => page.evaluate(() => ({
          angle: document.querySelector('#dancinglights').physics.cameraBase,
          sceneLarge: document.querySelector('#dancinglights').getBoundingClientRect().height >= 200,
          fps: /^\d+ FPS$/.test(document.querySelector('.frame-rate').textContent),
        }))).toEqual({ angle: 29, sceneLarge: true, fps: true });
      }
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
      await expect(page.locator('.audio-card')).not.toHaveAttribute('data-expanded', '');
      await page.setViewportSize({ width: 393, height: 852 });
    }
  } finally { await context.close(); }
});
