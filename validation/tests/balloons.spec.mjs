import { test, expect } from '@playwright/test';
import { replayReport } from '../replay-physics.mjs';
import { physicsReady, physicsState, syntheticAudio, startFrozen } from '../physics-state.mjs';

const url = 'http://127.0.0.1:8101';
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
    await expect.poll(async () => Math.min(...(await physicsState(page)).bars)).toBeGreaterThan(initial.height * .94);
    const raised = await physicsState(page);
    expect(raised.balls.some((b, i) => b.position[1] > initial.balls[i].position[1] + .05)).toBe(true);
    expect(raised.balls.some(b => b.position[1] > raised.height)).toBe(true);
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
    expect(render.type).toBe('WebGL2RenderingContext'); expect(render.calls).toBe(2);
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
    await expect.poll(async () => (await physicsState(page)).height).toBeCloseTo(1.2 * size.height / size.width, 2);
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
  await expect(page.locator('.generated-audio')).toBeChecked();
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
  await page.waitForTimeout(500);
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
