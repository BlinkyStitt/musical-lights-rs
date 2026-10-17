import { test, expect } from '@playwright/test';
import { physicsReady, normalView } from '../physics-state.mjs';

for (const route of ['/', '/advanced/']) test(`star brightness is proportional, local and fixed in size on ${route}`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('http://127.0.0.1:8101' + route); await physicsReady(page); await normalView(page);
  const result = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    const { Starfield } = await import(new URL(`${base}physics/stars.js`, document.baseURI));
    cancelAnimationFrame(v.request); v.stopPreview();
    const scene = new THREE.Scene(), sky = new Starfield(scene, { value: 1 });
    const geometry = sky.points.geometry;
    const selected = geometry.attributes.twinkle.array.reduce((sum, value) => sum + value, 0);
    const count = geometry.attributes.position.count;
    // Six equal-size white points at exact pixel centres. The top pair shares
    // the same falloff, but its base brightness differs 3:1. The bottom pair
    // sits outside the influence; the middle pair measures falloff. Read linear RGB.
    const positions = new Float32Array(18), properties = new Float32Array(24);
    for (let i = 0; i < 6; i++) {
      positions.set([(i % 2 ? 16.5 : -16.5) / 256 * 1.4004150764,
        (i < 2 ? 52.5 : i < 4 ? 26.5 : -52.5) / 256 * 1.4004150764, 1], i * 3);
      properties.set([7, 0, 1.2, i % 2 ? .1 : .3], i * 4);
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('star', new THREE.BufferAttribute(properties, 4));
    geometry.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(18).fill(1), 3));
    geometry.setAttribute('twinkle', new THREE.BufferAttribute(new Float32Array(6).fill(1), 1));
    geometry.setDrawRange(0, 6);
    const target = new THREE.WebGLRenderTarget(512, 256, { type: THREE.FloatType }); target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    const pixels = new Float32Array(512 * 256 * 4);
    const read = (strength = 0, time = 0, reduced = false, second = 0) => {
      sky.update(time, reduced, 2, 0, 0, false, new Float32Array(24));
      sky.influences[0].set(0, 52.5 / 256, .18, strength);
      sky.influences[1].set(0, 52.5 / 256, .18, second);
      v.renderer.setRenderTarget(target); v.renderer.render(scene, v.camera);
      v.renderer.readRenderTargetPixels(target, 0, 0, 512, 256, pixels); return pixels.slice();
    };
    const sample = frame => [239, 272, 239, 272, 239, 272].map((x, i) => frame[((i < 2 ? 180 : i < 4 ? 154 : 75) * 512 + x) * 4]);
    const support = frame => {
      const indices = []; for (let i = 0; i < frame.length; i += 4) if (frame[i] - frame[0] > 1e-6) indices.push(i);
      return indices.join(',');
    };
    try {
      const steady = read(), accent = read(.5), overlap = read(.5, 0, false, .5);
      const overlapHigh = read(.5, Math.PI / 2 / 4.8 * 1000, false, .5), overlapLow = read(.5, Math.PI * 1.5 / 4.8 * 1000, false, .5);
      const nearHigh = read(.5, Math.PI / 2 / 4.8 * 1000), nearLow = read(.5, Math.PI * 1.5 / 4.8 * 1000);
      const reduced = read(.5, 5000, true), ambientHigh = read(0, Math.PI / 2 / 1.2 * 1000), ambientLow = read(0, Math.PI * 1.5 / 1.2 * 1000);
      return { count, selected, steady: sample(steady), accent: sample(accent), nearHigh: sample(nearHigh), nearLow: sample(nearLow), ambientHigh: sample(ambientHigh), ambientLow: sample(ambientLow),
        overlap: sample(overlap), overlapHigh: sample(overlapHigh), overlapLow: sample(overlapLow),
        fixedSize: support(steady) === support(accent),
        reduced: reduced.every((value, i) => value === steady[i]),
        distant: [4, 5].every(i => sample(steady)[i] === sample(accent)[i]),
        listening: v.card.querySelector('.listening-toggle').checked, context: Boolean(v.card.activeAudioContext) };
    } finally {
      v.renderer.setRenderTarget(null); target.dispose(); sky.dispose(); v.request = requestAnimationFrame(v.animate);
    }
  });
  await info.attach('local-star-brightness.json', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.count).toBe(8920); expect(result.selected).toBe(4328);
  expect(result.accent[0]).toBeGreaterThan(result.steady[0] * 1.5);
  // Equal overlapping balls add equal light, even above the previous shared cap.
  expect(result.overlap[0] - result.steady[0]).toBeCloseTo(2 * (result.accent[0] - result.steady[0]), 5);
  expect(result.overlap[0] / result.overlap[1]).toBeCloseTo(3, 4);
  const nearGain = result.accent[0] - result.steady[0], middleGain = result.accent[2] - result.steady[2];
  expect(middleGain).toBeGreaterThan(0); expect(nearGain).toBeGreaterThan(middleGain * 2);
  expect(result.accent[1]).toBeGreaterThan(result.steady[1]);
  expect(result.steady[0] / result.steady[1]).toBeCloseTo(3, 4);
  expect(result.accent[0] / result.accent[1]).toBeCloseTo(3, 4);
  // Floating-point linear readback measures the +/-1.5% ambient light bound.
  expect(result.ambientHigh[0]).toBeLessThanOrEqual(result.steady[0] * 1.015 + 1e-6);
  expect(result.ambientLow[0]).toBeGreaterThanOrEqual(result.steady[0] * .985 - 1e-6);
  expect(result.ambientHigh[0]).toBeGreaterThan(result.ambientLow[0]);
  expect(result.nearHigh[0] - result.nearLow[0]).toBeGreaterThan(
    5 * (result.nearHigh[4] - result.nearLow[4]));
  expect(result.overlapHigh[0]).toBeGreaterThan(result.overlapLow[0] * 1.4);
  expect(result.fixedSize).toBe(true); expect(result.distant).toBe(true);
  expect(result.reduced).toBe(true); expect(result.listening).toBe(false); expect(result.context).toBe(false);
});

test('catalog stars visibly vary through the normal foreground at scene resolution', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('http://127.0.0.1:8101/advanced/'); await physicsReady(page); await normalView(page);
  const result = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const { default: init, PhysicsSimulation } = await import(new URL(`${base}physics/physics.js`, document.baseURI));
    const wasm = await init(), sim = new PhysicsSimulation(PhysicsSimulation.defaults(), v.palette);
    cancelAnimationFrame(v.request); v.stopPreview();
    // Use the real catalog, default physical balls and opaque foreground. Hold
    // geometry fixed to measure star light alone, at the app's actual resolution.
    const row = new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), v.layout[12]).slice();
    sim.free();
    for (let i = 0; i < 8; i++) row[3 + i * v.layout[8] + 9] = .6;
    v.current = row; v.previous = row.slice(); v.received = 1000; v.setCamera(0); v.starfield.reset(); v.draw(1000);
    const width = v.renderer.domElement.width, height = v.renderer.domElement.height;
    const gl = v.renderer.getContext();
    const pixels = new Uint8Array(width * height * 4), low = new Uint8Array(pixels.length).fill(255), high = new Uint8Array(pixels.length);
    const scan = moving => {
      low.fill(255); high.fill(0); v.starfield.reset();
      for (let frame = 0; frame < 24; frame++) {
        const now = 1000 + frame * 125; row[2] = frame + 1;
        if (moving) v.starfield.snapshot(row, v.layout, now);
        v.starfield.update(now, false, v.camera.aspect, 0, 0, false, v.edges);
        v.renderer.render(v.scene, v.camera); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        for (let i = 0; i < pixels.length; i++) { low[i] = Math.min(low[i], pixels[i]); high[i] = Math.max(high[i], pixels[i]); }
      }
      let visible = 0, strong = 0, maximum = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const change = Math.max(high[i] - low[i], high[i + 1] - low[i + 1], high[i + 2] - low[i + 2]);
        if (change >= 8) visible++; if (change >= 24) strong++; maximum = Math.max(maximum, change);
      }
      return { visible, strong, maximum };
    };
    try {
      const ambient = scan(false), rolling = scan(true);
      return { width, height, ambient, rolling, points: v.renderer.info.render.points };
    } finally {
      v.starfield.reset(); v.request = requestAnimationFrame(v.animate);
    }
  });
  await info.attach('catalog-motion-pixels.json', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.points).toBe(8920);
  expect(result.width * result.height).toBeLessThanOrEqual(200000);
  expect(result.ambient.visible).toBe(0);
  expect(result.rolling.visible).toBeGreaterThan(20);
  expect(result.rolling.strong).toBeGreaterThan(100);
  expect(result.rolling.maximum).toBeGreaterThan(60);
});
