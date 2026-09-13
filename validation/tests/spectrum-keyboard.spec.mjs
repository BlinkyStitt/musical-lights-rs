import { test, expect } from '@playwright/test';
import { meterPoint } from '../meter-input.mjs';

test.use({ hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:8101');
});

async function expectSample(page, index) {
  const meter = page.getByRole('meter').nth(index);
  await expect(meter).toBeFocused();
  await expect(page.locator('.meter[tabindex="0"]')).toHaveCount(1);
  await expect(meter).toHaveAttribute('tabindex', '0');
  await expect(page.locator('.meter[tabindex="-1"]')).toHaveCount(23);
  await expect(page.getByRole('tooltip')).toHaveText(await meter.getAttribute('aria-label'));
  await expect(meter).toHaveAttribute('aria-describedby', 'frequency-readout');
}

test('spectrum has one Tab stop, direct exits, and remembers the last focused sample', async ({ page }) => {
  const fullscreen = page.getByRole('button', { name: 'Fullscreen', exact: true });
  const calibration = page.locator('.calibration-controls > summary');
  await expect(page.getByRole('meter')).toHaveCount(24);
  await expect(page.locator('.bark-group[role="group"]')).toHaveCount(24);
  await expect(page.locator('.meter[tabindex="0"]')).toHaveCount(1);
  await fullscreen.focus();
  await page.keyboard.press('Tab');
  await expectSample(page, 0);
  await expect(page.getByRole('tooltip')).toHaveText('≈ 0–100 Hz');
  await page.keyboard.press('Tab');
  await expect(calibration).toBeFocused();
  await expect(page.getByRole('tooltip')).toBeHidden();
  await page.keyboard.press('Shift+Tab');
  await expectSample(page, 0);
  await page.keyboard.press('Shift+Tab');
  await expect(fullscreen).toBeFocused();
  await page.keyboard.press('Tab');
  await expectSample(page, 0);

  // Focus from outside keyboard navigation must update the sole Tab stop too.
  await page.getByRole('meter').nth(13).focus();
  await expectSample(page, 13);
  await expect(page.getByRole('tooltip')).toHaveText('≈ 2000–2320 Hz');
  await page.keyboard.press('Tab');
  await expect(calibration).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expectSample(page, 13);
  await page.keyboard.press('Shift+Tab');
  await expect(fullscreen).toBeFocused();
  await page.keyboard.press('Tab');
  await expectSample(page, 13);
});

test('arrows reach every sample across group boundaries and Home/End clamp at endpoints', async ({ page }) => {
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowLeft');
  await expectSample(page, 0);
  await page.keyboard.press('Home');
  await expectSample(page, 0);
  for (let index = 1; index < 24; index++) {
    await page.keyboard.press('ArrowRight');
    await expectSample(page, index);
  }
  await expect(page.getByRole('tooltip')).toHaveText('≈ 12000–15500 Hz');
  await page.keyboard.press('ArrowRight');
  await expectSample(page, 23);
  await page.keyboard.press('End');
  await expectSample(page, 23);
  for (let index = 22; index >= 0; index--) {
    await page.keyboard.press('ArrowLeft');
    await expectSample(page, index);
  }
  await page.keyboard.press('End');
  await expectSample(page, 23);
  await page.keyboard.press('Home');
  await expectSample(page, 0);

  await page.getByRole('meter').nth(13).focus();
  // Modified keys and vertical arrows remain available to the browser and AT.
  await page.evaluate(() => {
    window.spectrumKeys = [];
    document.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      window.spectrumKeys.push(event.defaultPrevented);
      // Observe the app first, then prevent native history shortcuts from
      // leaving the page before the next modifier combination can be checked.
      event.preventDefault();
    });
  });
  for (const modifier of ['Shift', 'Alt', 'Control', 'Meta']) {
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      await page.keyboard.press(`${modifier}+${key}`);
      await expectSample(page, 13);
    }
  }
  for (const key of ['ArrowUp', 'ArrowDown']) {
    await page.keyboard.press(key);
    await expectSample(page, 13);
  }
  expect(await page.evaluate(() => window.spectrumKeys)).toEqual(Array(18).fill(false));
});

for (const colorScheme of ['light', 'dark']) {
  test(`keyboard focus stays visible above spheres in ${colorScheme} mode`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('End');
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expectSample(page, 23);
      const meter = page.getByRole('meter').last();
      await expect(meter).toBeInViewport({ ratio: 1 });
      await expect(meter).toHaveCSS('outline-style', 'solid');
      await expect(meter).toHaveCSS('outline-width', '3px');
      await expect(meter).toHaveCSS('outline-offset', '4px');
      const layers = await page.evaluate(() => ({
        focus: Number(getComputedStyle(document.activeElement).zIndex),
        spheres: Number(getComputedStyle(document.querySelector('.balloon-layer')).zIndex),
        group: getComputedStyle(document.activeElement.parentElement).zIndex,
        otherOutlines: [...document.querySelectorAll('.meter:not(:focus-visible)')]
          .map(node => getComputedStyle(node).outlineStyle),
      }));
      expect(layers.focus).toBeGreaterThan(layers.spheres);
      expect(layers.group).toBe('auto');
      expect(layers.otherOutlines).toEqual(Array(23).fill('none'));
      // Include a sample through the spheres in the visual evidence too.
      await page.getByRole('meter').nth(13).focus();
      await page.screenshot({ path: testInfo.outputPath(`focus-${colorScheme}-${width}.png`), fullPage: true });
      await page.keyboard.press('End');
    }
  });
}

test('mouse and touch readouts do not replace keyboard selection and touch cleanup cancels expiry', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).focus();
  await page.keyboard.press('Tab');
  await page.getByRole('meter').nth(13).focus();
  await page.keyboard.press('Tab');
  const hover = await meterPoint(page, page.getByRole('meter').nth(20));
  await page.mouse.move(hover.x, hover.y);
  await expect(page.getByRole('tooltip')).toHaveText(hover.label);
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toBeHidden();
  await page.keyboard.press('Shift+Tab');
  await expectSample(page, 13);
  await page.keyboard.press('Tab');

  const touch = await meterPoint(page, page.getByRole('meter').nth(20));
  await page.touchscreen.tap(touch.x, touch.y);
  await expect(page.getByRole('tooltip')).toHaveText(touch.label);
  const selection = await page.locator('.meter[tabindex="0"]').getAttribute('aria-label');
  // Browsers can focus a tapped sample. Focus, but never the readout timer,
  // determines the remembered selection.
  const focusedLabel = await page.evaluate(() => document.activeElement.getAttribute('role') === 'meter'
    ? document.activeElement.getAttribute('aria-label') : '≈ 2000–2320 Hz');
  expect(selection).toBe(focusedLabel);
  await page.waitForTimeout(2000);
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expect(page.getByRole('tooltip')).toBeHidden({ timeout: 1500 });
  await expect(page.locator('.meter[tabindex="0"]')).toHaveAttribute('aria-label', selection);
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('.meter[tabindex="0"]')).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText(selection);

  await page.touchscreen.tap(touch.x, touch.y);
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await page.waitForTimeout(3100);
  await expect(page.getByRole('meter')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('keyboard can exit fullscreen from the last sample and route re-entry starts at zero', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const fullscreen = page.getByRole('button', { name: 'Fullscreen', exact: true });
  await fullscreen.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Tab');
  await expect(fullscreen).toBeFocused();
  await page.keyboard.press('Enter');
  const exit = page.getByRole('button', { name: 'Exit fullscreen', exact: true });
  await expect(exit).toBeFocused();
  await page.keyboard.press('Tab');
  await expectSample(page, 23);
  await page.keyboard.press('Shift+Tab');
  await expect(exit).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.site-header')).toBeVisible();
  await page.keyboard.press('Tab');
  await expectSample(page, 23);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(page.locator('.site-header')).toBeVisible();
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page.getByRole('meter')).toHaveCount(0);
  await page.keyboard.press('End');
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await fullscreen.focus();
  await page.keyboard.press('Tab');
  await expectSample(page, 0);
  expect(errors).toEqual([]);
});
