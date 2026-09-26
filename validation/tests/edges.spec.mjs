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
        for (const age of [...Array.from({ length: Math.ceil(.12 * fps) }, (_, i) => i / fps), .120001, 1]) {
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
      expect(edge, `${fps} FPS at ${age}s`).toBeCloseTo(Math.max(0, 1 - age / .12) * intensity, 6);
      if (age <= 1 / fps) expect(edge).toBeGreaterThanOrEqual(.7 * intensity);
      if (age >= .12) expect(edge).toBe(0);
    }
    await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
  });
}

for (const colorScheme of ['light', 'dark']) for (const reducedMotion of ['no-preference', 'reduce']) {
  test(`canvas glow retains rainbow centers and a one-pixel inner edge in ${colorScheme}, ${reducedMotion}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme, reducedMotion });
    await syntheticAudio(page); await page.goto('http://127.0.0.1:8101'); await startFrozen(page);
    await page.evaluate(() => window.sendBars(Array(24).fill(.4), 1));
    await expect.poll(() => page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      return v.current[v.layout[9]] / (v.current[v.layout[17] + 1]);
    })).toBeGreaterThan(.39);
    const pixels = await page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      // Read the actual rendered pixels. Rendering immediately avoids a cleared default buffer.
      v.draw(performance.now());
      const gl = v.renderer.getContext(), height = gl.drawingBufferHeight, width = gl.drawingBufferWidth;
      const values = new Uint8Array(width * 4);
      gl.readPixels(0, Math.floor(height * .08), width, 1, gl.RGBA, gl.UNSIGNED_BYTE, values);
      return { width, side: Math.max(0,(1-v.width/(v.camera.right-v.camera.left))/2)*width, plotWidth: v.width/(v.camera.right-v.camera.left)*width, ratio: v.renderer.getPixelRatio(), row: Array.from(values), colors: Array.from(v.bars.instanceColor.array), edges: Array.from(v.edges) };
    });
    expect(pixels.edges).toEqual(Array(24).fill(reducedMotion === 'reduce' ? .5 : 1));
    const rgb = x => pixels.row.slice(x * 4, x * 4 + 3);
    for (let i = 0; i < 24; i++) {
      const center = Math.floor(pixels.side + (i + .5) * pixels.plotWidth / 24);
      const edge = pixels.side + (i + .02) * pixels.plotWidth / 24;
      const left = Math.floor(edge + .5);
      const middle = rgb(center);
      // Multisample edge coverage differs between engines. Inspect the first two
      // inside pixels; an outside sample can contain transparent antialiasing.
      const border = [rgb(left), rgb(left + 1)].sort((a, b) => Math.min(...b) - Math.min(...a))[0];
      expect(Math.max(...middle) - Math.min(...middle)).toBeGreaterThan(30);
      // White is confined to the inside edge; the next pixels return to the fill.
      expect(Math.min(...border)).toBeGreaterThan(Math.min(...middle));
      expect(Math.min(...rgb(left + Math.ceil(2 * pixels.ratio)))).toBeLessThan(245);
    }
    await page.screenshot({ path: info.outputPath('white-inner-edge.png'), fullPage: true });
    await page.evaluate(() => { window.audioNow += .060; });
    await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.edges))).toBeCloseTo(reducedMotion === 'reduce' ? .25 : .5, 6);
    await page.evaluate(() => { window.audioNow += .060001; });
    await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.edges))).toBe(0);
    await page.evaluate(() => { window.audioNow += 10; });
    await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.edges))).toBe(0);
    expect(await page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.bars.instanceColor.array))).toEqual(pixels.colors);
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await page.evaluate(() => window.sendBars(Array(24).fill(.4), 1));
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.edges[0])).toBe(reducedMotion === 'reduce' ? .5 : 1);
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await page.getByRole('button', { name: 'Stop listening' }).click();
    await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.edges))).toBe(0);
    await physicsReady(page);
  });
}
