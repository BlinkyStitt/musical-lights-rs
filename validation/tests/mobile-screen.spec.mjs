import { test, expect } from '@playwright/test';

async function swipe(page, dx, dy, cancel = false, multiTouch = false) {
  const graph = page.locator('#dancinglights');
  const box = await graph.boundingBox();
  const pointer = { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: box.x + box.width / 2, clientY: box.y + 30 };
  await graph.dispatchEvent('pointerdown', pointer);
  if (multiTouch) await graph.dispatchEvent('pointerdown', { ...pointer, pointerId: 2, isPrimary: false });
  if (cancel) await graph.dispatchEvent('pointercancel', pointer);
  await graph.dispatchEvent('pointerup', { ...pointer, clientX: pointer.clientX + dx, clientY: pointer.clientY + dy });
}

test('a tapped band shows its color and frequency above the graph for three seconds', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8101');
  await expect(page.getByRole('meter')).toHaveCount(24);
  // Use native timers: Playwright Clock returns IDs above the Web IDL i32
  // range, so a WASM clearTimeout cannot cancel those synthetic IDs.
  const bands = page.getByRole('meter');
  const readout = page.getByRole('tooltip');
  await bands.first().tap();
  await expect(readout).toBeVisible();
  await expect(readout).toHaveText('0–100 Hz');
  const swatch = readout.locator('.frequency-swatch');
  expect(await swatch.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(await bands.first().locator('.meter-fill').evaluate(node => getComputedStyle(node).backgroundColor));
  const box = await readout.boundingBox();
  const graph = await page.locator('#dancinglights').boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(graph.y);
  await page.waitForTimeout(1500);
  await expect(readout).toBeVisible();
  await bands.last().tap();
  const selectedAt = await page.evaluate(() => performance.now());
  await expect(readout).toHaveText('12000–15500 Hz');
  await page.waitForTimeout(2000);
  // The first tap's deadline has passed; it must not hide the second label.
  await expect(readout).toBeVisible();
  await expect(readout).toBeHidden({ timeout: 1500 });
  const elapsed = await page.evaluate(() => performance.now()) - selectedAt;
  expect(elapsed).toBeGreaterThanOrEqual(2900);
  expect(elapsed).toBeLessThan(3600);
  // Sticky touch hover or focus must not bring the expired readout back.
  await page.waitForTimeout(300);
  await expect(readout).toBeHidden();
  await bands.last().tap();
  await expect(readout).toBeVisible();
  await page.getByRole('link', { name: 'About', exact: true }).tap();
  await page.waitForTimeout(3100);
  expect(errors).toEqual([]);
});

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
  await expect(exit).toHaveCSS('clip-path', 'inset(50%)');
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
  }
  await page.screenshot({ path: 'test-results/iphone-lights-only.png' });
  expect(await page.evaluate(() => inputRequests)).toBe(1);
  expect(await page.evaluate(() => sourceStream.getTracks()[0].readyState)).toBe('live');
  // A tap, sideways drag, short drag, cancellation, or pinch cannot exit.
  for (const gesture of [[0, 0], [100, 90], [0, 79], [0, 100, true], [0, 100, false, true]]) {
    await swipe(page, ...gesture);
    await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
  }
  await swipe(page, 0, 100);
  await expect(page.locator('.site-header')).toBeVisible();
  await expect(page.locator('.calibration-controls')).toBeVisible();
  expect(await page.evaluate(() => scrollY)).toBe(initialScroll);
  await page.getByRole('button', { name: 'Stop listening' }).tap();
  expect(await page.evaluate(() => sourceStream.getTracks()[0].readyState)).toBe('ended');
  await page.evaluate(() => sourceContext.close());
  expect(errors).toEqual([]);
});

test('fullscreen frequency labels expire and keyboard users can reveal the exit control', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
  await page.goto('http://127.0.0.1:8101');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).tap();
  await expect(page.locator('.fullscreen-hint')).toBeVisible();
  await page.getByRole('meter').nth(12).tap();
  const readout = page.getByRole('tooltip');
  await expect(readout).toHaveText('1720–2000 Hz');
  await expect(readout).toBeInViewport({ ratio: 1 });
  const box = await readout.boundingBox();
  expect(box.y).toBeLessThan(40);
  await expect(readout).toBeHidden({ timeout: 3500 });
  await expect(page.locator('.fullscreen-hint')).toBeHidden();
  // Focus the first bar with the keyboard, then move back to the exit control.
  await page.getByRole('meter').first().focus();
  await page.keyboard.press('Shift+Tab');
  const exit = page.getByRole('button', { name: 'Exit fullscreen', exact: true });
  await expect(exit).toBeFocused();
  await expect(exit).toHaveCSS('clip-path', 'none');
  await expect(exit).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.site-header')).toBeVisible();
});

test('a rejected native fullscreen request still expands the page and Escape exits', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { value: true });
    Element.prototype.requestFullscreen = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await page.goto('http://127.0.0.1:8101');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start listening' })).toBeHidden();
  await expect(page.locator('.screen-error')).toBeEmpty();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Fullscreen', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start listening' })).toBeInViewport();
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
