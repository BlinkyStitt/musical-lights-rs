import { test, expect } from '@playwright/test';
import { physicsReady, normalView, syntheticAudio, startFrozen } from '../physics-state.mjs';

for (const route of ['/', '/advanced/']) {
  test(`starfield twinkles behind foreground geometry on ${route}`, async ({ page }, info) => {
    await page.addInitScript(() => localStorage.setItem('musical-lights-display-v1', JSON.stringify({ version: 1, mirrorCount: 6 })));
    await page.goto('http://127.0.0.1:8101' + route); await physicsReady(page); await normalView(page);
    const result = await page.evaluate(async () => {
      const v = document.querySelector('#dancinglights').physics;
      const base = document.querySelector('meta[name="musical-lights-assets"]').content;
      const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
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
        v.lighting.uniforms.colorAttack.value = 3; v.mirrors.setCount(2048);
        v.scene.children.filter(node => node !== v.starfield.points).forEach(node => { node.visible = false; });
        v.setCamera(40); const independent = read(5000, true);
        let bright = 0, opaque = 0;
        for (let i = 0; i < first.length; i += 4) { if (first[i + 2] > 60) bright++; if (first[i + 3] === 255) opaque++; }
        v.scene.add(marker); const covered = read(0, true);
        const center = (128 * 512 + 256) * 4;
        return { bright, opaque, twinkle: changed(first, later), steady: changed(steady, steadyLater),
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
    expect(result.foreground).toEqual([255, 0, 0, 255]); expect(result.points).toBe(8920); expect(result.textures).toBe(1);
    await page.reload(); await physicsReady(page);
    await page.screenshot({ path: info.outputPath('starfield-scene.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.starfield.uniforms.time.value)).toBe(0);
  });
}

test('catalog stars respond to musical tempo and qualified attacks, then clear on Stop', async ({ page }, info) => {
  await syntheticAudio(page);
  await page.goto('http://127.0.0.1:8101/'); await startFrozen(page);
  await page.evaluate(() => window.sendBars(Array(24).fill(.4), 1));
  await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.starfield.uniforms.attacks.value))).toBe(1);
  const result = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    const { CATALOG } = await import(new URL(`${base}physics/stars-catalog.js`, document.baseURI));
    cancelAnimationFrame(v.request); v.stopPreview();
    v.scene.children.filter(node => node !== v.starfield.points).forEach(node => { node.visible = false; });
    const target = new THREE.WebGLRenderTarget(512, 256); target.texture.colorSpace = THREE.SRGBColorSpace;
    const pixels = new Uint8Array(512 * 256 * 4), quiet = new Float32Array(24), attack = quiet.slice();
    attack[3] = 1;
    const read = (bpm, elapsed, envelopes = quiet, reduced = false, playing = true) => {
      v.starfield.phase = 0; v.starfield.lastTime = null; v.starfield.wasTempo = false;
      v.starfield.update(0, reduced, 2, bpm, 1, playing, envelopes);
      v.starfield.update(elapsed, reduced, 2, bpm, 1, playing, envelopes);
      // Isolate music from the independent slow atmospheric twinkle.
      v.starfield.uniforms.time.value = 0;
      v.renderer.setRenderTarget(target); v.render();
      v.renderer.readRenderTargetPixels(target, 0, 0, 512, 256, pixels);
      return pixels.slice();
    };
    const changed = (a, b) => a.reduce((sum, value, i) => sum + (value !== b[i] ? 1 : 0), 0);
    try {
      v.card.dispatchEvent(new CustomEvent('audio-tempo', { detail: { bpm: 120, confidence: .8 } }));
      v.draw(performance.now());
      const liveTempo = [v.tempo, v.starfield.uniforms.musical.value];
      const initial = read(120, 0), fast = read(120, 125), slow = read(60, 125), samePhase = read(60, 250);
      const stopped = read(120, 0, quiet, false, false), flashed = read(0, 0, attack);
      const quietPixels = read(0, 0), reduced = read(120, 0, attack, true);
      // Verify recorded Orion landmarks at their projected pixel locations.
      const landmarks = [27919, 24378, 32263].map(id => {
        const [, ra, dec] = CATALOG.find(row => row[0] === id);
        const longitude = (5.6 - ra) * Math.PI / 12, latitude = dec * Math.PI / 180;
        const x = Math.floor(256 * (1 + Math.tan(longitude) / (Math.tan(35 * Math.PI / 180) * 2)));
        const y = Math.floor(128 * (1 + Math.tan(latitude) / (Math.cos(longitude) * Math.tan(35 * Math.PI / 180))));
        let peak = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const index = ((y + dy) * 512 + x + dx) * 4;
          peak = Math.max(peak, ...quietPixels.slice(index, index + 3));
        }
        return { id, x, y, peak };
      });
      return { liveTempo, tempoChange: changed(initial, fast), rateChange: changed(fast, slow),
        samePhase: changed(fast, samePhase), attackChange: changed(quietPixels, flashed),
        reduced: changed(stopped, reduced), stopped: changed(stopped, read(120, 125, attack, false, false)), landmarks };
    } finally { v.renderer.setRenderTarget(null); target.dispose(); v.request = requestAnimationFrame(v.animate); }
  });
  await info.attach('catalog-music-pixels.json', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.liveTempo).toEqual([120, 1]);
  expect(result.tempoChange).toBeGreaterThan(100); expect(result.rateChange).toBeGreaterThan(100);
  expect(result.samePhase).toBe(0); expect(result.attackChange).toBeGreaterThan(10);
  expect(result.reduced).toBe(0); expect(result.stopped).toBe(0);
  for (const landmark of result.landmarks) expect(landmark.peak, JSON.stringify(landmark)).toBeGreaterThan(80);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
  await expect.poll(() => page.evaluate(() => {
    const uniforms = document.querySelector('#dancinglights').physics.starfield.uniforms;
    return [uniforms.musical.value, Math.max(...uniforms.attacks.value)];
  })).toEqual([0, 0]);
});
