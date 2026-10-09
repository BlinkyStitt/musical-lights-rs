import { test, expect } from '@playwright/test';
import { physicsReady, syntheticAudio, startFrozen } from '../physics-state.mjs';

for (const reducedMotion of ['no-preference', 'reduce']) {
  test(`linear pulses survive 30/60/120 FPS sampling and repeated packets, ${reducedMotion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await syntheticAudio(page); await page.goto('http://127.0.0.1:8101'); await startFrozen(page);
    const runs = await page.evaluate(async () => {
      const runs = [];
      for (const fps of [30, 60, 120]) {
        window.sendBars(Array(24).fill(.4), 1);
        const start = window.audioNow, edges = [];
        for (const age of [...Array.from({ length: Math.ceil(.18 * fps) }, (_, i) => i / fps), .180001, 1]) {
          window.audioNow = start + age;
          const state = new Float64Array(99);
          state.set([window.audioNow, matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0, 4]);
          for (let i = 0; i < 24; i++) state.set([.4, .4, start, 0], 3 + i * 4);
          // Deliver both a newer snapshot and a duplicate; neither renews the attack.
          for (let repeat = 0; repeat < 2; repeat++) window.testNode.port.dispatchEvent(new MessageEvent('message', {
            data: { type: 'frame', sessionId: Number(document.querySelector('.audio-card').dataset.audioSession), state, clipped: 0 },
          }));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          edges.push({ age, edge: document.querySelector('#dancinglights').physics.edges[0] });
        }
        runs.push({ fps, edges });
      }
      return runs;
    });
    const intensity = reducedMotion === 'reduce' ? .5 : 1;
    for (const { fps, edges } of runs) for (const { age, edge } of edges) {
      expect(edge, `${fps} FPS at ${age}s`).toBeCloseTo(Math.max(0, 1 - age / .18) * intensity, 6);
      if (age <= 1 / fps) expect(edge).toBeGreaterThanOrEqual(.7 * intensity);
      if (age >= .18) expect(edge).toBe(0);
    }
    await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
  });
}

for (const colorScheme of ['light', 'dark']) for (const reducedMotion of ['no-preference', 'reduce']) {
  test(`canvas keeps colored boundaries and a white attack edge in ${colorScheme}, ${reducedMotion}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme, reducedMotion });
    await syntheticAudio(page); await page.goto('http://127.0.0.1:8101'); await startFrozen(page);
    // Pixel-width sampling needs a frontal camera; exercise the real saved
    // display setting instead of sampling a moving projected side face.
    await page.locator('.display-controls > summary').click();
    await page.locator('.camera-motion').uncheck();
    await page.locator('.camera-rotation').fill('0');
    await page.evaluate(() => window.sendBars(Array(24).fill(.4), 1));
    await expect.poll(() => page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      return v.current[v.layout[9]] / (v.current[v.layout[17] + 1]);
    })).toBeGreaterThan(.39);
    const pixels = await page.evaluate(async () => {
      const base = document.querySelector('meta[name="musical-lights-assets"]').content;
      const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
      const v = document.querySelector('#dancinglights').physics;
      // Read the actual rendered pixels. Rendering immediately avoids a cleared default buffer.
      v.draw(performance.now());
      const gl = v.renderer.getContext(), height = gl.drawingBufferHeight, width = gl.drawingBufferWidth;
      const values = new Uint8Array(width * 4);
      const interior = new THREE.Vector3(v.width / 2, v.renderedHeight(0) / 2, v.bars.instanceMatrix.array[14] + v.bars.geometry.boundingBox.max.z).project(v.camera);
      gl.readPixels(0, Math.floor((interior.y + 1) * height / 2), width, 1, gl.RGBA, gl.UNSIGNED_BYTE, values);
      // Sample the actual front face under perspective, rather than an
      // orthographic camera width. The depth moves this face toward the eye.
      const projectedX = x => (new THREE.Vector3(x, 0, v.bars.instanceMatrix.array[14] + v.bars.geometry.boundingBox.max.z).project(v.camera).x + 1) * width / 2;
      return { width, side: projectedX(0), plotWidth: projectedX(v.width) - projectedX(0), ratio: v.renderer.getPixelRatio(), row: Array.from(values), colors: Array.from(v.bars.instanceColor.array), edges: Array.from(v.edges) };
    });
    expect(pixels.edges).toEqual(Array(24).fill(reducedMotion === 'reduce' ? .5 : 1));
    const rgb = x => pixels.row.slice(x * 4, x * 4 + 3);
    for (let i = 0; i < 24; i++) {
      const center = Math.floor(pixels.side + (i + .5) * pixels.plotWidth / 24);
      const edge = pixels.side + (i + .02) * pixels.plotWidth / 24;
      const left = Math.floor(edge + .5);
      const middle = rgb(center);
      // Sample inside the front face, where the white flash overlays the fill.
      const border = Array.from({ length: Math.ceil(3 * pixels.ratio) }, (_, offset) => rgb(left + offset))
        .sort((a, b) => Math.min(...b) - Math.min(...a))[0];
      // Lit fills retain at least 75% encoded value and 40% relative saturation.
      // The previous unlit material fixed peak value at 100% for every face.
      expect(Math.max(...middle)).toBeGreaterThanOrEqual(255 * .75);
      expect((Math.max(...middle) - Math.min(...middle)) / Math.max(...middle)).toBeGreaterThanOrEqual(.4);
      // White is confined to the inside edge; the next pixels return to the fill.
      expect(Math.min(...border)).toBeGreaterThan(Math.min(...middle));
      expect(Math.min(...rgb(left + Math.ceil(3 * pixels.ratio)))).toBeLessThan(245);
    }
    await page.screenshot({ path: info.outputPath('white-inner-edge.png'), fullPage: true });
    await page.evaluate(() => { window.audioNow += .090; });
    await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.edges))).toBeCloseTo(reducedMotion === 'reduce' ? .25 : .5, 6);
    await page.evaluate(() => { window.audioNow += .090001; });
    await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.edges))).toBe(0);
    const colored = await page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      v.draw(performance.now());
      const gl = v.renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
      v.pointerPoint.set(v.width / 2, v.renderedHeight(0) / 2, v.config[5] / 2).project(v.camera);
      const values = new Uint8Array(width * 4);
      gl.readPixels(0, Math.floor((v.pointerPoint.y + 1) * height / 2), width, 1, gl.RGBA, gl.UNSIGNED_BYTE, values);
      return Array.from(values);
    });
    for (let i = 0; i < 24; i++) {
      const center = Math.floor(pixels.side + (i + .5) * pixels.plotWidth / 24);
      const inside = Math.ceil(pixels.side + (i + .02) * pixels.plotWidth / 24 + pixels.ratio);
      const fill = colored.slice(center * 4, center * 4 + 3), boundary = colored.slice(inside * 4, inside * 4 + 3);
      expect(Math.max(...boundary), JSON.stringify({ i, fill, boundary })).toBeGreaterThanOrEqual(Math.max(...fill) * .85);
      expect(Math.max(...boundary) - Math.min(...boundary)).toBeGreaterThan(60);
    }
    // Every seam must retain a colored fill after the flash ends. White
    // background slots and dark cracks both fail these actual-pixel checks.
    for (let i = 1; i < 24; i++) {
      const seam = Math.floor(pixels.side + i * pixels.plotWidth / 24);
      for (const x of [seam - 1, seam, seam + 1]) {
        const color = colored.slice(x * 4, x * 4 + 3);
        expect(Math.max(...color), `seam ${i} at ${x}`).toBeGreaterThan(180);
        expect(Math.max(...color) - Math.min(...color), `seam ${i} at ${x}`).toBeGreaterThan(60);
      }
    }
    await page.evaluate(() => { window.audioNow += 10; });
    await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.edges))).toBe(0);
    expect(await page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.bars.instanceColor.array))).toEqual(pixels.colors);
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await page.evaluate(() => window.sendBars(Array(24).fill(.4), 1));
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.edges[0])).toBe(reducedMotion === 'reduce' ? .5 : 1);
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
    await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.edges))).toBe(0);
    await physicsReady(page);
  });
}
