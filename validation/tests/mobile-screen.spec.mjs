import { test, expect } from '@playwright/test';
import { physicsReady, physicsState } from '../physics-state.mjs';
import { meterPoint } from '../meter-input.mjs';

test('iPhone sensor denial preserves mouse input and gravity continues after Stop', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.sensorRequests = [];
    for (const name of ['DeviceMotionEvent', 'DeviceOrientationEvent']) {
      Object.defineProperty(window[name], 'requestPermission', { value: () => {
        window.sensorRequests.push({ name, active: navigator.userActivation.isActive });
        return Promise.resolve('denied');
      } });
    }
    MediaDevices.prototype.getUserMedia = async () => {
      const context = new AudioContext();
      window.balloonSourceContext = context;
      return context.createMediaStreamDestination().stream;
    };
  });
  await page.goto('http://127.0.0.1:8101');
  await page.getByRole('button', { name: 'Start listening' }).tap();
  await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
  const calls = await page.evaluate(() => window.sensorRequests);
  expect(calls).toHaveLength(2);
  expect(calls.every(call => call.active)).toBe(true);
  await physicsReady(page);
  const box = await page.locator('canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.input[27])).toBe(1);
  await page.getByRole('button', { name: 'Stop listening' }).tap();
  await page.mouse.move(0, 0);
  const stopped = await physicsState(page);
  await expect.poll(async () => (await physicsState(page)).tick).toBeGreaterThan(stopped.tick + 10);
  await expect.poll(async () => (await physicsState(page)).balls.some((ball, i) => Math.abs(ball.position[1] - stopped.balls[i].position[1]) > .005)).toBe(true);
  await expect(page.getByRole('alert')).toBeEmpty();
  await page.evaluate(() => window.balloonSourceContext.close());
  expect(errors).toEqual([]);
});

async function drag(page, dx, dy) {
  // Playwright's WebKit transport supports touch taps, but no touch drags.
  // Exercise native pointer capture here with a mouse; touch-screen covers
  // trusted touch streams, cancellation, and multi-touch in Chromium.
  const box = await page.getByRole('meter').nth(12).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + 150;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
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
  const firstHit = await meterPoint(page, bands.first());
  await page.touchscreen.tap(firstHit.x, firstHit.y);
  await expect(readout).toBeVisible();
  await expect(readout).toHaveText(firstHit.label);
  const swatch = readout.locator('.frequency-swatch');
  const renderedColor = (await swatch.evaluate(node => getComputedStyle(node).backgroundColor)).match(/[\d.]+/g).map(Number);
  firstHit.color.match(/[\d.]+/g).map(Number).forEach((channel, i) => expect(renderedColor[i]).toBeCloseTo(channel, 5));
  const box = await readout.boundingBox();
  const graph = await page.locator('#dancinglights').boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(graph.y);
  await page.waitForTimeout(1500);
  await expect(readout).toBeVisible();
  const lastHit = await meterPoint(page, bands.last());
  await page.touchscreen.tap(lastHit.x, lastHit.y);
  const selectedAt = await page.evaluate(() => performance.now());
  await expect(readout).toHaveText(lastHit.label);
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
  await page.touchscreen.tap(lastHit.x, lastHit.y);
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
  }
  await page.screenshot({ path: 'test-results/iphone-lights-only.png' });
  expect(await page.evaluate(() => inputRequests)).toBe(1);
  expect(await page.evaluate(() => sourceStream.getTracks()[0].readyState)).toBe('live');
  // A tap, sideways drag, or short drag cannot exit.
  for (const gesture of [[0, 0], [100, 90], [0, 79]]) {
    await drag(page, ...gesture);
    await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
  }
  // Use the fixed Exit control in the top tap area. Safari can suppress
  // document-level gesture events after it changes the viewport.
  await exit.tap();
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
  const hit = await meterPoint(page, page.getByRole('meter').nth(12));
  await page.touchscreen.tap(hit.x, hit.y);
  const readout = page.getByRole('tooltip');
  await expect(readout).toHaveText(hit.label);
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
