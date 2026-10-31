import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { physicsReady, normalView, openFullscreenSettings, closeFullscreenSettings } from '../physics-state.mjs';
import { requireHardwareRenderer } from '../gpu-renderer.mjs';
import { activeGapIdentity } from '../active-gap-identity.mjs';
import { replayReport } from '../replay-physics.mjs';
import { recordPerformanceProcesses } from '../performance-processes.mjs';

// Only selected by the hardware configuration; the ordinary suite stays intact.
for (const mode of ['normal', 'portrait-fullscreen', 'landscape-fullscreen']) {
  test(`active gap five-minute acceptance: ${mode}`, async ({ page }, testInfo) => {
    test.setTimeout(600000);
    const identity = await activeGapIdentity();
    const sampler = await readFile(new URL('../active-gap-sampler.mjs', import.meta.url));
    const instrumentationSha256 = createHash('sha256').update(sampler).digest('hex');
    const errors = [], failedRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure() }));
    await page.setViewportSize(mode === 'landscape-fullscreen' ? { width: 844, height: 390 } : { width: 390, height: 844 });
    await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
    await page.route('**/active-gap-sampler.mjs', route => route.fulfill({ body: sampler, contentType: 'text/javascript' }));
    await page.goto('http://127.0.0.1:8101/advanced/');
    await physicsReady(page);
    expect(await page.locator('meta[name="musical-lights-assets"]').getAttribute('content')).toBe(`/assets/${identity.build.version}/`);
    if (mode === 'normal') await normalView(page);
    else {
      if (await page.locator('.audio-card').getAttribute('data-expanded') === null)
        await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await openFullscreenSettings(page);
    }
    await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
    await page.locator('.input-source').selectOption('generated');
    await page.locator('.review-start').click();
    await page.waitForFunction(() => document.querySelector('#dancinglights').physics.report.acceptanceWorkload());
    await page.locator('.diagnostics-controls').evaluate(node => { node.open = false; });
    await closeFullscreenSettings(page);
    await page.locator('#dancinglights').scrollIntoViewIfNeeded();
    const gpu = await page.evaluate(() => {
      const gl = document.querySelector('#dancinglights').physics.renderer.getContext();
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
    });
    requireHardwareRenderer(gpu);
    await page.waitForFunction(() => document.querySelector('#dancinglights').physics.sceneVisible);
    const nativePath = testInfo.outputPath('performance-processes.jsonl');
    const stopProcesses = await recordPerformanceProcesses(nativePath);
    let data;
    try {
      data = await page.evaluate(async mode => {
        const view = document.querySelector('#dancinglights').physics;
        const base = document.querySelector('meta[name="musical-lights-assets"]').content;
        const { evaluatePerformance } = await import(base + 'physics/performance.js');
        const { collectActiveGapPerformance } = await import('/active-gap-sampler.mjs');
        return collectActiveGapPerformance(view, mode, evaluatePerformance);
      }, mode);
    } finally {
      try { await stopProcesses(); }
      finally { await testInfo.attach('performance-processes', { path: nativePath, contentType: 'application/x-ndjson' }); }
    }
    await testInfo.attach('active-gap-performance', { body: JSON.stringify({ ...identity, instrumentationSha256,
      browserVersion: page.context().browser().version(), gpu, ...data, errors, failedRequests }), contentType: 'application/json' });
    assert.deepEqual(await activeGapIdentity(), identity, 'Build changed during performance capture');
    expect(errors).toEqual([]);
    expect(failedRequests).toEqual([]);
    expect(data.invalidReasons, JSON.stringify({ invalidations: data.invalidations, audioTransitions: data.audioTransitions,
      finalAudio: data.finalAudio })).toEqual([]);
    expect(data.numericPass, JSON.stringify({ ...data.summary, debt: data.debt, maxDebt: data.maxDebt,
      debtGrowthMs: data.debtGrowthMs, simulationLagMs: data.simulationLagMs,
      snapshotProgressDriftMs: data.snapshotProgressDriftMs, maxSnapshotAgeMs: data.maxSnapshotAgeMs })).toBe(true);
    expect((await replayReport(data)).every(row => row.matches)).toBe(true);
  });
}
