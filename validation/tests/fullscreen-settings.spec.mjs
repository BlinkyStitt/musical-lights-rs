import { test, expect } from '@playwright/test';
import { normalView, physicsReady } from '../physics-state.mjs';
const origin = 'http://127.0.0.1:8101';

for (const path of ['/', '/advanced/']) {
  test(`fullscreen settings cover only the top half and preserve the scene on ${path}`, async ({ page }, info) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      Object.defineProperty(document, 'fullscreenEnabled', { value: false });
      window.micRequests = 0;
      MediaDevices.prototype.getUserMedia = async () => { window.micRequests++; throw new Error('Test microphone denied'); };
    });
    await page.goto(origin + path); await physicsReady(page);
    await normalView(page);
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    // The entry action still requests Listening. Opening settings adds no input.
    await expect.poll(() => page.evaluate(() => micRequests)).toBe(1);
    await expect(page.locator('.listening-toggle')).toBeEnabled();
    await expect(page.locator('.audio-error')).toBeEmpty({ timeout: 5000 });
    for (const viewport of [{ width: 390, height: 844 }, { width: 568, height: 320 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.evaluate(() => {
        const v = document.querySelector('#dancinglights').physics;
        return v.canvasHeight === v.layer.getBoundingClientRect().height;
      })).toBe(true);
      const before = await page.evaluate(() => {
        const v = document.querySelector('#dancinglights').physics;
        window.modalIdentity = { worker: v.worker, renderer: v.renderer, controls: document.querySelector('.listening-toggle'), render: v.renderer.render };
        v.renderer.render = () => {};
        const box = v.layer.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, enclosure: v.input[32] };
      });
      const clip = { x: 0, y: Math.ceil(viewport.height / 2), width: viewport.width, height: Math.floor(viewport.height / 2) };
      const uncovered = await page.screenshot({ clip });
      const settings = page.getByRole('button', { name: 'Settings', exact: true });
      await settings.click();
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      await expect(dialog).toBeVisible();
      await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      expect(await dialog.evaluate(n => n.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toBeFocused();
      const box = await dialog.boundingBox();
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height / 2);
      expect((await page.screenshot({ clip })).equals(uncovered), 'bottom-half pixels remain visible through the modal backdrop').toBe(true);
      for (const selector of ['.listening-toggle', '.identify-song', '.motion-button', '.scroll-lights', '.camera-rotation', '.depth-slider', '.display-controls > summary', '.visual-gain-mode']) {
        if (selector === '.visual-gain-mode' && !await page.locator('.audio-tuning').evaluate(n => n.closest('details').open)) await page.getByText('Audio response & readouts', { exact: true }).click();
        await page.locator(selector).scrollIntoViewIfNeeded();
        await expect(page.locator(selector)).toBeInViewport();
        expect(await page.locator(selector).evaluate(n => !!n.closest('dialog'))).toBe(true);
      }
      await page.locator('.camera-rotation').fill('17');
      await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.cameraBase)).toBe(17);
      await page.locator('.fullscreen-settings-body').evaluate(n => { n.scrollTop = n.scrollHeight; });
      await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => {
        const card = document.querySelector('.audio-card'), v = card.querySelector('#dancinglights').physics, box = v.layer.getBoundingClientRect();
        card.scrollTop = 1000;
        return { same: v.worker === modalIdentity.worker && v.renderer === modalIdentity.renderer && card.querySelector('.listening-toggle') === modalIdentity.controls,
          scroll: card.scrollTop, requests: micRequests, geometry: { x: box.x, y: box.y, width: box.width, height: box.height, enclosure: v.input[32] } };
      })).toEqual({ same: true, scroll: 0, requests: 1, geometry: before });
      await page.screenshot({ path: info.outputPath(`modal-${viewport.width}.png`) });
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
      await expect(settings).toBeFocused();
      await settings.click();
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await page.evaluate(() => { document.querySelector('#dancinglights').physics.renderer.render = modalIdentity.render; });
    }
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await expect(page.locator('.scene-controls')).toBeVisible();
    await expect(page.locator('.camera-rotation')).toHaveValue('17');
    expect(await page.evaluate(() => document.querySelector('.listening-toggle') === modalIdentity.controls)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('settings close on native browser exit and route cleanup', async ({ page }, info) => {
  await page.addInitScript(() => {
    const Context = window.AudioContext;
    window.AudioContext = class extends Context { constructor(...args) { super(...args); window.modalContext = this; } };
  });
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.review-start').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await page.evaluate(() => { window.modalSession = { context: modalContext, id: document.querySelector('#dancinglights').physics.report.audioState.sessionId }; });
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  if (info.project.name === 'chromium') {
    expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await page.evaluate(() => document.exitFullscreen());
  } else {
    // iPhone has page expansion without the native API. Use its screen owner.
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  }
  await expect(page.locator('.audio-card')).not.toHaveAttribute('data-expanded', '');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.input-source')).toHaveValue('generated');
  expect(await page.evaluate(() => ({ same: modalContext === modalSession.context, state: modalContext.state, id: document.querySelector('#dancinglights').physics.report.audioState.sessionId }))).toEqual({ same: true, state: 'running', id: await page.evaluate(() => modalSession.id) });
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.evaluate(() => { window.oldModal = document.querySelector('dialog'); document.querySelector('nav a[href="/about"]').click(); });
  await expect(page.locator('.audio-card')).toHaveCount(0);
  expect(await page.evaluate(() => oldModal.open || oldModal.isConnected)).toBe(false);
  expect(await page.evaluate(() => modalSession.context.state)).toBe('closed');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe('hidden');
  await page.getByRole('link', { name: 'Home', exact: true }).click(); await physicsReady(page);
  await expect(page.locator('dialog')).toHaveCount(1);
});


test('Escape respects focused controls, closes Settings, and exits with action help open', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await page.locator('.input-source').selectOption('generated');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  const input = page.locator('.camera-rotation');
  // A focused editor can consume Escape before the dialog's native cancel.
  await input.evaluate(node => node.addEventListener('keydown', event => {
    if (event.key === 'Escape') event.preventDefault();
  }, { once: true }));
  await input.focus(); await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
  await page.getByRole('button', { name: 'Close settings', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).focus();
  await expect(page.locator('.control-help')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.audio-card')).not.toHaveAttribute('data-expanded', '');
  await expect(page.locator('.control-help')).not.toBeVisible();
  await expect(page.locator('.listening-toggle')).toBeVisible();
});
