import { test, expect } from '@playwright/test';
import { physicsReady, normalView } from '../physics-state.mjs';

for (const route of ['/', '/advanced/']) test(`bar columns have proportional brightness, focused falloff and additive overlaps on ${route}`, async ({ page }, info) => {
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
    // Equal-size white point pairs at the core, soft edge, distant sky, another
    // height in the column, and the boundary between adjacent columns. Each pair
    // has a 3:1 base-brightness ratio. Float RGB preserves unclipped light.
    const samples = [[250, 180], [261, 180], [229, 154], [282, 154], [190, 75], [321, 75], [250, 75], [261, 75], [239, 102], [272, 102]];
    const positions = new Float32Array(samples.length * 3), properties = new Float32Array(samples.length * 4);
    samples.forEach(([x, y], i) => {
      positions.set([(x + .5 - 256) / 256 * 1.4004150764, (y + .5 - 128) / 256 * 1.4004150764, 1], i * 3);
      properties.set([7, 0, 1.2, i % 2 ? .1 : .3], i * 4);
    });
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('star', new THREE.BufferAttribute(properties, 4));
    geometry.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(samples.length * 3).fill(1), 3));
    geometry.setAttribute('twinkle', new THREE.BufferAttribute(new Float32Array(samples.length).fill(1), 1));
    geometry.setDrawRange(0, samples.length);
    const camera = new THREE.PerspectiveCamera(2 * Math.atan(.5) * 180 / Math.PI, 2, .01, 200), pitch = 33 / 256;
    camera.position.set(pitch / 2, .5, 1); camera.lookAt(pitch / 2, .5, 0);
    const target = new THREE.WebGLRenderTarget(512, 256, { type: THREE.FloatType }); target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    const pixels = new Float32Array(512 * 256 * 4), flashes = new Float32Array(24);
    const read = (strength = 0, second = 0, time = 0, reduced = false, phase = 0, bank = 0) => {
      flashes.fill(0); flashes[0] = strength; flashes[1] = flashes[23] = second;
      camera.position.x = pitch * (.5 + 24 * bank); camera.lookAt(camera.position.x, .5, 0);
      sky.update(time, reduced, camera, phase, pitch, 1, 0, flashes);
      v.renderer.setRenderTarget(target); v.renderer.render(scene, v.camera);
      v.renderer.readRenderTargetPixels(target, 0, 0, 512, 256, pixels); return pixels.slice();
    };
    const sample = frame => samples.map(([x, y]) => frame[(y * 512 + x) * 4]);
    const support = frame => {
      const indices = []; for (let i = 0; i < frame.length; i += 4) if (frame[i] - frame[0] > 1e-6) indices.push(i);
      return indices.join(',');
    };
    try {
      const steady = read(), accent = read(.5), adjacent = read(0, .5), overlap = read(.5, .5), full = read(1);
      const reduced = read(.5, .5, 5000, true), wrapped = read(.5, 0, 0, false, 24);
      const repeated = read(.5, 0, 0, false, 0, 2), outside = read(.5, 0, 0, false, 0, 6);
      const ambientHigh = read(0, 0, Math.PI / 2 / 1.2 * 1000), ambientLow = read(0, 0, Math.PI * 1.5 / 1.2 * 1000);
      return { count, selected, steady: sample(steady), accent: sample(accent), adjacent: sample(adjacent), overlap: sample(overlap), full: sample(full),
        ambientHigh: sample(ambientHigh), ambientLow: sample(ambientLow), fixedSize: support(steady) === support(overlap),
        reduced: reduced.every((value, i) => value === steady[i]), wrapped: wrapped.every((value, i) => Math.abs(value - accent[i]) < 1e-6),
        repeatError: repeated.reduce((maximum, value, i) => Math.max(maximum, Math.abs(value - accent[i])), 0),
        outside: outside.every((value, i) => Math.abs(value - steady[i]) < 1e-6),
        distant: [4, 5].every(i => sample(steady)[i] === sample(accent)[i]),
        listening: v.card.querySelector('.listening-toggle').checked, context: Boolean(v.card.activeAudioContext) };
    } finally {
      v.renderer.setRenderTarget(null); target.dispose(); sky.dispose(); v.request = requestAnimationFrame(v.animate);
    }
  });
  await info.attach('bar-column-brightness.json', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.count).toBe(8920); expect(result.selected).toBe(4328);
  expect(result.accent[0]).toBeGreaterThan(result.steady[0] * 1.5);
  for (let i = 0; i < result.steady.length; i++) {
    expect(result.overlap[i] - result.steady[i]).toBeCloseTo(result.accent[i] + result.adjacent[i] - 2 * result.steady[i], 5);
  }
  expect(result.overlap[8] - result.steady[8]).toBeCloseTo(2 * (result.accent[8] - result.steady[8]), 5);
  expect(result.overlap[8] / result.overlap[9]).toBeCloseTo(3, 4);
  const nearGain = result.accent[0] - result.steady[0], edgeGain = result.accent[2] - result.steady[2];
  expect(edgeGain).toBeGreaterThan(0); expect(nearGain).toBeGreaterThan(edgeGain * 2);
  expect(result.accent[6]).toBeCloseTo(result.accent[0], 5);
  expect(result.full[0] - result.steady[0]).toBeCloseTo(2 * nearGain, 5);
  expect(result.accent[0] / result.accent[1]).toBeCloseTo(3, 4);
  expect(result.ambientHigh[0]).toBeLessThanOrEqual(result.steady[0] * 1.015 + 1e-6);
  expect(result.ambientLow[0]).toBeGreaterThanOrEqual(result.steady[0] * .985 - 1e-6);
  expect(result.ambientHigh[0]).toBeGreaterThan(result.ambientLow[0]);
  expect(result.fixedSize).toBe(true); expect(result.distant).toBe(true); expect(result.wrapped).toBe(true);
  // Moving the camera by two banks changes float uniform rounding by a few ulps.
  expect(result.repeatError).toBeLessThan(1e-5); expect(result.outside).toBe(true);
  expect(result.reduced).toBe(true); expect(result.listening).toBe(false); expect(result.context).toBe(false);
});

test('catalog stars visibly flash in columns through the normal foreground at scene resolution', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('http://127.0.0.1:8101/advanced/'); await physicsReady(page); await normalView(page);
  const result = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const { default: init, PhysicsSimulation } = await import(new URL(`${base}physics/physics.js`, document.baseURI));
    const wasm = await init(), sim = new PhysicsSimulation(PhysicsSimulation.defaults(), v.palette);
    cancelAnimationFrame(v.request); v.stopPreview();
    // Hold real catalog, ball geometry and opaque foreground fixed. Only star
    // inputs vary, isolating actual visible pixels from moving foreground bars.
    const row = new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), v.layout[12]).slice(); sim.free();
    v.current = row; v.previous = row.slice(); v.received = 1000; v.setCamera(0); v.starfield.reset(); v.draw(1000);
    const width = v.renderer.domElement.width, height = v.renderer.domElement.height, gl = v.renderer.getContext();
    const pixels = new Uint8Array(width * height * 4), low = new Uint8Array(pixels.length).fill(255), high = new Uint8Array(pixels.length);
    const flashes = new Float32Array(24);
    const scan = mode => {
      low.fill(255); high.fill(0);
      for (let frame = 0; frame < 24; frame++) {
        flashes.fill(0);
        for (let band = 0; band < 24; band++) {
          if (mode === 'chord' || mode === 'columns' && band % 4 === 3) flashes[band] = (frame % 8) / 7;
        }
        v.starfield.update(1000 + frame * 125, false, v.camera, v.renderedPhase, v.layout[3], v.renderedEnclosureHeight, v.renderedDepth, flashes);
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
    try { return { width, height, ambient: scan('ambient'), columns: scan('columns'), flashing: scan('chord'), points: v.renderer.info.render.points, calls: v.renderer.info.render.calls, textures: v.renderer.info.memory.textures }; }
    finally { v.starfield.reset(); v.request = requestAnimationFrame(v.animate); }
  });
  await info.attach('catalog-column-pixels.json', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.points).toBe(8920); expect(result.calls).toBe(5); expect(result.textures).toBe(0);
  expect(result.width * result.height).toBeLessThanOrEqual(200000);
  expect(result.ambient.visible).toBe(0); expect(result.columns.visible).toBeGreaterThan(20);
  // The whole-scene count uses a full chord; isolated column locality is measured
  // above with near/edge/distant points instead of a sky-wide coverage threshold.
  expect(result.flashing.visible).toBeGreaterThan(20);
  expect(result.flashing.strong).toBeGreaterThan(100); expect(result.flashing.maximum).toBeGreaterThan(60);
});
