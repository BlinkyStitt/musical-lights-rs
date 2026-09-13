import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('render the share image with the actual shared rainbow palette', async ({ page }) => {
  await page.goto('http://127.0.0.1:8101');
  await expect(page.getByRole('meter')).toHaveCount(24);
  const colors = await page.locator('.bark-group > .meter:first-child .meter-fill').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
  expect(colors).toHaveLength(24);
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.setContent(await readFile(new URL('./card.html', import.meta.url), 'utf8'));
  await page.evaluate(async colors => {
    // A static illustration of the spectrum, not a measurement of live audio.
    const heights = [40, 58, 84, 72, 51, 64, 88, 100, 78, 65, 50, 70, 87, 68, 54, 75, 92, 82, 63, 54, 76, 94, 83, 61];
    const spectrum = document.querySelector('.spectrum');
    colors.forEach((color, i) => {
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.backgroundColor = color;
      bar.style.height = `${heights[i]}%`;
      spectrum.append(bar);
    });
    await document.fonts.ready;
  }, colors);
  await page.screenshot({ path: '../musical-leptos/public/social-preview.png' });
});
