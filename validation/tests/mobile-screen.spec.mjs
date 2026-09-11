import { test, expect } from '@playwright/test';

test('iPhone fullscreen shows only the live lights without the native API', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { value: false });
    Element.prototype.requestFullscreen = undefined;
    window.inputRequests = 0;
    MediaDevices.prototype.getUserMedia = async () => {
      window.inputRequests++;
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start(); await context.resume();
      window.sourceContext = context; window.sourceStream = destination.stream;
      return destination.stream;
    };
  });
  await page.goto('http://127.0.0.1:8101');
  const expand = page.getByRole('button', { name: 'Fullscreen', exact: true });
  await expect(expand).toBeEnabled();
  await page.getByRole('button', { name: 'Start listening' }).tap();
  await expect.poll(() => page.getByRole('meter').evaluateAll(nodes => nodes.some(node => Number(node.getAttribute('aria-valuenow')) > 0))).toBe(true);
  const initialScroll = await page.evaluate(() => scrollY);
  await expand.tap();
  const exit = page.getByRole('button', { name: 'Exit fullscreen', exact: true });
  await expect(exit).toBeVisible();
  await expect(page.locator('.site-header')).toBeHidden();
  await expect(page.locator('.calibration-controls')).toBeHidden();
  await expect(page.locator('.control-note')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Stop listening' })).toBeHidden();
  await expect(page.locator('#dancinglights')).toBeInViewport({ ratio: 1 });
  for (const viewport of [{ width: 390, height: 664 }, { width: 844, height: 390 }, { width: 390, height: 664 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => (await page.locator('.audio-card').boundingBox()).height).toBe(viewport.height);
    const graph = await page.locator('#dancinglights').boundingBox();
    expect(graph.height).toBeGreaterThan(viewport.height * .9);
    await expect(exit).toBeInViewport({ ratio: 1 });
  }
  await page.screenshot({ path: 'test-results/iphone-lights-only.png' });
  expect(await page.evaluate(() => inputRequests)).toBe(1);
  expect(await page.evaluate(() => sourceStream.getTracks()[0].readyState)).toBe('live');
  await exit.tap();
  await expect(page.locator('.site-header')).toBeVisible();
  await expect(page.locator('.calibration-controls')).toBeVisible();
  expect(await page.evaluate(() => scrollY)).toBe(initialScroll);
  await page.getByRole('button', { name: 'Stop listening' }).tap();
  expect(await page.evaluate(() => sourceStream.getTracks()[0].readyState)).toBe('ended');
  await page.evaluate(() => sourceContext.close());
  expect(errors).toEqual([]);
});

test('a rejected native fullscreen request still expands the page and Escape exits', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { value: true });
    Element.prototype.requestFullscreen = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await page.goto('http://127.0.0.1:8101');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
  // Starting audio remains possible if the user expands before enabling the mic.
  await expect(page.getByRole('button', { name: 'Start listening' })).toBeInViewport();
  await expect(page.locator('.screen-error')).toBeEmpty();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Fullscreen', exact: true })).toBeVisible();
  await expect(page.locator('.site-header')).toBeVisible();
});

test('browser back closes the expanded view and restores the page', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { value: false });
  });
  await page.goto('http://127.0.0.1:8101/about');
  await page.getByRole('link', { name: 'Home', exact: true }).tap();
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).tap();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
  await page.goBack();
  await expect(page.locator('.site-header')).toBeVisible();
  await expect(page.locator('[data-expanded]')).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe('hidden');
});
