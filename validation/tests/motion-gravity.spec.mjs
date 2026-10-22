import { test, expect } from '@playwright/test';
import { closeFullscreenSettings, openFullscreenSettings, normalView, physicsReady, physicsState, syntheticAudio } from '../physics-state.mjs';

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
      await page.goto('http://127.0.0.1:8101'); await physicsReady(page); await normalView(page);
      await page.locator('.scroll-lights').uncheck();
      // Isolate sensor gravity from the travelling idle bars' launch forces.
      await page.evaluate(() => {
        const v = document.querySelector('#dancinglights').physics;
        v.stopPreview(); v.idle = false;
        v.push(Array(24).fill(0), Array(24).fill(0), false);
      });
      const send = async (gravity, angle = 0) => {
        await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).check();
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
      const disable = () => page.getByRole('checkbox', { name: 'Phone motion', exact: true }).uncheck();
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
      await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeVisible();
    });
  }
}

for (const path of ['/', '/advanced/']) for (const reducedMotion of ['reduce', 'no-preference']) {
test(`fixed browser orientation remaps cached gravity, shakes and pointer forces on ${path} (${reducedMotion})`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion });
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { value: false });
    for (const name of ['DeviceMotionEvent', 'DeviceOrientationEvent']) {
      if (!window[name]) window[name] = class {};
      Object.defineProperty(window[name], 'requestPermission', { configurable: true, value: () => Promise.resolve('granted') });
    }
  });
  await page.goto('http://127.0.0.1:8101' + path); await physicsReady(page);
  // Enter through the screen owner without the separate Listening entry action.
  if (!await page.locator('.audio-card').evaluate(n => n.hasAttribute('data-expanded'))) {
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).check();
  await expect(page.locator('.motion-status')).toHaveAttribute('data-state', 'waiting');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    Object.defineProperty(screen.orientation, 'angle', { configurable: true, value: 0 });
    const v = document.querySelector('#dancinglights').physics;
    window.motionIdentity = { worker: v.worker, renderer: v.renderer };
    window.sendRotationMotion = () => window.dispatchEvent(Object.assign(new Event('devicemotion'), {
      acceleration: { x: 3, y: -4, z: 7 },
      accelerationIncludingGravity: { x: 3, y: -4, z: 7 },
    }));
    window.sendRotationMotion();
    window.motionIdentity.accelerationAt = v.accelerationAt;
    // Use a nonzero gravity vector independently of platform signs, exercising
    // cached view adaptation without any further orientation/sensor event.
    v.deviceGravity(0, -9.81, 2, 0);
  });
  for (let turn = 0; turn < 4; turn++) {
    const angle = turn * Math.PI / 2;
    const state = await page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      return { gravity: Array.from(v.input.slice(34, 37)), acceleration: v.acceleration,
        identity: v.worker === motionIdentity.worker && v.renderer === motionIdentity.renderer && v.accelerationAt === motionIdentity.accelerationAt };
    });
    expect(state.identity).toBe(true);
    [9.81 * Math.sin(angle), -9.81 * Math.cos(angle), 2].forEach((n, i) => expect(state.gravity[i]).toBeCloseTo(n, 5));
    [-3 * Math.cos(angle) - 4 * Math.sin(angle), -3 * Math.sin(angle) + 4 * Math.cos(angle), -7].forEach((n, i) => expect(state.acceleration[i]).toBeCloseTo(n, 5));
    // Dispatch mouse coordinates at a known logical point, independent of touch profile.
    expect(await page.evaluate(turn => {
      const v = document.querySelector('#dancinglights').physics, r = v.layer.getBoundingClientRect();
      const [u, w] = [[.25, .7], [.3, .25], [.75, .3], [.7, .75]][turn];
      window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: r.left + u * r.width, clientY: r.top + w * r.height }));
      const actual = Array.from(v.input.slice(27, 31));
      v.pointer(.25, .3, true);
      const expected = Array.from(v.input.slice(27, 31));
      return actual.every((n, i) => Math.abs(n - expected[i]) < .01);
    }, turn)).toBe(true);
    await page.locator('.rotate-display').click();
    expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.input[27])).toBe(0);
  }
  // Remapping cached shakes must not refresh their 150 ms lifetime.
  await expect.poll(() => page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.input.slice(24, 27)))).toEqual([0, 0, 0]);
});
}

for (const path of ['/', '/advanced/']) {
  test(`rotation survives pending, denied and active motion plus visibility on ${path}`, async ({ page }) => {
    await syntheticAudio(page, 'pending');
    await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
    await page.goto('http://127.0.0.1:8101' + path); await physicsReady(page); await normalView(page);
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
    const motion = page.getByRole('checkbox', { name: 'Phone motion', exact: true });
    const status = page.locator('.motion-status');
    const rotate = page.locator('.rotate-display');
    await openFullscreenSettings(page); await motion.check();
    await expect(status).toHaveAttribute('data-state', 'requesting');
    await expect(motion).toBeEnabled();
    await closeFullscreenSettings(page); await rotate.click();
    await page.evaluate(() => resolveMotion.splice(0).forEach(resolve => resolve('denied')));
    await expect(status).toHaveAttribute('data-state', 'denied');
    await expect(status).toContainText('Allow Motion & Orientation for this site');
    await expect(rotate).toHaveAccessibleName('Rotate view clockwise, current rotation 90 degrees');
    await openFullscreenSettings(page); await motion.check();
    await expect(status).toHaveAttribute('data-state', 'requesting');
    // Listening can stop while motion permission is pending, then motion can
    // stop too. A late grant must not attach sensor listeners.
    await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'stopped');
    await motion.uncheck();
    await page.evaluate(() => resolveMotion.splice(0).forEach(resolve => resolve('granted')));
    await expect(status).toHaveAttribute('data-state', 'off');
    await closeFullscreenSettings(page); await rotate.click();
    const emit = () => page.evaluate(() => window.dispatchEvent(Object.assign(new Event('devicemotion'), {
      acceleration: { x: 3, y: -4, z: 7 }, accelerationIncludingGravity: { x: 3, y: 5.81, z: 9 },
    })));
    await emit();
    expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.motion.readings.motionEvents)).toBe(0);
    await openFullscreenSettings(page); await motion.check();
    await page.evaluate(() => resolveMotion.splice(0).forEach(resolve => resolve('granted')));
    await expect(status).toHaveAttribute('data-state', 'waiting');
    await closeFullscreenSettings(page); await rotate.click(); await emit();
    await expect(status).toHaveAttribute('data-state', 'active');
    for (const hidden of [true, false]) {
      await page.evaluate(hidden => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);
      await expect(rotate).toHaveAccessibleName('Rotate view clockwise, current rotation 270 degrees');
    }
    await emit(); await rotate.click();
    await expect(rotate).toHaveAccessibleName('Rotate view clockwise, current rotation 0 degrees');
    await expect(status).toHaveAttribute('data-state', 'active');
    await openFullscreenSettings(page); await motion.uncheck();
    await emit();
    expect(await page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      return [...v.input.slice(24, 27), ...v.input.slice(34, 38)];
    })).toEqual([0, 0, 0, 0, 0, 0, 0]);
    await motion.check(); await expect(status).toHaveAttribute('data-state', 'requesting');
    await page.evaluate(() => {
      window.oldMotion = document.querySelector('#dancinglights').physics.motion;
      document.querySelector('nav a[href="/about"]').click();
    });
    await expect(page.locator('.audio-card')).toHaveCount(0);
    await page.evaluate(() => resolveMotion.splice(0).forEach(resolve => resolve('granted')));
    const readings = await page.evaluate(() => oldMotion.readings.motionEvents);
    await emit();
    expect(await page.evaluate(() => ({ closed: oldMotion.closed, enabled: oldMotion.enabled, events: oldMotion.readings.motionEvents }))).toEqual({ closed: true, enabled: false, events: readings });
  });
}
