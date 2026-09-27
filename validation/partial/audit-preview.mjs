import { assertBrowserEnvironment } from '../browser-environment.mjs';
assertBrowserEnvironment();
// Usage: node validation/partial/audit-preview.mjs ORIGIN EXPECTED_BUILD [REPORT]
import { chromium, webkit, expect } from '../node_modules/@playwright/test/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import startup from '../browser-startup.mjs';
const [origin, build, output = '.cache/audio-audit/preview.json'] = process.argv.slice(2);
if (!origin || !build) throw new Error('Origin and exact expected build are required');
const expected = JSON.parse(await readFile('docs/audio-audit-results/audit.json', 'utf8'));
const finishBrowserAudit = await startup({ filteredProjects: ['chromium', 'webkit'].map(browserName => ({ name: browserName, use: { browserName } })) });
try {
const results = [];
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    expect((await page.goto(`${origin}/audio-audit/`)).status()).toBe(200);
    await expect(page.locator('#play')).toBeEnabled();
    await expect(page.locator('#fixture option')).toHaveCount(expected.cases.length);
    for (const fixture of ['recovered-150', 'short-burst', 'trumpet', 'music']) {
      await page.locator('#fixture').selectOption(fixture);
      await page.locator('#play').click();
      await expect(page.locator('#stop')).toBeEnabled();
      await expect(page.locator('#status')).toContainText(`${fixture}:`);
      await expect.poll(async () => Number((await page.locator('#status').textContent()).match(/: ([\d.]+) \//)?.[1] ?? 0)).toBeGreaterThan(.1);
      await page.locator('#stop').click();
    }
    await page.locator('#notes').fill('Automated export smoke check; not a listening judgment.');
    const download = page.waitForEvent('download'); await page.locator('#export').click();
    expect((await download).suggestedFilename()).toBe('listening-review.json');
    expect((await page.goto(`${origin}/flash-demo/`)).status()).toBe(200);
    await expect(page.locator('video')).toHaveCount(4);
    for (const video of await page.locator('video').all()) {
      await video.scrollIntoViewIfNeeded(); await video.evaluate(v => v.play());
      await expect.poll(() => video.evaluate(v => v.readyState >= 2 && v.currentTime > 0 && !v.error)).toBe(true);
    }
    expect((await page.goto(`${origin}/phone/`)).status()).toBe(200);
    await expect(page.getByRole('meter')).toHaveCount(24);
    await page.waitForFunction(() => document.querySelector('#dancinglights')?.physics?.current);
    const actualBuild = await page.evaluate(() => fetch('/physics/build.js').then(r => r.text()));
    expect(actualBuild.trim()).toBe(`export const build = '${build}';`);
    const wasm = await page.request.get(`${origin}/loudness/loudness.wasm`);
    expect(createHash('sha256').update(await wasm.body()).digest('hex')).toBe(expected.wasmSha256);
    expect(errors).toEqual([]);
    results.push({ browser: name, version: browser.version(), build, wasmSha256: expected.wasmSha256,
      playbackStarted: true, notesExported: true, actualRendererVideosPlay: true, bands: 24, errors, physicalPhone: false });
  } finally { await browser.close(); }
}
await writeFile(output, JSON.stringify({ origin, results }, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
} finally { await finishBrowserAudit(); }
