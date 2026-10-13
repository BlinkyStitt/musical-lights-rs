import { test, expect } from '@playwright/test';
import { physicsReady, normalView } from '../physics-state.mjs';

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
        v.starfield.update(time, reduced); v.renderer.setRenderTarget(target); v.render();
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
    expect(result.foreground).toEqual([255, 0, 0, 255]); expect(result.points).toBe(512); expect(result.textures).toBe(1);
    await page.reload(); await physicsReady(page);
    await page.screenshot({ path: info.outputPath('starfield-scene.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.starfield.uniforms.time.value)).toBe(0);
  });
}
