// Host measurements only; these never constitute physical-phone acceptance.
import { chromium, webkit, devices } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import checkBrowserStartup from './browser-startup.mjs';
const url = process.argv[2] ?? 'http://127.0.0.1:8104';
const output = process.argv[3] ?? 'docs/gain-stroke-results';
const summary = values => {
  const sorted = values.toSorted((a,b) => a-b);
  return { mean: values.reduce((a,b) => a+b,0) / values.length, p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
};
await checkBrowserStartup({ filteredProjects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }] });
const result = await readFile(`${output}/browser-timing-detail.json.gz`).then(bytes => JSON.parse(gunzipSync(bytes))).catch(() => []);
for (const [name, engine, profile] of [['chromium-mac', chromium, {}], ['iphone-profile-webkit-mac', webkit, devices['iPhone 13']]]) {
  const browser = await engine.launch();
  try {
    for (const mode of ['normal', 'portrait-fullscreen', 'landscape-fullscreen']) {
      if (result.some(item => item.name === name && item.mode === mode)) continue;
      const context = await browser.newContext({ ...profile, viewport: mode === 'landscape-fullscreen' ? { width: 844, height: 390 } : { width: 390, height: 844 } });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${url}/phone/`);
      await page.waitForFunction(() => document.querySelector('#dancinglights')?.physics?.current);
      await page.getByRole('button', { name: 'Start listening', exact: true }).click();
      await page.getByRole('button', { name: 'Stop listening', exact: true }).waitFor();
      if (mode !== 'normal') await page.getByRole('button', { name: /fullscreen/i }).first().click();
      // Keep the graph visible while the normal page's tone panel is open below it.
      await page.locator('.audio-card').scrollIntoViewIfNeeded();
      await page.waitForTimeout(5000);
      const data = await page.evaluate(() => new Promise(resolve => {
        const v = document.querySelector('#dancinglights').physics;
        const start = performance.now(), before = { ...v.metrics }, intervals = [], progress = [];
        let previous;
        const sample = now => {
          if (previous != null) intervals.push(now - previous);
          previous = now;
          progress.push({ ms: now - start, debt: v.metrics.debt, snapshotAge: v.metrics.snapshotAgeMs, tick: v.current[2], substeps: v.current[v.layout[15]], excess: v.current[v.layout[15] + 1] });
          if (now - start < 30000) requestAnimationFrame(sample);
          else resolve({ before, after: { ...v.metrics }, intervals, progress, config: v.config, layout: v.layout, userAgent: navigator.userAgent });
        };
        requestAnimationFrame(sample);
      }));
      const frames = summary(data.intervals), debts = summary(data.progress.map(p => p.debt));
      const item = { name, mode, physicalPhone: false, ...data, summary: { fps: 1000 / frames.mean, frameMs: frames, physicsDebtMs: debts,
        over25Fraction: data.intervals.filter(x => x > 25).length / data.intervals.length,
        physicsCpuMsPerTick: (data.after.physicsMs - data.before.physicsMs) / (data.after.physicsSteps - data.before.physicsSteps),
        overloadTicks: data.after.overloadTicks - data.before.overloadTicks }, errors };
      result.push(item); console.log(name, mode, item.summary);
      await page.screenshot({ path: `${output}/${name}-${mode}.png` });
      if (mode !== 'normal') await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
      await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
      await context.close();
      await writeFile(`${output}/browser-timing-detail.json.gz`, gzipSync(JSON.stringify(result)));
      await writeFile(`${output}/browser-timing.json`, JSON.stringify(result.map(({ intervals, progress, ...summary }) => summary), null, 2) + '\n');
    }
  } finally { await browser.close(); }
}
