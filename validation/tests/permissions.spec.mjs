import { test, expect } from '@playwright/test';
import { physicsReady, syntheticAudio } from '../physics-state.mjs';
const url = 'http://127.0.0.1:8101/phone/';

async function permissions(page, state = 'granted') {
  await page.addInitScript(({ state }) => {
    window.permissionRequests = [];
    window.permissionQueries = [];
    // Each query returns its own read-only status backed by a per-descriptor state.
    const names = ['microphone', 'accelerometer', 'gyroscope'];
    const states = Object.fromEntries(names.map(name => [name, state]));
    const observers = Object.fromEntries(names.map(name => [name, []]));
    window.setPermission = (name, value, notify = true) => {
      if (!names.includes(name) || !['granted', 'denied', 'prompt'].includes(value)) throw new TypeError('Invalid permission');
      states[name] = value;
      if (notify) for (const status of observers[name]) status.dispatchEvent(new Event('change'));
    };
    // Storage is optional, including for private browsing and Home Screen entries.
    Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: {
      query: async ({ name }) => {
        window.permissionQueries.push(name);
        if (window.permissionQueryUnsupported) throw new TypeError('Unsupported permission');
        if (!names.includes(name)) throw new TypeError(`Unsupported permission: ${name}`);
        const status = new EventTarget();
        Object.defineProperties(status, { state: { get: () => states[name] }, name: { value: name } });
        observers[name].push(status);
        return status;
      },
    } });
    for (const name of ['DeviceMotionEvent', 'DeviceOrientationEvent']) {
      if (!window[name]) window[name] = class {};
      Object.defineProperty(window[name], 'requestPermission', { configurable: true, value: async () => {
        if (!navigator.userActivation.isActive) throw new DOMException('A gesture is required', 'NotAllowedError');
        window.permissionRequests.push(name);
        return window.motionPermission ?? 'granted';
      } });
    }
    MediaDevices.prototype.getUserMedia = async () => {
      window.permissionRequests.push('microphone');
      if (window.microphoneMode === 'pending') return new Promise(() => {});
      throw new DOMException('User did not grant access', 'NotAllowedError');
    };
  }, { state });
}

for (const path of ['/', '/phone/?source=bookmark#permissions']) {
  test(`queried access is displayed without requesting capture on direct entry ${path}`, async ({ page }, info) => {
    await permissions(page, 'granted');
    await page.goto(`http://127.0.0.1:8101${path}`);
    await expect(page.locator('.microphone-permission')).toHaveText('Microphone access allowed.');
    await expect(page.locator('.mic-status')).toHaveText('Microphone off');
    await expect(page.locator('.motion-status')).toHaveText('Motion access allowed · motion off.');
    await page.reload();
    await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'granted');
    expect(await page.evaluate(() => window.permissionRequests)).toEqual([]);
    await page.getByText('About microphone and motion access', { exact: true }).click();
    await expect(page.locator('.permission-help')).toContainText('Home Screen app or another browser may have separate permissions');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('permission-status.png'), fullPage: true });
  });
}

test('permission status follows revocation, return from settings, and route cleanup', async ({ page }) => {
  await permissions(page, 'prompt'); await page.goto(url);
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'prompt');
  await page.evaluate(() => {
    setPermission('microphone', 'denied');
  });
  await expect(page.locator('.microphone-permission')).toContainText('access blocked');
  await page.evaluate(() => {
    for (const name of ['microphone', 'accelerometer', 'gyroscope']) setPermission(name, 'granted', false);
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'granted');
  await expect(page.locator('.motion-status')).toHaveText('Motion access allowed · motion off.');
  await page.getByRole('button', { name: 'Enable motion', exact: true }).click();
  await expect(page.locator('.motion-status')).toHaveAttribute('data-state', 'waiting');
  await page.evaluate(() => {
    setPermission('accelerometer', 'denied');
  });
  await expect(page.locator('.motion-status')).toContainText('Motion access blocked');
  await page.evaluate(() => {
    setPermission('accelerometer', 'granted');
  });
  await expect(page.locator('.motion-status')).toContainText(/waiting for sensor readings/i);
  await page.getByRole('button', { name: 'Disable motion', exact: true }).click();
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page.locator('.microphone-permission')).toHaveCount(0);
  const count = await page.evaluate(() => permissionQueries.length);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('pageshow'));
  });
  expect(await page.evaluate(() => permissionQueries.length)).toBe(count);
  expect(await page.evaluate(() => permissionRequests)).toEqual(['DeviceMotionEvent', 'DeviceOrientationEvent']);
});

test('pending access is distinct from permission and route cleanup removes its display', async ({ page }) => {
  await permissions(page, 'prompt');
  await page.goto(url); await physicsReady(page);
  await page.evaluate(() => {
    window.microphoneMode = 'pending';
  });
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'requesting');
  await expect(page.locator('.microphone-permission')).toContainText('respond to your browser if it asks');
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page.locator('.microphone-permission')).toHaveCount(0);
});

test('unsupported permission queries still allow microphone and motion access from a gesture', async ({ page }) => {
  await syntheticAudio(page);
  await page.addInitScript(() => Object.defineProperty(navigator, 'permissions', { configurable: true, value: {
    query: async () => { throw new TypeError('Unsupported permission'); },
  } }));
  await page.goto(url); await physicsReady(page);
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'unknown');
  await expect(page.locator('.motion-status')).toHaveText('Motion off · tap Enable motion to check access.');
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toBeVisible();
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'granted');
  await expect(page.locator('.motion-status')).toHaveAttribute('data-state', 'waiting');
  await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
  await expect(page.locator('.mic-status')).toHaveText('Microphone off');
  await expect(page.locator('.motion-status')).toHaveText('Motion access allowed · motion off.');
  await page.reload();
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'unknown');
});

test('dismissed microphone access has persistent guidance without claiming a permanent denial', async ({ page }) => {
  await permissions(page, 'prompt'); await page.goto(url); await physicsReady(page);
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'not-allowed');
  await expect(page.locator('.microphone-permission')).toContainText('Check this site’s browser permissions');
  await expect(page.locator('.audio-error')).toBeEmpty({ timeout: 6000 });
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'not-allowed');
  await page.evaluate(() => {
    setPermission('microphone', 'granted');
  });
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'granted');
});

test('missing device APIs are reported as unavailable without disabling test audio', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    Object.defineProperty(window, 'DeviceMotionEvent', { configurable: true, value: undefined });
    Object.defineProperty(window, 'DeviceOrientationEvent', { configurable: true, value: undefined });
  });
  await page.goto(url); await physicsReady(page);
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('.motion-status')).toHaveText('Phone motion is unavailable in this browser.');
  await page.locator('.generated-audio').check();
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(page.locator('.mic-status')).toHaveText('Test audio · Mic off');
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'unavailable');
});
