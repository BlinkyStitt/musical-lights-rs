import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:8101';

for (const path of ['/about', '/about/']) {
  test(`direct ${path} loads and refreshes with HTTP 200`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const suffix = '?source=direct&next=%2Fabout#history';
    const response = await page.goto(`${origin}${path}${suffix}`);
    expect(response.status()).toBe(200);
    await expect(page).toHaveURL(`${origin}/about/${suffix}`);
    await expect(page.getByRole('heading', { name: 'About Musical Lights', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'About', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(await page.locator('.about-page').evaluate(node => getComputedStyle(node).maxWidth)).toBe('720px');

    const refreshed = await page.reload();
    expect(refreshed.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'About Musical Lights', exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${origin}/about/${suffix}`);

    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/`);
    await expect(page.getByRole('meter')).toHaveCount(24);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'About Musical Lights', exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${origin}/about/${suffix}`);
    await page.goForward();
    await expect(page.getByRole('meter')).toHaveCount(24);
    expect(errors).toEqual([]);
  });
}

test('an unknown nested route loads the app not-found view with HTTP 404', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `${origin}/missing/nested/route?source=direct#history`;
  const response = await page.goto(url);
  expect(response.status()).toBe(404);
  await expect(page).toHaveURL(url);
  await expect(page.getByRole('heading')).toContainText("We couldn't find that page!");
  await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  expect((await page.reload()).status()).toBe(404);
  await expect(page.getByRole('heading')).toContainText("We couldn't find that page!");
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('meter')).toHaveCount(24);
  expect((await request.get(`${origin}/missing-script.js`)).status()).toBe(404);
  expect(errors).toEqual([]);
});
