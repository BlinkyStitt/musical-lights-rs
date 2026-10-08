import { test, expect } from '@playwright/test';
import { replayReport } from '../replay-physics.mjs';
import { physicsReady, physicsState, syntheticAudio, startFrozen } from '../physics-state.mjs';
import { meterPoint } from '../meter-input.mjs';

const url = 'http://127.0.0.1:8101';

test('a subpixel seam fragment uses its visible wrapped copy for native hover', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(url); await physicsReady(page);
  await page.locator('.scroll-lights').uncheck();
  await page.evaluate(() => {
    const view = document.querySelector('#dancinglights').physics;
    // Hold one real rendered pointer layout at the seam. This is a geometry
    // fixture, independent of worker timing and frame-rate acceptance.
    cancelAnimationFrame(view.request); view.request = null;
    // A later enclosure snapshot reprojects the stored rendered phase.
    // Keep that state consistent with the pointer geometry held by this fixture.
    view.renderedPhase = 1.99999;
    view.positionMeters(view.renderedPhase);
  });
  const meter = page.getByRole('meter').nth(22);
  expect((await meter.boundingBox()).width).toBeLessThan(1);
  const label = await meter.getAttribute('aria-label');
  const point = await meterPoint(page, meter);
  expect(point.label).toBe(label);
  await page.mouse.move(point.x, point.y);
  await expect(page.getByRole('tooltip')).toHaveText(label);
});

test('continuous scrolling carries source identity and stops in place', async ({ page }, info) => {
  await syntheticAudio(page); await page.goto(url); await physicsReady(page);
  await expect(page.locator('.scroll-lights')).toBeChecked();
  await startFrozen(page);
  await page.evaluate(() => {
    const levels = Array(24).fill(0); levels[0] = .6; levels[23] = .2;
    window.sendBars(levels);
    const state = new Float64Array(99); state.set([window.audioNow, 0, 4]);
    for (let i = 0; i < 24; i++) state.set([levels[i], levels[i], i === 0 ? window.audioNow : -1, 0], 3 + i * 4);
    window.testNode.port.dispatchEvent(new MessageEvent('message', { data: {
      type: 'frame', sessionId: Number(document.querySelector('.audio-card').dataset.audioSession), state, clipped: 0,
    } }));
  });
  const sourceLabel = await page.getByRole('meter').first().getAttribute('aria-label');
  await page.locator('.scroll-lights').check();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.renderedPhase)).toBeGreaterThan(.3);
  await expect(page.getByRole('meter').first()).toHaveAttribute('aria-label', sourceLabel);
  await expect(page.getByRole('meter').first()).toHaveAttribute('aria-valuenow', '60');
  const moved = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return { edges: Array.from(v.edges), colors: Array.from(v.bars.instanceColor.array), palette: Array.from(v.palette),
      phase: v.renderedPhase, x: v.bars.instanceMatrix.array[12], top: v.current[v.layout[9]], max: v.current[v.layout[17] + 1] };
  });
  expect(moved.edges[0]).toBe(1); expect(moved.edges[1]).toBe(0);
  expect(moved.colors.slice(0, 3)).toEqual(moved.palette.slice(0, 3));
  expect(moved.x).toBeCloseTo((.5 + moved.phase) * .05, 5);
  expect(moved.top).toBeCloseTo(.003 + .6 * (moved.max - .003), 4);
  await page.screenshot({ path: info.outputPath('scrolling-bands.png') });
  await page.evaluate(() => { window.audioNow += .181; });
  await expect.poll(async () => Math.max(...(await physicsState(page)).edges)).toBe(0);
  await page.locator('.scroll-lights').uncheck();
  const stopTick = (await physicsState(page)).tick;
  await expect.poll(() => page.evaluate(stopTick => {
    const view = document.querySelector('#dancinglights').physics;
    return view.current[2] >= stopTick + 20 && view.current[view.layout[20]] === view.previous[view.layout[20]];
  }, stopTick)).toBe(true);
  const phase = await page.evaluate(() => document.querySelector('#dancinglights').physics.renderedPhase);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.renderedPhase)).toBe(phase);
  // Balanced scrolling can return below .3 before the stop gesture arrives.
  // Its position must stay fixed wherever it actually settles in the cycle.
  expect(phase).toBeGreaterThanOrEqual(0);
  expect(phase).toBeLessThan(24);
  await page.locator('.scroll-lights').check();
  await expect.poll(() => page.evaluate(stopped => {
    const phase = document.querySelector('#dancinglights').physics.renderedPhase;
    return Math.abs(((phase - stopped + 36) % 24) - 12);
  }, phase)).toBeGreaterThan(.1);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
});

test('Reduced Motion suppresses scrolling and audio stop restores the independent idle display', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await syntheticAudio(page); await page.goto(url); await startFrozen(page);
  await page.locator('.scroll-lights').check();
  await page.waitForTimeout(1700);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.input[33])).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[33])).toBe(1);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-preview', 'true');
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[33])).toBe(1);
  await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.edges))).toBe(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[33])).toBe(0);
  await expect(page.getByRole('meter').first()).toHaveAttribute('aria-label', '≈ 0–100 Hz');
});

for (const width of [375, 1440]) {
  test(`8 rigid spheres use a single WebGL2 canvas and physical bar positions at ${width}px`, async ({ page }, info) => {
    test.setTimeout(60000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setViewportSize({ width, height: 900 });
    await syntheticAudio(page); await page.goto(url); await startFrozen(page);
    await expect(page.locator('#dancinglights canvas')).toHaveCount(1);
    await expect(page.getByRole('meter')).toHaveCount(24);
    const initial = await physicsState(page);
    const ratios = [.55,1.4,2.2,.8,3.1,1,4,1.8];
    expect(initial.balls).toHaveLength(8);
    for (let i = 0; i < 8; i++) expect(initial.balls[i].radius * 2 / .048).toBeCloseTo(ratios[i], 5);
    await page.evaluate(() => window.sendBars(Array(24).fill(1), 1));
    await expect.poll(async () => Math.min(...(await physicsState(page)).bars)).toBeGreaterThan(initial.barMax - .005);
    const raised = await physicsState(page);
    expect(raised.balls.some((b, i) => b.position[1] > initial.balls[i].position[1] + .05)).toBe(true);
    expect(raised.balls.every(b => b.position[1] + b.radius <= raised.ceiling + .005)).toBe(true);
    expect(raised.balls.some((b, i) => b.color.some((c, j) => c !== initial.balls[i].color[j]))).toBe(true);
    const render = await page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      // Sample one complete draw. Bars use the current physical snapshot.
      // Comparing a fast moving render to a different worker snapshot is invalid.
      v.draw(performance.now());
      const expected = Array.from({ length: 24 }, (_, i) => v.current[v.layout[9] + i]);
      return { expected, ballInstances: v.balls.count, barInstances: v.bars.count, type: v.renderer.getContext().constructor.name, calls: v.renderer.info.render.calls,
        tops: Array.from({ length: 24 }, (_, i) => v.renderedHeight(i)),
        roofExtents: Array.from({ length: 24 }, (_, i) => v.renderedHeight(i, 1)) };
    });
    expect(render.ballInstances).toBe(8); expect(render.barInstances).toBe(144);
    // One additional instanced batch draws both side-wall bar banks. The
    // original body and source-bar instance counts remain unchanged.
    // Front, side and ball reflections use bounded parity batches; one box
    // draws all six coatings.
    expect(render.type).toBe('WebGL2RenderingContext'); expect(render.calls).toBe(9);
    render.tops.forEach((top, i) => expect(top).toBeCloseTo(render.expected[i], 5));
    render.roofExtents.forEach((extent, i) => expect(extent).toBeCloseTo(render.expected[i], 5));
    await page.screenshot({ path: info.outputPath('rigid-bodies.png'), fullPage: true });
    await page.evaluate(() => window.sendBars(Array(24).fill(0)));
    await expect.poll(async () => Math.max(...(await physicsState(page)).bars)).toBeCloseTo(.003, 3);
    await expect.poll(async () => (await physicsState(page)).balls.filter(b => b.position[1] < raised.height).length, { timeout: 30000 }).toBe(8);
    expect(errors).toEqual([]);
  });
}

test('resize preserves size, one worker and canvas; route close frees audio, GPU, observer and loop', async ({ page }) => {
  await page.addInitScript(() => {
    window.workers = new Set(); window.observers = new Set(); window.frames = new Set();
    const Worker = window.Worker; window.Worker = class extends Worker {
      constructor(...args) { super(...args); window.workers.add(this); }
      terminate() { window.workers.delete(this); super.terminate(); }
    };
    const Observer = window.ResizeObserver; window.ResizeObserver = class extends Observer {
      observe(...args) { window.observers.add(this); super.observe(...args); }
      disconnect() { window.observers.delete(this); super.disconnect(); }
    };
    const raf = requestAnimationFrame, cancel = cancelAnimationFrame;
    window.requestAnimationFrame = fn => { const id = raf(now => { window.frames.delete(id); fn(now); }); window.frames.add(id); return id; };
    window.cancelAnimationFrame = id => { window.frames.delete(id); cancel(id); };
  });
  await syntheticAudio(page); await page.goto(url); await startFrozen(page);
  const initial = await physicsState(page);
  await page.evaluate(() => { const v = document.querySelector('#dancinglights').physics; window.originalView = v; window.originalCanvas = v.canvas; window.gl = v.renderer.getContext(); });
  for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
    await expect.poll(async () => page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      const scene = v.layer.getBoundingClientRect();
      return Math.abs(v.current[1] - Math.max(.4, 1.2 * scene.height / scene.width));
    })).toBeLessThan(.005);
    const scene = await page.locator('.balloon-layer').boundingBox();
    const controls = await page.locator('.audio-controls').boundingBox();
    expect(scene.y + scene.height).toBeLessThanOrEqual(controls.y);
    expect((await physicsState(page)).balls.map(b => b.radius)).toEqual(initial.balls.map(b => b.radius));
    await page.keyboard.press('Escape');
  }
  expect(await page.evaluate(() => document.querySelector('canvas') === window.originalCanvas)).toBe(true);
  expect(await page.evaluate(() => window.workers.size)).toBe(1);
  expect(await page.evaluate(() => window.frames.size)).toBe(1);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
  const tick = (await physicsState(page)).tick;
  await expect.poll(async () => (await physicsState(page)).tick).toBeGreaterThan(tick + 10);
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect.poll(() => page.evaluate(() => [window.workers.size, window.observers.size, window.frames.size, window.testContext.state, window.gl.isContextLost()])).toEqual([0, 0, 0, 'closed', true]);
});

test('pointer and device inputs apply recorded forces and reduced motion reduces their strength', async ({ page }) => {
  await syntheticAudio(page); await page.goto(url);
  await page.evaluate(() => { Object.defineProperty(DeviceOrientationEvent, 'requestPermission', { value: async () => { throw new Error('Tilt unavailable'); } }); });
  await startFrozen(page);
  await page.evaluate(() => {
    window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration: { x: -8, y: 0, z: 0 } }));
  });
  // Preserve the original requirement that more than a third respond, without
  // coupling a sensor check to a historical particle count.
  await expect.poll(async () => {
    const { balls } = await physicsState(page);
    return balls.filter(b => b.velocity[0] > .05).length / balls.length;
  }).toBeGreaterThan(1 / 3);
  const box = await page.locator('canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.input[27])).toBe(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[31])).toBe(1);
});

test('physical controls require reset while camera rotation preserves the running world', async ({ page }) => {
  await page.goto(`${url}/advanced`); await physicsReady(page); await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.physics-controls > summary').click();
  const before = await physicsState(page);
  await page.locator('[data-config="2"]').fill('16');
  expect((await physicsState(page)).balls[0].mass).toBe(before.balls[0].mass);
  await page.locator('.display-controls > summary').click();
  await page.locator('.camera-rotation').fill('20');
  await expect.poll(async () => (await physicsState(page)).tick).toBeGreaterThan(before.tick);
  expect((await physicsState(page)).balls[0].mass).toBe(before.balls[0].mass);
  await page.getByRole('button', { name: 'Apply settings and reset' }).click();
  await physicsReady(page);
  await expect.poll(async () => (await physicsState(page)).balls[0].mass).toBeCloseTo(before.balls[0].mass * 2, 6);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.cameraBase)).toBe(20);
  const camera = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return { yaw: v.rotation, slider: Number(document.querySelector('.camera-rotation').value) };
  });
  expect(Math.abs(camera.yaw - 20)).toBeLessThanOrEqual(5.5);
  expect(Math.abs(camera.yaw - camera.slider)).toBeLessThan(1);
});

test('depth shakes and audio bars both move balls while tilt permission is still pending', async ({ page }) => {
  await syntheticAudio(page); await page.goto(url);
  await page.evaluate(() => {
    Object.defineProperty(DeviceOrientationEvent, 'requestPermission', { value: () => new Promise(() => {}) });
  });
  await startFrozen(page);
  // Let gravity settle first so a depth velocity cannot be attributed to spawn.
  await page.waitForTimeout(2000);
  const before = await physicsState(page);
  const samples = await page.evaluate(async () => {
    const view = document.querySelector('#dancinglights').physics;
    window.sendBars(Array(24).fill(.5));
    const samples = [];
    const until = performance.now() + 700;
    while (performance.now() < until) {
      window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration: { x: null, y: null, z: 8 } }));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const { current: state, layout } = view;
      samples.push({ input: view.input[26], bars: Array.from(state.slice(layout[9], layout[10])),
        balls: Array.from({ length: layout[21] }, (_, i) => {
          const o = 3 + i * layout[8];
          return { y: state[o + 1], vz: state[o + 11] };
        }) });
    }
    return samples;
  });
  expect(samples.some(s => s.input === -8)).toBe(true);
  expect(samples.some(s => s.balls.some(b => b.vz < -.1))).toBe(true);
  expect(samples.some(s => Math.min(...s.bars) > before.barMax * .45)).toBe(true);
  expect(samples.some(s => s.balls.some((b, i) => b.y > before.balls[i].position[1] + .03))).toBe(true);
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[26])).toBe(0);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
  await page.evaluate(() => window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration: { x: 5, y: 5, z: 5 } })));
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.acceleration)).toEqual([-5, -5, -5]);
  await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).uncheck();
});

for (const end of ['stop', 'route', 'microphone denial', 'audio failure']) {
  test(`audio lifecycle never implicitly requests sensor permission after ${end}`, async ({ page }) => {
    await syntheticAudio(page, 'pending'); await page.goto(url); await physicsReady(page);
    await page.evaluate(() => { window.savedInput = document.querySelector('#dancinglights').physics.motion; });
    if (end === 'microphone denial') await page.evaluate(() => { MediaDevices.prototype.getUserMedia = async () => { throw new Error('Microphone denied'); }; });
    if (end === 'microphone denial') {
      await page.getByRole('checkbox', { name: 'Listening', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Microphone denied');
      await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).not.toBeChecked();
    }
    else {
      await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
      await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
      if (end === 'stop') await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
      if (end === 'route') await page.getByRole('link', { name: 'About', exact: true }).click();
      if (end === 'audio failure') { await page.evaluate(() => window.testNode.dispatchEvent(new Event('processorerror'))); await expect(page.getByRole('alert')).toContainText('Audio processor failed'); }
    }
    await page.evaluate(async () => { for (const resolve of window.resolveMotion) resolve('granted'); await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(await page.evaluate(() => window.savedInput.motion)).toBeNull();
  });
}

test('context loss pauses physics and restoration resumes without losing the Exit button', async ({ page }) => {
  await page.goto(url); await physicsReady(page);
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await page.evaluate(() => { const v = document.querySelector('#dancinglights').physics; window.loss = v.renderer.getContext().getExtension('WEBGL_lose_context'); window.loss.loseContext(); });
  await expect(page.locator('.physics-status')).toContainText('Graphics paused');
  const tick = (await physicsState(page)).tick;
  await page.waitForTimeout(150);
  expect((await physicsState(page)).tick).toBe(tick);
  await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
  await page.evaluate(() => window.loss.restoreContext());
  await expect.poll(async () => (await physicsState(page)).tick).toBeGreaterThan(tick + 5);
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
});

test('phone page sends generated PCM through the audio processor and exports an honest incomplete report', async ({ page }) => {
  await page.goto(`${url}/advanced`); await physicsReady(page); await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await expect(page.locator('.input-source')).toHaveValue('microphone');
  await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.review-start').click();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.acceptanceWorkload())).toBe(true);
  await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.input.slice(0, 24)))).toBeGreaterThan(.1);
  await page.locator('.phone-device').fill('Mac emulation'); await page.locator('.phone-browser').fill('test browser'); await page.locator('.ios-version').fill('test-only Mac WebKit'); await page.locator('.low-power-off').check();
  await page.locator('.physics-controls').evaluate(node => { node.open = true; });
  await page.locator('[data-config="5"]').fill('0.36');
  await page.getByRole('button', { name: 'Start five-minute test' }).click();
  await expect(page.locator('.physics-status')).toContainText('Warming');
  await expect(page.locator('.direction-curve')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.bars.geometry.parameters.depth)).toBeCloseTo(.36, 5);
  await expect.poll(() => page.evaluate(() => {
    const walls = document.querySelector('#dancinglights').physics.enclosure;
    return Array.from({ length: walls.count }, (_, i) => walls.instanceMatrix.array[i * 16 + 10]);
  })).toEqual(Array(3).fill(Math.fround(.36)));
  await expect.poll(async () => (await physicsState(page)).tick).toBeGreaterThan(40);
  await page.locator('.diagnostics-controls > summary').click();
  const sequence = await page.evaluate(() => document.querySelector('#dancinglights').physics.sequence);
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.sequence)).toBeGreaterThan(sequence + 24);
  await page.getByRole('button', { name: 'End test early' }).click();
  await expect(page.getByRole('button', { name: 'Export test report' })).toBeEnabled();
  await expect(page.locator('.direction-curve')).toBeEnabled();
  const report = await page.evaluate(() => document.querySelector('#dancinglights').physics.report.result);
  expect(report.accepted).toBe(false); expect(report.invalidReasons).toContain('Test ended before five minutes');
  expect(report.inputs.length).toBeGreaterThan(20); expect(report.finalTick).toBeGreaterThan(40);
  expect(report.discardedSimulationMs).toBe(0);
  expect(report.config[5]).toBeCloseTo(0.36, 5);
  expect((await replayReport(report)).every(result => result.matches)).toBe(true);
  const historical = { ...report, layout: [...report.layout] };
  historical.layout[18] = 4;
  await expect(replayReport(historical)).rejects.toThrow('matching historical engine');
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export test report' }).click();
  expect((await download).suggestedFilename()).toContain('normal.json');
});

test('a delayed worker reports debt and catches up without discarding simulation time', async ({ page }) => {
  await page.goto(url); await physicsReady(page);
  const worker = page.workers().find(worker => worker.url().endsWith('/physics/worker.js'));
  expect(worker).toBeTruthy();
  const before = await physicsState(page);
  await worker.evaluate(() => { const end = performance.now() + 250; while (performance.now() < end) { /* Deliberate worker CPU stall. */ } });
  await expect.poll(async () => (await physicsState(page)).metrics.maxDebt).toBeGreaterThan(100);
  await expect.poll(async () => (await physicsState(page)).tick).toBeGreaterThan(before.tick + 30);
  await expect.poll(async () => (await physicsState(page)).metrics.debt).toBeLessThan(17);
  expect((await physicsState(page)).metrics.discardedSimulationMs).toBe(0);
});

test('snapshots stay fresh while the render loop is paused', async ({ page }) => {
  await page.goto(url); await physicsReady(page);
  const result = await page.evaluate(async () => {
    const view = document.querySelector('#dancinglights').physics;
    cancelAnimationFrame(view.request);
    view.recordTiming = true;
    const tick = view.current[2], frames = view.metrics.frames, samples = view.timing.snapshots.length;
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      return { ticks: view.current[2] - tick, frames: view.metrics.frames - frames,
        samples: view.timing.snapshots.length - samples, age: performance.now() - view.received,
        buffers: view.buffers.length + Number(Boolean(view.previous)) + Number(Boolean(view.current)) + Number(view.inflight) };
    } finally { view.request = requestAnimationFrame(view.animate); }
  });
  expect(result.frames).toBe(0);
  expect(result.ticks).toBeGreaterThan(24);
  expect(result.samples).toBeGreaterThan(5);
  expect(result.age).toBeLessThan(100);
  expect(result.buffers).toBe(3);
});

test('expensive physics ticks yield snapshots between steps and retain their debt', async ({ page }) => {
  await page.goto(url); await physicsReady(page);
  await page.evaluate(() => { document.querySelector('#dancinglights').physics.timing.snapshots = []; document.querySelector('#dancinglights').physics.recordTiming = true; });
  const worker = page.workers().find(worker => worker.url().endsWith('/physics/worker.js'));
  const before = await physicsState(page);
  await worker.evaluate(async () => {
    const { PhysicsSimulation } = await import(new URL('./physics.js', self.location.href));
    const step = PhysicsSimulation.prototype.step;
    const post = self.postMessage;
    const probe = self.expensiveTickProbe = { injected: 0, published: [], done: false };
    probe.restore = () => {
      PhysicsSimulation.prototype.step = step; self.postMessage = post; probe.done = true;
    };
    PhysicsSimulation.prototype.step = function () {
      step.call(this);
      const end = performance.now() + 20;
      while (performance.now() < end) { /* Reproduce expensive indivisible contact steps. */ }
      if (++probe.injected === 64) probe.restore();
    };
    self.postMessage = function (message, ...args) {
      // Keep the injected load until actual snapshot publication has yielded
      // enough observations. Eight ticks can finish before a slow renderer
      // returns enough of the bounded transfer buffers to observe three batches.
      if (message.type === 'snapshot' && message.batchMs >= 20) {
        probe.published.push({ ticks: message.batchTicks, batchMs: message.batchMs });
        if (probe.published.length === 4) probe.restore();
      }
      return post.call(self, message, ...args);
    };
  });
  try {
    await expect.poll(() => worker.evaluate(() => self.expensiveTickProbe.done)).toBe(true);
    await expect.poll(async () => (await physicsState(page)).tick).toBeGreaterThan(before.tick + 60);
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.timing.snapshots.filter(sample => sample.batchMs >= 20).length)).toBeGreaterThanOrEqual(3);
    const costly = await page.evaluate(() => document.querySelector('#dancinglights').physics.timing.snapshots.filter(sample => sample.batchMs >= 20));
    expect(costly.every(sample => sample.ticks === 1)).toBe(true);
    await expect.poll(async () => (await physicsState(page)).metrics.debt).toBeLessThan(17);
    expect((await physicsState(page)).metrics.discardedSimulationMs).toBe(0);
  } finally {
    await worker.evaluate(() => { self.expensiveTickProbe.restore(); delete self.expensiveTickProbe; });
  }
});

test('phone acceptance rejects frozen snapshots despite 60 FPS and a current worker', async ({ page }) => {
  await page.goto(`${url}/advanced`); await physicsReady(page);
  const results = await page.evaluate(() => {
    // Synthetic reports test the acceptance rule; they are not device measurements.
    const report = document.querySelector('#dancinglights').physics.report;
    report.intervals = new Float32Array(60000); report.renderCosts = new Float32Array(60000);
    report.intervals.fill(1000 / 60); report.count = 18000;
    report.invalid = []; report.maxSnapshotAgeMs = 10;
    report.progress = Array.from({ length: 300 }, (_, i) => ({ elapsedMs: i * 1000, tick: 1800 + i * 120, debtMs: 0 }));
    const data = { type: 'report', physicsCosts: Array(37800).fill(.25),
      elapsedMs: 315000, initialTick: 0, finalTick: 37800, debt: 0, maxDebt: 0,
      discardedSimulationMs: 0, recordingOverflow: false };
    report.receive(data); const moving = report.result.numericPass;
    for (const sample of report.progress) sample.tick = 1800;
    report.receive(data); const frozen = report.result.numericPass;
    report.progress.forEach((sample, i) => { sample.tick = 1800 + i * 120; });
    report.maxSnapshotAgeMs = 350;
    report.receive(data); const stale = report.result.numericPass;
    return { moving, frozen, stale };
  });
  expect(results).toEqual({ moving: true, frozen: false, stale: false });
});

test('wrapped pointer surfaces and keyboard focus retain the source frequency', async ({ page }) => {
  await syntheticAudio(page); await page.goto(url); await startFrozen(page);
  // This fixture needs a stationary hover surface. Camera motion has its own
  // tests; stop it through the saved setting instead of forcing an unstable hit.
  await page.locator('.display-controls > summary').click();
  await page.locator('.camera-motion').uncheck();
  const last = await page.getByRole('meter').last().getAttribute('aria-label');
  await page.locator('.scroll-lights').check();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.renderedPhase)).toBeGreaterThan(.4);
  await page.locator('.scroll-lights').uncheck();
  await page.waitForFunction(() => {
    const v = document.querySelector('#dancinglights').physics;
    return v.previous && v.current[v.layout[20]] === v.previous[v.layout[20]];
  });
  // Host speed can carry more than one band past the seam before Stop arrives.
  // Select the actual clipped copy, retaining its immutable source identity.
  const wrapped = await page.locator('.bark-copy').evaluateAll(nodes =>
    nodes.filter(node => node.getBoundingClientRect().width > 0)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0].dataset.sourceBand);
  const wrappedLabel = await page.getByRole('meter').nth(Number(wrapped)).getAttribute('aria-label');
  await page.locator(`.bark-copy[data-source-band="${wrapped}"]`).hover();
  await expect(page.locator('.frequency-tooltip')).toContainText(wrappedLabel);
  await page.getByRole('meter').first().focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('meter').last()).toBeFocused();
  await expect(page.locator('.frequency-tooltip')).toContainText(last);
  await page.locator('.scroll-lights').check();
  await page.getByRole('meter').last().focus();
  const before = await page.getByRole('meter').last().getAttribute('aria-label');
  await page.waitForTimeout(1600);
  await expect(page.getByRole('meter').last()).toBeFocused();
  await expect(page.getByRole('meter').last()).toHaveAttribute('aria-label', before);
  await expect(page.getByRole('meter')).toHaveCount(24);
});

test('leftward scrolling interpolates through the seam without sweeping the pattern right', async ({ page }) => {
  await page.goto(url); await physicsReady(page);
  const samples = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    cancelAnimationFrame(v.raf);
    const previous = v.previous, current = v.current, received = v.received;
    try {
      return [[.1, .08, .5], [.01, 23.99, .75], [23.99, .01, .75]].map(([from, to, alpha]) => {
        v.previous = new Float32Array(previous ?? current); v.current = new Float32Array(current);
        v.previous[0] = 1; v.current[0] = 1.02;
        v.previous[v.layout[20]] = from; v.current[v.layout[20]] = to;
        v.received = performance.now(); v.draw(v.received + 20 * alpha);
        return v.renderedPhase;
      });
    } finally { v.previous = previous; v.current = current; v.received = received; v.raf = requestAnimationFrame(v.animate); }
  });
  expect(samples[0]).toBeCloseTo(.09, 4);
  expect(samples[1]).toBeCloseTo(23.995, 4);
  expect(samples[2]).toBeCloseTo(.005, 4);
});

for (const scenario of [
  // A 16 m/s² device acceleration exceeds gravity for upward lift. At 1x SI
  // scale a 2 m/s² lift cannot overcome gravity; do not rely on a hidden gain.
  { name: 'portrait sideways', angle: 0, acceleration: { x: -16, y: 0, z: 0 }, axis: 0, travel: .08 },
  { name: 'portrait lift', angle: 0, acceleration: { x: 0, y: -16, z: 0 }, axis: 1, travel: .08 },
  { name: 'landscape lift', angle: 90, acceleration: { x: -16, y: 0, z: 0 }, axis: 1, travel: .08 },
  { name: 'depth', angle: 0, acceleration: { x: 0, y: 0, z: -16 }, axis: 2, travel: .035 },
]) {
  test(`handheld box shake produces visible ${scenario.name} travel from rest`, async ({ page }, info) => {
    await syntheticAudio(page); await page.goto(url); await startFrozen(page);
    await page.evaluate(angle => Object.defineProperty(screen.orientation, 'angle', { configurable: true, value: angle }), scenario.angle);
    await page.waitForTimeout(2000);
    const before = await physicsState(page);
    const result = await page.evaluate(async ({ acceleration, axis }) => {
      const view = document.querySelector('#dancinglights').physics;
      const first = Array.from({ length: view.layout[21] }, (_, i) => view.current[3 + i * view.layout[8] + axis]);
      const travel = first.map(() => 0);
      const end = performance.now() + 240;
      while (performance.now() < end) {
        window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration }));
        await new Promise(resolve => requestAnimationFrame(resolve));
        for (let i = 0; i < first.length; i++) travel[i] = Math.max(travel[i], view.current[3 + i * view.layout[8] + axis] - first[i]);
      }
      return { travel, input: Array.from(view.input.slice(24, 27)) };
    }, scenario);
    await info.attach('shake-travel', { body: JSON.stringify(result), contentType: 'application/json' });
    expect(result.travel.filter(distance => distance > scenario.travel).length).toBeGreaterThanOrEqual(before.balls.length / 2);
    expect(result.input[scenario.axis]).toBeCloseTo(16, 5);
    // Lost events do not leave a continuous force; gravity/collisions continue.
    await expect.poll(() => page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.input.slice(24, 27)))).toEqual([0, 0, 0]);
    const after = await physicsState(page);
    for (const b of after.balls) {
      expect(b.position[0]).toBeGreaterThanOrEqual(b.radius - .006);
      expect(b.position[0]).toBeLessThanOrEqual(1.2 - b.radius + .006);
      expect(b.position[1]).toBeGreaterThanOrEqual(b.radius - .006);
      expect(b.position[1]).toBeLessThanOrEqual(after.ceiling - b.radius + .006);
      expect(Math.abs(b.position[2])).toBeLessThanOrEqual(after.config[5] / 2 - b.radius + .006);
    }
  });
}

test('rotation-locked phone can enable shaking without starting the microphone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await syntheticAudio(page); await page.goto(url); await physicsReady(page);
  await page.locator('.scroll-lights').uncheck();
  // Measure sensor-only travel from rest. The independent idle sine must not
  // keep prescribing moving supports while this fixture establishes its floor.
  await page.evaluate(() => new Promise(resolve => {
    const v = document.querySelector('#dancinglights').physics;
    v.stopPreview(); v.idle = false;
    v.push(new Float64Array(24), new Float32Array(24), false);
    const reset = ({ data }) => {
      if (data.type !== 'reset') return;
      v.worker.removeEventListener('message', reset); resolve();
    };
    v.worker.addEventListener('message', reset);
    v.worker.postMessage({ type: 'reset', config: Array.from(v.config) });
  }));
  await physicsReady(page);
  await page.evaluate(() => {
    Object.defineProperty(screen.orientation, 'angle', { configurable: true, value: 0 });
    Object.defineProperty(DeviceOrientationEvent, 'requestPermission', { configurable: true, value: () => Promise.resolve('denied') });
  });
  await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).check();
  await expect(page.locator('.motion-status')).toHaveAttribute('data-state', 'waiting');
  expect(await page.evaluate(() => window.testContext === undefined)).toBe(true);
  await page.waitForTimeout(2000);
  const before = await physicsState(page);
  const travel = await page.evaluate(async () => {
    const view = document.querySelector('#dancinglights').physics;
    const count = view.layout[21], stride = view.layout[8];
    const initial = Array.from({ length: count }, (_, i) => view.current[3 + i * stride]);
    const distances = initial.map(() => 0);
    const send = x => window.dispatchEvent(Object.assign(new Event('devicemotion'), {
      acceleration: { x: null, y: null, z: null }, accelerationIncludingGravity: { x, y: 9.81, z: 0 },
    }));
    send(0);
    await new Promise(resolve => setTimeout(resolve, 16));
    const until = performance.now() + 240;
    while (performance.now() < until) {
      send(-16);
      await new Promise(resolve => requestAnimationFrame(resolve));
      for (let i = 0; i < count; i++) distances[i] = Math.max(distances[i], view.current[3 + i * stride] - initial[i]);
    }
    return distances;
  });
  expect(travel.filter(distance => distance > .08).length).toBeGreaterThanOrEqual(before.balls.length / 2);
  await expect(page.locator('.motion-status')).toHaveAttribute('data-state', 'active');
  await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).uncheck();
  await expect(page.locator('.motion-status')).toHaveText('Motion access allowed · motion off.');
  expect(await page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.input.slice(24, 27)))).toEqual([0, 0, 0]);
  expect(await page.evaluate(() => window.testContext === undefined)).toBe(true);
});

test('motion denial is visible and a new gesture can retry without stopping music', async ({ page }) => {
  await syntheticAudio(page, 'denied'); await page.goto(url); await startFrozen(page);
  await expect(page.locator('.motion-status')).toHaveAttribute('data-state', 'denied');
  await page.evaluate(() => { Object.defineProperty(DeviceMotionEvent, 'requestPermission', { configurable: true, value: () => Promise.resolve('granted') }); });
  await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).check();
  await expect(page.locator('.motion-status')).toHaveAttribute('data-state', 'waiting');
  await page.evaluate(() => {
    window.sendBars(Array(24).fill(.5));
    window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration: { x: 0, y: 0, z: 0 } }));
  });
  await expect(page.locator('.motion-status')).toHaveAttribute('data-state', 'active');
  await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).uncheck();
  expect(await page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.input.slice(0, 24)))).toEqual(Array(24).fill(.5));
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
});

for (const acceleration of ['denied', 'unavailable', 'pending']) {
  test(`tilt-only motion can be disabled when acceleration is ${acceleration}`, async ({ page }) => {
    await syntheticAudio(page); await page.goto(url); await physicsReady(page);
    await page.evaluate(acceleration => {
      if (acceleration === 'unavailable') Object.defineProperty(window, 'DeviceMotionEvent', { configurable: true, value: undefined });
      else Object.defineProperty(DeviceMotionEvent, 'requestPermission', { configurable: true,
        value: () => acceleration === 'pending' ? new Promise(resolve => { window.finishShakePermission = resolve; }) : Promise.resolve('denied'),
      });
    }, acceleration);
    await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).check();
    const disable = page.getByRole('checkbox', { name: 'Phone motion', exact: true });
    await expect(disable).toBeEnabled();
    await expect(disable).toBeChecked();
    await expect(page.locator('.motion-status')).toContainText('Tilt on');
    await page.evaluate(() => window.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta: 20, gamma: 45 })));
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[34])).toBeGreaterThan(1);
    expect(await page.evaluate(() => window.testContext === undefined)).toBe(true);
    await disable.uncheck();
    await expect(page.getByRole('checkbox', { name: 'Phone motion', exact: true })).not.toBeChecked();
    await page.evaluate(() => {
      window.finishShakePermission?.('granted');
      window.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta: 60, gamma: 60 }));
      window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration: { x: 8, y: 0, z: 0 } }));
    });
    await expect.poll(() => page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.input.slice(24, 27)))).toEqual([0, 0, 0]);
    expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.motion.motion)).toBeNull();
    expect(await page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.input.slice(34, 38)))).toEqual([0, 0, 0, 0]);
  });
}
