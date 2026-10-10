import { test, expect } from '@playwright/test';

test('share metadata and image work without JavaScript', async ({ browser, request }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8101');
  await expect(page).toHaveTitle('Musical Lights');
  for (const property of ['og:title', 'og:description', 'og:image', 'og:type', 'og:url']) {
    const meta = page.locator(`meta[property="${property}"]`);
    await expect(meta).toHaveCount(1);
    expect(await meta.getAttribute('content')).toBeTruthy();
  }
  const image = await page.locator('meta[property="og:image"]').getAttribute('content');
  expect(image).toBe('https://blink.stitthappens.com/social-preview.png');
  await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '1200');
  await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute('content', '630');
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute('content', image);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://blink.stitthappens.com/');
  const response = await request.get(`http://127.0.0.1:8101${new URL(image).pathname}`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('image/png');
  const png = await response.body();
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(png.readUInt32BE(16)).toBe(1200);
  expect(png.readUInt32BE(20)).toBe(630);
  await context.close();
});

test('mounting and navigation preserve a single set of share metadata', async ({ page }) => {
  await page.goto('http://127.0.0.1:8101');
  await expect(page.getByRole('meter')).toHaveCount(24);
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'About Musical Lights' })).toBeVisible();
  for (const property of ['og:title', 'og:description', 'og:image', 'og:type', 'og:url']) {
    await expect(page.locator(`meta[property="${property}"]`)).toHaveCount(1);
  }
  await expect(page.locator('title')).toHaveCount(1);
  await expect(page.locator('meta[name="description"]')).toHaveCount(1);
});

test('share bars use the current full-gamut browser colors', async ({ page }) => {
  await page.goto('http://127.0.0.1:8101');
  await expect(page.getByRole('meter')).toHaveCount(24);
  const comparisons = await page.evaluate(async () => {
    const image = new Image();
    image.src = '/social-preview.png';
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 630;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, 1200, 630).data;
    return [...document.querySelectorAll('.bark-group')].map((group, band) => {
      ctx.fillStyle = getComputedStyle(group).getPropertyValue('--band-color');
      ctx.fillRect(0, 0, 1, 1);
      const expected = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
      const x = Math.floor(72 + (1056 + 10) / 24 * (band + 0.5) - 5);
      const offset = (490 * 1200 + x) * 4;
      return { expected, actual: [...pixels.slice(offset, offset + 3)] };
    });
  });
  expect(comparisons).toHaveLength(24);
  for (const { expected, actual } of comparisons) expect(actual).toEqual(expected);
});

test('jacket icons retain their dimensions and all ICO frames', async ({ page, request }) => {
  const { readFile } = await import('node:fs/promises');
  for (const [name, size] of [
    ['android-chrome-512x512.png', 512], ['android-chrome-192x192.png', 192],
    ['apple-touch-icon.png', 180], ['favicon-32x32.png', 32], ['favicon-16x16.png', 16],
  ]) {
    const png = await readFile(new URL(`../../musical-leptos/public/${name}`, import.meta.url));
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  }
  const checkFrames = ico => {
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
    for (const [frame, size] of [16, 32, 48].entries()) {
      const entry = 6 + frame * 16;
      expect(ico[entry]).toBe(size);
      expect(ico[entry + 1]).toBe(size);
      const offset = ico.readUInt32LE(entry + 12);
      expect(offset + ico.readUInt32LE(entry + 8)).toBeLessThanOrEqual(ico.length);
      expect(ico.readUInt32LE(offset + 4)).toBe(size);
      expect(ico.readUInt32LE(offset + 8)).toBe(size * 2);
    }
  };
  checkFrames(await readFile(new URL('../../musical-leptos/public/favicon.ico', import.meta.url)));
  await page.goto('http://127.0.0.1:8101');
  const icon = await page.locator('link[rel="icon"]').getAttribute('href');
  const response = await request.get(new URL(icon, page.url()).href);
  expect(response.status()).toBe(200);
  checkFrames(await response.body());
});
