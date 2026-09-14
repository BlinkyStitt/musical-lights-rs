import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { value: false });
    window.pointerLog = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
      document.addEventListener(type, event => pointerLog.push({ type, trusted: event.isTrusted, target: event.target.className, y: event.clientY, primary: event.isPrimary, button: event.button }), true);
    }
  });
});

async function touchInput(page, context) {
  const box = await page.getByRole('meter').nth(4).boundingBox();
  const session = await context.newCDPSession(page);
  const point = { x: Math.round(box.x + box.width / 2), y: box.y + box.height - 200, id: 1 };
  const send = (type, touchPoints) => session.send('Input.dispatchTouchEvent', { type, touchPoints });
  const move = async (dx, dy) => {
    for (let step = 1; step <= 10; step++) {
      await send('touchMove', [{ ...point, x: point.x + dx * step / 10, y: point.y + dy * step / 10 }]);
    }
  };
  const label = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).closest('[role=meter]').getAttribute('aria-label'), point);
  return { point, send, move, label };
}

test('a browser touch swipe across a live bar exits before release without a frequency readout', async ({ page, context }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.inputRequests = 0;
    MediaDevices.prototype.getUserMedia = async () => {
      inputRequests++;
      const source = new AudioContext();
      const oscillator = source.createOscillator();
      const destination = source.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start(); await source.resume();
      window.sourceContext = source; window.sourceStream = destination.stream;
      return destination.stream;
    };
  });
  await page.goto('http://127.0.0.1:8101');
  await page.getByRole('button', { name: 'Start listening' }).tap();
  await expect.poll(() => page.getByRole('meter').nth(4).getAttribute('aria-valuenow')).toMatch(/^[3-9]\d$|^100$/);
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).tap();
  const { point, send, move } = await touchInput(page, context);
  await page.evaluate(() => { pointerLog.length = 0; });
  await send('touchStart', [point]);
  await expect(page.getByRole('tooltip')).toBeHidden();
  await move(20, 80);
  // Exit while the finger is still down; do not depend on pointerup arriving.
  await expect(page.locator('.site-header')).toBeVisible();
  await send('touchEnd', []);
  await expect(page.getByRole('tooltip')).toBeHidden();
  const events = await page.evaluate(() => pointerLog);
  expect(events[0].target).toBe('meter');
  expect(events.every(event => event.trusted)).toBe(true);
  expect(events.some(event => event.type === 'gotpointercapture')).toBe(true);
  expect(events.some(event => event.type === 'lostpointercapture')).toBe(true);
  expect(events.some(event => event.type === 'pointercancel')).toBe(false);
  expect(await page.evaluate(() => inputRequests)).toBe(1);
  expect(await page.evaluate(() => sourceStream.getTracks()[0].readyState)).toBe('live');
  // Lift and move the finger from the graph to the controls. Linux Chromium
  // suppresses an immediately injected post-swipe tap even on a plain page;
  // a separate gesture after 200 ms delivers the click. Allow 50 ms margin.
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Stop listening' }).tap();
  await expect(page.getByRole('button', { name: 'Start listening' })).toBeVisible();
  expect(await page.evaluate(() => sourceStream.getTracks()[0].readyState)).toBe('ended');
  await page.evaluate(() => sourceContext.close());
  expect(errors).toEqual([]);
});

test('only a completed tap shows a frequency; short and sideways drags do not', async ({ page, context }) => {
  await page.goto('http://127.0.0.1:8101');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).tap();
  const { point, send, move, label } = await touchInput(page, context);
  const readout = page.getByRole('tooltip');
  await send('touchStart', [point]);
  await expect(readout).toBeHidden();
  await send('touchEnd', []);
  await expect(readout).toHaveText(label);
  for (const [dx, dy] of [[0, 79], [100, 90], [0, -80]]) {
    await send('touchStart', [point]);
    await expect(readout).toBeHidden();
    await move(dx, dy);
    // Moving back to the starting point must not turn a drag into a tap.
    await send('touchMove', [point]);
    await send('touchEnd', []);
    await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
    await expect(readout).toBeHidden();
  }
});

test('canceled and multi-touch gestures cannot exit or select a band', async ({ page, context }) => {
  await page.goto('http://127.0.0.1:8101');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).tap();
  const { point, send, move } = await touchInput(page, context);
  await send('touchStart', [point]);
  await move(0, 40);
  await send('touchCancel', []);
  await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
  await expect(page.getByRole('tooltip')).toBeHidden();
  await send('touchStart', [point]);
  const second = { ...point, id: 2, x: point.x + 80 };
  await send('touchStart', [point, second]);
  await send('touchMove', [{ ...point, y: point.y + 120 }, { ...second, y: second.y + 120 }]);
  await send('touchEnd', []);
  await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
  await expect(page.getByRole('tooltip')).toBeHidden();
  // A fresh single-finger swipe still works after cancellation.
  await send('touchStart', [point]);
  await move(0, 100);
  await expect(page.locator('.site-header')).toBeVisible();
  await send('touchEnd', []);
});

test('touch scrolling the normal page does not trigger a band tap', async ({ page, context }) => {
  await page.goto('http://127.0.0.1:8101');
  const { point, send, move } = await touchInput(page, context);
  await send('touchStart', [point]);
  await move(0, -100);
  await send('touchEnd', []);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await expect(page.getByRole('tooltip')).toBeHidden();
  await expect(page.locator('[data-expanded]')).toHaveCount(0);
});
