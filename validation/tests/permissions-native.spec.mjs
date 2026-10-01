import { test, expect } from '@playwright/test';
import { physicsReady } from '../physics-state.mjs';
const origin = 'http://127.0.0.1:8101';

// The browser provides a virtual audio device. Permissions, getUserMedia,
// MediaStreamTrack, and the AudioWorklet all use their native implementations.
async function observeCapture(page) {
  await page.addInitScript(() => {
    window.captures = [];
    window.captureRequests = 0;
    const acquire = MediaDevices.prototype.getUserMedia;
    MediaDevices.prototype.getUserMedia = async function (...args) {
      window.captureRequests++;
      const stream = await Reflect.apply(acquire, this, args);
      window.captures.push(stream);
      return stream;
    };
  });
}

test('browser-managed grant survives reload and native capture stops on Stop and route close', async ({ page, context }) => {
  await context.grantPermissions(['microphone'], { origin });
  await observeCapture(page);
  await page.goto(`${origin}/phone/?source=bookmark#permissions`); await physicsReady(page);
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'granted');
  expect(await page.evaluate(() => captureRequests)).toBe(0);
  await page.reload(); await physicsReady(page);
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'granted');
  expect(await page.evaluate(() => captureRequests)).toBe(0);
  for (const end of ['Stop listening', 'About']) {
    await page.getByRole('button', { name: 'Start listening', exact: true }).click();
    await expect(page.locator('.mic-status')).toHaveText('Listening · Mic on');
    expect(await page.evaluate(() => captures.at(-1).getAudioTracks()[0].readyState)).toBe('live');
    await page.getByRole(end === 'About' ? 'link' : 'button', { name: end, exact: true }).click();
    await expect.poll(() => page.evaluate(() => captures.map(stream => stream.getAudioTracks()[0].readyState)))
      .toEqual(end === 'About' ? ['ended', 'ended'] : ['ended']);
  }
});

test('native permission changes update the mounted display and denied capture fails', async ({ page, context }) => {
  await context.grantPermissions([], { origin });
  await observeCapture(page);
  await page.goto(origin); await physicsReady(page);
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'denied');
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'not-allowed');
  expect(await page.evaluate(() => captures.length)).toBe(0);
  expect(await page.evaluate(() => captureRequests)).toBe(1);
  await context.grantPermissions(['microphone'], { origin });
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'granted');
  await context.clearPermissions();
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'prompt');
});

test('a real insecure HTTP origin reports missing secure APIs without property overrides', async ({ page }) => {
  await page.goto('http://musical-lights-insecure.test:8101/');
  expect(await page.evaluate(() => ({ secure: isSecureContext, capture: typeof navigator.mediaDevices })))
    .toEqual({ secure: false, capture: 'undefined' });
  await expect(page.locator('.microphone-permission')).toHaveAttribute('data-state', 'insecure');
  await expect(page.locator('.motion-status')).toHaveText('Motion access requires a secure HTTPS page.');
});

// Chromium rounds DeviceMotion readings to 0.1 m/s²; use representable inputs.
test('browser-delivered virtual sensor readings reach the real motion and force path', async ({ page, context }) => {
  await context.grantPermissions(['accelerometer', 'gyroscope'], { origin });
  const cdp = await context.newCDPSession(page);
  for (const type of ['accelerometer', 'linear-acceleration', 'gyroscope']) {
    await cdp.send('Emulation.setSensorOverrideEnabled', { type, enabled: true });
    await cdp.send('Emulation.setSensorOverrideReadings', { type, reading: { xyz: { x: 0, y: type === 'accelerometer' ? 9.8 : 0, z: 0 } } });
  }
  await page.goto(origin); await physicsReady(page);
  await page.evaluate(() => {
    window.sensorEvents = [];
    window.addEventListener('devicemotion', event => {
      sensorEvents.push({ trusted: event.isTrusted, x: event.acceleration?.x, y: event.acceleration?.y });
    });
  });
  await page.getByRole('button', { name: 'Enable motion', exact: true }).click();
  await cdp.send('Emulation.setSensorOverrideReadings', { type: 'accelerometer', reading: { xyz: { x: 0, y: 7.8, z: 0 } } });
  await cdp.send('Emulation.setSensorOverrideReadings', { type: 'linear-acceleration', reading: { xyz: { x: 0, y: -2, z: 0 } } });
  await expect(page.locator('.motion-status')).toHaveAttribute('data-state', 'active');
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[25])).toBeCloseTo(2, 5);
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[35])).toBeCloseTo(-9.8, 5);
  expect(await page.evaluate(() => sensorEvents.some(event => event.trusted && event.y === -2))).toBe(true);
  await page.getByRole('button', { name: 'Disable motion', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.input.slice(24, 27))))
    .toEqual([0, 0, 0]);
});


test('native gravity turns upside down and settles balls against the back of a flat phone', async ({ page, context }) => {
  await context.grantPermissions(['accelerometer', 'gyroscope'], { origin });
  const cdp = await context.newCDPSession(page);
  for (const type of ['accelerometer', 'linear-acceleration', 'gyroscope']) {
    await cdp.send('Emulation.setSensorOverrideEnabled', { type, enabled: true });
    await cdp.send('Emulation.setSensorOverrideReadings', { type, reading: { xyz: { x: 0, y: type === 'accelerometer' ? 9.8 : 0, z: 0 } } });
  }
  await page.goto(origin); await physicsReady(page);
  await page.getByRole('button', { name: 'Enable motion', exact: true }).click();
  await expect(page.locator('.motion-status')).toHaveAttribute('data-state', 'active');
  await cdp.send('Emulation.setSensorOverrideReadings', { type: 'accelerometer', reading: { xyz: { x: 0, y: -9.8, z: 0 } } });
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[35])).toBeCloseTo(9.8, 5);
  await expect.poll(() => page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return Array.from({ length: v.layout[21] }, (_, i) => v.current[3 + i * v.layout[8] + 1]).every(y => y > v.current[1] / 2);
  })).toBe(true);
  await cdp.send('Emulation.setSensorOverrideReadings', { type: 'accelerometer', reading: { xyz: { x: 0, y: 0, z: 9.8 } } });
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[36])).toBeCloseTo(-9.8, 5);
  await expect.poll(() => page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return Array.from({ length: v.layout[21] }, (_, i) => v.current[3 + i * v.layout[8] + 2]).every(z => z < -.01);
  })).toBe(true);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.input[35])).toBe(0);
  await page.getByRole('button', { name: 'Disable motion', exact: true }).click();
  expect(await page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.input.slice(34, 38)))).toEqual([0, 0, 0, 0]);
});
