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
    navigator.mediaDevices.getUserMedia = async () => window.balloonContext.createMediaStreamDestination().stream;
    window.readBalloons = () => [...document.querySelectorAll('.balloon')].map(node => ({
      x: Number.parseFloat(node.style.left) / 100,
      y: 1 - Number.parseFloat(node.style.top) / 100,
      color: node.style.getPropertyValue('--balloon-color'),
    }));
    window.sendBalloonBars = levels => {
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
  await expect(page.locator('.balloon')).toHaveCount(12);
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
  // Keep a real mouse near the falling sphere instead of expecting it to hover.
  for (let advanced = 0; advanced < frames; advanced += 12) {
    const box = await page.locator('.balloon').nth(index).boundingBox();
    await page.mouse.move(box.x + box.width * .3, box.y + box.height * .5);
    await page.evaluate(count => window.advanceBalloons(count), Math.min(12, frames - advanced));
  }
  const after = await page.evaluate(index => window.readBalloons()[index], index);
  return { before, after };
}

for (const width of [375, 1440]) {
  test(`12 round spheres start with colors from x position at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors = await prepare(page);
    await expect(page.locator('#dancinglights > div')).toHaveCount(24);
    await expect(page.locator('.balloon-layer')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.balloon-layer')).toHaveCSS('pointer-events', 'none');
    const dimensions = await page.evaluate(() => {
      const bar = document.querySelector('.meter').getBoundingClientRect();
      return [...document.querySelectorAll('.balloon')].map(node => node.getBoundingClientRect().width / bar.width);
    });
    expect(Math.min(...dimensions)).toBeCloseTo(.55, 1);
    expect(Math.max(...dimensions)).toBeCloseTo(4, 1);
    await expect(page.locator('.balloon-string')).toHaveCount(0);
    const bodies = await page.locator('.balloon').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect();
      const band = Math.floor(Number.parseFloat(node.style.left) / 100 * 24);
      return {
        width: box.width, height: box.height,
        radius: getComputedStyle(node).borderRadius,
        knot: getComputedStyle(node, '::after').content,
        color: node.style.getPropertyValue('--balloon-color').trim(),
        expected: document.querySelectorAll('.meter')[band].style.getPropertyValue('--band-color').trim(),
      };
    }));
    for (const body of bodies) {
      expect(Math.abs(body.width - body.height)).toBeLessThan(.1);
      expect(body.radius).toBe('50%');
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
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { beta: 0, gamma: 0 }));
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
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
      const layer = document.querySelector('.balloon-layer').getBoundingClientRect();
      const radii = [...document.querySelectorAll('.balloon')].map(node => node.getBoundingClientRect().width / 2);
      let maximumOverlap = 0;
      let touched = false;
      let shifted = false;
      let retainedColors = true;
      for (let frame = 0; frame < 240; frame++) {
        await window.advanceBalloons(1);
        const bodies = window.readBalloons();
        for (const [i, a] of bodies.entries()) {
          retainedColors &&= a.color === initial[i].color;
          shifted ||= Math.abs(a.x - initial[i].x) > .005;
          for (let j = i + 1; j < bodies.length; j++) {
            const b = bodies[j];
            const distance = Math.hypot((a.x - b.x) * layer.width, (a.y - b.y) * layer.height);
            const overlap = radii[i] + radii[j] - distance;
            maximumOverlap = Math.max(maximumOverlap, overlap);
            touched ||= overlap > -.5;
          }
        }
      }
      return { maximumOverlap, touched, shifted, retainedColors };
    });
    // Gravity has no horizontal force. Sideways motion here comes from contact.
    expect(result).toMatchObject({ touched: true, shifted: true, retainedColors: true });
    expect(result.maximumOverlap).toBeLessThan(.5);
    expect(await page.evaluate(() => window.motionPermissionCalls)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Start listening' })).toBeEnabled();
    const { before, after } = await repel(page, 4, 30);
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.color).toBe(before.color);
    expect(errors).toEqual([]);
  });
}

test('mouse repulsion moves a balloon across other colors without recoloring it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await prepare(page);
  await startFrozen(page);
  const { before, after } = await repel(page, 4, 240);
  expect(after.x).toBeGreaterThan(before.x + 1 / 24);
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
        if (input === 'tilt') window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { beta: 0, gamma: 45 }));
        if (input === 'shake') window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 20, y: 0, z: 0 } }));
        await window.advanceBalloons(30);
        return window.readBalloons();
      }, input);
    }
    // Compare the same initial world and duration, with gravity in every run.
    const tilt = outcomes.tilt[4].x - outcomes.none[4].x;
    expect(tilt).toBeGreaterThan(0);
    tiltDisplacements.push(tilt);
    if (reducedMotion === 'reduce') {
      expect(outcomes.shake).toEqual(outcomes.none);
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

test('reduced motion reduces pointer displacement and stops residual movement', async ({ page }) => {
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
      const before = await page.evaluate(() => window.readBalloons());
      await page.evaluate(() => window.advanceBalloons(60));
      const after = await page.evaluate(() => window.readBalloons());
      for (let i = 0; i < 12; i++) expect(after[i].x).toBeCloseTo(before[i].x, 6);
    }
  }
  expect(distances[1]).toBeGreaterThan(0);
  expect(distances[0]).toBeGreaterThan(distances[1] * 3);
  expect(errors).toEqual([]);
});

for (const permission of ['denied', 'reject', 'throw', 'unsupported']) {
  test(`${permission} sensors leave working mouse behavior without page errors`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = await prepare(page, permission);
    await startFrozen(page);
    const { before, after } = await repel(page, 4, 60);
    expect(after.x).toBeGreaterThan(before.x + .01);
    const listeners = await page.evaluate(() => window.balloonListeners());
    expect(listeners.deviceorientation).toBe(0);
    expect(listeners.devicemotion).toBe(0);
    await expect(page.getByRole('alert')).toBeEmpty();
    expect(errors).toEqual([]);
  });
}

test('rising bars push overlapping balloons and only new impacts blend their colors', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await prepare(page);
  await startFrozen(page);
  const before = await page.evaluate(() => window.readBalloons());
  // A neighboring high bar cannot recolor a narrow balloon it does not touch.
  await page.evaluate(async () => {
    const levels = Array(24).fill(0); levels[22] = .8;
    window.sendBalloonBars(levels);
    await window.advanceBalloons(3);
  });
  const near = (await page.evaluate(() => window.readBalloons()))[0];
  expect(near.x).toBe(before[0].x);
  expect(near.color).toBe(before[0].color);
  expect(near.y).toBeLessThan(before[0].y);
  const hit = await page.evaluate(async () => {
    window.sendBalloonBars(Array(24).fill(1));
    await window.advanceBalloons(3);
    return window.readBalloons();
  });
  expect(hit[0].y).toBeGreaterThan(before[0].y + .1);
  expect(hit[0].color).not.toBe(before[0].color);
  await page.evaluate(() => window.advanceBalloons(120));
  expect((await page.evaluate(() => window.readBalloons()))[0].color).toBe(hit[0].color);
  const geometry = await page.evaluate(() => {
    const layer = document.querySelector('.balloon-layer').getBoundingClientRect();
    const barTop = document.querySelector('.meter-fill').getBoundingClientRect().top;
    return [...document.querySelectorAll('.balloon')].map(node => {
      const body = node.getBoundingClientRect();
      return { top: body.top, bottom: body.bottom, layerTop: layer.top, barTop };
    });
  });
  for (const body of geometry) {
    expect(body.top).toBeGreaterThanOrEqual(body.layerTop - 1);
    expect(body.bottom).toBeLessThanOrEqual(body.barTop + 1);
  }
  await page.screenshot({ path: 'test-results/balloon-impacts.png', fullPage: true });
  expect(errors).toEqual([]);
});

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
  await page.getByRole('button', { name: 'Stop listening' }).click();
  expect(await page.evaluate(() => window.pendingBalloons())).toBe(1);
  expect(await page.evaluate(() => window.balloonListeners())).toEqual(idleListeners);
  const stopped = await page.evaluate(() => window.readBalloons());
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 20, y: 0, z: 0 } }));
    await window.advanceBalloons(10);
  });
  const falling = await page.evaluate(() => window.readBalloons());
  expect(falling[0].y).toBeLessThan(stopped[0].y);
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
      await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Microphone denied', 'NotAllowedError'); }; });
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
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 20, y: 0, z: 0 } }));
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
