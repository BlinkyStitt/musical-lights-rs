import { test, expect } from '@playwright/test';

const url = 'http://127.0.0.1:8101';

async function prepare(page, permission = 'granted') {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ permission }) => {
    // Control time from mount onward so idle gravity and listening use the
    // same deterministic clock. IDs remain valid wasm-bindgen i32 handles.
    const pending = new Map();
    let nextId = 1;
    window.balloonNow = performance.now();
    window.balloonAnimationCalls = 0;
    window.requestAnimationFrame = callback => {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = id => {
      pending.delete(id);
    };
    window.pendingBalloons = () => pending.size;
    window.advanceBalloons = async count => {
      for (let i = 0; i < count; i++) {
        window.balloonNow += 1000 / 60;
        const callbacks = [...pending.entries()];
        for (const [id, callback] of callbacks) {
          if (!pending.delete(id)) continue;
          window.balloonAnimationCalls++;
          callback(window.balloonNow);
        }
        // Let Leptos apply the DisplayFrame before observing DOM geometry.
        await Promise.resolve();
      }
    };
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    const tracked = new Map(['pointermove', 'pointerout', 'blur', 'deviceorientation', 'devicemotion'].map(type => [type, new Set()]));
    window.balloonListeners = () => Object.fromEntries([...tracked].map(([key, value]) => [key, value.size]));
    window.addEventListener = (type, listener, options) => {
      tracked.get(type)?.add(listener);
      return add(type, listener, options);
    };
    window.removeEventListener = (type, listener, options) => {
      tracked.get(type)?.delete(listener);
      return remove(type, listener, options);
    };
    window.motionPermissionCalls = [];
    window.resolveMotion = [];
    for (const name of ['DeviceOrientationEvent', 'DeviceMotionEvent']) {
      if (permission === 'unsupported') {
        Object.defineProperty(window, name, { value: undefined, configurable: true });
      } else {
        Object.defineProperty(window[name], 'requestPermission', { configurable: true, value: () => {
          window.motionPermissionCalls.push({ name, active: navigator.userActivation.isActive });
          if (permission === 'throw') throw new DOMException('Sensors denied', 'NotAllowedError');
          if (permission === 'reject') return Promise.reject(new DOMException('Sensors denied', 'NotAllowedError'));
          if (permission === 'pending') return new Promise(resolve => window.resolveMotion.push(resolve));
          return Promise.resolve(permission);
        } });
      }
    }
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(...args) { super(...args); window.balloonContext = this; }
      get currentTime() { return window.balloonClock ? window.balloonClock() : super.currentTime; }
    };
    const NativeNode = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(...args) { super(...args); window.balloonNode = this; }
    };
    MediaDevices.prototype.getUserMedia = async () => window.balloonContext.createMediaStreamDestination().stream;
    window.readBalloons = () => [...document.querySelectorAll('.balloon')].map(node => ({
      x: Number.parseFloat(node.style.getPropertyValue('--balloon-x')) / 100,
      y: 1 - Number.parseFloat(node.style.getPropertyValue('--balloon-y')) / 100,
      color: node.style.getPropertyValue('--balloon-color'),
    }));
    window.readBalloonShapes = () => [...document.querySelectorAll('.balloon')].map(node => {
      const box = node.getBoundingClientRect();
      const layer = node.parentElement.getBoundingClientRect();
      const x = layer.x + Number.parseFloat(node.style.getPropertyValue('--balloon-x')) / 100 * layer.width;
      const y = layer.y + Number.parseFloat(node.style.getPropertyValue('--balloon-y')) / 100 * layer.height;
      const radius = Math.min(box.width, box.height) / 2;
      return {
        x: box.x, y: box.y, width: box.width, height: box.height, radius,
        centerError: Math.hypot(box.x + box.width / 2 - x, box.y + box.height / 2 - y),
        start: { x: box.x + radius, y: box.y + radius },
        end: { x: box.right - radius, y: box.bottom - radius },
      };
    });
    window.capsuleOverlap = (a, b) => {
      // Independent endpoint-to-segment distances use the actual CSS capsule.
      // Two axis-aligned center segments cross exactly when their bounds overlap.
      const crosses = Math.max(a.start.x, b.start.x) <= Math.min(a.end.x, b.end.x)
        && Math.max(a.start.y, b.start.y) <= Math.min(a.end.y, b.end.y);
      const pointDistance = (p, segment) => {
        const dx = segment.end.x - segment.start.x, dy = segment.end.y - segment.start.y;
        const length = dx * dx + dy * dy;
        const t = length ? Math.max(0, Math.min(1, ((p.x - segment.start.x) * dx + (p.y - segment.start.y) * dy) / length)) : 0;
        return Math.hypot(p.x - segment.start.x - t * dx, p.y - segment.start.y - t * dy);
      };
      const distance = crosses ? 0 : Math.min(pointDistance(a.start, b), pointDistance(a.end, b), pointDistance(b.start, a), pointDistance(b.end, a));
      return a.radius + b.radius - distance;
    };
    window.sendBalloonBars = (levels) => {
      const at = window.balloonClock();
      const state = new Float64Array(146);
      state[0] = at;
      state[1] = Number(matchMedia('(prefers-reduced-motion: reduce)').matches);
      for (let band = 0; band < 24; band++) {
        const level = levels[band] ?? 0;
        state.set([level, 0, at + 100, 0, level, level], 2 + band * 6);
      }
      window.balloonNode.port.dispatchEvent(new MessageEvent('message', {
        data: { type: 'frame', state, sones: 0, clipped: 0, calibration: 0 },
      }));
    };
  }, { permission });
  await page.goto(url);
  await expect(page.locator('.balloon')).toHaveCount(24);
  await page.requestGC();
  return errors;
}

async function startFrozen(page) {
  await page.getByRole('button', { name: 'Start listening' }).click();
  await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
  await page.evaluate(async () => {
    await window.balloonContext.suspend();
    await new Promise(resolve => setTimeout(resolve, 50));
    const origin = window.balloonContext.currentTime;
    const started = window.balloonNow;
    window.balloonClock = () => origin + (window.balloonNow - started) / 1000;
    await window.advanceBalloons(2);
  });
}

async function repel(page, index = 4, frames = 45) {
  const before = await page.evaluate(index => window.readBalloons()[index], index);
  const path = [before];
  // Keep a real mouse near the falling sphere instead of expecting it to hover.
  for (let advanced = 0; advanced < frames; advanced += 12) {
    const box = await page.locator('.balloon').nth(index).boundingBox();
    await page.mouse.move(box.x + box.width * .3, box.y + box.height * .5);
    await page.evaluate(count => window.advanceBalloons(count), Math.min(12, frames - advanced));
    path.push(await page.evaluate(index => window.readBalloons()[index], index));
  }
  return { before, after: path.at(-1), path };
}

async function compareMouse(page, index, frames) {
  const baseline = await page.evaluate(async ({ index, frames }) => {
    const path = [window.readBalloons()[index]];
    for (let advanced = 0; advanced < frames; advanced += 12) {
      await window.advanceBalloons(Math.min(12, frames - advanced));
      path.push(window.readBalloons()[index]);
    }
    return path;
  }, { index, frames });
  await page.goto(url);
  await startFrozen(page);
  return { ...await repel(page, index, frames), baseline };
}

for (const width of [375, 1440]) {
  test(`24 round spheres start with colors from x position at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors = await prepare(page);
    await expect(page.locator('#dancinglights > div')).toHaveCount(24);
    await expect(page.locator('.balloon-layer')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.balloon-layer')).toHaveCSS('pointer-events', 'none');
    const dimensions = await page.evaluate(() => {
      const bar = document.querySelector('.bark-group').getBoundingClientRect();
      return [...document.querySelectorAll('.balloon')].map(node => node.getBoundingClientRect().width / bar.width);
    });
    expect(Math.min(...dimensions)).toBeCloseTo(.55, 1);
    expect(Math.max(...dimensions)).toBeCloseTo(4, 1);
    await expect(page.locator('.balloon-string')).toHaveCount(0);
    const bodies = await page.locator('.balloon').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect();
      const band = Math.floor(Number.parseFloat(node.style.getPropertyValue('--balloon-x')) / 100 * 24);
      return {
        width: box.width, height: box.height,
        radius: getComputedStyle(node).borderRadius,
        knot: getComputedStyle(node, '::after').content,
        color: node.style.getPropertyValue('--balloon-color').trim(),
        expected: document.querySelectorAll('.bark-group')[band].style.getPropertyValue('--band-color').trim(),
      };
    }));
    for (const body of bodies) {
      expect(Math.abs(body.width - body.height)).toBeLessThan(.1);
      expect(Number.parseFloat(body.radius)).toBeGreaterThanOrEqual(body.width / 2);
      expect(body.knot).toBe('none');
      expect(body.color).toBe(body.expected);
    }
    const initial = await page.evaluate(() => window.readBalloons());
    await page.mouse.move(200, 200);
    await page.evaluate(() => window.advanceBalloons(12));
    const falling = await page.evaluate(() => window.readBalloons());
    expect(falling[0].y).toBeLessThan(initial[0].y - .02);
    expect(falling.map(body => body.color)).toEqual(initial.map(body => body.color));
    expect(await page.evaluate(() => window.motionPermissionCalls)).toEqual([]);
    expect(await page.evaluate(() => window.pendingBalloons())).toBe(1);
    expect(errors).toEqual([]);
  });
}

test('flat phone gravity accelerates spheres down the page and the floor bounces them', async ({ page }) => {
  const errors = await prepare(page);
  await startFrozen(page);
  const motion = await page.evaluate(async () => {
    window.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta: 0, gamma: 0 }));
    window.dispatchEvent(Object.assign(new Event('devicemotion'), {
      acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 },
    }));
    const positions = [window.readBalloons()[0]];
    await window.advanceBalloons(8); positions.push(window.readBalloons()[0]);
    await window.advanceBalloons(8); positions.push(window.readBalloons()[0]);
    const trajectory = [];
    for (let frame = 0; frame < 90; frame++) {
      await window.advanceBalloons(1); trajectory.push(window.readBalloons()[0]);
    }
    return { positions, trajectory };
  });
  const [start, middle, end] = motion.positions;
  expect(start.y - end.y).toBeGreaterThan(.08);
  expect(middle.y - end.y).toBeGreaterThan(start.y - middle.y);
  expect(motion.trajectory.some((p, i, path) => i > 0 && p.y > path[i - 1].y + .002)).toBe(true);
  expect(motion.trajectory.every(p => p.color === start.color)).toBe(true);
  expect(errors).toEqual([]);
});

for (const width of [375, 1440]) {
  test(`spheres collide without overlap or color transfer with the microphone off at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors = await prepare(page);
    const result = await page.evaluate(async () => {
      const initial = window.readBalloons();
      let maximumOverlap = 0;
      let maximumCenterError = 0;
      let worst;
      let touched = false;
      let shifted = false;
      let retainedColors = true;
      for (let frame = 0; frame < 240; frame++) {
        await window.advanceBalloons(1);
        const bodies = window.readBalloons();
        const shapes = window.readBalloonShapes();
        maximumCenterError = Math.max(maximumCenterError, ...shapes.map(shape => shape.centerError));
        for (const [i, a] of bodies.entries()) {
          retainedColors &&= a.color === initial[i].color;
          shifted ||= Math.abs(a.x - initial[i].x) > .005;
          for (let j = i + 1; j < bodies.length; j++) {
            const overlap = window.capsuleOverlap(shapes[i], shapes[j]);
            if (overlap > maximumOverlap) {
              maximumOverlap = overlap;
              worst = { frame, i, j, overlap };
            }
            touched ||= overlap > -.5;
          }
        }
      }
      return { maximumOverlap, maximumCenterError, touched, shifted, retainedColors, worst };
    });
    // Gravity has no horizontal force. Sideways motion here comes from contact.
    expect(result).toMatchObject({ touched: true, shifted: true, retainedColors: true });
    expect(result.maximumOverlap, JSON.stringify(result.worst)).toBeLessThan(.5);
    expect(result.maximumCenterError).toBeLessThan(.05);
    expect(await page.evaluate(() => window.motionPermissionCalls)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Start listening' })).toBeEnabled();
    const { before, after } = await repel(page, 4, 30);
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.color).toBe(before.color);
    expect(errors).toEqual([]);
  });
}

test('mouse repulsion moves a balloon across other colors without recoloring it', async ({ page }) => {
  const errors = await prepare(page);
  await startFrozen(page);
  // Compare the same crowd and gravity with and without mouse input. Neighbor
  // contacts can reverse a body's motion after the mouse has pushed it.
  const { before, after, path, baseline } = await compareMouse(page, 4, 240);
  expect(Math.max(...path.map((body, i) => body.x - baseline[i].x))).toBeGreaterThan(.01);
  expect(Math.max(...path.map(body => body.x)) - Math.min(...path.map(body => body.x))).toBeGreaterThan(1 / 24);
  expect(path.every(body => body.color === before.color)).toBe(true);
  expect(after.color).toBe(before.color);
  const calls = await page.evaluate(() => window.motionPermissionCalls);
  expect(calls.map(call => call.name)).toEqual(['DeviceOrientationEvent', 'DeviceMotionEvent']);
  expect(calls.every(call => call.active)).toBe(true);
  const frozen = await page.evaluate(() => window.readBalloons());
  await page.evaluate(async () => {
    window.dispatchEvent(new PointerEvent('pointerout'));
    // Touch motion must not feed the mouse force.
    window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', clientX: 300, clientY: 250 }));
    await window.advanceBalloons(120);
  });
  expect((await page.evaluate(() => window.readBalloons())).map(b => b.color)).toEqual(frozen.map(b => b.color));
  expect(errors).toEqual([]);
});

test('synthetic tilt and shake events move balloons and reduced motion damps input', async ({ page }) => {
  const errors = await prepare(page);
  const tiltDisplacements = [];
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion });
    const outcomes = {};
    for (const input of ['none', 'tilt', 'shake']) {
      await page.goto(url);
      await startFrozen(page);
      outcomes[input] = await page.evaluate(async input => {
        if (input === 'tilt') window.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta: 0, gamma: 45 }));
        if (input === 'shake') window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration: { x: 20, y: 0, z: 0 } }));
        await window.advanceBalloons(30);
        return window.readBalloons();
      }, input);
    }
    // Compare the same initial world and duration, with gravity in every run.
    const tilt = outcomes.tilt[4].x - outcomes.none[4].x;
    expect(tilt).toBeGreaterThan(0);
    tiltDisplacements.push(tilt);
    if (reducedMotion === 'reduce') {
      for (const [index, body] of outcomes.shake.entries()) {
        expect(body.x).toBeCloseTo(outcomes.none[index].x, 12);
        expect(body.y).toBeCloseTo(outcomes.none[index].y, 12);
      }
    } else {
      expect(tilt).toBeGreaterThan(.001);
      expect(outcomes.shake[4].x).toBeLessThan(outcomes.none[4].x - .04);
    }
    for (const input of ['tilt', 'shake']) {
      expect(outcomes[input].map(body => body.color)).toEqual(outcomes.none.map(body => body.color));
    }
  }
  expect(tiltDisplacements[0]).toBeGreaterThan(tiltDisplacements[1] * 3);
  expect(errors).toEqual([]);
});

test('reduced motion damps pointer displacement while gravity continues', async ({ page }) => {
  const distances = [];
  const errors = await prepare(page);
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion });
    await page.goto(url);
    await startFrozen(page);
    const { before, after } = await repel(page, 4, 30);
    distances.push(after.x - before.x);
    await page.evaluate(async () => {
      window.dispatchEvent(new PointerEvent('pointerout'));
      await window.advanceBalloons(120);
    });
    if (reducedMotion === 'reduce') {
      const falling = await page.evaluate(() => window.readBalloons());
      // Contact can move bodies sideways as gravity forms a pile. Do not
      // mistake that motion for residual pointer force or require it to stop.
      expect(falling[4].y).toBeLessThan(after.y);
      expect(falling[4].color).toBe(after.color);
    }
  }
  expect(distances[1]).toBeGreaterThan(0);
  expect(distances[0]).toBeGreaterThan(distances[1] * 3);
  expect(errors).toEqual([]);
});

for (const permission of ['denied', 'reject', 'throw', 'unsupported']) {
  test(`${permission} sensors leave working mouse behavior without page errors`, async ({ page }) => {
    const errors = await prepare(page, permission);
    await startFrozen(page);
    const { after, baseline } = await compareMouse(page, 4, 60);
    expect(after.x).toBeGreaterThan(baseline.at(-1).x + .01);
    const listeners = await page.evaluate(() => window.balloonListeners());
    expect(listeners.deviceorientation).toBe(0);
    expect(listeners.devicemotion).toBe(0);
    await expect(page.getByRole('alert')).toBeEmpty();
    expect(errors).toEqual([]);
  });
}

test('rising bars push overlapping balloons and only new impacts blend their colors', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await prepare(page);
  await startFrozen(page);
  const before = await page.evaluate(() => window.readBalloons());
  // A distant high bar cannot recolor a balloon it does not touch.
  await page.evaluate(async () => {
    const levels = Array(24).fill(0); levels[22] = .8;
    window.sendBalloonBars(levels);
    await window.advanceBalloons(3);
  });
  const near = (await page.evaluate(() => window.readBalloons()))[6];
  expect(near.color).toBe(before[6].color);
  const hit = await page.evaluate(async () => {
    window.sendBalloonBars(Array(24).fill(1));
    await window.advanceBalloons(3);
    return window.readBalloons();
  });
  expect(hit[6].y).toBeGreaterThan(before[6].y + .1);
  expect(hit[6].color).not.toBe(before[6].color);
  await page.evaluate(() => window.advanceBalloons(120));
  expect((await page.evaluate(() => window.readBalloons()))[6].color).toBe(hit[6].color);
  const geometry = await page.evaluate(() => {
    const layer = document.querySelector('.balloon-layer').getBoundingClientRect();
    const bars = [...document.querySelectorAll('.meter-fill')].map(node => ({
      box: node.getBoundingClientRect(),
      corner: Number.parseFloat(getComputedStyle(node).borderTopLeftRadius),
    }));
    return [...document.querySelectorAll('.balloon')].map(node => {
      const body = node.getBoundingClientRect();
      const x = body.x + body.width / 2, y = body.y + body.height / 2;
      const radius = Math.min(body.width, body.height) / 2;
      const segmentX = body.width / 2 - radius, segmentY = body.height / 2 - radius;
      // Rounded capsules can flatten over caps or squeeze into a real gap.
      // Measure solid surfaces, including the body's changing end radius.
      const overlaps = bars.map(({ box, corner }) => {
        const dx = Math.max(box.left + corner - x - segmentX, 0, x - segmentX - (box.right - corner));
        const dy = Math.max(box.top + corner - y - segmentY, 0);
        return radius + corner - Math.hypot(dx, dy);
      });
      return { top: body.top, layerTop: layer.top, maximumBarOverlap: Math.max(...overlaps) };
    });
  });
  for (const body of geometry) {
    expect(body.top).toBeGreaterThanOrEqual(body.layerTop - 1);
    expect(body.maximumBarOverlap, JSON.stringify(body)).toBeLessThan(1);
  }
  await page.screenshot({ path: testInfo.outputPath('balloon-impacts.png'), fullPage: true });
  expect(errors).toEqual([]);
});

for (const width of [375, 1440]) {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    test(`crowded balls compress and recover with five percent headroom at ${width}px, ${reducedMotion}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion, colorScheme: 'dark' });
      const errors = await prepare(page);
      const resting = await page.evaluate(() => window.readBalloonShapes());
      await startFrozen(page);
      const crowded = await page.evaluate(async () => {
        window.sendBalloonBars(Array(24).fill(1));
        await window.advanceBalloons(8);
        const layer = document.querySelector('.balloon-layer').getBoundingClientRect();
        const graph = document.querySelector('#dancinglights').getBoundingClientRect();
        const track = document.querySelector('.meter-track').getBoundingClientRect();
        return { shapes: window.readBalloonShapes(), bodies: window.readBalloons(),
          bounds: { x: layer.x, y: layer.y, right: layer.right, bottom: layer.bottom },
          headroom: (track.top - graph.top) / graph.height };
      });
      expect(crowded.headroom).toBeCloseTo(.05, 3);
      expect(crowded.shapes.filter((body, index) => body.height < resting[index].height * .75).length).toBeGreaterThan(3);
      for (const body of crowded.shapes) {
        expect(body.width).toBeGreaterThan(0);
        expect(body.height).toBeGreaterThan(0);
        expect(body.x).toBeGreaterThanOrEqual(crowded.bounds.x - .5);
        expect(body.y).toBeGreaterThanOrEqual(crowded.bounds.y - .5);
        expect(body.x + body.width).toBeLessThanOrEqual(crowded.bounds.right + .5);
        expect(body.y + body.height).toBeLessThanOrEqual(crowded.bounds.bottom + .5);
      }
      await page.screenshot({ path: testInfo.outputPath('compressed-balls.png'), fullPage: true });
      const released = await page.evaluate(async () => {
        window.sendBalloonBars(Array(24).fill(0));
        await window.advanceBalloons(120);
        return { shapes: window.readBalloonShapes(), bodies: window.readBalloons() };
      });
      // The largest body must visibly recover when the pressure is released.
      expect(released.shapes[6].height).toBeGreaterThan(crowded.shapes[6].height * 1.5);
      expect(released.bodies.map(body => body.color)).toEqual(crowded.bodies.map(body => body.color));
      await page.screenshot({ path: testInfo.outputPath('recovered-balls.png'), fullPage: true });
      expect(errors).toEqual([]);
    });
  }
}

test('fullscreen reuses spheres, Stop keeps gravity, and route cleanup releases resources', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await prepare(page);
  const idleListeners = await page.evaluate(() => window.balloonListeners());
  await startFrozen(page);
  const activeListeners = await page.evaluate(() => window.balloonListeners());
  expect(activeListeners.devicemotion).toBe(1);
  expect(activeListeners.deviceorientation).toBe(1);
  expect(activeListeners.pointermove).toBe(idleListeners.pointermove);
  await page.evaluate(() => { window.originalBalloons = [...document.querySelectorAll('.balloon')]; });
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
    await page.evaluate(() => window.advanceBalloons(3));
    await expect(page.locator('#dancinglights > div')).toHaveCount(24);
    const { before, after } = await repel(page);
    expect(after.x).toBeGreaterThan(before.x);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.advanceBalloons(3));
    expect(await page.evaluate(() => window.balloonListeners())).toEqual(activeListeners);
  }
  expect(await page.evaluate(() => window.originalBalloons.every((node, i) => node === document.querySelectorAll('.balloon')[i]))).toBe(true);
  // Lift a large body before Stop so the falling check starts above the floor.
  await page.evaluate(async () => { window.sendBalloonBars(Array(24).fill(.5)); await window.advanceBalloons(3); });
  await page.getByRole('button', { name: 'Stop listening' }).click();
  expect(await page.evaluate(() => window.pendingBalloons())).toBe(1);
  expect(await page.evaluate(() => window.balloonListeners())).toEqual(idleListeners);
  const stopped = await page.evaluate(() => window.readBalloons());
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration: { x: 20, y: 0, z: 0 } }));
    await window.advanceBalloons(10);
  });
  const falling = await page.evaluate(() => window.readBalloons());
  expect(falling[6].y).toBeLessThan(stopped[6].y);
  expect(falling.map(body => body.color)).toEqual(stopped.map(body => body.color));
  await page.getByRole('button', { name: 'Start listening' }).click();
  await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
  expect(await page.evaluate(() => window.balloonListeners())).toEqual(activeListeners);
  await page.getByRole('link', { name: 'About', exact: true }).click();
  expect(await page.evaluate(() => window.pendingBalloons())).toBe(0);
  expect(await page.evaluate(() => window.balloonListeners().devicemotion)).toBe(0);
  expect(await page.evaluate(() => window.balloonListeners().pointermove)).toBe(0);
  expect(errors).toEqual([]);
});

for (const end of ['stop', 'route', 'microphone denial', 'audio failure']) {
  test(`late motion permission cannot restore sensors after ${end}`, async ({ page }) => {
    const errors = await prepare(page, 'pending');
    const idleListeners = await page.evaluate(() => window.balloonListeners());
    if (end === 'microphone denial') {
      await page.evaluate(() => { MediaDevices.prototype.getUserMedia = async () => { throw new DOMException('Microphone denied', 'NotAllowedError'); }; });
    }
    await page.getByRole('button', { name: 'Start listening' }).click();
    if (end === 'microphone denial') {
      await expect(page.getByRole('alert')).toContainText('Microphone denied');
    } else {
      await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
      if (end === 'route') await page.getByRole('link', { name: 'About', exact: true }).click();
      if (end === 'stop') await page.getByRole('button', { name: 'Stop listening' }).click();
      if (end === 'audio failure') {
        await page.evaluate(() => window.balloonNode.dispatchEvent(new Event('processorerror')));
        await expect(page.getByRole('alert')).toContainText('Audio processor failed');
      }
    }
    await expect.poll(() => page.evaluate(() => window.pendingBalloons())).toBe(end === 'route' ? 0 : 1);
    const calls = await page.evaluate(() => window.balloonAnimationCalls);
    const before = await page.evaluate(() => window.readBalloons());
    await page.evaluate(async () => {
      for (const resolve of window.resolveMotion) resolve('granted');
      await new Promise(resolve => setTimeout(resolve, 100));
      window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration: { x: 20, y: 0, z: 0 } }));
      await window.advanceBalloons(12);
    });
    if (end === 'route') {
      expect(await page.evaluate(() => window.balloonAnimationCalls)).toBe(calls);
    } else {
      expect(await page.evaluate(() => window.balloonAnimationCalls)).toBe(calls + 12);
      const after = await page.evaluate(() => window.readBalloons());
      expect(after[0].y).toBeLessThan(before[0].y - .02);
      expect(after.map(body => body.color)).toEqual(before.map(body => body.color));
    }
    const listeners = await page.evaluate(() => window.balloonListeners());
    expect(listeners.devicemotion).toBe(0);
    expect(listeners.deviceorientation).toBe(0);
    expect(listeners.pointermove).toBe(end === 'route' ? 0 : idleListeners.pointermove);
    expect(errors).toEqual([]);
  });
}


test('the 24 visible bar heights also drive sphere collisions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await prepare(page);
  await startFrozen(page);
  // Track the largest body; a small compressed body can pass between bars.
  const before = (await page.evaluate(() => window.readBalloons()))[6];
  await page.evaluate(async () => {
    window.sendBalloonBars(Array(24).fill(0));
    await window.advanceBalloons(6);
  });
  const silent = (await page.evaluate(() => window.readBalloons()))[6];
  await expect(page.getByRole('meter').first()).toHaveAttribute('aria-valuenow', '0');
  expect(silent.y).toBeLessThan(before.y);
  expect(silent.color).toBe(before.color);
  await page.evaluate(async () => {
    window.sendBalloonBars(Array(24).fill(1));
    await window.advanceBalloons(6);
  });
  const aggregateHit = (await page.evaluate(() => window.readBalloons()))[6];
  await expect(page.getByRole('meter').first()).toHaveAttribute('aria-valuenow', '100');
  expect(aggregateHit.y).toBeGreaterThan(before.y + .1);
  expect(aggregateHit.color).not.toBe(before.color);
  expect(errors).toEqual([]);
});
