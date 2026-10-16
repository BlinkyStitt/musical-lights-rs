import { test, expect } from '@playwright/test';
import { physicsReady, normalView, syntheticAudio } from '../physics-state.mjs';

test('contact color fills a rolling surface gradually instead of swapping bands', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('http://127.0.0.1:8101/advanced/');
  await physicsReady(page); await normalView(page);
  const result = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    const { default: init, PhysicsSimulation } = await import(new URL(`${base}physics/physics.js`, document.baseURI));
    const wasm = await init(), layout = PhysicsSimulation.layout(), config = PhysicsSimulation.defaults();
    // Ball 0 starts red over source 6, then rolls onto blue sources. Audio is off.
    const palette = Float32Array.from({ length: 72 }, (_, i) => Math.floor(i / 3) === 6 ? +(i % 3 === 0) : +(i % 3 === 2));
    // Leave room above the first contact so its light can finish filling in
    // free space. Repeated blue contacts must not hide a lost swirl target.
    config[0] = 5;
    const sim = new PhysicsSimulation(config, palette), input = new Float32Array(layout[22]);
    input[24] = 5; input[32] = config[0]; input[62] = config[5]; sim.input(input);
    const surface = () => new Float32Array(wasm.memory.buffer, sim.pigments_ptr(), 72).slice(0, 9);
    const mean = () => new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12]).slice(18, 21);
    const frames = [{ tick: 0, surface: Array.from(surface()), mean: Array.from(mean()) }];
    let firstContact, maximumJump = 0, previous = surface();
    for (let tick = 1; tick <= 360; tick++) {
      sim.step(); const current = surface();
      maximumJump = Math.max(maximumJump, ...current.map((value, i) => Math.abs(value - previous[i])));
      if (firstContact === undefined && current.some((value, i) => i % 3 === 2 && value > 1e-5)) {
        firstContact = tick;
        // Follow the retained contact light while the ball leaves the bars.
        input[24] = 0; input[35] = 2; input[37] = 1; sim.input(input);
      }
      if (firstContact !== undefined && [0, 24, 60, 120].includes(tick - firstContact)) {
        frames.push({ tick, surface: Array.from(current), mean: Array.from(mean()) });
      }
      previous = current;
    }
    cancelAnimationFrame(v.request); v.stopPreview(); v.draw(performance.now());
    const visible = v.scene.children.map(node => node.visible), count = v.balls.count;
    const matrices = v.balls.instanceMatrix.array.slice(), colors = v.balls.instanceColor.array.slice();
    const attributes = ['pigmentA', 'pigmentB', 'pigmentC'].map(name => v.balls.geometry.attributes[name]);
    const saved = attributes.map(attr => attr.array.slice());
    const target = new THREE.WebGLRenderTarget(256, 256); target.texture.colorSpace = THREE.SRGBColorSpace;
    const pixels = new Uint8Array(256 * 256 * 4), camera = new THREE.PerspectiveCamera(30, 1, .01, 20);
    camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    try {
      v.scene.children.forEach(node => { if (node !== v.balls && !node.isLight) node.visible = false; });
      v.balls.count = 1; v.balls.setMatrixAt(0, new THREE.Matrix4().makeScale(.8, .8, .8)); v.balls.instanceMatrix.needsUpdate = true;
      for (const frame of frames) {
        attributes.forEach((attr, region) => { attr.array.set(frame.surface.slice(region * 3, region * 3 + 3), 0); attr.needsUpdate = true; });
        v.balls.instanceColor.array.set(frame.mean, 0); v.balls.instanceColor.needsUpdate = true;
        v.renderer.setRenderTarget(target); v.renderer.render(v.scene, camera);
        v.renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
        // Compare blue fraction, so surface illumination does not set the result.
        frame.blue = [90, 128, 166].map(y => {
          let red = 0, blue = 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const index = ((y + dy) * 256 + 128 + dx) * 4;
            red += pixels[index]; blue += pixels[index + 2];
          }
          return blue / (red + blue);
        });
      }
      return { version: layout[18], firstContact, maximumJump, frames };
    } finally {
      sim.free(); v.renderer.setRenderTarget(null); target.dispose(); v.balls.count = count;
      v.scene.children.forEach((node, i) => { node.visible = visible[i]; });
      v.balls.instanceMatrix.array.set(matrices); v.balls.instanceMatrix.needsUpdate = true;
      v.balls.instanceColor.array.set(colors); v.balls.instanceColor.needsUpdate = true;
      attributes.forEach((attr, i) => { attr.array.set(saved[i]); attr.needsUpdate = true; });
      v.request = requestAnimationFrame(v.animate);
    }
  });
  await info.attach('contact-fill-pixels.json', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.version).toBe(19); expect(result.firstContact).toBeGreaterThan(0);
  expect(result.maximumJump).toBeGreaterThan(.001); expect(result.maximumJump).toBeLessThan(.038);
  expect(result.frames).toHaveLength(5);
  const [initial, impact, early, middle, late] = result.frames;
  expect(initial.surface).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0]);
  expect(Math.max(...impact.blue)).toBeLessThan(.1);
  // Contact-local light must preserve distinct soft swirl regions rather than
  // become the former monotone lower/middle/upper gradient.
  for (const frame of [early, middle, late]) {
    expect(Math.max(...frame.surface.filter((_, i) => i % 3 === 2))).toBeGreaterThan(0);
    expect(Math.max(...frame.blue) - Math.min(...frame.blue)).toBeGreaterThan(.01);
  }
  expect(Math.max(...late.blue)).toBeGreaterThan(Math.max(...early.blue));
  expect(late.mean[2]).toBeGreaterThan(early.mean[2]);
});


test('microphone and digital playback publish attack-only paint while Stop restores idle contacts', async ({ page }) => {
  await syntheticAudio(page);
  await page.goto('http://127.0.0.1:8101/advanced/');
  await physicsReady(page); await normalView(page);
  const policy = () => page.evaluate(() => document.querySelector('#dancinglights').physics.input[63]);
  await expect.poll(policy).toBe(0);
  await page.evaluate(() => { window.paintWorker = document.querySelector('#dancinglights').physics.worker; });
  const listening = page.getByRole('checkbox', { name: 'Listening', exact: true });
  await listening.check();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect.poll(policy).toBe(1);
  await listening.uncheck();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'stopped');
  await expect.poll(policy).toBe(0);
  await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.review-start').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect.poll(policy).toBe(1);
  await page.locator('.tone-pause').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'paused');
  await expect.poll(policy).toBe(0);
  await page.locator('.tone-pause').click();
  await expect.poll(policy).toBe(1);
  await page.locator('.review-stop').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'stopped');
  await expect.poll(policy).toBe(0);
  expect(await page.evaluate(() => window.paintWorker === document.querySelector('#dancinglights').physics.worker)).toBe(true);
});
