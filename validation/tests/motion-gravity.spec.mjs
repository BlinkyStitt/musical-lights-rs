import { test, expect } from '@playwright/test';
import { physicsReady, physicsState } from '../physics-state.mjs';

// Synthetic readings model each platform's native convention; they do not
// certify physical sensors or permission prompts on a phone.
for (const apple of [false, true]) {
  for (const fallback of [false, true]) {
    test(`${apple ? 'iPhone' : 'Chromium'} gravity keeps upright balls down with ${fallback ? 'gravity-only' : 'linear'} readings`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript(({ apple }) => {
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: apple ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' : 'Mozilla/5.0 (Linux; Android 15) Chrome/140.0' });
        Object.defineProperty(navigator, 'platform', { configurable: true, value: apple ? 'iPhone' : 'Linux armv8l' });
        for (const name of ['DeviceMotionEvent', 'DeviceOrientationEvent']) {
          if (!window[name]) window[name] = class {};
          Object.defineProperty(window[name], 'requestPermission', { configurable: true, value: () => Promise.resolve(name === 'DeviceMotionEvent' ? 'granted' : 'denied') });
        }
      }, { apple });
      await page.goto('http://127.0.0.1:8101'); await physicsReady(page);
      await page.locator('.scroll-lights').uncheck();
      const send = async (gravity, angle = 0) => {
        await page.getByRole('button', { name: 'Enable motion', exact: true }).click();
        await expect(page.locator('.motion-status')).toHaveAttribute('data-state', 'waiting');
        await page.evaluate(({ gravity, angle, apple, fallback }) => {
          Object.defineProperty(screen.orientation, 'angle', { configurable: true, value: angle });
          window.dispatchEvent(Object.assign(new Event('devicemotion'), {
            acceleration: fallback ? null : { x: 0, y: 0, z: 0 },
            accelerationIncludingGravity: Object.fromEntries(['x', 'y', 'z'].map((axis, i) => [axis, gravity[i] * (apple ? 1 : -1)])),
          }));
        }, { gravity, angle, apple, fallback });
        await expect(page.locator('.motion-status')).toHaveAttribute('data-state', 'active');
      };
      const gravity = () => page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.input.slice(34, 37)));
      const disable = () => page.getByRole('button', { name: 'Disable motion', exact: true }).click();
      const settledDown = async () => {
        await expect.poll(async () => {
          const state = await physicsState(page);
          return state.balls.every(ball => ball.position[1] < state.height / 2);
        }).toBe(true);
      };
      await send([0, -9.8, 0]);
      expect((await gravity())[1]).toBeCloseTo(-9.8, 5);
      // Give the original upward-gravity bug time to lift all balls.
      await page.waitForTimeout(1200);
      await settledDown();
      await disable();
      await send([0, 9.8, 0]);
      expect((await gravity())[1]).toBeCloseTo(9.8, 5);
      await expect.poll(async () => {
        const state = await physicsState(page);
        return state.balls.every(ball => ball.position[1] > state.height / 2);
      }).toBe(true);
      await disable();
      await send([0, 0, -9.8]);
      expect((await gravity())[2]).toBeCloseTo(-9.8, 5);
      await expect.poll(async () => (await physicsState(page)).balls.every(ball => ball.position[2] < -.01)).toBe(true);
      await disable();
      await send([0, 0, 9.8]);
      expect((await gravity())[2]).toBeCloseTo(9.8, 5);
      await expect.poll(async () => (await physicsState(page)).balls.every(ball => ball.position[2] > .01)).toBe(true);
      await disable();
      await send([-9.8, 0, 0], 90);
      expect((await gravity())[1]).toBeCloseTo(-9.8, 5);
      await settledDown();
      await disable();
      expect(await page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.input.slice(34, 38)))).toEqual([0, 0, 0, 0]);
      await expect(page.getByRole('button', { name: 'Start listening', exact: true })).toBeVisible();
    });
  }
}
