import { test, expect } from '@playwright/test';
import { physicsReady, normalView } from '../physics-state.mjs';

for (const route of ['/', '/advanced/']) test(`star glints stay visible without a microphone and strengthen with music on ${route}`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('http://127.0.0.1:8101' + route); await physicsReady(page); await normalView(page);
  const result = await page.evaluate(async () => {
    const card = document.querySelector('.audio-card'), v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    cancelAnimationFrame(v.request); v.stopPreview();
    const positions = v.starfield.points.geometry.attributes.position.array.slice();
    const hidden = v.scene.children.filter(node => node !== v.starfield.points), visibility = hidden.map(node => node.visible);
    hidden.forEach(node => { node.visible = false; });
    const target = new THREE.WebGLRenderTarget(512, 256); target.texture.colorSpace = THREE.SRGBColorSpace;
    const pixels = new Uint8Array(512 * 256 * 4), quiet = new Float32Array(24), attack = quiet.slice(); attack[3] = 1;
    const read = (time, bpm = 0, elapsed = 0, attacks = quiet, reduced = false, playing = false) => {
      const sky = v.starfield;
      sky.lastTime = null; sky.wasTempo = false; sky.phase = 0;
      sky.update(0, reduced, 2, bpm, 1, playing, attacks);
      sky.update(elapsed, reduced, 2, bpm, 1, playing, attacks);
      sky.uniforms.time.value = reduced ? 0 : time / 1000;
      v.renderer.setRenderTarget(target); v.render();
      v.renderer.readRenderTargetPixels(target, 0, 0, 512, 256, pixels); return pixels.slice();
    };
    const contrast = frames => {
      let strong = 0, maximum = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const values = frames.map(frame => Math.max(frame[i], frame[i + 1], frame[i + 2]));
        const change = Math.max(...values) - Math.min(...values);
        if (change >= 60) strong++; maximum = Math.max(maximum, change);
      }
      return { strong, maximum };
    };
    const twinkles = v.starfield.points.geometry.attributes.twinkle, selected = twinkles.array.slice();
    try {
      const idle = Array.from({ length: 12 }, (_, i) => read(i * 400));
      // Independent GPU reference: animate the entire unchanged catalog, then
      // compare the number of visible glints with the selected subset.
      twinkles.array.fill(1); twinkles.needsUpdate = true;
      const allStars = contrast(Array.from({ length: 12 }, (_, i) => read(i * 400)));
      twinkles.array.fill(0); twinkles.needsUpdate = true;
      const steadyStars = read(0, 120, 0, attack, false, true);
      const steadyStarsLater = read(8000, 120, 250, attack, false, true);
      twinkles.array.set(selected); twinkles.needsUpdate = true;
      // Compare half a beat at 120 BPM with a quarter beat at 60 BPM.
      // Twice the elapsed time at 60 BPM must reproduce the same phase.
      const initial = read(0, 120, 0, quiet, false, true), beat = read(0, 120, 250, quiet, false, true);
      const slow = read(0, 60, 250, quiet, false, true), samePhase = read(0, 60, 500, quiet, false, true);
      const quietPixels = read(0), attacked = read(0, 0, 0, attack, false, true);
      const stopped = read(0, 120, 125, attack, false, false);
      const steady = read(0, 0, 0, quiet, true), steadyLater = read(8000, 120, 125, attack, true, true);
      return { allStars, selected: selected.reduce((sum, value) => sum + value, 0), steadyStars: steadyStars.every((value, i) => value === steadyStarsLater[i]), idle: contrast(idle), beat: contrast([initial, beat]), rate: contrast([beat, slow]), attack: contrast([quietPixels, attacked]),
        samePhase: samePhase.every((value, i) => value === beat[i]), stopped: stopped.every((value, i) => value === quietPixels[i]),
        reduced: steadyLater.every((value, i) => value === steady[i]), positionsUnchanged: positions.every((value, i) => value === v.starfield.points.geometry.attributes.position.array[i]),
        points: positions.length / 3, listening: card.querySelector('.listening-toggle').checked, context: Boolean(card.activeAudioContext) };
    } finally {
      twinkles.array.set(selected); twinkles.needsUpdate = true;
      v.renderer.setRenderTarget(null); target.dispose(); hidden.forEach((node, i) => { node.visible = visibility[i]; });
      v.request = requestAnimationFrame(v.animate);
    }
  });
  await info.attach('strong-star-glints.json', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.idle.strong).toBeGreaterThan(50); expect(result.idle.maximum).toBeGreaterThan(100);
  expect(result.beat.strong).toBeGreaterThan(40); expect(result.rate.strong).toBeGreaterThan(20);
  expect(result.attack.strong).toBeGreaterThan(10); expect(result.attack.maximum).toBeGreaterThan(100);
  expect(result.idle.strong).toBeLessThan(result.allStars.strong * .7);
  expect(result.idle.strong).toBeGreaterThan(result.allStars.strong * .3);
  expect(result.selected).toBeGreaterThan(8920 * .45); expect(result.selected).toBeLessThan(8920 * .55);
  expect(result.steadyStars).toBe(true);
  expect(result.samePhase).toBe(true); expect(result.stopped).toBe(true); expect(result.reduced).toBe(true);
  expect(result.positionsUnchanged).toBe(true); expect(result.points).toBe(8920);
  expect(result.listening).toBe(false); expect(result.context).toBe(false);
});
