import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { physicsReady } from '../physics-state.mjs';
const origin = 'http://127.0.0.1:8101';
const output = fileURLToPath(new URL('../../docs/musical-motion-results/', import.meta.url));

for (const theme of ['light', 'dark']) {
  test(`shared compact bar, collapsed settings and fullscreen safe layout in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`${origin}/advanced/`); await physicsReady(page);
    const labels = await page.locator('.button-row .setting-switch span').allTextContents();
    expect(labels).toEqual(['Listening', 'Phone motion', 'Scroll lights', 'Identify song']);
    for (const section of ['display', 'calibration', 'physics', 'diagnostics']) expect(await page.locator(`.${section}-controls`).evaluate(n => n.open)).toBe(false);
    expect(await page.locator('.song-history').evaluate(n => n.open)).toBe(false);
    expect(await page.evaluate(() => {
      const bar = document.querySelector('.audio-controls').getBoundingClientRect();
      const source = document.querySelector('.input-source-controls').getBoundingClientRect();
      const graph = document.querySelector('.spectrum-panel').getBoundingClientRect();
      return { barAboveSource: bar.bottom <= source.top, sourceAboveGraph: source.bottom <= graph.top, fits: document.documentElement.scrollWidth <= innerWidth };
    })).toEqual({ barAboveSource: true, sourceAboveGraph: true, fits: true });
    await page.locator('.input-source').selectOption('generated');
    await expect(page.locator('.review-start')).toBeVisible();
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.locator('.input-source-controls')).toBeHidden();
    for (const viewport of [{ width: 320, height: 720 }, { width: 568, height: 320 }]) {
      await page.setViewportSize(viewport);
      for (const label of ['Listening', 'Phone motion', 'Scroll lights', 'Identify song']) {
        const control = page.getByRole('checkbox', { name: label, exact: true });
        await expect(control.locator('..')).toBeInViewport({ ratio: 1 });
        expect(await control.locator('..').evaluate(n => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      }
      await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await page.locator('.scroll-lights').focus(); await page.keyboard.press('Space');
    await expect(page.locator('.scroll-lights')).not.toBeChecked();
    await expect(page.locator('.scroll-lights')).toBeFocused();
    await expect(page.locator('.scroll-lights')).toHaveCSS('outline-style', 'solid');
  });
}

test('lit geometry, contact pigments and Reduced Motion drift use the physical scene', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${origin}/advanced/`); await physicsReady(page);
  await page.locator('.display-controls > summary').click();
  await page.locator('.camera-rotation').fill('30');
  const state = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    // A worker receipt may precede the next animation frame. Render this
    // snapshot before comparing its contact history with mesh attributes.
    v.draw(performance.now());
    const target = new THREE.WebGLRenderTarget(240, 160);
    const pixels = new Uint8Array(240 * 160 * 4);
    const lights = v.scene.children.filter(n => n.isLight), intensities = lights.map(n => n.intensity);
    const sum = () => { v.renderer.setRenderTarget(target); v.renderer.render(v.scene, v.camera); v.renderer.readRenderTargetPixels(target, 0, 0, 240, 160, pixels); return pixels.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : value), 0); };
    const lit = sum(); lights.forEach(n => { n.intensity = 0; }); const dark = sum();
    v.attackLights[0].position.set(v.width / 2, .2, 0); v.attackLights[0].intensity = .035;
    const attackOnly = sum();
    lights.forEach((n, i) => { n.intensity = intensities[i]; });
    // Isolate one prescribed bar and sample its physical side face. The old
    // XY-only outline painted this entire face black, even under fill light.
    const count = v.bars.count, matrix = new THREE.Matrix4().fromArray(v.bars.instanceMatrix.array, 0);
    const hidden = [v.balls, v.enclosure, v.ceiling]; hidden.forEach(n => { n.visible = false; });
    const object = new THREE.Object3D(); object.position.set(.6, .3 - v.layout[6] / 2, 0); object.updateMatrix();
    v.bars.count = 1; v.bars.setMatrixAt(0, object.matrix); v.bars.instanceMatrix.needsUpdate = true;
    const point = new THREE.Vector3(.6 + (v.layout[3] - v.layout[4]) / 2, .12, 0).project(v.camera);
    sum();
    const pixel = ((Math.floor((point.y + 1) * 80) * 240) + Math.floor((point.x + 1) * 120)) * 4;
    const sideBrightness = pixels[pixel] + pixels[pixel + 1] + pixels[pixel + 2];
    v.bars.count = count; v.bars.setMatrixAt(0, matrix); v.bars.instanceMatrix.needsUpdate = true;
    hidden.forEach(n => { n.visible = true; });
    lights.forEach((n, i) => { n.intensity = intensities[i]; }); v.renderer.setRenderTarget(null); target.dispose();
    return { lit, dark, attackOnly, sideBrightness, barsLit: v.bars.material.isMeshLambertMaterial, walls: v.enclosure.children.length,
      attacks: v.attackLights.length, shadows: v.renderer.shadowMap.enabled, pigments: Array.from(v.pigments),
      color: Array.from(v.current.slice(18, 21)), pattern: Array.from(v.balls.geometry.attributes.pigmentA.array.slice(0, 3)) };
  });
  expect(state.barsLit).toBe(true); expect(state.walls).toBe(4); expect(state.attacks).toBe(4); expect(state.shadows).toBe(false);
  expect(state.lit).toBeGreaterThan(state.dark * 1.5);
  expect(state.attackOnly).toBeGreaterThan(state.dark + 100);
  expect(state.sideBrightness).toBeGreaterThan(30);
  expect(state.pattern).toEqual(state.pigments.slice(0, 3));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const phase = await page.evaluate(() => document.querySelector('#dancinglights').physics.patternTime.value);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.patternTime.value)).toBe(phase);
  expect(errors).toEqual([]);
});

test('identical-audio scrolling, angled lighting and swirl previews record frame cost', async ({ page }, info) => {
  await mkdir(output, { recursive: true });
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto(`${origin}/advanced/`); await physicsReady(page);
  await page.locator('.input-source').selectOption('trumpet');
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await page.locator('.display-controls > summary').click();
  await page.locator('.camera-rotation').fill('25');
  await page.locator('#dancinglights').scrollIntoViewIfNeeded();
  const measurements = [];
  for (const scrolling of [true, false]) {
    await page.locator('.scroll-lights').setChecked(scrolling);
    await page.locator('.review-replay').click();
    await page.waitForTimeout(2000);
    const metrics = await page.evaluate(() => new Promise(resolve => {
      const v = document.querySelector('#dancinglights').physics;
      const start = performance.now(), frames = v.metrics.frames, cost = v.metrics.renderMs, times = [];
      let previous = start;
      const sample = now => { times.push(now - previous); previous = now;
        if (now - start < 4000) requestAnimationFrame(sample);
        else { const sorted = times.toSorted((a, b) => a - b); resolve({ fps: times.length * 1000 / (now - start),
          p95FrameMs: sorted[Math.ceil(sorted.length * .95) - 1], meanRenderMs: (v.metrics.renderMs - cost) / (v.metrics.frames - frames),
          debt: v.metrics.debt, discardedSimulationMs: v.metrics.discardedSimulationMs, bpm: v.tempo, confidence: v.tempoConfidence,
          clip: v.card.review.identity, diagnostics: v.card.dataset.toneDiagnostics, physicalDevice: false }); }
      }; requestAnimationFrame(sample);
    }));
    const build = JSON.parse(await readFile(new URL('../../musical-leptos/dist/build.json', import.meta.url), 'utf8'));
    measurements.push({ build, measuredAt: new Date().toISOString(), scrolling, ...metrics });
    await page.screenshot({ path: `${output}/${info.project.name}-${scrolling ? 'scrolling' : 'stationary'}-angled-swirl.png` });
  }
  expect(measurements[0].clip.pcmSha256).toBe(measurements[1].clip.pcmSha256);
  expect(measurements.every(m => m.diagnostics === 'false' && m.discardedSimulationMs === 0)).toBe(true);
  await writeFile(`${output}/${info.project.name}-render-cost.json`, JSON.stringify(measurements, null, 2) + '\n');
});

test('source selection waits for its handlers and digital transport to initialize', async ({ page }) => {
  let release;
  const initialized = new Promise(resolve => { release = resolve; });
  await page.route('**/physics/physics_bg.wasm', async route => {
    await initialized; await route.continue();
  });
  await page.addInitScript(() => {
    window.microphoneRequests = 0;
    MediaDevices.prototype.getUserMedia = async () => { window.microphoneRequests++; throw Error('Unexpected microphone request'); };
  });
  await page.goto(`${origin}/advanced/`);
  const source = page.locator('.input-source');
  await expect(source).toBeDisabled();
  release();
  await source.selectOption('generated');
  await expect(page.locator('.review-start')).toBeVisible();
  await page.locator('.review-start').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.listening-toggle')).not.toBeChecked();
  expect(await page.evaluate(() => microphoneRequests)).toBe(0);
});
