import { test, expect } from '@playwright/test';
import { VisualizerScreen } from '../../musical-leptos/src/screen.js';

function sentinel() {
  const lock = new EventTarget();
  lock.released = false;
  lock.releases = 0;
  lock.release = async () => {
    lock.releases++;
    lock.released = true;
    lock.dispatchEvent(new Event('release'));
  };
  return lock;
}

function environment(request = async () => sentinel()) {
  const document = new EventTarget();
  const changes = [];
  const requests = [];
  document.hidden = false;
  document.fullscreenEnabled = true;
  document.fullscreenElement = null;
  document.defaultView = { navigator: { wakeLock: { request: type => {
    requests.push(type);
    return request();
  } } } };
  document.exitFullscreen = async () => {
    document.fullscreenElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  };
  const attributes = new Set();
  const element = Object.assign(new EventTarget(), { ownerDocument: document, toggleAttribute: (name, enabled) => enabled ? attributes.add(name) : attributes.delete(name), requestFullscreen: async () => {
    document.fullscreenElement = element;
    document.dispatchEvent(new Event('fullscreenchange'));
  } });
  const screen = new VisualizerScreen(element, (awake, full, error) => changes.push({ awake, full, error }), () => {});
  const visible = value => {
    document.hidden = !value;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  return { document, element, screen, changes, requests, visible, attributes };
}

test('screen lock follows visibility and closes without later callbacks', async () => {
  const locks = [];
  const env = environment(async () => { const lock = sentinel(); locks.push(lock); return lock; });
  await expect.poll(() => env.changes.at(-1).awake).toBe('Screen stays awake');
  expect(env.requests).toEqual(['screen']);
  env.visible(false);
  expect(locks[0].released).toBe(true);
  expect(env.changes.at(-1).awake).toBe('Screen may sleep');
  env.visible(true);
  await expect.poll(() => env.changes.at(-1).awake).toBe('Screen stays awake');
  expect(env.requests).toEqual(['screen', 'screen']);
  await locks[1].release(); // A system release must report the loss, not retry forever.
  expect(env.changes.at(-1).awake).toBe('Screen may sleep');
  expect(env.requests).toHaveLength(2);
  env.visible(false); env.visible(true);
  await expect.poll(() => locks.length).toBe(3);
  env.screen.close();
  expect(locks[2].released).toBe(true);
  const count = env.changes.length;
  env.visible(false); env.visible(true);
  env.document.dispatchEvent(new Event('fullscreenchange'));
  await Promise.resolve();
  expect(env.changes).toHaveLength(count);
  expect(env.requests).toHaveLength(3);
});

test('a rejected wake request leaves fullscreen available without retry loops', async () => {
  const env = environment(async () => { throw new DOMException('Power saving', 'NotAllowedError'); });
  await expect.poll(() => env.changes.at(-1).awake).toBe('Screen may sleep');
  expect(env.changes.at(-1).error).toBe('');
  await env.screen.toggleFullscreen();
  expect(env.changes.at(-1).full).toBe(true);
  expect(env.requests).toEqual(['screen']);
  env.screen.close();
});

test('late wake grants close immediately after the view closes', async () => {
  let resolve;
  const env = environment(() => new Promise(done => { resolve = done; }));
  env.screen.close();
  const count = env.changes.length;
  const lock = sentinel(); resolve(lock);
  await expect.poll(() => lock.releases).toBe(1);
  expect(env.changes).toHaveLength(count);
  expect(env.requests).toEqual(['screen']);
});

test('visibility changes during a pending wake request release the stale lock', async () => {
  const pending = [];
  const env = environment(() => new Promise(resolve => pending.push(resolve)));
  env.visible(false); env.visible(true);
  expect(env.requests).toHaveLength(1);
  const stale = sentinel(); pending[0](stale);
  await expect.poll(() => env.requests.length).toBe(2);
  expect(stale.releases).toBe(1);
  const current = sentinel(); pending[1](current);
  await expect.poll(() => env.changes.at(-1).awake).toBe('Screen stays awake');
  expect(current.released).toBe(false);
  env.screen.close();
  expect(current.releases).toBe(1);
});

test('fullscreen follows external exits, keeps expansion after rejection, and closes late entries', async () => {
  const env = environment();
  await env.screen.toggleFullscreen();
  expect(env.changes.at(-1).full).toBe(true);
  await env.document.exitFullscreen();
  expect(env.changes.at(-1).full).toBe(false);
  env.element.requestFullscreen = async () => { throw new TypeError('Denied'); };
  await env.screen.toggleFullscreen();
  expect(env.changes.at(-1).error).toBe('');
  expect(env.changes.at(-1).full).toBe(true);
  expect(env.attributes.has('data-expanded')).toBe(true);
  await env.screen.toggleFullscreen();
  expect(env.changes.at(-1).full).toBe(false);
  let resolve;
  env.element.requestFullscreen = () => new Promise(done => { resolve = done; });
  const entry = env.screen.toggleFullscreen();
  env.screen.close();
  expect(env.attributes.has('data-expanded')).toBe(false);
  const count = env.changes.length;
  env.document.fullscreenElement = env.element;
  resolve(); await entry;
  expect(env.document.fullscreenElement).toBe(null);
  expect(env.changes).toHaveLength(count);
});

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
  await expect(page.getByRole('button', { name: 'Start listening' })).toBeEnabled();
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
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Microphone denied', 'NotAllowedError'); };
  });
  await page.goto('http://127.0.0.1:8101');
  await expect(page.locator('.wake-status')).toHaveText('Screen stays awake');
  await page.getByRole('button', { name: 'Start listening' }).click();
  await expect(page.getByRole('alert')).toContainText('Microphone denied');
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
  await expect(page.getByRole('button', { name: 'Start listening' })).toBeEnabled();
  if (result === 'granted') expect(await page.evaluate(() => nativeLock.released)).toBe(false);
  await page.getByRole('link', { name: 'About', exact: true }).click();
  if (result === 'granted') await expect.poll(() => page.evaluate(() => nativeLock.released)).toBe(true);
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
  test(`fullscreen expands the live graph and follows browser exits at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext(); const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start(); await context.resume();
        window.sourceContext = context; window.sourceStream = destination.stream;
        return destination.stream;
      };
    });
    await page.goto('http://127.0.0.1:8101');
    await page.getByRole('button', { name: 'Start listening' }).click();
    await expect.poll(() => page.getByRole('meter').evaluateAll(nodes => nodes.some(node => Number(node.getAttribute('aria-valuenow')) > 0))).toBe(true);
    const before = await page.locator('#dancinglights').boundingBox();
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.className)).toBe('audio-card');
    const card = await page.locator('.audio-card').boundingBox();
    expect(card).toEqual({ x: 0, y: 0, ...viewport });
    await expect(page.locator('#dancinglights')).toBeInViewport({ ratio: 1 });
    expect((await page.locator('#dancinglights').boundingBox()).height).toBeGreaterThan(before.height + 100);
    await expect(page.getByRole('button', { name: 'Stop listening' })).toBeHidden();
    await expect(page.locator('.control-note')).toBeHidden();
    await expect(page.locator('.site-header')).toBeHidden();
    for (const colorScheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `test-results/fullscreen-${viewport.width}-${colorScheme}.png` });
    }
    // A real pointer drag exits without a persistent button over the lights.
    await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toHaveCSS('clip-path', 'inset(50%)');
    await page.mouse.move(viewport.width / 2, 80);
    await page.mouse.down();
    await page.mouse.move(viewport.width / 2, 200, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByRole('button', { name: 'Fullscreen', exact: true })).toBeVisible();
    await expect(page.locator('.frame-rate')).toHaveText(/^[1-9][0-9]* FPS$/);
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.className)).toBe('audio-card');
    // Native browser exit emits the same event as Escape or browser controls.
    await page.evaluate(() => document.exitFullscreen());
    await expect(page.getByRole('button', { name: 'Fullscreen', exact: true })).toBeVisible();
    expect(await page.evaluate(() => sourceStream.getTracks()[0].readyState)).toBe('live');
    await page.getByRole('button', { name: 'Stop listening' }).click();
    expect(await page.evaluate(() => sourceStream.getTracks()[0].readyState)).toBe('ended');
    await page.evaluate(() => sourceContext.close());
  });
}
