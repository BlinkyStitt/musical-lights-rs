import { test, expect } from '@playwright/test';
import { physicsReady, syntheticAudio, startFrozen, normalView } from '../physics-state.mjs';
const origin = 'http://127.0.0.1:8101';

test('colored attack light follows band loudness on bars, nearby surfaces and fog without changing white edges', async ({ page }, info) => {
  await syntheticAudio(page); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(origin + '/advanced/'); await normalView(page); await startFrozen(page);
  await page.evaluate(() => window.sendBars(Array(24).fill(.4), 1));
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.renderedHeight(0))).toBeGreaterThan(.01);
  const result = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    const { LIGHT_FIELD } = await import(new URL(`${base}physics/lighting.js`, document.baseURI));
    cancelAnimationFrame(v.request); v.stopPreview(); v.onFrame = () => {}; v.receive = () => {};
    v.worker.postMessage({ type: 'pause', paused: true }); v.previous = v.current.slice();
    const height = v.current[v.layout[17]], top = height / 4, x = v.layout[3] / 2;
    v.current.fill(top, v.layout[9], v.layout[10]); v.mirrors.setCount(3);
    const color = new THREE.Color(.2, .025, .01);
    for (let i = 0; i < v.bars.count; i++) v.bars.setColorAt(i, color);
    v.bars.instanceColor.needsUpdate = true;
    v.scene.children.forEach(node => { node.visible = node === v.bars; });
    const camera = new THREE.OrthographicCamera(-.005, .005, .005, -.005, .01, 10);
    camera.position.set(x, top * .75, 2); camera.lookAt(x, top * .75, 0); camera.updateMatrixWorld();
    const target = new THREE.WebGLRenderTarget(32, 32), pixels = new Uint8Array(32 * 32 * 4);
    const u = v.lighting.uniforms, scene = new THREE.Scene();
    const material = new THREE.ShaderMaterial({ uniforms: { ...u, probeFog: { value: 0 } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: LIGHT_FIELD + `uniform float probeFog; void main() {
        vec3 point = vec3(${x + .08}, ${top}, 0.0);
        gl_FragColor = vec4(mix(localIllumination(point, vec3(-1.0, 0.0, 0.0)), scatteredIllumination(point), probeFog), 1.0);
      }`, depthTest: false, depthWrite: false });
    const probe = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material); scene.add(probe);
    let at = performance.now();
    const read = scene => {
      v.renderer.setRenderTarget(target); v.renderer.render(scene, camera);
      v.renderer.readRenderTargetPixels(target, 0, 0, 32, 32, pixels);
      return Array.from(pixels.slice((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 3));
    };
    const sample = (level, edge, strength, microphone = true) => {
      v.idle = false; v.listening = microphone; v.waveLight = () => 0;
      v.input.fill(level, 0, 24); v.edges.fill(edge);
      v.lighting.configure({ ...v.settings, colorAttack: strength, colorSpill: 0, attackLight: 0 });
      v.draw(at += 100);
      const bar = read(v.scene);
      // Settle the real fog envelope on its normal bounded time steps.
      for (let i = 0; i < 30; i++) v.lighting.update(v, v.current, v.layout[9], v.renderedPhase, v.layout[3], height, v.config[5], at += 100);
      u.stripColor.value.forEach((c, i) => c.copy(i === 0 ? color : new THREE.Color(0, 0, 0)));
      u.glowBallColor.value.forEach(c => c.setRGB(0, 0, 0));
      material.uniforms.probeFog.value = 0; const nearby = read(scene);
      material.uniforms.probeFog.value = 1; const fog = read(scene);
      return { bar, nearby, fog };
    };
    try {
      const off = sample(.8, .5, 0), low = sample(.2, .5, 1), high = sample(.8, .5, 1), brighter = sample(.8, .5, 3);
      const quietOff = sample(.8, 0, 0), quietOn = sample(.8, 0, 3);
      const zeroLevel = sample(0, .5, 3), digital = sample(.8, .5, 1, false);
      const side = v.sideBars.geometry.attributes.pulse;
      return { off, low, high, brighter, quietOff, quietOn, zeroLevel, digital,
        whiteGlow: u.attackGlow.value, edges: Array.from(v.edges),
        sidePulsesMatch: !!side && Array.from(side.array.slice(0, v.sideBars.mesh.count)).every((value, i) => value === v.bars.geometry.attributes.pulse.array[v.sideBars.sourceBands[i]]) };
    } finally { v.renderer.setRenderTarget(null); target.dispose(); probe.geometry.dispose(); material.dispose(); }
  });
  await info.attach('colored-attack-light.json', { body: JSON.stringify(result), contentType: 'application/json' });
  for (const kind of ['bar', 'nearby', 'fog']) {
    expect(result.low[kind][0], kind).toBeGreaterThan(result.off[kind][0]);
    expect(result.high[kind][0], kind).toBeGreaterThan(result.low[kind][0] + 3);
    expect(result.brighter[kind][0], kind).toBeGreaterThan(result.high[kind][0]);
    expect(result.high[kind][0] - result.off[kind][0], kind).toBeGreaterThan(2 * (result.high[kind][1] - result.off[kind][1]));
  }
  expect(result.quietOn).toEqual(result.quietOff); expect(result.zeroLevel.bar).toEqual(result.off.bar);
  expect(result.digital.nearby).toEqual(result.high.nearby); expect(result.digital.fog).toEqual(result.high.fog);
  expect(result.whiteGlow).toBe(1); expect(result.edges).toEqual(Array(24).fill(.5)); expect(result.sidePulsesMatch).toBe(true);
  await page.reload(); await physicsReady(page); await normalView(page);
  await page.getByText('Lighting & rendering', { exact: true }).click();
  const input = page.getByRole('spinbutton', { name: 'Colored attack light', exact: true });
  await expect(input).toHaveValue('1'); await input.fill('2'); await input.dispatchEvent('change');
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.lighting.uniforms.colorAttack.value)).toBe(2);
  await input.fill('4'); await input.dispatchEvent('change');
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.lighting.uniforms.colorAttack.value)).toBe(2);
  await page.reload(); await physicsReady(page); await normalView(page);
  await page.getByText('Lighting & rendering', { exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Colored attack light', exact: true })).toHaveValue('2');
});

for (const path of ['/', '/advanced/']) {
  test(`bar attack glow changes edge pixels and preserves quiet bars and attack inputs on ${path}`, async ({ page }, info) => {
    await syntheticAudio(page); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(origin + path); await normalView(page); await startFrozen(page);
    await page.locator('.depth-slider').fill('1');
    await page.evaluate(() => window.sendBars(Array(24).fill(.4), 1));
    await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.edges))).toBe(.5);
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.renderedHeight(0))).toBeGreaterThan(.01);
    await page.getByText('Lighting & rendering', { exact: true }).click();
    const input = page.getByRole('spinbutton', { name: 'Bar attack glow', exact: true });
    await expect(input).toHaveValue('1');
    await input.fill('3'); await input.dispatchEvent('change');
    const result = await page.evaluate(async () => {
      const v = document.querySelector('#dancinglights').physics;
      const base = document.querySelector('meta[name="musical-lights-assets"]').content;
      const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
      v.draw(performance.now());
      const camera = new THREE.OrthographicCamera(-v.width / 2, v.width / 2, v.height / 2, -v.height / 2, .01, 10);
      camera.position.set(v.width / 2, v.height / 2, 2); camera.lookAt(v.width / 2, v.height / 2, 0); camera.updateMatrixWorld();
      const target = new THREE.WebGLRenderTarget(600, 400), pixels = new Uint8Array(600 * 400 * 4);
      const u = v.lighting.uniforms, savedGlow = u.attackGlow.value, strength = u.lightStrength.value.clone();
      const visible = v.scene.children.map(node => node.visible), edges = v.meshEdges.slice();
      const draw = glow => {
        u.attackGlow.value = glow;
        v.bars.geometry.attributes.edge.needsUpdate = true;
        v.renderer.setRenderTarget(target); v.renderer.render(v.scene, camera);
        v.renderer.readRenderTargetPixels(target, 0, 0, 600, 400, pixels); return pixels.slice();
      };
      const difference = (a, b) => {
        let sum = 0, changed = 0;
        for (let i = 0; i < a.length; i++) if (i % 4 !== 3) { sum += b[i] - a[i]; if (a[i] !== b[i]) changed++; }
        return { sum, changed };
      };
      try {
        v.scene.children.forEach(node => { node.visible = node === v.bars || node.isLight; });
        u.lightStrength.value.set(0, 0, strength.z, 0);
        const old = draw(.8), brighter = draw(1), maximum = draw(3);
        v.meshEdges.fill(0);
        const quietOff = draw(0), quietBright = draw(3);
        return { oldToDefault: difference(old, brighter), defaultToMaximum: difference(brighter, maximum),
          quiet: difference(quietOff, quietBright), configured: savedGlow, sourceEdges: Array.from(v.edges),
          saved: JSON.parse(localStorage.getItem('musical-lights-display-v1')).attackGlow };
      } finally {
        v.meshEdges.set(edges); v.bars.geometry.attributes.edge.needsUpdate = true;
        v.scene.children.forEach((node, i) => { node.visible = visible[i]; });
        u.attackGlow.value = savedGlow; u.lightStrength.value.copy(strength);
        v.renderer.setRenderTarget(null); target.dispose();
      }
    });
    await info.attach('attack-glow.json', { body: JSON.stringify(result), contentType: 'application/json' });
    expect(result.oldToDefault.sum).toBeGreaterThan(0); expect(result.oldToDefault.changed).toBeGreaterThan(10);
    expect(result.defaultToMaximum.sum).toBeGreaterThan(0); expect(result.defaultToMaximum.changed).toBeGreaterThan(10);
    expect(result.quiet).toEqual({ sum: 0, changed: 0 });
    expect(result.configured).toBe(3); expect(result.saved).toBe(3);
    expect(result.sourceEdges).toEqual(Array(24).fill(.5));
    await input.fill('4'); await input.dispatchEvent('change');
    expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.lighting.uniforms.attackGlow.value)).toBe(3);
    await page.reload(); await physicsReady(page); await normalView(page);
    await page.getByText('Lighting & rendering', { exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Bar attack glow', exact: true })).toHaveValue('3');
    expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.lighting.uniforms.attackGlow.value)).toBe(3);
  });
}

test('Auto baseline keeps live bar motion visible and manual depth cancels its test', async ({ page }) => {
  await syntheticAudio(page); await page.goto(origin + '/advanced/'); await normalView(page); await startFrozen(page);
  await page.locator('.depth-slider').fill('1');
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  const travel = await page.evaluate(() => new Promise(resolve => {
    const v = document.querySelector('#dancinglights').physics;
    const first = v.renderedHeight(0); let maximum = first;
    window.sendBars(Array(24).fill(.6), 1);
    const sample = () => {
      maximum = Math.max(maximum, v.renderedHeight(0));
      if (!v.depthProfile.baseline) { resolve(maximum - first); return; }
      requestAnimationFrame(sample);
    };
    sample();
  }));
  expect(travel).toBeGreaterThan(.05);
  await page.locator('.depth-slider').fill('128');
  await expect.poll(() => page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return [v.settings.depthMode, v.mirrors.count, v.depthProfile.done, v.balls.count];
  })).toEqual(['manual', 128, true, 8]);
  await page.reload(); await physicsReady(page);
  expect(await page.evaluate(() => ({ count: document.querySelector('.depth-slider').value,
    profiling: document.querySelector('#dancinglights').physics.depthProfile !== undefined }))).toEqual({ count: '128', profiling: false });
});

test('Auto measures shallow startup and clicking Auto retests the full range', async ({ page }) => {
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await page.waitForFunction(() => document.querySelector('#dancinglights').physics.depthProfile?.done, null, { timeout: 30000 });
  const measured = await page.evaluate(() => {
    const view = document.querySelector('#dancinglights').physics;
    return { count: Number(document.querySelector('.depth-slider').value),
      title: document.querySelector('.depth-status').title, start: view.depthProfile.start };
  });
  expect(measured.count).toBeGreaterThanOrEqual(1); expect(measured.count).toBeLessThanOrEqual(32);
  expect(measured.title).toMatch(/Hz target/);
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  const retest = await page.evaluate(() => {
    const profile = document.querySelector('#dancinglights').physics.depthProfile;
    return { start: profile.start, maximum: profile.candidates.at(-1) };
  });
  expect(retest.start).toBeGreaterThan(measured.start); expect(retest.maximum).toBe(2048);
});

test('saved Auto depth and Reset display return to the shallow startup range', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('musical-lights-display-v1', JSON.stringify({ version: 1, mirrorCount: 2048, depthMode: 'auto' })));
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.depthProfile?.done), { timeout: 30000 }).toBe(true);
  const state = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return { count: v.mirrors.count, pool: v.mirrors.poolCount, balls: v.balls.count, measuredAt: v.depthProfile.start };
  });
  expect(state.count).toBeGreaterThanOrEqual(1); expect(state.count).toBeLessThanOrEqual(32);
  expect(state.pool).toBe(32); expect(state.balls).toBe(8);
  await page.locator('.display-controls > summary').click();
  await page.locator('.mirror-count').fill('128');
  await page.locator('.mirror-count').dispatchEvent('change');
  expect(await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return [v.settings.depthMode, v.mirrors.count, v.balls.count];
  })).toEqual(['manual', 128, 8]);
  await page.getByRole('button', { name: 'Reset display', exact: true }).click();
  const reset = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return { mode: v.settings.depthMode, max: v.depthProfile.candidates.at(-1), measuredAt: v.depthProfile.start };
  });
  expect(reset.mode).toBe('auto'); expect(reset.max).toBe(32);
  expect(reset.measuredAt).toBeGreaterThan(state.measuredAt);
  await page.locator('#dancinglights').scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.depthProfile.done), { timeout: 30000 }).toBe(true);
  const count = Number(await page.locator('.depth-slider').inputValue());
  expect(count).toBeGreaterThanOrEqual(1); expect(count).toBeLessThanOrEqual(32);
});

test('Auto stops when its scene leaves the viewport and waits for an explicit retest', async ({ page }) => {
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await page.locator('footer').scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.depthProfile.done)).toBe(true);
  await expect(page.locator('.depth-status')).toHaveText('Auto paused');
  await expect(page.locator('.depth-status')).toHaveAttribute('title', 'Select Auto to measure again.');
  const selected = await page.locator('.depth-slider').inputValue();
  await page.locator('#dancinglights').scrollIntoViewIfNeeded();
  expect(await page.locator('.depth-slider').inputValue()).toBe(selected);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.depthProfile.done)).toBe(true);
});

test('bar and ball light changes visible surfaces throughout the enclosure depth', async ({ page }, info) => {
  await syntheticAudio(page); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(origin + '/advanced/'); await normalView(page); await startFrozen(page);
  await page.locator('.depth-slider').fill('8');
  await page.evaluate(() => window.sendBars(Array(24).fill(.4), 1));
  await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.edges))).toBe(.5);
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.renderedHeight(0))).toBeGreaterThan(.01);
  const result = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    v.draw(performance.now());
    const depth = v.config[5], middle = -depth * 4;
    const camera = new THREE.OrthographicCamera(-depth * 5, depth * 5, v.height / 2, -v.height / 2, .01, 20);
    camera.position.set(-2, v.height / 2, middle); camera.lookAt(v.width / 2, v.height / 2, middle); camera.updateMatrixWorld();
    v.lighting.uniforms.lightView.value.setFromMatrix4(camera.matrixWorldInverse);
    const target = new THREE.WebGLRenderTarget(600, 240), pixels = new Uint8Array(600 * 240 * 4);
    const draw = () => { v.renderer.setRenderTarget(target); v.renderer.render(v.scene, camera); v.renderer.readRenderTargetPixels(target, 0, 0, 600, 240, pixels); return pixels.slice(); };
    const u = v.lighting.uniforms, settings = { ...v.settings };
    const visibility = v.bars.visible; const sideVisibility = v.sideBars.mesh.visible;
    try {
      // Keep the coating and balls visible, so differences measure emitted light
      // on nearby surfaces rather than only the source bar's own emission.
      v.bars.visible = false; v.sideBars.mesh.visible = false;
      u.colorEmission.value.set(0, 0); u.lightStrength.value.set(0, 0, settings.lightRange, 0);
      const dark = draw();
      v.lighting.configure({ ...settings, barGlow: .08, ballGlow: .12, colorSpill: .18, attackLight: 0 });
      const color = draw();
      v.lighting.configure({ ...settings, barGlow: .08, ballGlow: .12, colorSpill: .18, attackLight: .8 });
      const white = draw();
      const regions = Array.from({ length: 3 }, () => ({ colored: 0, white: 0, coloredDelta: 0, whiteDelta: 0 }));
      for (let y = 0; y < 240; y++) for (let x = 50; x < 550; x++) {
        const i = (y * 600 + x) * 4, region = regions[Math.min(2, Math.floor((x - 50) * 3 / 500))];
        const c = [0, 1, 2].map(k => color[i + k] - dark[i + k]);
        const w = [0, 1, 2].map(k => white[i + k] - color[i + k]);
        if (Math.max(...c) > 0) region.colored++;
        if (Math.max(...w) > 0) region.white++;
        region.coloredDelta += c.reduce((a, b) => a + b, 0); region.whiteDelta += w.reduce((a, b) => a + b, 0);
      }
      return { regions, sourceEdges: Array.from(v.edges), stripEdges: u.stripState.value.map(s => s.z),
        clock: { audio: window.audioNow, context: window.testContext.currentTime, analysis: window.lastAnalysisTime }, strips: u.stripState.value.length, balls: u.glowBallPosition.value.length,
        pointLights: v.scene.children.filter(n => n.isPointLight).length,
        physicalBalls: v.balls.count, copies: v.mirrors.count };
    } finally {
      v.bars.visible = visibility; v.sideBars.mesh.visible = sideVisibility;
      v.lighting.configure(settings); v.renderer.setRenderTarget(null); target.dispose();
    }
  });
  await info.attach('depth-lighting.json', { body: JSON.stringify(result), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('shared-lighting.png'), fullPage: true });
  for (const region of result.regions) {
    expect(region.colored).toBeGreaterThan(10); expect(region.white).toBeGreaterThan(10);
    expect(region.coloredDelta).toBeGreaterThan(0); expect(region.whiteDelta).toBeGreaterThan(0);
  }
  expect(result.sourceEdges).toEqual(Array(24).fill(.5)); expect(result.stripEdges).toEqual(result.sourceEdges);
  expect(result.strips).toBe(24); expect(result.balls).toBe(8); expect(result.physicalBalls).toBe(8); expect(result.copies).toBe(8); expect(result.pointLights).toBe(0);
});

test('scene resolution changes drawing pixels while physical geometry stays fixed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await page.locator('.depth-slider').fill('8');
  const state = () => page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return { pixels: v.canvas.width * v.canvas.height, width: v.width, height: v.height, balls: v.balls.count, depth: v.mirrors.count };
  });
  const before = await state();
  await page.getByText('Lighting & rendering', { exact: true }).click();
  const resolution = page.locator('[data-render-setting="resolution"]');
  await resolution.fill('.5'); await resolution.dispatchEvent('change');
  await expect.poll(async () => (await state()).pixels).toBeLessThan(before.pixels * .26);
  const after = await state();
  expect(after.pixels).toBeGreaterThan(before.pixels * .24);
  expect({ ...after, pixels: before.pixels }).toEqual(before);
});
