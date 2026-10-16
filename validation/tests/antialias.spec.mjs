import { test, expect } from '@playwright/test';
import { physicsReady, normalView } from '../physics-state.mjs';

test('multisampling smooths ball and bar silhouettes within the existing pixel budget', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('http://127.0.0.1:8101/advanced/');
  await physicsReady(page); await normalView(page);
  for (const viewport of [{ width: 900, height: 720 }, { width: 1200, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => !document.querySelector('#dancinglights').physics.resizePending)).toBe(true);
    const result = await page.evaluate(async () => {
      const v = document.querySelector('#dancinglights').physics;
      const base = document.querySelector('meta[name="musical-lights-assets"]').content;
      const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
      const width = v.canvas.width, height = v.canvas.height;
      const reference = new THREE.WebGLRenderer({ alpha: true, antialias: false });
      reference.setSize(width, height, false);
      const scene = new THREE.Scene(); scene.background = new THREE.Color(0);
      const camera = new THREE.PerspectiveCamera(30, width / height, .01, 20);
      camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0);
      const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const read = renderer => {
        renderer.render(scene, camera);
        const gl = renderer.getContext(), pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let partial = 0, coverage = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] > 0 && pixels[i] < 255) partial++;
          coverage += pixels[i] / 255;
        }
        return { partial, coverage, corner: Array.from(pixels.slice(0, 4)),
          center: Array.from(pixels.slice((Math.floor(height / 2) * width + Math.floor(width / 2)) * 4,
            (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4 + 4)) };
      };
      try {
        const shapes = [];
        for (const geometry of [v.balls.geometry, v.bars.geometry]) {
          // Use the production meshes with an unlit white material to isolate
          // geometric edge coverage from pigments, lighting and star twinkle.
          geometry.computeBoundingBox();
          const mesh = new THREE.Mesh(geometry, material);
          const size = geometry.boundingBox.getSize(new THREE.Vector3());
          mesh.scale.set(1.5 / size.x, 1.5 / size.y, 1.5 / size.z);
          mesh.rotation.set(.31, .17, .23); scene.add(mesh);
          shapes.push({ baseline: read(reference), smooth: read(v.renderer) });
          scene.remove(mesh);
        }
        const gl = v.renderer.getContext();
        return { antialias: gl.getContextAttributes().antialias, samples: gl.getParameter(gl.SAMPLES),
          pixels: width * height, budget: 200000 * (v.settings.resolution ?? 1) ** 2, shapes };
      } finally {
        material.dispose(); reference.dispose(); reference.forceContextLoss();
        v.draw(performance.now());
      }
    });
    await info.attach(`antialias-${viewport.width}.json`, { body: JSON.stringify(result), contentType: 'application/json' });
    expect(result.antialias).toBe(true); expect(result.samples).toBeGreaterThan(1);
    expect(result.pixels).toBeLessThanOrEqual(result.budget);
    for (const { baseline, smooth } of result.shapes) {
      expect(baseline.partial).toBe(0); expect(smooth.partial).toBeGreaterThan(20);
      expect(smooth.coverage / baseline.coverage).toBeGreaterThan(.98);
      expect(smooth.coverage / baseline.coverage).toBeLessThan(1.02);
      expect(smooth.center).toEqual([255, 255, 255, 255]);
      expect(smooth.corner).toEqual([0, 0, 0, 255]);
    }
  }
});
