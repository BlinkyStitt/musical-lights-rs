import { test, expect } from '@playwright/test';
import { physicsReady } from '../physics-state.mjs';

for (const kind of ['stationary', 'stepped', 'sweep', 'two', 'volume', 'bursts', 'silence']) {
  test(`phone tone ${kind} uses the real worklet with synchronized diagnostics`, async ({ page }) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:8101/phone'); await physicsReady(page);
    await page.locator('.tone-kind').selectOption(kind);
    await page.locator('.tone-trace').check();
    await page.getByRole('button', { name: 'Start listening', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toBeVisible();
    await expect(page.locator('.tone-status')).toContainText(kind);
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.toneRows)).toBeGreaterThan(100);
    const data = await page.evaluate(() => {
      const report = document.querySelector('#dancinglights').physics.report;
      const rows = report.toneChunks.flatMap(c => {
        const out = [];
        for (let i = 0; i < c.values.length; i += c.stride) out.push(Array.from(c.values.slice(i, i + c.stride)));
        return out;
      });
      let error = 0;
      for (const row of rows) {
        const bands = row.slice(242, 266), peak = Math.max(...bands);
        const targets = bands.map((_, i) => row[269 + i * 5]), top = Math.max(...targets);
        if (peak) for (let i = 0; i < 24; i++) error = Math.max(error, Math.abs(targets[i] / top - bands[i] / peak));
      }
      return { error, metadata: report.toneMetadata, physics: report.tonePhysics.at(-1), stride: report.toneChunks[0].stride, sones: rows.at(-1)[1] };
    });
    expect(data.stride).toBe(389); expect(data.error).toBeLessThan(2e-7);
    expect(data.metadata.kind).toBe(kind); expect(data.physics.tops).toHaveLength(24);
    expect(data.physics.velocities).toHaveLength(24);
    if (kind === 'silence') expect(data.sones).toBe(0);
    else expect(data.sones).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Pause tone', exact: true }).click();
    await expect(page.locator('.tone-status')).toContainText('paused');
    await page.getByRole('button', { name: 'Resume tone', exact: true }).click();
    await expect(page.locator('.tone-status')).not.toContainText('paused');
    await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause tone', exact: true })).toBeDisabled();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export tone trace', exact: true }).click();
    expect((await download).suggestedFilename()).toContain('musical-lights-tones-');
    expect(errors).toEqual([]);
  });
}
