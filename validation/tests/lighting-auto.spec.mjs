import { test, expect } from '@playwright/test';
import { physicsReady, syntheticAudio, startFrozen, normalView } from '../physics-state.mjs';
const origin = 'http://127.0.0.1:8101';

test('Auto measures startup, freezes its choice, and manual depth cancels a retest', async ({ page }) => {
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.depthProfile?.done), { timeout: 30000 }).toBe(true);
  const count = await page.locator('.depth-slider').inputValue();
  expect(Number(count)).toBeGreaterThanOrEqual(0); expect(Number(count)).toBeLessThanOrEqual(2048);
  await expect(page.locator('.depth-status')).toHaveAttribute('title', /Hz target/);
  await page.getByRole('button', { name: 'Retest', exact: true }).click();
  await page.locator('.depth-slider').fill('128');
  await expect.poll(() => page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return [v.settings.depthMode, v.mirrors.count, v.depthProfile.done, v.balls.count];
  })).toEqual(['manual', 128, true, 8]);
  await page.reload(); await physicsReady(page);
  expect(await page.locator('.depth-slider').inputValue()).toBe('128');
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.depthProfile)).toBeUndefined();
});

test('Auto stops when its scene leaves the viewport and waits for an explicit retest', async ({ page }) => {
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await page.getByRole('button', { name: 'Retest', exact: true }).click();
  await page.locator('footer').scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.depthProfile.done)).toBe(true);
  await expect(page.locator('.depth-status')).toHaveText('Auto paused');
  const selected = await page.locator('.depth-slider').inputValue();
  await page.locator('#dancinglights').scrollIntoViewIfNeeded();
  expect(await page.locator('.depth-slider').inputValue()).toBe(selected);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.depthProfile.done)).toBe(true);
});

test('bar and ball light changes visible surfaces throughout the enclosure depth', async ({ page }, info) => {
  await syntheticAudio(page); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(origin + '/advanced/'); await normalView(page); await startFrozen(page);
  await page.locator('.depth-slider').fill('8');
  await page.evaluate(() => window.sendBars(Array(24).fill(.4), 1));
  await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.edges))).toBe(.5);
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.renderedHeight(0))).toBeGreaterThan(.01);
  const result = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    v.draw(performance.now());
    const depth = v.config[5], middle = -depth * 4;
    const camera = new THREE.OrthographicCamera(-depth * 5, depth * 5, v.height / 2, -v.height / 2, .01, 20);
    camera.position.set(-2, v.height / 2, middle); camera.lookAt(v.width / 2, v.height / 2, middle); camera.updateMatrixWorld();
    v.lighting.uniforms.lightView.value.setFromMatrix4(camera.matrixWorldInverse);
    const target = new THREE.WebGLRenderTarget(600, 240), pixels = new Uint8Array(600 * 240 * 4);
    const draw = () => { v.renderer.setRenderTarget(target); v.renderer.render(v.scene, camera); v.renderer.readRenderTargetPixels(target, 0, 0, 600, 240, pixels); return pixels.slice(); };
    const u = v.lighting.uniforms, settings = { ...v.settings };
    const visibility = v.bars.visible; const sideVisibility = v.sideBars.mesh.visible;
    try {
      // Keep the coating and balls visible, so differences measure emitted light
      // on nearby surfaces rather than only the source bar's own emission.
      v.bars.visible = false; v.sideBars.mesh.visible = false;
      u.colorEmission.value.set(0, 0); u.lightStrength.value.set(0, 0, settings.lightRange, 0);
      const dark = draw();
      v.lighting.configure({ ...settings, barGlow: .08, ballGlow: .12, colorSpill: .18, attackLight: 0 });
      const color = draw();
      v.lighting.configure({ ...settings, barGlow: .08, ballGlow: .12, colorSpill: .18, attackLight: .8 });
      const white = draw();
      const regions = Array.from({ length: 3 }, () => ({ colored: 0, white: 0, coloredDelta: 0, whiteDelta: 0 }));
      for (let y = 0; y < 240; y++) for (let x = 50; x < 550; x++) {
        const i = (y * 600 + x) * 4, region = regions[Math.min(2, Math.floor((x - 50) * 3 / 500))];
        const c = [0, 1, 2].map(k => color[i + k] - dark[i + k]);
        const w = [0, 1, 2].map(k => white[i + k] - color[i + k]);
        if (Math.max(...c) > 0) region.colored++;
        if (Math.max(...w) > 0) region.white++;
        region.coloredDelta += c.reduce((a, b) => a + b, 0); region.whiteDelta += w.reduce((a, b) => a + b, 0);
      }
      return { regions, sourceEdges: Array.from(v.edges), stripEdges: u.stripState.value.map(s => s.z),
        clock: { audio: window.audioNow, context: window.testContext.currentTime, analysis: window.lastAnalysisTime }, strips: u.stripState.value.length, balls: u.glowBallPosition.value.length,
        pointLights: v.scene.children.filter(n => n.isPointLight).length,
        physicalBalls: v.balls.count, copies: v.mirrors.count };
    } finally {
      v.bars.visible = visibility; v.sideBars.mesh.visible = sideVisibility;
      v.lighting.configure(settings); v.renderer.setRenderTarget(null); target.dispose();
    }
  });
  await info.attach('depth-lighting.json', { body: JSON.stringify(result), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('shared-lighting.png'), fullPage: true });
  for (const region of result.regions) {
    expect(region.colored).toBeGreaterThan(10); expect(region.white).toBeGreaterThan(10);
    expect(region.coloredDelta).toBeGreaterThan(0); expect(region.whiteDelta).toBeGreaterThan(0);
  }
  expect(result.sourceEdges).toEqual(Array(24).fill(.5)); expect(result.stripEdges).toEqual(result.sourceEdges);
  expect(result.strips).toBe(24); expect(result.balls).toBe(8); expect(result.physicalBalls).toBe(8); expect(result.copies).toBe(8); expect(result.pointLights).toBe(0);
});

test('scene resolution changes drawing pixels while physical geometry stays fixed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await page.locator('.depth-slider').fill('8');
  const state = () => page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return { pixels: v.canvas.width * v.canvas.height, width: v.width, height: v.height, balls: v.balls.count, depth: v.mirrors.count };
  });
  const before = await state();
  await page.getByText('Lighting & rendering', { exact: true }).click();
  const resolution = page.locator('[data-render-setting="resolution"]');
  await resolution.fill('.5'); await resolution.dispatchEvent('change');
  await expect.poll(async () => (await state()).pixels).toBeLessThan(before.pixels * .26);
  const after = await state();
  expect(after.pixels).toBeGreaterThan(before.pixels * .24);
  expect({ ...after, pixels: before.pixels }).toEqual(before);
});
