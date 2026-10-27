import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openFullscreenSettings, closeFullscreenSettings, physicsReady } from '../physics-state.mjs';
const origin = 'http://127.0.0.1:8101';

for (const theme of ['light', 'dark']) {
  test(`shared compact bar, collapsed settings and fullscreen safe layout in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`${origin}/advanced/`); await physicsReady(page);
    const labels = await page.locator('.button-row .setting-switch > span').allTextContents();
    expect(labels).toEqual(['Listening', 'Identify song', 'Phone motion', 'Scroll lights']);
    for (const section of ['display', 'calibration', 'physics', 'diagnostics']) expect(await page.locator(`.${section}-controls`).evaluate(n => n.open)).toBe(false);
    expect(await page.locator('.song-history').evaluate(n => n.open)).toBe(false);
    expect(await page.evaluate(() => {
      const bar = document.querySelector('.audio-controls').getBoundingClientRect();
      const source = document.querySelector('.input-source-controls').getBoundingClientRect();
      const graph = document.querySelector('.spectrum-panel').getBoundingClientRect();
      return { barAboveSource: bar.bottom <= source.top, graphAboveBar: graph.bottom <= bar.top, fits: document.documentElement.scrollWidth <= innerWidth };
    })).toEqual({ barAboveSource: true, graphAboveBar: true, fits: true });
    await page.locator('.input-source').selectOption('generated');
    await expect(page.locator('.review-start')).toBeVisible();
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.locator('.input-source-controls')).toBeHidden();
    for (const viewport of [{ width: 320, height: 720 }, { width: 568, height: 320 }]) {
      await page.setViewportSize(viewport);
      await openFullscreenSettings(page);
      for (const label of ['Listening', 'Identify song', 'Phone motion', 'Scroll lights']) {
        const control = page.getByRole('checkbox', { name: label, exact: true });
        await control.locator('..').evaluate(n => n.scrollIntoView({ block: 'center' }));
        await expect(control.locator('..')).toBeInViewport({ ratio: 1 });
        expect(await control.locator('..').evaluate(n => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      }
      await closeFullscreenSettings(page);
      const exit = page.getByRole('button', { name: 'Exit fullscreen', exact: true });
      await exit.evaluate(n => n.scrollIntoView({ block: 'center' }));
      await expect(exit).toBeInViewport({ ratio: 1 });
      expect(await exit.evaluate(n => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const overlaps = await page.locator('.scene-controls').evaluate(node => {
        const controls = [...node.querySelectorAll('button,input,output')].filter(n => !n.hidden && n.getBoundingClientRect().width > 0);
        return controls.flatMap((a, i) => controls.slice(i + 1).flatMap(b => {
          const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
          const area = Math.max(0, Math.min(x.right, y.right) - Math.max(x.left, y.left))
            * Math.max(0, Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top));
          return area > .5 ? [[a.className, b.className]] : [];
        }));
      });
      expect(overlaps).toEqual([]);
    }
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await page.locator('.scroll-lights').focus(); await page.keyboard.press('Space');
    await expect(page.locator('.scroll-lights')).not.toBeChecked();
    await expect(page.locator('.scroll-lights')).toBeFocused();
    await expect(page.locator('.scroll-lights')).toHaveCSS('outline-style', 'solid');
  });
}

test('lit geometry and gradual contact pigments use the physical scene with Reduced Motion', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${origin}/advanced/`); await physicsReady(page);
  await page.locator('.display-controls > summary').click();
  await page.locator('.camera-rotation').fill('30');
  const state = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    const { linearToHsluv } = await import(new URL(`${base}physics/pigment.js`, document.baseURI));
    // A worker receipt may precede the next animation frame. Render this
    // snapshot before comparing its contact history with mesh attributes.
    v.draw(performance.now());
    // Measure physical surface lighting separately from the opaque atmosphere.
    const target = new THREE.WebGLRenderTarget(240, 160);
    const pixels = new Uint8Array(240 * 160 * 4);
    const lights = v.scene.children.filter(n => n.isLight), intensities = lights.map(n => n.intensity);
    const sum = () => { v.renderer.setRenderTarget(target); v.renderer.render(v.scene, v.camera); v.renderer.readRenderTargetPixels(target, 0, 0, 240, 160, pixels); return pixels.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : value), 0); };
    const u = v.lighting.uniforms, strength = u.lightStrength.value.clone(), emission = u.colorEmission.value.clone();
    const edges = u.stripState.value.map(s => s.z);
    u.lightStrength.value.set(0, 0, strength.z, 0); u.colorEmission.value.set(0, 0);
    const lit = sum(); lights.forEach(n => { n.intensity = 0; }); const dark = sum();
    u.stripState.value.forEach(s => { s.z = 1; }); u.lightStrength.value.y = .8;
    const attackOnly = sum();
    u.stripState.value.forEach((s, i) => { s.z = edges[i]; });
    u.lightStrength.value.copy(strength); u.colorEmission.value.copy(emission);
    lights.forEach((n, i) => { n.intensity = intensities[i]; });
    // Sample the real outer front coating. Joined flat tops omit the
    // internal end faces of the former rectangular bars.
    const count = v.bars.count, matrix = new THREE.Matrix4().fromArray(v.bars.instanceMatrix.array, 0);
    const hidden = [v.balls, v.sideBars.mesh, v.enclosure]; hidden.forEach(n => { n.visible = false; });
    const object = new THREE.Object3D(); object.position.set(.6, .15, 0); object.scale.set(1, .3, v.config[5]); object.updateMatrix();
    v.bars.count = 1; v.bars.setMatrixAt(0, object.matrix); v.bars.instanceMatrix.needsUpdate = true;
    const point = new THREE.Vector3(.6, .12, v.config[5] / 2).project(v.camera);
    sum();
    const pixel = ((Math.floor((point.y + 1) * 80) * 240) + Math.floor((point.x + 1) * 120)) * 4;
    const frontBrightness = pixels[pixel] + pixels[pixel + 1] + pixels[pixel + 2];
    v.bars.count = count; v.bars.setMatrixAt(0, matrix); v.bars.instanceMatrix.needsUpdate = true;
    hidden.forEach(n => { n.visible = true; });
    lights.forEach((n, i) => { n.intensity = intensities[i]; }); v.renderer.setRenderTarget(null); target.dispose();
    return { lit, dark, attackOnly, frontBrightness, barsLit: v.bars.material.isMeshLambertMaterial, walls: v.enclosure.geometry.groups.length,
      attacks: u.stripState.value.length, pointLights: lights.filter(n => n.isPointLight).length, shadows: v.renderer.shadowMap.enabled, pigments: Array.from(v.pigments),
      color: Array.from(v.current.slice(18, 21)), lightColor: v.lighting.uniforms.glowBallColor.value[0].toArray(), expectedPattern: Array.from(new Float32Array(linearToHsluv(v.pigments.slice(0, 3)))), pattern: Array.from(v.balls.geometry.attributes.pigmentA.array.slice(0, 3)) };
  });
  expect(state.barsLit).toBe(true); expect(state.walls).toBe(6); expect(state.attacks).toBe(24); expect(state.pointLights).toBe(0); expect(state.shadows).toBe(false);
  expect(state.lit).toBeGreaterThan(state.dark * 1.5);
  expect(state.attackOnly).toBeGreaterThan(state.dark + 100);
  expect(state.frontBrightness).toBeGreaterThan(30);
  expect(state.pattern).toEqual(state.expectedPattern);
  expect(state.lightColor).toEqual(state.color);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.balls.material.transparent)).toBe(false);
  expect(errors).toEqual([]);
});

test('identical-audio scrolling, angled lighting and swirl previews record frame cost', async ({ page }, info) => {
  const output = info.outputPath('previews');
  await mkdir(output, { recursive: true });
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto(`${origin}/advanced/`); await physicsReady(page);
  await page.locator('.display-controls > summary').press('Enter');
  await page.locator('.camera-rotation').fill('25');
  await page.locator('#dancinglights').scrollIntoViewIfNeeded();
  // Wait for a real draw at the requested angle, rather than a fixed sleep.
  // Register the sampler before each native Replay gesture so protocol work
  // cannot consume part of the four-second measurement interval.
  await page.waitForFunction(() => document.querySelector('#dancinglights').physics.metrics.frames > 0);
  await page.locator('.input-source').selectOption('trumpet');
  await page.waitForFunction(() => document.querySelector('.audio-card').dataset.audioState === 'playing'
    && !document.querySelector('.review-replay').disabled, null, { timeout: 5000 });
  const build = JSON.parse(await readFile(new URL('../../musical-leptos/dist/build.json', import.meta.url), 'utf8'));
  const measurements = [];
  for (const scrolling of [true, false]) {
    const scroll = page.locator('.scroll-lights');
    if (!scrolling) await scroll.press('Space');
    await expect(scroll).toBeChecked({ checked: scrolling });
    await page.evaluate(() => {
      window.previewMeasurement = new Promise(resolve => {
        const card = document.querySelector('.audio-card');
        const begin = ({ detail }) => {
          if (detail.reason !== 'source start') return;
          card.removeEventListener('audio-session', begin);
          const v = document.querySelector('#dancinglights').physics;
          const start = performance.now(), frames = v.metrics.frames, cost = v.metrics.renderMs, times = [];
          let previous = start;
          const sample = now => { times.push(now - previous); previous = now;
            if (now - start < 4000) requestAnimationFrame(sample);
            else { const sorted = times.toSorted((a, b) => a - b); resolve({ fps: times.length * 1000 / (now - start),
              p95FrameMs: sorted[Math.ceil(sorted.length * .95) - 1], meanRenderMs: (v.metrics.renderMs - cost) / (v.metrics.frames - frames),
              debt: v.metrics.debt, discardedSimulationMs: v.metrics.discardedSimulationMs, bpm: v.tempo, confidence: v.tempoConfidence,
              clip: v.card.review.identity, diagnostics: v.card.dataset.toneDiagnostics, audioState: v.card.dataset.audioState,
              startState: detail.state, physicalDevice: false }); }
          }; requestAnimationFrame(sample);
        };
        card.addEventListener('audio-session', begin);
      });
    });
    await page.locator('.review-replay').press('Enter');
    const metrics = await page.evaluate(() => window.previewMeasurement);
    measurements.push({ build, measuredAt: new Date().toISOString(), scrolling, ...metrics });
    await page.screenshot({ path: `${output}/${info.project.name}-${scrolling ? 'scrolling' : 'stationary'}-angled-swirl.png` });
  }
  expect(measurements[0].clip.pcmSha256).toBe(measurements[1].clip.pcmSha256);
  expect(measurements.every(m => m.diagnostics === 'false' && m.discardedSimulationMs === 0)).toBe(true);
  expect(measurements.every(m => m.startState === 'playing' && m.audioState === 'playing')).toBe(true);
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

test('slider buttons step once and value editors validate, cancel and save', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('http://127.0.0.1:8101/advanced/'); await physicsReady(page);
  const exit = page.getByRole('button', {name: 'Exit fullscreen', exact: true});
  if (await exit.isVisible()) await exit.click();
  await page.locator('.display-controls').evaluate(node => { node.open = true; });
  await page.getByRole('button', {name: 'Decrease Camera angle (degrees)', exact: true}).focus();
  await page.keyboard.press('Tab'); await expect(page.locator('.camera-rotation')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', {name: 'Increase Camera angle (degrees)', exact: true})).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', {name: 'Edit Camera angle (degrees)', exact: true})).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.getByRole('spinbutton', {name: 'Camera angle (degrees) value', exact: true})).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', {name: 'Edit Camera angle (degrees)', exact: true})).toBeFocused();
  for (const [selector, name, value, next] of [
    ['.camera-rotation', 'Camera angle (degrees)', '12', '13'],
    ['.camera-zoom', 'Zoom', '25', '26'],
    ['.camera-x', 'Horizontal position', '20', '21'],
    ['.camera-y', 'Vertical position', '70', '71'],
    ['.depth-slider', 'Box depth (cm)', '199', '200'],
    ['.flight-height', 'Flight height (% of available space)', '35', '36'],
  ]) {
    const range = page.locator(selector), edit = page.getByRole('button', {name: `Edit ${name}`, exact: true});
    const positions = await range.locator('..').evaluate(group => {
      const [minus, slider, plus, value] = [...group.children].slice(0, 4).map(node => node.getBoundingClientRect());
      return { centers: [minus, slider, plus, value].map(box => box.y + box.height / 2),
        leftToRight: minus.right <= slider.left && slider.right <= plus.left && plus.right <= value.left };
    });
    expect(Math.max(...positions.centers) - Math.min(...positions.centers)).toBeLessThan(2);
    expect(positions.leftToRight).toBe(true);
    await edit.hover(); await page.mouse.down();
    // A real press can span a camera-label refresh. Keep the native click
    // target alive through that draw, then type without refocusing the editor.
    await page.evaluate(() => document.querySelector('#dancinglights').physics.updateCamera(performance.now() + 100));
    await page.mouse.up();
    await expect(page.getByRole('spinbutton', { name: `${name} value`, exact: true })).toBeFocused();
    // Type into the editor selected by the real click. Locator.fill/press
    // would focus it again and could hide a broken editor focus transition.
    await page.keyboard.type(value); await page.keyboard.press('Enter'); await expect(range).toHaveValue(value);
    await page.getByRole('button', {name: `Increase ${name}`, exact: true}).click(); await expect(range).toHaveValue(next);
    await page.getByRole('button', {name: `Decrease ${name}`, exact: true}).click(); await expect(range).toHaveValue(value);
    await edit.click(); await page.keyboard.type('99999'); await page.keyboard.press('Enter');
    const editorState = () => range.locator('..').evaluate(group => {
      const range = group.querySelector('input[type=range]'), editor = group.querySelector('.slider-editor');
      const box = editor.getBoundingClientRect();
      return { value: range.value, visible: box.width > 0 && box.height > 0 && getComputedStyle(editor).visibility === 'visible',
        type: editor.type, label: editor.getAttribute('aria-label'), focused: document.activeElement === editor };
    });
    await expect.poll(editorState).toEqual({ value, visible: true, type: 'number', label: `${name} value`, focused: true });
    await page.keyboard.press('Escape');
    await expect.poll(editorState).toEqual({ value, visible: false, type: 'number', label: `${name} value`, focused: false });
  }
  const { saved, audio } = await page.evaluate(() => ({ saved: JSON.parse(localStorage.getItem('musical-lights-display-v1')),
    audio: !!document.querySelector('.audio-card').activeAudioContext }));
  expect(saved.cameraZoom).toBe(25); expect(saved.cameraX).toBe(20); expect(saved.cameraY).toBe(70);
  expect(saved.cameraAngle).toBe(12); expect(saved.physics[5]).toBeCloseTo(1.99,5); expect(saved.flight).toBe(35);
  expect(audio).toBe(false);
  await page.reload(); await physicsReady(page);
  await expect.poll(() => page.evaluate(() => ({ depth: document.querySelector('.depth-slider').value,
    flight: document.querySelector('.flight-height').value, fits: document.documentElement.scrollWidth <= innerWidth })))
    .toEqual({ depth: '199', flight: '35', fits: true });
});
