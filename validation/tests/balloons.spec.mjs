import { test, expect } from '@playwright/test';
import { replayReport } from '../replay-physics.mjs';
import { physicsReady, physicsState, syntheticAudio, startFrozen } from '../physics-state.mjs';

const url = 'http://127.0.0.1:8101';

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
  await page.waitForTimeout(350);
  const phase = await page.evaluate(() => document.querySelector('#dancinglights').physics.renderedPhase);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.renderedPhase)).toBe(phase);
  expect(phase).toBeGreaterThan(.3);
  await page.locator('.scroll-lights').check();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.renderedPhase)).toBeGreaterThan(phase + .1);
  await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
});

test('Reduced Motion suppresses scrolling and Stop retains source identity', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await syntheticAudio(page); await page.goto(url); await startFrozen(page);
  await page.locator('.scroll-lights').check();
  await page.waitForTimeout(1700);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.input[33])).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[33])).toBe(1);
  await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[33])).toBe(0);
  await expect(page.getByRole('meter').first()).toHaveAttribute('aria-label', '≈ 0–100 Hz');
});

for (const width of [375, 1440]) {
  test(`24 rigid spheres use a single WebGL2 canvas and physical bar positions at ${width}px`, async ({ page }, info) => {
    test.setTimeout(60000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setViewportSize({ width, height: 900 });
    await syntheticAudio(page); await page.goto(url); await startFrozen(page);
    await expect(page.locator('#dancinglights canvas')).toHaveCount(1);
    await expect(page.getByRole('meter')).toHaveCount(24);
    const initial = await physicsState(page);
    const ratios = [.55,1.4,2.2,.8,3.1,1,4,1.8,.65,2.6,1.2,3.5,.65,1,1.2,.8,1.4,.55,.7,1.1,1.6,.9,1.3,.6];
    for (let i = 0; i < 24; i++) expect(initial.balls[i].radius * 2 / .048).toBeCloseTo(ratios[i], 5);
    await page.evaluate(() => window.sendBars(Array(24).fill(1), 1));
    await expect.poll(async () => Math.min(...(await physicsState(page)).bars)).toBeGreaterThan(initial.barMax - .005);
    const raised = await physicsState(page);
    expect(raised.balls.some((b, i) => b.position[1] > initial.balls[i].position[1] + .05)).toBe(true);
    expect(raised.balls.every(b => b.position[1] + b.radius <= raised.ceiling + .005)).toBe(true);
    expect(raised.balls.some((b, i) => b.color.some((c, j) => c !== initial.balls[i].color[j]))).toBe(true);
    const render = await page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      // Sample one complete draw, including its intentional interpolation delay.
      // Comparing a fast moving render to a different worker snapshot is invalid.
      v.draw(performance.now());
      const a = v.bars.instanceMatrix.array;
      const expected = Array.from({ length: 24 }, (_, i) => {
        const current = v.current[v.layout[9] + i], previous = (v.previous ?? v.current)[v.layout[9] + i];
        return previous + (current - previous) * v.renderAlpha;
      });
      return { expected, type: v.renderer.getContext().constructor.name, calls: v.renderer.info.render.calls,
        tops: Array.from({ length: 24 }, (_, i) => a[i * 16 + 13] + v.layout[6] / 2) };
    });
    expect(render.type).toBe('WebGL2RenderingContext'); expect(render.calls).toBe(3);
    render.tops.forEach((top, i) => expect(top).toBeCloseTo(render.expected[i], 5));
    await page.screenshot({ path: info.outputPath('rigid-bodies.png'), fullPage: true });
    await page.evaluate(() => window.sendBars(Array(24).fill(0)));
    await expect.poll(async () => Math.max(...(await physicsState(page)).bars)).toBeCloseTo(.003, 3);
    await expect.poll(async () => (await physicsState(page)).balls.filter(b => b.position[1] < raised.height).length, { timeout: 30000 }).toBeGreaterThan(12);
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
    await expect.poll(async () => (await physicsState(page)).height).toBeCloseTo(Math.max(.4, 1.2 * size.height / size.width), 2);
    expect((await physicsState(page)).balls.map(b => b.radius)).toEqual(initial.balls.map(b => b.radius));
    await page.keyboard.press('Escape');
  }
  expect(await page.evaluate(() => document.querySelector('canvas') === window.originalCanvas)).toBe(true);
  expect(await page.evaluate(() => window.workers.size)).toBe(1);
  expect(await page.evaluate(() => window.frames.size)).toBe(1);
  await page.getByRole('button', { name: 'Stop listening' }).click();
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
  await expect.poll(async () => (await physicsState(page)).balls.filter(b => b.velocity[0] > .05).length).toBeGreaterThan(8);
  const box = await page.locator('canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.input[27])).toBe(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[31])).toBe(1);
});

test('physical controls require reset while camera rotation preserves the running world', async ({ page }) => {
  await page.goto(url); await physicsReady(page);
  await page.locator('.physics-controls > summary').click();
  const before = await physicsState(page);
  await page.locator('[data-config="2"]').fill('2200');
  expect((await physicsState(page)).balls[0].mass).toBe(before.balls[0].mass);
  await page.locator('.camera-rotation').fill('20');
  await expect.poll(async () => (await physicsState(page)).tick).toBeGreaterThan(before.tick);
  expect((await physicsState(page)).balls[0].mass).toBe(before.balls[0].mass);
  await page.getByRole('button', { name: 'Apply settings and reset' }).click();
  await physicsReady(page);
  await expect.poll(async () => (await physicsState(page)).balls[0].mass).toBeCloseTo(before.balls[0].mass * 2, 6);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.rotation)).toBe(20);
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
        balls: Array.from({ length: layout[0] }, (_, i) => {
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
  await page.getByRole('button', { name: 'Stop listening' }).click();
  await page.evaluate(() => window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration: { x: 5, y: 5, z: 5 } })));
  expect(await page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.input.slice(24, 27)))).toEqual([0, 0, 0]);
});

for (const end of ['stop', 'route', 'microphone denial', 'audio failure']) {
  test(`late sensor permission cannot restore listeners after ${end}`, async ({ page }) => {
    await syntheticAudio(page, 'pending'); await page.goto(url); await physicsReady(page);
    await page.evaluate(() => { window.savedInput = document.querySelector('#dancinglights').physics.motion; });
    if (end === 'microphone denial') await page.evaluate(() => { MediaDevices.prototype.getUserMedia = async () => { throw new Error('Microphone denied'); }; });
    await page.getByRole('button', { name: 'Start listening', exact: true }).click();
    if (end === 'microphone denial') await expect(page.getByRole('alert')).toContainText('Microphone denied');
    else {
      await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
      if (end === 'stop') await page.getByRole('button', { name: 'Stop listening' }).click();
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
  await page.goto(`${url}/phone`); await physicsReady(page);
  await expect(page.locator('.generated-audio')).not.toBeChecked();
  await page.locator('.generated-audio').check();
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.acceptanceWorkload())).toBe(true);
  await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.input.slice(0, 24)))).toBeGreaterThan(.1);
  await page.locator('.ios-version').fill('test-only Mac WebKit'); await page.locator('.low-power-off').check();
  await page.locator('[data-config="5"]').fill('0.36');
  await page.getByRole('button', { name: 'Start five-minute test' }).click();
  await expect(page.locator('.physics-status')).toContainText('Warming');
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.bars.geometry.parameters.depth)).toBeCloseTo(0.36, 5);
  await expect.poll(async () => (await physicsState(page)).tick).toBeGreaterThan(40);
  await page.locator('.physics-controls > summary').click();
  const sequence = await page.evaluate(() => document.querySelector('#dancinglights').physics.sequence);
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.sequence)).toBeGreaterThan(sequence + 24);
  await page.getByRole('button', { name: 'End test early' }).click();
  await expect(page.getByRole('button', { name: 'Export test report' })).toBeEnabled();
  const report = await page.evaluate(() => document.querySelector('#dancinglights').physics.report.result);
  expect(report.accepted).toBe(false); expect(report.invalidReasons).toContain('Test ended before five minutes');
  expect(report.inputs.length).toBeGreaterThan(20); expect(report.finalTick).toBeGreaterThan(40);
  expect(report.discardedSimulationMs).toBe(0);
  expect(report.config[5]).toBeCloseTo(0.36, 5);
  expect((await replayReport(report)).every(result => result.matches)).toBe(true);
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

test('phone acceptance rejects frozen snapshots despite 60 FPS and a current worker', async ({ page }) => {
  await page.goto(url); await physicsReady(page);
  const results = await page.evaluate(() => {
    // Synthetic reports test the acceptance rule; they are not device measurements.
    const report = document.querySelector('#dancinglights').physics.report;
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
  const last = await page.getByRole('meter').last().getAttribute('aria-label');
  await page.locator('.scroll-lights').check();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.renderedPhase)).toBeGreaterThan(.4);
  await page.locator('.scroll-lights').uncheck(); await page.waitForTimeout(350);
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
