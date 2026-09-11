import { test, expect } from '@playwright/test';

for (const colorScheme of ['light', 'dark']) {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    test(`white borders follow attacks and fade over rainbow bars in ${colorScheme}, ${reducedMotion}`, async ({ page }) => {
      const width = colorScheme === 'dark' ? 1440 : 375;
      await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
      await page.emulateMedia({ colorScheme, reducedMotion });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        const NativeContext = window.AudioContext;
        window.AudioContext = class extends NativeContext {
          constructor(...args) { super(...args); window.testContext = this; }
          get currentTime() { return window.edgeClock ? window.edgeClock() : super.currentTime; }
        };
        const NativeNode = window.AudioWorkletNode;
        window.AudioWorkletNode = class extends NativeNode {
          constructor(...args) { super(...args); window.testPort = this.port; }
        };
        navigator.mediaDevices.getUserMedia = async () => window.testContext.createMediaStreamDestination().stream;
      });
      await page.goto('http://127.0.0.1:8101');
      await expect(page.locator('.meter-edge')).toHaveCount(24);
      const palette = await page.locator('.meter-fill').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
      expect(await page.locator('.meter-edge').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).opacity === '0'))).toBe(true);
      await page.getByRole('button', { name: 'Start listening' }).click();
      await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
      await page.evaluate(async () => {
        await window.testContext.suspend();
        await new Promise(resolve => setTimeout(resolve, 50));
        const origin = window.testContext.currentTime;
        const started = performance.now();
        window.edgeClock = () => origin + (performance.now() - started) / 1000;
        window.edgeNodes = [...document.querySelectorAll('.meter-edge')];
        window.readBands = () => window.edgeNodes.map(node => {
          const fill = node.previousElementSibling;
          const style = getComputedStyle(node);
          const box = node.getBoundingClientRect();
          const bar = fill.getBoundingClientRect();
          return {
            level: new DOMMatrixReadOnly(getComputedStyle(fill).transform).m22,
            edge: Number(style.opacity), border: style.borderTopColor,
            width: Number.parseFloat(style.borderTopWidth),
            topDifference: Math.abs(box.top - bar.top), bottomDifference: Math.abs(box.bottom - bar.bottom),
            transition: style.transitionDuration, animation: style.animationName,
          };
        });
        window.screenFrame = () => new Promise(resolve => requestAnimationFrame(now => queueMicrotask(() => resolve(now))));
        window.tap = () => {
          // This checks DOM geometry and motion from the public snapshot contract.
          // worklet.spec.mjs separately checks real PCM, attacks, and stalled delivery.
          const at = window.edgeClock();
          const state = new Float64Array(146);
          state[0] = at;
          state[1] = Number(matchMedia('(prefers-reduced-motion: reduce)').matches);
          for (let band = 0; band < 24; band++) {
            state.set([.6 + band * .01, 0, at + .350, 1, 0, 0], 2 + band * 6);
          }
          window.testPort.dispatchEvent(new MessageEvent('message', {
            data: { type: 'frame', state, sones: 0, clipped: 0, calibration: 0 },
          }));
        };
      });
      const peak = await page.evaluate(async () => {
        window.tap();
        await window.screenFrame();
        return window.readBands();
      });
      for (const band of peak) {
        expect(band.level).toBeGreaterThan(0);
        expect(band.edge).toBe(1);
        expect(band.border).toBe('rgb(255, 255, 255)');
        expect(band.width).toBe(1);
        expect(band.topDifference).toBeLessThan(1);
        expect(band.bottomDifference).toBeLessThan(1);
        expect(band.transition).toBe('0s');
        expect(band.animation).toBe('none');
      }
      await page.screenshot({ path: `test-results/white-borders-${colorScheme}-${reducedMotion}.png`, fullPage: true });
      await expect.poll(() => page.evaluate(() => Math.max(...window.readBands().map(band => band.edge)))).toBeLessThan(0.1);
      const fading = await page.evaluate(() => window.readBands());
      expect(fading.some(band => band.level > 0.01)).toBe(true);
      for (const [i, band] of fading.entries()) expect(band.edge).toBeLessThan(band.level / peak[i].level);
      await expect.poll(() => page.evaluate(() => window.readBands().every(band => band.level === 0 && band.edge === 0)), { timeout: 7000 }).toBe(true);
      expect(await page.locator('.meter-fill').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor))).toEqual(palette);
      // Fullscreen resizes the same borders; it does not scale their thickness.
      await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
      const full = await page.evaluate(async () => {
        window.tap(); await window.screenFrame(); return window.readBands();
      });
      for (const band of full) {
        expect(band.edge).toBe(1);
        expect(band.width).toBe(1);
        expect(band.topDifference).toBeLessThan(1);
        expect(band.bottomDifference).toBeLessThan(1);
      }
      await page.screenshot({ path: `test-results/white-borders-fullscreen-${colorScheme}-${reducedMotion}.png` });
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
      await page.getByRole('button', { name: 'Stop listening' }).click();
      await expect.poll(() => page.evaluate(() => window.readBands().every(band => band.level === 0 && band.edge === 0))).toBe(true);
      expect(await page.evaluate(() => window.edgeNodes.every((node, i) => node === document.querySelectorAll('.meter-edge')[i]))).toBe(true);
      expect(errors).toEqual([]);
    });
  }
}
