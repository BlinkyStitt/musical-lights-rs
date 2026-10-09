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
    await expect(page.getByRole('heading', { name: 'Old Arduino Code', exact: true })).toBeVisible();
    expect(await page.locator('.about-page').evaluate(node => getComputedStyle(node).maxWidth)).toBe('720px');

    const refreshed = await page.reload();
    expect(refreshed.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'About Musical Lights', exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${origin}/about/${suffix}`);

    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/`);
    await expect(page.getByRole('heading', { name: 'Musical Lights', exact: true })).toBeVisible();
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

for (const route of ['/', '/about/', '/advanced/']) {
  test(`Musical Lights branding fits a narrow header on ${route}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`${origin}${route}`);
    await expect(page.locator('.wordmark')).toHaveText('▂▅▃▆ Musical Lights');
    await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute('content', 'Musical Lights');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    const brand = await page.locator('.wordmark').boundingBox();
    const nav = await page.locator('.site-header nav').boundingBox();
    expect(brand.y + brand.height <= nav.y || brand.x + brand.width <= nav.x).toBe(true);
  });
}

test('a stale cached entry navigates to the current deployment before loading the app', async ({ page, request }) => {
  const html = await (await request.get(origin)).text();
  const { version } = await (await request.get(`${origin}/build.json`)).json();
  const old = '0'.repeat(24);
  let entries = 0;
  await page.route(`${origin}/advanced/**`, async route => {
    if (!route.request().isNavigationRequest()) return route.continue();
    entries++;
    await route.fulfill({ contentType: 'text/html', body: entries === 1 ? html.replaceAll(version, old) : html });
  });
  await page.goto(`${origin}/advanced/?source=bookmark#test`);
  await expect(page.getByRole('meter')).toHaveCount(24);
  await expect(page).toHaveURL(`${origin}/advanced/?source=bookmark#test`);
  expect(entries).toBe(2);
  await expect(page.locator('meta[name="musical-lights-assets"]')).toHaveAttribute('content', `/assets/${version}/`);
  await expect.poll(() => page.workers().some(worker => worker.url().includes(`/assets/${version}/physics/worker.js`))).toBe(true);
});

test('runtime requests use one version, including audio and transitive worker WASM', async ({ page }) => {
  const { syntheticAudio, startFrozen } = await import('../physics-state.mjs');
  await syntheticAudio(page);
  const requests = [];
  page.context().on('request', request => requests.push(new URL(request.url()).pathname));
  // AudioWorklet fetches are not surfaced in Playwright's network events.
  // Observe its real module URL while leaving native loading/execution intact.
  await page.addInitScript(() => {
    const add = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = function(url, options) {
      window.workletURL = new URL(url, document.baseURI).pathname;
      return add.call(this, url, options);
    };
  });
  // Old stable URLs must never participate in a new app, even when they could
  // return cached modules. Fail closed here to catch an overlooked dependency.
  await page.route(/\/(?:physics|loudness|snippets)\//, route => {
    if (new URL(route.request().url()).pathname.startsWith('/assets/')) return route.continue();
    return route.abort();
  });
  await page.goto(origin); await startFrozen(page);
  const assets = await page.locator('meta[name="musical-lights-assets"]').getAttribute('content');
  for (const suffix of ['physics/view.js', 'physics/worker.js', 'physics/physics.js', 'physics/physics_bg.wasm', 'loudness/loudness.wasm']) {
    await expect.poll(() => requests.includes(assets + suffix)).toBe(true);
  }
  expect(await page.evaluate(() => window.workletURL)).toBe(assets + 'loudness/processor.js');
  expect(requests.filter(path => /\.(js|wasm)$/.test(path)).every(path => path.startsWith(assets))).toBe(true);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
});

test('an unavailable deployment check still boots the coherent cached runtime', async ({ page }) => {
  await page.route('**/build.json?*', route => route.abort());
  await page.goto(origin);
  await expect(page.getByRole('meter')).toHaveCount(24);
});

for (const path of ['/advanced', '/advanced/']) {
  test(`direct ${path} loads, refreshes and participates in browser history`, async ({ page }) => {
    expect((await page.goto(`${origin}${path}`)).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Advanced', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Advanced', exact: true })).toHaveAttribute('aria-current', 'page');
    expect((await page.reload()).status()).toBe(200);
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page.locator('.calibration-controls, .physics-controls, .diagnostics-controls')).toHaveCount(0);
    await expect(page.locator('.display-controls')).not.toHaveAttribute('open');
    await expect(page.locator('.song-history')).not.toHaveAttribute('open');
    await expect(page.locator('.frame-rate, .diagnostic-fps')).toHaveCount(0);
    await page.goBack(); await expect(page.locator('.input-source')).toBeVisible();
    await page.goForward(); await expect(page.locator('.learning-topics')).toBeVisible();
  });
}
test('retired phone route gets normal not-found behavior', async ({ page }) => {
  expect((await page.goto(`${origin}/phone/`)).status()).toBe(404);
  await expect(page.getByRole('heading')).toContainText("We couldn't find that page!");
  expect((await page.reload()).status()).toBe(404);
});
