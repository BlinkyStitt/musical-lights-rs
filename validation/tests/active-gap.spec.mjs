import { test, expect } from '@playwright/test';
import { physicsReady, normalView, syntheticAudio, startFrozen } from '../physics-state.mjs';
const origin = 'http://127.0.0.1:8101';
const sliderName = 'Active gap cap (cm)';
test.use({ hasTouch: true });

test('active gap cap edits, validates, restores and resets without acquiring audio', async ({ page }) => {
  await page.addInitScript(() => { window.captureRequests = 0; MediaDevices.prototype.getUserMedia = async () => { window.captureRequests++; throw new Error('Unexpected capture'); }; });
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await page.locator('.display-controls').evaluate(n => { n.open = true; });
  const slider = page.getByRole('slider', { name: sliderName, exact: true });
  await expect(slider).toHaveValue('60');
  await page.getByRole('button', { name: `Increase ${sliderName}`, exact: true }).click(); await expect(slider).toHaveValue('61');
  await slider.focus(); await slider.press('ArrowLeft'); await expect(slider).toHaveValue('60');
  await page.getByRole('button', { name: `Edit ${sliderName}`, exact: true }).click();
  const editor = page.getByRole('spinbutton', { name: `${sliderName} value`, exact: true });
  await editor.fill('2001'); await editor.press('Enter'); await expect(editor).toBeVisible(); await expect(slider).toHaveValue('60');
  await editor.fill('2000'); await editor.press('Enter'); await expect(slider).toHaveValue('2000');
  await page.getByRole('button', { name: `Increase ${sliderName}`, exact: true }).click(); await expect(slider).toHaveValue('2000');
  await page.getByRole('button', { name: `Edit ${sliderName}`, exact: true }).click();
  await editor.fill('40.5'); await editor.press('Enter'); await expect(editor).toBeVisible(); await expect(slider).toHaveValue('2000');
  await editor.fill('40'); await editor.press('Enter'); await expect(slider).toHaveValue('40');
  await page.getByRole('button', { name: 'About active gap cap', exact: true }).click();
  await expect(page.getByRole('tooltip')).toContainText('Ball and flight clearance reduce actual bar travel');
  await page.reload(); await physicsReady(page); await normalView(page);
  await page.locator('.display-controls').evaluate(n => { n.open = true; }); await expect(slider).toHaveValue('40');
  await page.goto(origin + '/'); await physicsReady(page); await normalView(page);
  await page.locator('.display-controls').evaluate(n => { n.open = true; }); await expect(slider).toHaveValue('40');
  await page.locator('.display-controls').evaluate(n => { n.open = true; });
  await page.getByRole('button', { name: 'Reset display', exact: true }).click(); await expect(slider).toHaveValue('60');
  expect(await page.evaluate(() => !!document.querySelector('.audio-card').activeAudioContext)).toBe(false);
  expect(await page.evaluate(() => window.captureRequests)).toBe(0);
});

test('live gap edits preserve measured meters and filtered targets while physics continues', async ({ page }) => {
  // Wait for mobile expansion to mount before leaving it for normal-page controls.
  await syntheticAudio(page); await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page); await startFrozen(page);
  await expect(page.locator('.audio-card')).not.toHaveAttribute('data-expanded');
  await page.evaluate(() => window.sendBars(Array(24).fill(.6)));
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[0])).toBeCloseTo(.6, 6);
  const measured = () => page.getByRole('meter').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-valuenow')));
  const before = await measured();
  const tick = await page.evaluate(() => document.querySelector('#dancinglights').physics.current[2]);
  await page.locator('.display-controls').evaluate(node => { node.open = true; });
  for (const cap of [40, 2000, 60]) {
    await page.getByRole('slider', { name: sliderName, exact: true }).fill(String(cap));
    await expect.poll(() => page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      const expectedBase = (v.height - Math.min(v.height, v.input[67])) / 2 + .003;
      return Math.abs(v.current[v.layout[17] + 5] - expectedBase) < 1e-5;
    })).toBe(true);
    expect(await measured()).toEqual(before);
    const state = await page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      return { targets: Array.from(v.input.slice(0, 24)), tick: v.current[2], balls: v.balls.count };
    });
    expect(state.targets).toEqual(Array(24).fill(Math.fround(.6)));
    expect(state.tick).toBeGreaterThan(tick); expect(state.balls).toBe(8);
  }
});

test('restored cap constructs active placement and live geometry reaches all banks in shared fullscreen Settings', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('musical-lights-display-v1', JSON.stringify({ version: 1, activeGapCap: 40, flight: 35 })));
  await page.goto(origin + '/advanced/'); await physicsReady(page);
  const before = await page.evaluate(() => { const v = document.querySelector('#dancinglights').physics; return { tick: v.current[2], height: v.canvasHeight }; });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.display-controls').evaluate(n => { n.open = true; });
  const slider = page.getByRole('slider', { name: sliderName, exact: true });
  await expect(slider).toHaveValue('40'); await slider.fill('60');
  await expect.poll(() => page.evaluate(() => { const v = document.querySelector('#dancinglights').physics; return Math.abs(v.current[v.layout[17] + 6] - .1283) < 1e-5; })).toBe(true);
  const state = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics; v.draw(performance.now()); v.sideBars.update(v.layout);
    const base = v.current[v.layout[17] + 5], height = v.current[v.layout[17]], tops = Array.from(v.renderedTops);
    return { base, height, tick: v.current[2], canvasHeight: v.canvasHeight, balls: v.balls.count, audio: !!v.card.activeAudioContext,
      tops, source: Array.from(v.bars.instanceMatrix.array), side: Array.from(v.sideBars.mesh.instanceMatrix.array), sideCount: v.sideBars.mesh.count, sideBands: Array.from(v.sideBars.sourceBands.slice(0, v.sideBars.mesh.count)), offsets: Array.from(v.sideBars.offsets.slice(0, v.sideBars.mesh.count)), input: v.input[67], report: v.report.readConfig()[11] };
  });
  expect(state.tick).toBeGreaterThan(before.tick); expect(state.canvasHeight).toBe(before.height); expect(state.balls).toBe(8); expect(state.audio).toBe(false);
  expect(state.base).toBeCloseTo((state.height - .6) / 2 + .003, 3); expect(state.report).toBeCloseTo(.6, 6);
  for (let i = 0; i < 144; i++) expect(Math.abs(state.source[i * 16 + 5])).toBeCloseTo(state.tops[i % 24], 5);
  expect(new Set(state.offsets).size).toBe(8);
  for (let i = 0; i < state.sideCount; i++) expect(Math.abs(state.side[i * 16 + 5])).toBeCloseTo(state.tops[state.sideBands[i]], 5);
  await slider.focus(); await slider.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
});
