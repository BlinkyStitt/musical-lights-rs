import { test, expect } from '@playwright/test';
import { physicsReady, normalView, openFullscreenSettings, closeFullscreenSettings } from '../physics-state.mjs';

// Freeze real geometry with no microphone or digital session. Read actual pixels
// from opposing faces of an opaque sphere and from the source/adjacent banks.
async function fixture(page, options = {}) {
  await page.addInitScript(options => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: options.apple ? 'iPhone' : 'Android' });
    for (const name of ['DeviceMotionEvent', 'DeviceOrientationEvent']) {
      window[name] ??= class {};
      Object.defineProperty(window[name], 'requestPermission', { configurable: true,
        value: () => options.pending ? new Promise(resolve => { (window.motionPermissions ??= []).push(resolve); }) : Promise.resolve(options.orientationOnly && name === 'DeviceMotionEvent' ? 'denied' : 'granted') });
    }
  }, options);
  await page.goto('http://127.0.0.1:8101/advanced/'); await physicsReady(page); await normalView(page);
  await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Phone motion', exact: true })).toBeChecked();
  await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    cancelAnimationFrame(v.request); v.stopPreview(); v.onFrame = () => {}; v.receive = () => {};
    v.worker.postMessage({ type: 'pause', paused: true });
    v.previous = v.current.slice(); v.idle = false; v.waveLight = () => 0;
    v.current.fill(.08, v.layout[9], v.layout[10]); v.previous.set(v.current);
    v.draw(performance.now() + 100);
    const target = new THREE.WebGLRenderTarget(192, 192), bytes = new Uint8Array(192 * 192 * 4);
    const camera = new THREE.OrthographicCamera(-.11, .11, .11, -.11, .01, 10);
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(.08, 32, 24), new THREE.MeshLambertMaterial({ color: 0x777777 }));
    sphere.position.set(.6, v.height / 2, 0); v.scene.add(sphere);
    window.tiltFixture = { v, THREE, sphere };
    window.readTilt = (direction = [0, 0, 1], banks = false) => {
      camera.position.copy(sphere.position).add(new THREE.Vector3(...direction).multiplyScalar(2));
      camera.up.set(0, direction[1] ? 0 : 1, direction[1] ? -1 : 0);
      camera.lookAt(sphere.position); camera.updateMatrixWorld();
      const visibility = v.scene.children.map(node => node.visible);
      v.scene.children.forEach(node => { node.visible = node.isLight || (banks ? node === v.bars || node === v.sideBars.mesh : node === sphere); });
      if (banks) { camera.position.set(.6, v.height / 2 + .45, 2); camera.up.set(0, 1, 0); camera.lookAt(.6, .04, 0); camera.left = -1.8; camera.right = 1.8; camera.top = .25; camera.bottom = -.25; camera.updateProjectionMatrix(); }
      else { camera.left = -.11; camera.right = .11; camera.top = .11; camera.bottom = -.11; camera.updateProjectionMatrix(); }
      v.renderer.setRenderTarget(target); v.render(camera);
      v.renderer.readRenderTargetPixels(target, 0, 0, 192, 192, bytes);
      v.renderer.setRenderTarget(null); v.scene.children.forEach((node, i) => { node.visible = visibility[i]; });
      return Array.from(bytes);
    };
  });
}


// These cases share the same rendered pose expectations, including continuous
// gravity-only flips (20 ms events exercise the filter instead of resetting it).
for (const options of [{ apple: false }, { apple: true }, { fallback: true }, { apple: true, fallback: true }, { orientationOnly: true }]) {
  test(`world-up lighting pixels through sensors ${JSON.stringify(options)}`, async ({ page }, info) => {
    await fixture(page, options);
    const result = await page.evaluate(async options => {
      const { v } = window.tiltFixture;
      const send = (gravity, beta, gamma, angle = 0, shake = [0, 0, 0]) => {
        Object.defineProperty(screen.orientation, 'angle', { configurable: true, value: angle });
        if (options.orientationOnly) {
          window.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta, gamma })); return;
        }
        for (let i = 0; i < (options.fallback ? 160 : 1); i++) {
          const event = Object.assign(new Event('devicemotion'), {
            acceleration: options.fallback ? null : { x: shake[0], y: shake[1], z: shake[2] },
            accelerationIncludingGravity: Object.fromEntries(['x', 'y', 'z'].map((axis, k) => [axis, gravity[k] * (options.apple ? 1 : -1) + shake[k]])),
          });
          Object.defineProperty(event, 'timeStamp', { value: window.sensorTime = (window.sensorTime ?? 0) + 20 });
          window.dispatchEvent(event);
        }
      };
      const faces = () => [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map(d => window.readTilt(d));
      send([0, -9.81, 0], 90, 0); const upright = faces(), bankUp = window.readTilt([0, 0, 1], true);
      // Linear user acceleration is removed from gravity before light orientation.
      send([0, -9.81, 0], 90, 0, 0, options.fallback ? [0, 0, 0] : [4, -3, 6]); const shake = faces();
      send([0, 9.81, 0], -90, 0); const inverted = faces(), bankDown = window.readTilt([0, 0, 1], true);
      send([-9.81, 0, 0], 0, -90); const sideways = faces();
      send([0, 0, -9.81], 0, 0); const faceUp = faces();
      send([0, 0, 9.81], 180, 0); const faceDown = faces();
      send([-9.81, 0, 0], 0, -90, 90); const rotated = faces();
      const references = [[0, -9.81, 0], [0, 9.81, 0], [-9.81, 0, 0], [0, 0, -9.81], [0, 0, 9.81]].map(g => { v.globalLighting.update(...g); return faces(); });
      const bodies = Array.from(v.balls.instanceMatrix.array), pigments = Array.from(v.pigments ?? []);
      const diff = (a, b) => a.reduce((n, value, i) => n + (i % 4 !== 3 && value !== b[i] ? 1 : 0), 0);
      const brightness = a => a.reduce((n, value, i) => n + (i % 4 !== 3 ? value : 0), 0);
      window.tiltFixture.off = () => ({ faceChanges: faces().map((p, i) => diff(p, upright[i])), bodies: Array.from(v.balls.instanceMatrix.array), pigments: Array.from(v.pigments ?? []) });
      return {
        faces: Object.fromEntries(Object.entries({ upright, inverted, sideways, faceUp, faceDown }).map(([pose, pixels]) => [pose, pixels.map(brightness)])),
        referenceChanges: [upright, inverted, sideways, faceUp, faceDown].map((p, k) => p.map((pixels, i) => diff(pixels, references[k][i]))),
        shakeChanges: shake.map((p, i) => diff(p, upright[i])), rotatedChanges: rotated.map((p, i) => diff(p, upright[i])),
        bankChanged: diff(bankUp, bankDown), bodies, pigments,
        listening: v.listening, audio: v.card.dataset.audioState, gravity: Array.from(v.input.slice(34, 38)), balls: v.balls.count, depth: v.renderedDepth };
    }, options);
    expect(result.listening).toBeFalsy(); expect(result.audio).not.toBe('playing'); expect(result.balls).toBe(8); expect(result.depth).toBeCloseTo(.48);
    for (const [pose, a, b] of [['upright', 0, 1], ['inverted', 1, 0], ['sideways', 2, 3], ['faceUp', 4, 5], ['faceDown', 5, 4]]) {
      expect(result.faces[pose][a], pose).toBeGreaterThan(result.faces[pose][b] * 1.15);
    }
    for (const changes of [result.shakeChanges, result.rotatedChanges, ...result.referenceChanges]) {
      for (const count of changes) expect(count).toBeLessThan(50);
    }
    expect(result.bankChanged).toBeGreaterThan(100);
    await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).uncheck();
    const off = await page.evaluate(() => window.tiltFixture.off());
    expect(off.bodies).toEqual(result.bodies); expect(off.pigments).toEqual(result.pigments);
    expect(off.faceChanges).toEqual([0, 0, 0, 0, 0, 0]);
    await info.attach('tilt-lighting-summary.json', { body: JSON.stringify({ options, ...result, bodies: undefined, pigments: undefined }), contentType: 'application/json' });
  });
}

test('display rotation remaps cached gravity lighting and cannot revive stopped motion', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
  await fixture(page);
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await page.evaluate(() => {
    const { v } = window.tiltFixture;
    const read = () => [window.readTilt(), window.readTilt([0, 0, 1], true)];
    // Independent ideal poses include browser rotation plus each display turn.
    const references = [[9.81, 0, 2], [0, 9.81, 2], [-9.81, 0, 2], [0, -9.81, 2]].map(g => {
      v.globalLighting.update(...g); return read();
    });
    v.globalLighting.update(0, -1, 0);
    const upright = read();
    Object.defineProperty(screen.orientation, 'angle', { configurable: true, value: 90 });
    window.dispatchEvent(Object.assign(new Event('devicemotion'), {
      acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: { x: 0, y: 9.81, z: -2 },
    }));
    window.rotationPixels = expected => read().map((pixels, k) => pixels.reduce((sum, value, i) => sum + (i % 4 !== 3 && value !== (expected === null ? upright : references[expected])[k][i] ? 1 : 0), 0));
  });
  for (let turn = 0; turn < 4; turn++) {
    const differences = await page.evaluate(turn => window.rotationPixels(turn), turn);
    for (const difference of differences) expect(difference).toBeLessThan(50);
    // No new sensor event: display rotation must immediately reuse cached gravity.
    await page.locator('.rotate-display').click();
  }
  await openFullscreenSettings(page);
  await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).uncheck();
  await closeFullscreenSettings(page);
  await page.locator('.rotate-display').click();
  expect(await page.evaluate(() => window.rotationPixels(null))).toEqual([0, 0]);
  expect(await page.evaluate(() => {
    const { v } = window.tiltFixture;
    return { gravity: Array.from(v.input.slice(34, 38)), cached: v.lastGravity };
  })).toEqual({ gravity: [0, 0, 0, 0], cached: null });
});

test('invalid gravity falls back without rewriting physics; camera changes leave world-up fixed', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fixture(page);
  const result = await page.evaluate(() => {
    const { v } = window.tiltFixture;
    const upright = window.readTilt();
    const invalid = [[0, 0, 0], [1e-9, 0, 0], [NaN, 1, 0], [0, Infinity, 0]].map(g => {
      v.deviceGravity(...g, 0); return { pixels: window.readTilt(), gravity: Array.from(v.input.slice(34, 38), n => Number.isFinite(n) ? n : String(n)) };
    });
    v.deviceGravity(0, 9.81, 0, 0); const inverted = window.readTilt();
    v.setCamera(65); const camera = window.readTilt();
    const equal = (a, b) => a.every((v, i) => v === b[i]);
    return { fallback: invalid.map(row => equal(row.pixels, upright)), gravity: invalid.map(row => row.gravity), cameraSame: equal(camera, inverted), changed: !equal(inverted, upright) };
  });
  expect(result.fallback).toEqual([true, true, true, true]);
  expect(result.gravity[0]).toEqual([0, 0, 0, 1]); expect(result.gravity[2]).toContain('NaN');
  expect(result.cameraSame).toBe(true); expect(result.changed).toBe(true);
});

test('analytical candidate casts moving sphere shadows on an opaque receiver, preserving emission', async ({ page }, info) => {
  await page.route('**/tilt-shadow-candidate.mjs', route => route.fulfill({ path: new URL('../tilt-shadow-candidate.mjs', import.meta.url).pathname, contentType: 'text/javascript' }));
  await fixture(page);
  const result = await page.evaluate(async () => {
    const { v, THREE, sphere } = window.tiltFixture;
    const { installShadowCandidate } = await import('/tilt-shadow-candidate.mjs');
    installShadowCandidate(v, THREE);
    sphere.visible = false;
    v.bars.material.color.setRGB(.4, .4, .4);
    v.lighting.configure({ colorSpill: 0, attackLight: 0, colorAttack: 0, barGlow: 0, ballGlow: 0 });
    const camera = new THREE.OrthographicCamera(-.14, .14, .09, -.09, .01, 10);
    camera.position.set(.6, .04, 2); camera.lookAt(.6, .04, 0); camera.updateMatrixWorld();
    const target = new THREE.WebGLRenderTarget(192, 128), bytes = new Uint8Array(192 * 128 * 4);
    const matrix = new THREE.Matrix4().makeScale(.015, .015, .015).setPosition(.6, .04, .28);
    v.balls.setMatrixAt(0, matrix); v.balls.instanceMatrix.needsUpdate = true;
    for (let i = 1; i < 8; i++) v.balls.setMatrixAt(i, new THREE.Matrix4().makeScale(.001, .001, .001).setPosition(10, 10, 10));
    v.scene.children.forEach(n => { n.visible = n.isLight || n === v.bars; });
    const read = () => {
      v.renderer.setRenderTarget(target); v.render(camera);
      v.renderer.readRenderTargetPixels(target, 0, 0, 192, 128, bytes); return Array.from(bytes);
    };
    v.deviceGravity(0, -9.81, 0, 0); const upright = read();
    v.deviceGravity(9.81, 0, 0, 0); const tilted = read();
    // Remove the caster without changing lights to isolate actual shadow pixels.
    v.balls.setMatrixAt(0, new THREE.Matrix4().makeScale(.001, .001, .001).setPosition(10, 10, 10));
    const clear = read();
    v.deviceGravity(0, -9.81, 0, 0); const clearUp = read();
    // With global lights hidden, caster movement cannot dim independent emission.
    v.scene.children.filter(n => n.isLight).forEach(n => { n.visible = false; });
    v.lighting.configure({ colorSpill: 0, attackLight: 0, colorAttack: 0, barGlow: .3, ballGlow: 0 });
    const emissionClear = read();
    v.balls.setMatrixAt(0, matrix); const emissionShadow = read();
    v.renderer.setRenderTarget(null); target.dispose();
    const shadow = (clear, cast) => {
      const pixels = [];
      for (let i = 0; i < clear.length; i += 4) if (clear[i] + clear[i + 1] + clear[i + 2] > cast[i] + cast[i + 1] + cast[i + 2] + 12) pixels.push([i / 4 % 192, Math.floor(i / 4 / 192)]);
      return { count: pixels.length, centroid: [0, 1].map(k => pixels.reduce((n, p) => n + p[k], 0) / pixels.length) };
    };
    return { tilted: shadow(clear, tilted), upright: shadow(clearUp, upright), emissionSame: emissionShadow.every((v, i) => v === emissionClear[i]) };
  });
  await info.attach('shadow-pixels.json', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.tilted.count).toBeGreaterThan(20); expect(result.upright.count).toBeGreaterThan(20);
  expect(Math.hypot(...result.tilted.centroid.map((v, i) => v - result.upright.centroid[i]))).toBeGreaterThan(10);
  expect(result.emissionSame).toBe(true);
});


test('route cleanup and late permissions cannot light a replacement scene', async ({ page }) => {
  await fixture(page, { pending: true });
  await page.evaluate(() => { window.oldTiltView = window.tiltFixture.v; window.oldTiltView.deviceGravity(0, 9.81, 0, 0); });
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.oldTiltView.closed)).toBe(true);
  await page.evaluate(() => { for (const resolve of window.motionPermissions) resolve('granted'); });
  await page.getByRole('link', { name: 'Home', exact: true }).click(); await physicsReady(page);
  const result = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    const old = window.oldTiltView.globalLighting.up.toArray();
    window.oldTiltView.deviceGravity(9.81, 0, 0, 0);
    window.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta: -90, gamma: 0 }));
    window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: { x: 0, y: -9.81, z: 0 } }));
    return { old, after: window.oldTiltView.globalLighting.up.toArray(), current: v.globalLighting.up.toArray().map(n => n || 0), gravity: Array.from(v.input.slice(34, 38)), motionEnabled: v.motion.enabled };
  });
  expect(result.after).toEqual(result.old); expect(result.current).toEqual([0, 1, 0]);
  expect(result.gravity).toEqual([0, 0, 0, 0]); expect(result.motionEnabled).toBe(false);
});
