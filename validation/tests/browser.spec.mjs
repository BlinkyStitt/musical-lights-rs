import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const leptos = 'http://127.0.0.1:8101';

test('Leptos renders routes and 24 meters without the temporary counter', async ({ page }) => {
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('page error:', error.message); });
  await page.goto(leptos);
  await expect(page.getByRole('heading', { name: 'Musical Lights' })).toBeVisible();
  await expect(page.locator('#dancinglights > div')).toHaveCount(24);
  expect(await page.getByRole('meter').evaluateAll(nodes => nodes.slice(0, 5).map(n => n.getAttribute('aria-label'))))
    .toEqual(['0–100 Hz', '100–200 Hz', '200–300 Hz', '300–400 Hz', '400–510 Hz']);
  await expect(page.getByRole('button', { name: /Click me|counter/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Pause display|Resume display/i })).toHaveCount(0);
  await expect(page.getByText('Every band has room')).toHaveCount(0);
  await expect(page.locator('.meter-guide')).toHaveText('LOUDQUIET');
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Old Arduino Code' })).toBeVisible();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('#dancinglights > div')).toHaveCount(24);
  await page.goto(`${leptos}/missing`);
  await expect(page.getByRole('heading')).toContainText("We couldn't find that page!");
  expect(errors).toEqual([]);
});

async function trackContexts(page) {
  await trackAnimation(page);
  await page.addInitScript(() => {
    window.audioContexts = [];
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(options) { super(options); window.audioContexts.push(this); }
    };
  });
}

async function trackAnimation(page) {
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    window.pendingAnimationFrames = new Set();
    window.animationCalls = 0;
    window.requestAnimationFrame = callback => {
      const id = request(now => {
        window.pendingAnimationFrames.delete(id);
        window.animationCalls++;
        callback(now);
      });
      window.pendingAnimationFrames.add(id);
      return id;
    };
    window.cancelAnimationFrame = id => {
      window.pendingAnimationFrames.delete(id);
      cancel(id);
    };
  });
}

async function expectAnimationStopped(page) {
  await expect.poll(() => page.evaluate(() => window.pendingAnimationFrames.size)).toBe(0);
  const calls = await page.evaluate(() => window.animationCalls);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.animationCalls)).toBe(calls);
}

test('microphone denial displays an error and closes the audio context', async ({ page }) => {
  await trackContexts(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Microphone denied', 'NotAllowedError'); };
  });
  await page.goto(leptos);
  await page.getByRole('button', { name: 'Start listening' }).click();
  await expect(page.getByRole('alert')).toContainText('Microphone denied');
  await expect(page.getByRole('button', { name: 'Start listening' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.audioContexts.map(c => c.state))).toEqual(['closed']);
  await expectAnimationStopped(page);
});

for (const rate of [44100, 48000]) {
  test(`real audio peaks above full scale update 24 meters at ${rate} Hz and release resources`, async ({ page }) => {
    const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('page error:', error.message); });
    await trackAnimation(page);
    await page.addInitScript(({ rate }) => {
      const NativeContext = window.AudioContext;
      window.audioContexts = [];
      window.AudioContext = class extends NativeContext {
        constructor(options) { super({ ...options, sampleRate: rate }); window.audioContexts.push(this); }
      };
      const NativeNode = window.AudioWorkletNode;
      window.inputPeak = 0;
      window.AudioWorkletNode = class extends NativeNode {
        constructor(...args) {
          super(...args);
          this.port.addEventListener('message', ({ data }) => {
            for (const sample of data) window.inputPeak = Math.max(window.inputPeak, Math.abs(sample));
          });
        }
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new NativeContext({ sampleRate: rate });
        const oscillator = context.createOscillator();
        oscillator.frequency.value = 1000;
        const gain = context.createGain(); gain.gain.value = 4;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain); gain.connect(destination); oscillator.start(); await context.resume();
        window.testInputGain = gain;
        window.inputStream = destination.stream; window.inputContext = context;
        return destination.stream;
      };
    }, { rate });
    await page.goto(leptos);
    await page.getByRole('button', { name: 'Start listening' }).click();
    await expect(page.getByText(`Sample rate: ${rate} Hz · Smooth display`)).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.inputPeak)).toBeGreaterThan(1);
    await expect.poll(() => page.getByRole('meter').evaluateAll(nodes => Math.max(...nodes.map(n => Number(n.getAttribute('aria-valuenow')))))).toBeGreaterThan(0);
    await expect(page.locator('#dancinglights > div')).toHaveCount(24);
    await expect(page.getByRole('alert')).toBeEmpty();
    await page.screenshot({ path: `test-results/leptos-${rate}.png`, fullPage: true });
    // Falling meters retain the same DOM nodes and reach zero after silence.
    await page.evaluate(() => { window.originalMeters = [...document.querySelectorAll('.meter')]; });
    await page.evaluate(() => { window.testInputGain.gain.value = 0; });
    await expect.poll(() => page.getByRole('meter').evaluateAll(nodes => nodes.every(n => n.getAttribute('aria-valuenow') === '0'))).toBe(true);
    expect(await page.evaluate(() => window.originalMeters.every((node, i) => node === document.querySelectorAll('.meter')[i]))).toBe(true);
    await page.getByRole('button', { name: 'Stop listening' }).click();
    await expect.poll(() => page.evaluate(() => window.inputStream.getTracks().map(t => t.readyState))).toEqual(['ended']);
    await expect.poll(() => page.evaluate(() => window.audioContexts.map(c => c.state))).toEqual(['closed']);
    await expectAnimationStopped(page);
    await expect.poll(() => page.getByRole('meter').evaluateAll(nodes => nodes.every(n => n.getAttribute('aria-valuenow') === '0'))).toBe(true);
    await page.evaluate(() => window.inputContext.close());
    await page.getByRole('button', { name: 'Start listening' }).click();
    await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
    await page.getByRole('link', { name: 'About', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.inputStream.getTracks().map(t => t.readyState))).toEqual(['ended']);
    await expect.poll(() => page.evaluate(() => window.audioContexts.map(c => c.state))).toEqual(['closed', 'closed']);
    await expectAnimationStopped(page);
    await page.evaluate(() => window.inputContext.close());
    expect(errors).toEqual([]);
  });
}

test('leaving the view while permission is pending releases the late stream', async ({ page }) => {
  await trackContexts(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.resolveInput = resolve; });
  });
  await page.goto(leptos);
  await page.getByRole('button', { name: 'Start listening' }).click();
  await expect.poll(() => page.evaluate(() => typeof window.resolveInput)).toBe('function');
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.audioContexts.map(c => c.state))).toEqual(['closed']);
  // Cancel drawing before the still-pending permission promise resolves.
  await expectAnimationStopped(page);
  await page.evaluate(async () => {
    const context = new AudioContext();
    const stream = context.createMediaStreamDestination().stream;
    window.lateStream = stream;
    window.resolveInput(stream);
    await context.close();
  });
  await expect.poll(() => page.evaluate(() => window.lateStream.getTracks().map(t => t.readyState))).toEqual(['ended']);
  await expect.poll(() => page.evaluate(() => window.audioContexts.every(c => c.state === 'closed'))).toBe(true);
});

test('input worklet handles absent input and actual block lengths', async () => {
  let Processor; const messages = [];
  vm.runInNewContext(await readFile('../musical-leptos/src/my-wasm-processor.js', 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage: (data, transfer) => messages.push({ data, transfer }) }; },
    registerProcessor: (_, value) => { Processor = value; },
  });
  const processor = new Processor();
  expect(processor.process([], [])).toBe(true);
  expect(messages).toHaveLength(0);
  for (const length of [64, 128, 256, 511]) {
    const output = [[new Float32Array(length)]];
    expect(processor.process([[]], output)).toBe(true);
    expect(Array.from(messages.pop().data)).toEqual(Array(length).fill(0));
    processor.process([[new Float32Array(length).fill(0.5), new Float32Array(length).fill(-0.25)]], output);
    const { data, transfer } = messages.pop();
    expect(Array.from(data)).toEqual(Array(length).fill(0.125));
    expect(transfer).toEqual([data.buffer]);
    // Float PCM may exceed one. Cancellation must not lose the quiet channel
    // to intermediate float32 rounding, or overflow with maximum finite PCM.
    for (const [samples, expected] of [
      [[4, 8], 6],
      [[2 ** 25, 1, -(2 ** 25)], Math.fround(1 / 3)],
      [[3.4028234663852886e38, 3.4028234663852886e38], 3.4028234663852886e38],
    ]) {
      processor.process([samples.map(value => new Float32Array(length).fill(value))], output);
      expect(Array.from(messages.pop().data)).toEqual(Array(length).fill(expected));
    }
    expect(Array.from(output[0][0])).toEqual(Array(length).fill(0));
  }
});

test('meters rise on the next frame, retain live levels, and fall without rapid flashes', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(...args) { super(...args); window.testContext = this; }
    };
    const NativeNode = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(...args) { super(...args); window.testPort = this.port; }
    };
    navigator.mediaDevices.getUserMedia = async () => window.testContext.createMediaStreamDestination().stream;
  });
  await page.goto(leptos);
  await page.getByRole('button', { name: 'Start listening' }).click();
  await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
  await page.evaluate(async () => {
    await window.testContext.suspend();
    // Drain the last real worklet messages before supplying controlled blocks.
    await new Promise(resolve => setTimeout(resolve, 50));
    window.meterNodes = [...document.querySelectorAll('.meter-fill')];
    window.heights = () => window.meterNodes.map(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).m22);
    window.screenFrame = () => new Promise(resolve => requestAnimationFrame(() => queueMicrotask(resolve)));
    let phase = 0;
    window.sendAudio = gain => {
      const data = Float32Array.from({ length: 128 }, () => gain * Math.sin(phase++ * 2 * Math.PI * 1000 / window.testContext.sampleRate));
      window.testPort.dispatchEvent(new MessageEvent('message', { data }));
    };
  });
  const attack = await page.evaluate(async () => {
    const before = Math.max(...window.heights());
    for (let block = 0; block < 20; block++) window.sendAudio(4);
    await window.screenFrame();
    return { before, after: Math.max(...window.heights()) };
  });
  expect(attack.before).toBe(0);
  expect(attack.after).toBeGreaterThan(0.1);
  expect(await page.locator('.meter-fill').first().evaluate(node => {
    const style = getComputedStyle(node);
    return [style.transitionDuration, style.animationName];
  })).toEqual(['0s', 'none']);
  // No new audio callback means the last live level still applies, not zero.
  await page.waitForTimeout(1200);
  const floor = await page.evaluate(() => window.heights());
  expect(Math.max(...floor)).toBeGreaterThan(0.1);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.heights())).toEqual(floor);
  const fall = await page.evaluate(async () => {
    window.sendAudio(0);
    const levels = [];
    const end = performance.now() + 1100;
    while (performance.now() < end) {
      await window.screenFrame();
      levels.push(Math.max(...window.heights()));
    }
    return levels;
  });
  expect(new Set(fall).size).toBeGreaterThan(10);
  expect(fall.at(-1)).toBe(0);
  for (let i = 1; i < fall.length; i++) expect(fall[i]).toBeLessThanOrEqual(fall[i - 1]);

  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion });
    const maxFlashes = await page.evaluate(async () => {
      const wasLit = Array(24 * 100).fill(false);
      const rises = Array.from(wasLit, () => []);
      let maxFlashes = 0;
      const start = performance.now();
      let lastTick = -1;
      while (performance.now() - start < 2200) {
        const tick = Math.floor((performance.now() - start) / 50);
        if (tick !== lastTick) {
          // Many queued blocks arrive together, including taps and silence.
          for (let block = 0; block < 20; block++) window.sendAudio(tick % 2 ? 0 : 4);
          lastTick = tick;
        }
        await window.screenFrame();
        const now = performance.now();
        for (const [band, height] of window.heights().entries()) {
          for (let pixel = 0; pixel < 100; pixel++) {
            const index = band * 100 + pixel;
            const lit = height >= (pixel + 1) / 100;
            if (lit && !wasLit[index]) {
              rises[index] = rises[index].filter(time => now - time < 1000);
              rises[index].push(now);
              maxFlashes = Math.max(maxFlashes, rises[index].length);
            }
            wasLit[index] = lit;
          }
        }
      }
      return maxFlashes;
    });
    expect(maxFlashes).toBeGreaterThan(0);
    expect(maxFlashes).toBeLessThanOrEqual(3);
  }
  expect(await page.evaluate(() => window.meterNodes.every((node, i) => node === document.querySelectorAll('.meter-fill')[i]))).toBe(true);
  await expect(page.getByRole('alert')).toBeEmpty();
  await page.evaluate(() => {
    const data = new Float32Array(128); data[108] = NaN;
    window.testPort.dispatchEvent(new MessageEvent('message', { data }));
  });
  await expect(page.getByRole('alert')).toContainText('sample 108 is not finite');
  await page.waitForTimeout(360);
  await page.evaluate(() => window.sendAudio(0));
  await expect(page.getByRole('alert')).toBeEmpty();
});

for (const width of [375, 768, 1440]) {
  test(`spectrum is centered and readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    await page.goto(leptos);
    const card = await page.locator('.audio-card').boundingBox();
    expect(Math.abs(card.x + card.width / 2 - width / 2)).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const meters = await page.getByRole('meter').all();
    expect(meters).toHaveLength(24);
    const first = await meters[0].boundingBox();
    const last = await meters[23].boundingBox();
    expect(first.y).toBe(last.y);
    expect(last.x + last.width).toBeLessThan(card.x + card.width);
    await expect(page.getByRole('button', { name: 'Start listening' })).toBeInViewport();
    await expect(page.locator('#dancinglights')).toBeInViewport({ ratio: 1 });
    expect(first.y).toBeLessThan(200);
    const description = await page.locator('.intro').boundingBox();
    expect(description.y).toBeGreaterThan(first.y + first.height);
    for (const meter of meters) {
      const label = await meter.getAttribute('aria-label');
      await meter.hover();
      const tooltip = meter.getByRole('tooltip');
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toHaveText(label);
      const box = await tooltip.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await page.mouse.move(0, 0);
    await page.getByRole('button', { name: 'Start listening' }).focus();
    await page.keyboard.press('Tab');
    await expect(meters[0].getByRole('tooltip')).toBeVisible();
    // Check actual text colors against the background they use.
    const contrasts = await page.evaluate(() => {
      const luminance = rgb => {
        const channels = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
          v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      return ['.primary', '.control-note', '.mic-status', '.eyebrow', '.frequency-tooltip', '.how-it-works p', 'footer a'].map(selector => {
        const node = document.querySelector(selector);
        let parent = node;
        while (getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)') parent = parent.parentElement;
        const fore = luminance(getComputedStyle(node).color);
        const back = luminance(getComputedStyle(parent).backgroundColor);
        return { selector, ratio: (Math.max(fore, back) + .05) / (Math.min(fore, back) + .05) };
      });
    });
    for (const { selector, ratio } of contrasts) expect(ratio, selector).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: `test-results/leptos-layout-${width}.png`, fullPage: true });
    if (width === 1440) {
      const session = await page.context().newCDPSession(page);
      for (const type of ['deuteranopia', 'protanopia', 'tritanopia']) {
        await session.send('Emulation.setEmulatedVisionDeficiency', { type });
        await page.screenshot({ path: `test-results/leptos-${type}.png`, fullPage: true });
      }
    }
  });
}

test('Dioxus renders its visible page', async ({ page }) => {
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('page error:', error.message); });
  await page.goto('http://127.0.0.1:8102');
  await expect(page.getByRole('heading', { name: 'Musical Lights' })).toBeVisible();
  await expect(page.locator('#links a')).toHaveCount(6);
  await page.screenshot({ path: 'test-results/dioxus.png' });
  expect(errors).toEqual([]);
});

test('standalone WASM executes its shared-memory audio worklet', async ({ page }) => {
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('page error:', error.message); });
  await page.addInitScript(() => {
    window.workletErrors = [];
    const NativeNode = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(...args) {
        super(...args);
        this.addEventListener('processorerror', () => window.workletErrors.push('processorerror'));
        window.testAnalyser = this.context.createAnalyser();
        this.connect(window.testAnalyser);
      }
    };
  });
  await page.goto('http://127.0.0.1:8103');
  await expect(page.getByRole('slider')).toHaveCount(2);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.getByRole('slider').first().fill('25');
  await expect.poll(() => page.evaluate(() => {
    const samples = new Float32Array(128);
    window.testAnalyser.getFloatTimeDomainData(samples);
    return samples.some(value => Number.isFinite(value) && Math.abs(value) > 0.01);
  })).toBe(true);
  expect(await page.evaluate(() => window.workletErrors)).toEqual([]);
  expect(errors).toEqual([]);
});
