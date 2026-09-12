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
  await expect(page.getByRole('meter')).toHaveCount(240);
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'About Musical Lights' })).toBeVisible();
  for (const property of ['og:title', 'og:description', 'og:image', 'og:type', 'og:url']) {
    await expect(page.locator(`meta[property="${property}"]`)).toHaveCount(1);
  }
  await expect(page.locator('title')).toHaveCount(1);
  await expect(page.locator('meta[name="description"]')).toHaveCount(1);
});
