import { test, expect } from '@playwright/test';
import { openFullscreenSettings, physicsReady, normalView, syntheticAudio, startFrozen } from '../physics-state.mjs';

for (const route of ['/', '/advanced/']) {
  test(`starfield twinkles behind foreground geometry on ${route}`, async ({ page }, info) => {
    await page.addInitScript(() => localStorage.setItem('musical-lights-display-v1', JSON.stringify({ version: 1, mirrorCount: 6 })));
    await page.goto('http://127.0.0.1:8101' + route); await physicsReady(page); await normalView(page);
    const result = await page.evaluate(async () => {
      const v = document.querySelector('#dancinglights').physics;
      const base = document.querySelector('meta[name="musical-lights-assets"]').content;
      const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
      const { CATALOG } = await import(new URL(`${base}physics/stars-catalog.js`, document.baseURI));
      cancelAnimationFrame(v.request); v.stopPreview();
      const target = new THREE.WebGLRenderTarget(512, 256); target.texture.colorSpace = THREE.SRGBColorSpace;
      const pixels = new Uint8Array(512 * 256 * 4);
      const skyCamera = v.camera.clone(); skyCamera.aspect = 2; skyCamera.updateProjectionMatrix();
      const hidden = v.scene.children.filter(node => node !== v.starfield.points);
      hidden.forEach(node => { node.visible = false; });
      const read = (time, reduced) => {
        v.starfield.update(time, reduced, skyCamera, 0, v.layout[3], v.renderedEnclosureHeight, v.renderedDepth, new Float32Array(24)); v.renderer.setRenderTarget(target); v.render();
        v.renderer.readRenderTargetPixels(target, 0, 0, 512, 256, pixels);
        return pixels.slice();
      };
      const changed = (a, b) => a.reduce((sum, value, i) => sum + (value !== b[i] ? 1 : 0), 0);
      const marker = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
      marker.position.copy(v.camera.position).addScaledVector(v.camera.getWorldDirection(new THREE.Vector3()), 1);
      marker.quaternion.copy(v.camera.quaternion);
      try {
        const first = read(0, false), later = read(2400, false), steady = read(0, true);
        const steadyLater = read(5000, true);
        const landmarks = [27919, 24378, 32263].map(id => {
          const [, ra, dec] = CATALOG.find(row => row[0] === id);
          const longitude = (5.6 - ra) * Math.PI / 12, latitude = dec * Math.PI / 180;
          const x = Math.floor(256 * (1 + Math.tan(longitude) / (Math.tan(35 * Math.PI / 180) * 2)));
          const y = Math.floor(128 * (1 + Math.tan(latitude) / (Math.cos(longitude) * Math.tan(35 * Math.PI / 180))));
          let peak = 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const index = ((y + dy) * 512 + x + dx) * 4;
            peak = Math.max(peak, ...steady.slice(index, index + 3));
          }
          return { id, x, y, peak };
        });
        v.lighting.uniforms.colorAttack.value = 3; v.current[v.layout[17]+4]=2;
        v.scene.children.filter(node => node !== v.starfield.points).forEach(node => { node.visible = false; });
        v.setCamera(40); const independent = read(5000, true);
        let bright = 0, opaque = 0;
        for (let i = 0; i < first.length; i += 4) { if (first[i + 2] > 60) bright++; if (first[i + 3] === 255) opaque++; }
        v.scene.add(marker); const covered = read(0, true);
        const center = (128 * 512 + 256) * 4;
        return { landmarks, bright, opaque, twinkle: changed(first, later), steady: changed(steady, steadyLater),
          independent: changed(steady, independent), foreground: Array.from(covered.slice(center, center + 4)),
          points: v.starfield.points.geometry.attributes.position.count, textures: v.renderer.info.memory.textures };
      } finally {
        v.renderer.setRenderTarget(null); target.dispose(); v.scene.remove(marker); marker.geometry.dispose(); marker.material.dispose();
      }
    });
    await info.attach('starfield-pixels.json', { body: JSON.stringify(result), contentType: 'application/json' });
    expect(result.bright).toBeGreaterThan(50); expect(result.bright).toBeLessThan(512 * 256 * .02);
    expect(result.opaque).toBe(512 * 256); expect(result.twinkle).toBeGreaterThan(100);
    expect(result.steady).toBe(0); expect(result.independent).toBe(0);
    for (const landmark of result.landmarks) expect(landmark.peak, JSON.stringify(landmark)).toBeGreaterThan(80);
    expect(result.foreground).toEqual([255, 0, 0, 255]); expect(result.points).toBe(8920); expect(result.textures).toBe(1);
    await page.reload(); await physicsReady(page);
    await page.screenshot({ path: info.outputPath('starfield-scene.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.starfield.uniforms.time.value)).toBe(0);
  });
}

for (const source of ['microphone', 'generated']) test(`star columns share the visible ${source} flash and release it on Stop`, async ({ page }, info) => {
  await syntheticAudio(page);
  await page.goto('http://127.0.0.1:8101/' + (source === 'generated' ? 'advanced/' : ''));
  if (source === 'microphone') await startFrozen(page); else { await physicsReady(page); await normalView(page); }
  if (source === 'generated') {
    await openFullscreenSettings(page);
    await page.locator('.input-source').selectOption('generated'); await page.locator('.review-start').click();
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
    await expect(page.locator('.listening-toggle')).not.toBeChecked();
    await page.evaluate(() => { window.freezeClock = true; window.audioNow = window.testContext.currentTime; });
  }
  await page.evaluate(() => window.sendBars(Array(24).fill(.4), 1));
  await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.edges))).toBe(1);
  const result = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics, now = performance.now();
    cancelAnimationFrame(v.request); v.stopPreview(); v.draw(now);
    const flashes = Array.from(v.starfield.flashes), displayed = Array.from(v.meshEdges.slice(0, 24));
    v.request = requestAnimationFrame(v.animate); return { flashes, displayed, listening: v.listening };
  });
  await info.attach('displayed-column-flashes.json', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.flashes).toEqual(result.displayed); expect(result.flashes.some(value => value > 0)).toBe(true);
  expect(result.listening).toBe(source === 'microphone');
  await openFullscreenSettings(page);
  if (source === 'generated') await page.locator('.review-stop').click(); else await page.locator('.listening-toggle').uncheck();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'stopped');
  const stopped = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    cancelAnimationFrame(v.request); v.stopPreview(); v.clearAudio(); v.draw(performance.now());
    const matching = Array.from(v.starfield.flashes).every((value, i) => value === v.meshEdges[i]);
    const cleared = v.edges.every(value => value === 0);
    v.request = requestAnimationFrame(v.animate); return { matching, cleared };
  });
  expect(stopped).toEqual({ matching: true, cleared: true });
});

test('column projection follows interpolated bars, seams and depth while ball motion has no influence', async ({ page }) => {
  await page.goto('http://127.0.0.1:8101/advanced/'); await physicsReady(page); await normalView(page);
  const result = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics, now = performance.now();
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    cancelAnimationFrame(v.request); v.stopPreview();
    const old = v.current.slice(), next = old.slice();
    old[0] = 1 / 120; next[0] = 2 / 120;
    old[v.layout[20]] = 23.9; next[v.layout[20]] = .1;
    v.previous = old; v.current = next; v.received = now;
    v.updateScene(now); const first = v.starfield.uniforms.phase.value;
    v.updateScene(now + 1000 / 120); const last = v.starfield.uniforms.phase.value;
    const original = v.starfield.points.geometry.attributes.position.array.slice();
    const flashes = Array.from(v.starfield.flashes), projection = v.starfield.uniforms.starToRoom.value.elements.slice();
    for (let i = 0; i < next[v.layout[30]]; i++) {
      next[3 + i * v.layout[8]] += .3;
      next[3 + i * v.layout[8] + 9] = 5; next[v.layout[11] + i] = 10;
    }
    v.updateScene(now + 1000 / 120);
    const noBallInfluence = flashes.every((value, i) => value === v.starfield.flashes[i])
      && projection.every((value, i) => value === v.starfield.uniforms.starToRoom.value.elements[i]);
    let error = 0;
    for (const angle of [-30, 0, 30]) for (const depth of [.2, 2]) {
      old[v.layout[17] + 4] = next[v.layout[17] + 4] = depth; v.config[5] = depth; v.setCamera(angle); v.updateScene(now + 1000 / 120);
      for (const x of [-1.2, 0, .6, 1.2, 2.4]) {
        const pixel = new THREE.Vector3(x, v.renderedEnclosureHeight / 2, depth / 2).project(v.camera);
        const room = new THREE.Vector3(pixel.x, pixel.y, 1).applyMatrix3(v.starfield.uniforms.starToRoom.value);
        error = Math.max(error, Math.abs(room.x / room.z - x));
      }
    }
    const fixedStars = original.every((value, i) => value === v.starfield.points.geometry.attributes.position.array[i]);
    v.pause(); const reset = v.starfield.flashes.every(v => v === 0) && v.starfield.uniforms.extent.value.y === 0;
    return { first, last, noBallInfluence, error, fixedStars, reset };
  });
  expect(result.first).toBeCloseTo(23.9, 4); expect(result.last).toBeCloseTo(.1, 4);
  expect(result.noBallInfluence).toBe(true); expect(result.error).toBeLessThan(1e-5);
  expect(result.fixedStars).toBe(true); expect(result.reset).toBe(true);
});

test('idle columns share bar flashes and Reduced Motion keeps stars steady', async ({ page }) => {
  await page.goto('http://127.0.0.1:8101/advanced/'); await physicsReady(page); await normalView(page);
  await expect.poll(() => page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return v.starfield.flashes.some(value => value > 0) && v.starfield.flashes.every((value, i) => value === v.meshEdges[i]);
  })).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.evaluate(() => {
    const sky = document.querySelector('#dancinglights').physics.starfield;
    return sky.flashes.every(value => value === 0) && sky.uniforms.motion.value === 0 && sky.uniforms.time.value === 0;
  })).toBe(true);
});
