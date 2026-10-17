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
      const hidden = v.scene.children.filter(node => node !== v.starfield.points);
      hidden.forEach(node => { node.visible = false; });
      const read = (time, reduced) => {
        v.starfield.update(time, reduced, 2, 0, 0, false, new Float32Array(24)); v.renderer.setRenderTarget(target); v.render();
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

for (const source of ['microphone', 'generated']) test(`local star accents follow ${source} audio and clear on Stop`, async ({ page }, info) => {
  await syntheticAudio(page);
  await page.goto('http://127.0.0.1:8101/' + (source === 'generated' ? 'advanced/' : ''));
  if (source === 'microphone') await startFrozen(page); else { await physicsReady(page); await normalView(page); }
  if (source === 'generated') {
    await openFullscreenSettings(page);
    await page.locator('.input-source').selectOption('generated');
    await page.locator('.review-start').click();
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
    await expect(page.locator('.listening-toggle')).not.toBeChecked();
    await page.evaluate(() => { window.freezeClock = true; window.audioNow = window.testContext.currentTime; });
  }
  await page.evaluate(() => window.sendBars(Array(24).fill(.4), 1));
  await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.edges))).toBe(1);
  const result = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics, sky = v.starfield, now = performance.now();
    cancelAnimationFrame(v.request); v.stopPreview();
    const state = v.current.slice(); state.fill(0, v.layout[10], v.layout[11] + 8);
    for (let i = 0; i < 8; i++) state.fill(0, 3 + i * v.layout[8] + 9, 3 + i * v.layout[8] + 15);
    state[2] = 1; state[v.layout[10] + 3] = .1; state[v.layout[11]] = .1;
    sky.reset(); sky.snapshot(state, v.layout, now);
    const attacks = new Float32Array(24); attacks[3] = v.edges[3];
    sky.update(now, false, v.camera.aspect, 120, 1, v.card.dataset.audioState === 'playing', attacks);
    const initial = sky.influences.map(v => v.w);
    sky.update(now + 125, false, v.camera.aspect, 120, 1, true, attacks);
    const fast = sky.influences[0].w;
    sky.reset(); sky.snapshot(state, v.layout, now);
    sky.update(now, false, v.camera.aspect, 60, 1, true, attacks);
    sky.update(now + 250, false, v.camera.aspect, 60, 1, true, attacks);
    const samePhase = sky.influences[0].w;
    sky.update(now + 250, true, v.camera.aspect, 120, 1, true, attacks);
    const reduced = sky.influences.every(v => v.w === 0) && sky.uniforms.motion.value === 0;
    v.request = requestAnimationFrame(v.animate);
    return { initial, fast, samePhase, reduced };
  });
  await info.attach('local-music.json', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.initial[0]).toBeCloseTo(.15, 6); expect(result.initial.slice(1)).toEqual(Array(7).fill(0));
  expect(result.fast).toBeCloseTo(.125, 6); expect(result.samePhase).toBeCloseTo(result.fast, 6); expect(result.reduced).toBe(true);
  await openFullscreenSettings(page);
  if (source === 'generated') await page.locator('.review-stop').click(); else await page.locator('.listening-toggle').uncheck();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'stopped');
  const stopped = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics, sky = v.starfield, now = performance.now();
    const state = v.current.slice(), attacks = new Float32Array(24).fill(1);
    for (let i = 0; i < 8; i++) state.fill(0, 3 + i * v.layout[8] + 9, 3 + i * v.layout[8] + 15);
    state.fill(0, v.layout[10], v.layout[11] + 8); state[2] = 1;
    state[v.layout[10] + 3] = .1; state[v.layout[11]] = .1;
    sky.reset(); sky.snapshot(state, v.layout, now);
    sky.update(now, false, v.camera.aspect, 120, 1, v.card.dataset.audioState === 'playing', attacks);
    const quiet = sky.influences.every(v => v.w === 0);
    state[2]++; state[12] = .6; sky.snapshot(state, v.layout, now);
    sky.update(now + 80, false, v.camera.aspect, 120, 1, v.card.dataset.audioState === 'playing', attacks);
    return { quiet, rolling: sky.influences[0].w > 0 };
  });
  expect(stopped).toEqual({ quiet: true, rolling: true });
});

test('star regions track rendered interpolation without camera impacts and reset on resume', async ({ page }) => {
  await page.goto('http://127.0.0.1:8101/advanced/'); await physicsReady(page); await normalView(page);
  const result = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics, now = performance.now();
    cancelAnimationFrame(v.request); v.stopPreview();
    const old = v.current.slice(), next = old.slice(), stride = v.layout[8];
    old[2] = 1; old[0] = 1 / 120; next[2] = 2; next[0] = 2 / 120;
    old[3] = .4; next[3] = .75;
    old.fill(0, v.layout[10], v.layout[11] + 8); next.fill(0, v.layout[10], v.layout[11] + 8);
    for (let i = 0; i < 8; i++) { old[3 + i * stride + 9] = .6; next[3 + i * stride + 9] = .6; }
    const sky = v.starfield; sky.reset(); sky.snapshot(old, v.layout, now - 10); sky.snapshot(next, v.layout, now);
    v.previous = old; v.current = next; v.received = now;
    v.draw(now); const first = sky.influences[0].x;
    v.draw(now + 1000 / 120); const last = sky.influences[0].x;
    const original = sky.points.geometry.attributes.position.array.slice();
    v.setCamera(30); v.draw(now + 1000 / 120);
    const cameraMoved = sky.influences[0].x !== last;
    v.camera.aspect = 2; v.camera.updateProjectionMatrix(); v.draw(now + 1000 / 120);
    const bounded = sky.influences.every(v => v.z >= .35 && v.z <= .75);
    const noImpacts = Array.from(sky.bounceAt).every(v => v === -Infinity);
    const fixedStars = original.every((value, i) => value === sky.points.geometry.attributes.position.array[i]);
    v.pause(); const reset = sky.tick === null && sky.influences.every(v => v.w === 0);
    return { interpolated: last > first, cameraMoved, bounded, noImpacts, fixedStars, reset };
  });
  expect(result).toEqual({ interpolated: true, cameraMoved: true, bounded: true, noImpacts: true, fixedStars: true, reset: true });
});
