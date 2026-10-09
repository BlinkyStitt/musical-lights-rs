import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { physicsReady, syntheticAudio } from '../physics-state.mjs';

// Serve two releases over real HTTP: AudioWorklet loads bypass page routing.
// The second release has identical code but a new namespace, and old files 404.
async function deploymentFixture() {
  const dist = resolve(fileURLToPath(new URL('../../musical-leptos/dist/', import.meta.url)));
  const { version: original } = JSON.parse(await readFile(resolve(dist, 'build.json'), 'utf8'));
  const next = original === 'a'.repeat(24) ? 'b'.repeat(24) : 'a'.repeat(24);
  let version = original, retireOn = null;
  const requests = [];
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    requests.push(pathname);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    if (retireOn && pathname.endsWith(retireOn)) { version = next; retireOn = null; }
    if (pathname === '/build.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version })); return;
    }
    if (pathname.startsWith('/assets/') && !pathname.startsWith(`/assets/${version}/`)) {
      response.writeHead(404).end('Retired release'); return;
    }
    const relative = pathname.replace(`/assets/${version}/`, `/assets/${original}/`);
    const file = resolve(dist, `.${relative.endsWith('/') ? relative + 'index.html' : relative}`);
    if (!file.startsWith(dist + sep)) { response.writeHead(403).end(); return; }
    try {
      let body = await readFile(file);
      const extension = extname(file);
      if (extension === '.html') body = Buffer.from(body.toString().replaceAll(original, version));
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
      response.writeHead(200, { 'Content-Type': types[extension] ?? 'application/octet-stream' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`, original, next, requests,
    deploy: () => { version = next; }, retireDuring: suffix => { retireOn = suffix; },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}

async function trackMicrophone(page) {
  await page.evaluate(() => {
    const capture = MediaDevices.prototype.getUserMedia;
    window.microphoneRequests = 0;
    MediaDevices.prototype.getUserMedia = async function (...args) {
      window.microphoneRequests++;
      const stream = await Reflect.apply(capture, this, args);
      window.capturedTracks = stream.getTracks();
      return stream;
    };
  });
}

for (const source of ['microphone', 'generated tones']) {
  test(`an open tab safely updates before first starting ${source} after deployment`, async ({ page }) => {
    const fixture = await deploymentFixture();
    try {
      await syntheticAudio(page);
      const path = '/advanced/?source=bookmark#check';
      await page.goto(fixture.origin + path); await physicsReady(page); await trackMicrophone(page);
      if (source === 'generated tones') {
        await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.input-source').selectOption('generated');
      }
      fixture.deploy();
      if (source === 'generated tones') await page.locator('.review-start').click(); else await page.locator('.listening-toggle').click();
      const reload = page.getByRole('link', { name: 'Reload updated app' });
      await expect(reload).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.testContext.state)).toBe('closed');
      expect(await page.evaluate(() => window.microphoneRequests)).toBe(0);
      // The idle spectrum wave uses no audio context or capture.
      expect(await page.evaluate(() => window.microphoneRequests)).toBe(0);
      await reload.click();
      await expect(page).toHaveURL(fixture.origin + path);
      await physicsReady(page);
      await expect(page.locator('meta[name="musical-lights-assets"]')).toHaveAttribute('content', `/assets/${fixture.next}/`);
      if (source === 'generated tones') {
        await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.input-source').selectOption('generated');
      }
      if (source === 'generated tones') await page.locator('.review-start').click(); else await page.locator('.listening-toggle').check();
      await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.mic-status')).toBeEmpty();
  if (source !== 'generated tones') await expect(page.locator('.listening-toggle')).toBeEnabled();
      expect(fixture.requests).toContain(`/assets/${fixture.next}/loudness/loudness.wasm`);
      expect(fixture.requests).toContain(`/assets/${fixture.next}/loudness/processor.js`);
      if (source === 'generated tones') await page.locator('.review-stop').click(); else await page.locator('.listening-toggle').uncheck();
    } finally { await fixture.close(); }
  });
}

for (const resource of ['loudness/loudness.wasm', 'loudness/processor.js']) {
  test(`deployment during ${resource} loading offers recovery and releases the microphone`, async ({ page }) => {
    const fixture = await deploymentFixture();
    try {
      await syntheticAudio(page); await page.goto(fixture.origin); await physicsReady(page); await trackMicrophone(page);
      fixture.retireDuring(resource);
      await page.getByRole('checkbox', { name: 'Listening', exact: true }).click();
      await expect(page.getByRole('link', { name: 'Reload updated app' })).toBeVisible();
      expect(await page.evaluate(() => window.microphoneRequests)).toBe(1);
      await expect.poll(() => page.evaluate(() => [window.testContext.state, ...window.capturedTracks.map(track => track.readyState)])).toEqual(['closed', 'ended']);
      await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeEnabled();
    } finally { await fixture.close(); }
  });
}

test('a deployment leaves existing listening untouched and checks the next session', async ({ page }) => {
  const fixture = await deploymentFixture();
  try {
    await syntheticAudio(page); await page.goto(fixture.origin); await physicsReady(page);
    await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
    const stop = page.getByRole('checkbox', { name: 'Listening', exact: true });
    await expect(stop).toBeChecked();
    await expect(stop).toBeEnabled();
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
    const session = await page.locator('.audio-card').getAttribute('data-audio-session');
    fixture.deploy();
    await page.waitForTimeout(300);
    await expect(stop).toBeChecked();
    await expect(stop).toBeEnabled();
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-session', session);
    await expect(page.locator('.runtime-update')).toHaveCount(0);
    expect(await page.evaluate(() => window.testContext.state)).toBe('running');
    await stop.uncheck();
    await page.getByRole('checkbox', { name: 'Listening', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Reload updated app' })).toBeVisible();
  } finally { await fixture.close(); }
});
