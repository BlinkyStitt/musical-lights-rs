import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { physicsReady, physicsState } from '../physics-state.mjs';
import { meterPoint } from '../meter-input.mjs';

test('iPhone sensor denial preserves mouse input and gravity continues after Stop', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.sensorRequests = [];
    for (const name of ['DeviceMotionEvent', 'DeviceOrientationEvent']) {
      Object.defineProperty(window[name], 'requestPermission', { value: () => {
        window.sensorRequests.push({ name, active: navigator.userActivation.isActive });
        return Promise.resolve('denied');
      } });
    }
  });
  // Use the real generated-audio pipeline to raise the bars. Silent input can
  // leave every ball at rest before a slower browser reaches the Stop button.
  await page.goto('http://127.0.0.1:8101/advanced/');
  await physicsReady(page);
  await expect(page.locator('.input-source')).toHaveValue('microphone');
  await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.input-source').selectOption('generated');
  await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
  const calls = await page.evaluate(() => window.sensorRequests);
  expect(calls).toHaveLength(2);
  expect(calls.every(call => call.active)).toBe(true);
  // This test needs an airborne ball at Stop. The narrow, masking-aware
  // display intentionally does not raise half the bars for six active tones.
  await expect.poll(async () => (await physicsState(page)).balls.some(ball => ball.position[1] > ball.radius + .1)).toBe(true);
  const box = await page.locator('#dancinglights canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.input[27])).toBe(1);
  await page.mouse.move(0, 0);
  const stop = page.getByRole('checkbox', { name: 'Listening', exact: true });
  await stop.evaluate(button => button.addEventListener('click', () => {
    // Capture at the actual Stop event so protocol latency cannot consume the
    // fall before its starting height is measured.
    const { current, layout } = document.querySelector('#dancinglights').physics;
    window.physicsAtStop = { tick: current[2], balls: Array.from({ length: layout[21] }, (_, i) => {
      const offset = 3 + i * layout[8];
      return { y: current[offset + 1], radius: current[offset + 7] };
    }) };
  }, { once: true }));
  // Stop in the same browser turn that observes an elevated ball. A separate
  // protocol round trip/tap can arrive after that transient has already ended.
  await page.waitForFunction(button => {
    const { current, layout } = document.querySelector('#dancinglights').physics;
    const elevated = Array.from({ length: layout[21] }, (_, i) => 3 + i * layout[8])
      .some(offset => current[offset + 1] > current[offset + 7] + .1);
    if (!elevated) return false;
    button.click();
    return true;
  }, await stop.elementHandle(), { timeout: 5000 });
  const stopped = await page.evaluate(() => window.physicsAtStop);
  expect(stopped.balls.some(ball => ball.y > ball.radius + .1)).toBe(true);
  await expect.poll(async () => (await physicsState(page)).tick).toBeGreaterThan(stopped.tick + 10);
  await expect.poll(async () => (await physicsState(page)).balls.some((ball, i) => ball.position[1] < stopped.balls[i].y - .005)).toBe(true);
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toBeEmpty();
  expect(errors).toEqual([]);
});

async function drag(page, dx, dy) {
  // Playwright's WebKit transport supports touch taps, but no touch drags.
  // Exercise native pointer capture here with a mouse; touch-screen covers
  // trusted touch streams, cancellation, and multi-touch in Chromium.
  const box = await page.getByRole('meter').nth(12).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + 150;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
}

test('a tapped band shows its color and frequency above the graph for three seconds', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8101');
  await expect(page.getByRole('meter')).toHaveCount(24);
  // Use native timers: Playwright Clock returns IDs above the Web IDL i32
  // range, so a WASM clearTimeout cannot cancel those synthetic IDs.
  const bands = page.getByRole('meter');
  const readout = page.getByRole('tooltip');
  const firstHit = await meterPoint(page, bands.first());
  await page.touchscreen.tap(firstHit.x, firstHit.y);
  await expect(readout).toBeVisible();
  await expect(readout).toHaveText(firstHit.label);
  const swatch = readout.locator('.frequency-swatch');
  const renderedColor = (await swatch.evaluate(node => getComputedStyle(node).backgroundColor)).match(/[\d.]+/g).map(Number);
  firstHit.color.match(/[\d.]+/g).map(Number).forEach((channel, i) => expect(renderedColor[i]).toBeCloseTo(channel, 5));
  const box = await readout.boundingBox();
  const graph = await page.locator('#dancinglights').boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(graph.y);
  await page.waitForTimeout(1500);
  await expect(readout).toBeVisible();
  const lastHit = await meterPoint(page, bands.last());
  await page.touchscreen.tap(lastHit.x, lastHit.y);
  const selectedAt = await page.evaluate(() => performance.now());
  await expect(readout).toHaveText(lastHit.label);
  await page.waitForTimeout(2000);
  // The first tap's deadline has passed; it must not hide the second label.
  await expect(readout).toBeVisible();
  await expect(readout).toBeHidden({ timeout: 1500 });
  const elapsed = await page.evaluate(() => performance.now()) - selectedAt;
  expect(elapsed).toBeGreaterThanOrEqual(2900);
  expect(elapsed).toBeLessThan(3600);
  // Sticky touch hover or focus must not bring the expired readout back.
  await page.waitForTimeout(300);
  await expect(readout).toBeHidden();
  await page.touchscreen.tap(lastHit.x, lastHit.y);
  await expect(readout).toBeVisible();
  await page.getByRole('link', { name: 'About', exact: true }).tap();
  await page.waitForTimeout(3100);
  expect(errors).toEqual([]);
});

test('iPhone fullscreen shows only the live lights without the native API', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { value: false });
    Element.prototype.requestFullscreen = undefined;
    window.inputRequests = 0;
    MediaDevices.prototype.getUserMedia = async () => {
      window.inputRequests++;
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start(); await context.resume();
      window.sourceContext = context; window.sourceStream = destination.stream;
      return destination.stream;
    };
  });
  await page.goto('http://127.0.0.1:8101');
  const expand = page.getByRole('button', { name: 'Fullscreen', exact: true });
  await expect(expand).toBeEnabled();
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect.poll(() => page.getByRole('meter').evaluateAll(nodes => nodes.some(node => Number(node.getAttribute('aria-valuenow')) > 0))).toBe(true);
  const initialScroll = await page.evaluate(() => scrollY);
  await expand.tap();
  const exit = page.getByRole('button', { name: 'Exit fullscreen', exact: true });
  await expect(exit).toBeVisible();
  await expect(page.locator('.site-header')).toBeHidden();
  await expect(page.locator('.calibration-controls')).toBeHidden();
  await expect(page.locator('.control-note')).toBeHidden();
  await expect(page.locator('.wake-status')).toBeHidden();
  await expect(page.locator('.frame-rate')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeHidden();
  await expect(page.locator('#dancinglights')).toBeInViewport({ ratio: 1 });
  for (const viewport of [{ width: 390, height: 664 }, { width: 844, height: 390 }, { width: 390, height: 664 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => (await page.locator('.audio-card').boundingBox()).height).toBe(viewport.height);
    const graph = await page.locator('#dancinglights').boundingBox();
    expect(graph.height).toBeGreaterThan(viewport.height * .9);
    await expect(exit).toBeInViewport({ ratio: 1 });
  }
  await page.screenshot({ path: 'test-results/iphone-lights-only.png' });
  expect(await page.evaluate(() => inputRequests)).toBe(1);
  expect(await page.evaluate(() => sourceStream.getTracks()[0].readyState)).toBe('live');
  // A tap, sideways drag, or short drag cannot exit.
  for (const gesture of [[0, 0], [100, 90], [0, 79]]) {
    await drag(page, ...gesture);
    await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
  }
  // Use the fixed Exit control in the top tap area. Safari can suppress
  // document-level gesture events after it changes the viewport.
  await exit.tap();
  await expect(page.locator('.site-header')).toBeVisible();
  await expect(page.locator('.calibration-controls')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeVisible();
  expect(await page.evaluate(() => scrollY)).toBe(initialScroll);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
  expect(await page.evaluate(() => sourceStream.getTracks()[0].readyState)).toBe('ended');
  await page.evaluate(() => sourceContext.close());
  expect(errors).toEqual([]);
});

test('fullscreen frequency labels expire and keyboard users can reveal the exit control', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
  await page.goto('http://127.0.0.1:8101');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).tap();
  await expect(page.locator('.fullscreen-hint')).toBeVisible();
  const hit = await meterPoint(page, page.getByRole('meter').nth(12));
  await page.touchscreen.tap(hit.x, hit.y);
  const readout = page.getByRole('tooltip');
  await expect(readout).toHaveText(hit.label);
  await expect(readout).toBeInViewport({ ratio: 1 });
  const box = await readout.boundingBox();
  expect(box.y).toBeLessThan(40);
  await expect(readout).toBeHidden({ timeout: 3500 });
  await expect(page.locator('.fullscreen-hint')).toBeHidden();
  // Focus the first bar with the keyboard, then move back to the exit control.
  await page.getByRole('meter').first().focus();
  await page.keyboard.press('Shift+Tab');
  const exit = page.getByRole('button', { name: 'Exit fullscreen', exact: true });
  await expect(exit).toBeFocused();
  await expect(exit).toHaveCSS('clip-path', 'none');
  await expect(exit).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.site-header')).toBeVisible();
});

test('a rejected native fullscreen request still expands the page and Escape exits', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { value: true });
    Element.prototype.requestFullscreen = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await page.goto('http://127.0.0.1:8101');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeHidden();
  await expect(page.locator('.screen-error')).toBeEmpty();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Fullscreen', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeInViewport();
  await expect(page.locator('.site-header')).toBeVisible();
});

test('browser back closes the expanded view and restores the page', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { value: false });
  });
  await page.goto('http://127.0.0.1:8101/about');
  await page.getByRole('link', { name: 'Home', exact: true }).tap();
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).tap();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
  await page.goBack();
  await expect(page.locator('.site-header')).toBeVisible();
  await expect(page.locator('[data-expanded]')).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe('hidden');
});

test('fullscreen transitions keep live audio and bounded simulation delay', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(document, 'fullscreenEnabled', { value: false }); });
  await page.setViewportSize({width:390,height:844});
  await page.goto('http://127.0.0.1:8101/advanced/');await physicsReady(page);
  await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.input-source').selectOption('generated');
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect.poll(()=>page.evaluate(()=>document.querySelector('#dancinglights').physics.report.acceptanceWorkload())).toBe(true);
  await page.waitForTimeout(2000);
  await page.evaluate(()=>{
    const v=document.querySelector('#dancinglights').physics;
    window.transitionIdentity={worker:v.worker,renderer:v.renderer,session:v.report.audioState.sessionId};
    window.transitionBefore={...v.metrics};window.transitionFrames=[];window.transitionRunning=true;
    let previous=performance.now();
    const record=now=>{transitionFrames.push({frame:now-previous,height:v.current[1],requested:v.input[32],debt:v.metrics.debt,age:v.metrics.snapshotAgeMs});previous=now;if(transitionRunning)requestAnimationFrame(record)};
    requestAnimationFrame(record);
  });
  await page.waitForTimeout(500);
  await page.getByRole('button',{name:'Fullscreen',exact:true}).tap();
  await page.waitForTimeout(1500);
  await page.setViewportSize({width:844,height:390});await page.waitForTimeout(1500);
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(1500);
  await page.getByRole('button',{name:'Exit fullscreen',exact:true}).tap();await page.waitForTimeout(1500);
  const data=await page.evaluate(()=>{
    transitionRunning=false;const v=document.querySelector('#dancinglights').physics;
    const original=v.renderer.setSize;let allocations=0;v.renderer.setSize=(...args)=>{allocations++;return original.apply(v.renderer,args)};
    v.measure();v.measure();v.renderer.setSize=original;
    return{same:v.worker===transitionIdentity.worker&&v.renderer===transitionIdentity.renderer&&v.report.audioState.sessionId===transitionIdentity.session,
      overloads:v.metrics.overloadTicks-transitionBefore.overloadTicks,discarded:v.metrics.discardedSimulationMs,allocations,frames:transitionFrames};
  });
  expect(data.same).toBe(true);expect(data.discarded).toBe(0);expect(data.allocations).toBe(0);
  expect(data.frames.some(f=>Math.abs(f.height-f.requested)>.01)).toBe(true);
  expect(data.frames.at(-1).height).toBeCloseTo(data.frames.at(-1).requested,5);
  expect(Math.max(...data.frames.map(f=>f.debt))).toBeLessThan(100);
  expect(Math.max(...data.frames.map(f=>f.age))).toBeLessThan(100);
  // Changing music can still reach the contact limit; isolated resize overloads
  // are covered by the native constant-input regression, not hidden here.
});

// Always retain worker execution, scheduling, collision work and resize evidence,
// including when an assertion above fails.
test.afterEach(async ({ page }, info) => {
  const timing = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights')?.physics;
    return { layout: v?.layout, timing: v?.timing, metrics: v?.metrics, transitions: window.transitionFrames };
  }).catch(error => ({ error: String(error) }));
  const path = info.outputPath('physics-timing.json');
  await writeFile(path, JSON.stringify(timing));
  await info.attach('physics-timing', { path, contentType: 'application/json' });
});
