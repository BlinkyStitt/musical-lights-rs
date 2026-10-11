import { test, expect } from '@playwright/test';
import { physicsReady, syntheticAudio, startFrozen, normalView } from '../physics-state.mjs';
const origin = 'http://127.0.0.1:8101';

test('Auto measures startup, freezes its choice, and manual depth cancels a retest', async ({ page }) => {
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.depthProfile?.done), { timeout: 30000 }).toBe(true);
  const count = await page.locator('.depth-slider').inputValue();
  expect(Number(count)).toBeGreaterThanOrEqual(0); expect(Number(count)).toBeLessThanOrEqual(2048);
  await expect(page.locator('.depth-status')).toHaveAttribute('title', /Hz target/);
  await page.getByRole('button', { name: 'Retest', exact: true }).click();
  await page.locator('.depth-slider').fill('128');
  await expect.poll(() => page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return [v.settings.depthMode, v.mirrors.count, v.depthProfile.done, v.balls.count];
  })).toEqual(['manual', 128, true, 8]);
  await page.reload(); await physicsReady(page);
  expect(await page.locator('.depth-slider').inputValue()).toBe('128');
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.depthProfile)).toBeUndefined();
});

test('Auto stops when its scene leaves the viewport and waits for an explicit retest', async ({ page }) => {
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await page.getByRole('button', { name: 'Retest', exact: true }).click();
  await page.locator('footer').scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.depthProfile.done)).toBe(true);
  await expect(page.locator('.depth-status')).toHaveText('Auto paused');
  const selected = await page.locator('.depth-slider').inputValue();
  await page.locator('#dancinglights').scrollIntoViewIfNeeded();
  expect(await page.locator('.depth-slider').inputValue()).toBe(selected);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.depthProfile.done)).toBe(true);
});
