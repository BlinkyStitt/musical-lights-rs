import { test, expect } from '@playwright/test';

test('unsupported native screen APIs still allow the lights-only view', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'wakeLock', { value: undefined });
    Object.defineProperty(document, 'fullscreenEnabled', { value: false });
  });
  await page.goto('http://127.0.0.1:8101');
  await expect(page.locator('.wake-status')).toHaveText('Screen wake lock unavailable');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeEnabled();
  await expect(page.getByRole('meter')).toHaveCount(24);
});

test('the mounted view owns its wake lock independently of microphone permission', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.screenLocks = [];
    Object.defineProperty(navigator, 'wakeLock', { value: { request: async () => {
      const lock = new EventTarget(); lock.released = false;
      lock.release = async () => { lock.released = true; lock.dispatchEvent(new Event('release')); };
      window.screenLocks.push(lock); return lock;
    } } });
    MediaDevices.prototype.getUserMedia = async () => { throw new DOMException('Microphone denied', 'NotAllowedError'); };
  });
  await page.goto('http://127.0.0.1:8101');
  await expect(page.locator('.wake-status')).toHaveText('Screen stays awake');
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Microphone denied');
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).not.toBeChecked();
  expect(await page.evaluate(() => screenLocks[0].released)).toBe(false);
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect.poll(() => page.evaluate(() => screenLocks[0].released)).toBe(true);
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('.wake-status')).toHaveText('Screen stays awake');
  expect(await page.evaluate(() => screenLocks.map(lock => lock.released))).toEqual([true, false]);
  expect(errors).toEqual([]);
});

test('native wake-lock status matches the browser grant and releases on route close', async ({ page }) => {
  await page.addInitScript(() => {
    const request = navigator.wakeLock.request.bind(navigator.wakeLock);
    navigator.wakeLock.request = async type => {
      try {
        window.nativeLock = await request(type);
        window.nativeLockResult = 'granted';
        return window.nativeLock;
      } catch (error) {
        window.nativeLockResult = `${error.name}: ${error.message}`;
        throw error;
      }
    };
  });
  await page.goto('http://127.0.0.1:8101');
  await expect.poll(() => page.evaluate(() => typeof nativeLockResult)).toBe('string');
  const result = await page.evaluate(() => nativeLockResult);
  console.log(`Native screen wake lock: ${result}`);
  await expect(page.locator('.wake-status')).toHaveText(result === 'granted' ? 'Screen stays awake' : 'Screen may sleep');
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeEnabled();
  if (result === 'granted') expect(await page.evaluate(() => nativeLock.released)).toBe(false);
  await page.getByRole('link', { name: 'About', exact: true }).click();
  if (result === 'granted') await expect.poll(() => page.evaluate(() => nativeLock.released)).toBe(true);
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
  test(`fullscreen expands the live graph and follows browser exits at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript(() => {
      MediaDevices.prototype.getUserMedia = async () => {
        const context = new AudioContext(); const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start(); await context.resume();
        window.sourceContext = context; window.sourceStream = destination.stream;
        return destination.stream;
      };
    });
    await page.goto('http://127.0.0.1:8101');
    await page.requestGC();
    await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
    await expect.poll(() => page.getByRole('meter').evaluateAll(nodes => nodes.some(node => Number(node.getAttribute('aria-valuenow')) > 0))).toBe(true);
    const before = await page.locator('#dancinglights').boundingBox();
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.className)).toBe('audio-card');
    const card = await page.locator('.audio-card').boundingBox();
    expect(card).toEqual({ x: 0, y: 0, ...viewport });
    await expect(page.locator('#dancinglights')).toBeInViewport({ ratio: 1 });
    expect((await page.locator('#dancinglights').boundingBox()).height).toBeGreaterThan(before.height + 100);
    for (const name of ['Listening', 'Phone motion', 'Scroll lights', 'Identify song']) {
      await expect(page.getByRole('checkbox', { name, exact: true })).toBeVisible();
    }
    await expect(page.locator('.control-note')).toBeHidden();
    await expect(page.locator('.wake-status')).toBeHidden();
    await expect(page.locator('.diagnostic-fps')).toHaveCount(0);
    await expect(page.locator('.frame-rate')).toHaveText(/^\d+ FPS$/);
    await expect(page.locator('.frame-rate')).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.site-header')).toBeHidden();
    for (const colorScheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `test-results/fullscreen-${viewport.width}-${colorScheme}.png` });
    }
    // Keep the real exit button available to touch users in the fullscreen view.
    await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
    await page.mouse.move(viewport.width / 2, 80);
    await page.mouse.down();
    await page.mouse.move(viewport.width / 2, 200, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByRole('button', { name: 'Fullscreen', exact: true })).toBeVisible();
    await expect(page.locator('.frame-rate, .diagnostic-fps')).toHaveCount(0);
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.className)).toBe('audio-card');
    // Native browser exit emits the same event as Escape or browser controls.
    await page.evaluate(() => document.exitFullscreen());
    await expect(page.getByRole('button', { name: 'Fullscreen', exact: true })).toBeVisible();
    expect(await page.evaluate(() => sourceStream.getTracks()[0].readyState)).toBe('live');
    await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
    expect(await page.evaluate(() => sourceStream.getTracks()[0].readyState)).toBe('ended');
    await page.evaluate(() => sourceContext.close());
  });
}
