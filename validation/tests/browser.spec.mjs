import { test, expect } from '@playwright/test';
import { meterPoint, meterPoints } from '../meter-input.mjs';
const leptos = 'http://127.0.0.1:8101';

test('Leptos renders routes and 24 meters without the temporary counter', async ({ page }) => {
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('page error:', error.message); });
  await page.goto(leptos);
  await expect(page.getByRole('heading', { name: 'Musical Lights' })).toBeVisible();
  await expect(page.locator('#dancinglights > div')).toHaveCount(24);
  expect(await page.getByRole('meter').evaluateAll(nodes => nodes.slice(0, 5).map(n => n.getAttribute('aria-label'))))
    .toEqual(['≈ 0–100 Hz', '≈ 100–200 Hz', '≈ 200–300 Hz', '≈ 300–400 Hz', '≈ 400–510 Hz']);
  await expect(page.getByRole('button', { name: /Click me|counter/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Pause display|Resume display/i })).toHaveCount(0);
  await expect(page.getByText('Every band has room')).toHaveCount(0);
  await expect(page.locator('.meter-guide')).toHaveText('QUIETLOUDLOUDQUIET');
  await expect(page.locator('.frame-rate, .diagnostic-fps')).toHaveCount(0);
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

async function expectOnlySphereAnimation(page) {
  await expect.poll(() => page.evaluate(() => window.pendingAnimationFrames.size)).toBe(1);
  const calls = await page.evaluate(() => window.animationCalls);
  await expect.poll(() => page.evaluate(() => window.animationCalls)).toBeGreaterThan(calls);
}

test('microphone denial displays an error and closes the audio context', async ({ page }) => {
  await trackContexts(page);
  await page.addInitScript(() => {
    MediaDevices.prototype.getUserMedia = async () => { throw new DOMException('Microphone denied', 'NotAllowedError'); };
  });
  await page.goto(leptos);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Microphone denied');
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.audioContexts.map(c => c.state))).toEqual(['closed']);
  await expectOnlySphereAnimation(page);
});

for (const rate of [44100, 48000]) {
  test(`real audio peaks above full scale update 24 meters at ${rate} Hz and release resources`, async ({ page }) => {
    const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('page error:', error.message); });
    await trackAnimation(page);
    await page.addInitScript(({ rate }) => {
      const NativeContext = window.AudioContext;
      window.audioContexts = [];
      window.AudioContext = class extends NativeContext {
        constructor(options) { super(options); window.audioContexts.push(this); }
      };
      const NativeNode = window.AudioWorkletNode;
      window.inputClipped = 0;
      window.AudioWorkletNode = class extends NativeNode {
        constructor(...args) {
          super(...args);
          this.port.addEventListener('message', ({ data }) => {
            if (data.type === 'frame') window.inputClipped = data.clipped;
          });
        }
      };
      MediaDevices.prototype.getUserMedia = async () => {
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
    await expect(page.getByRole('meter')).toHaveCount(24);
    const bandColors = await page.locator('.bark-group').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).getPropertyValue('--band-color').trim()));
    await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
    // Home omits technical input details; capture still uses the output context's rate.
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
    expect(await page.evaluate(() => window.audioContexts[0].sampleRate)).toBe(48000);
    await expect.poll(() => page.evaluate(() => window.inputClipped)).toBeGreaterThan(0);
    await expect.poll(() => page.getByRole('meter').evaluateAll(nodes => Math.max(...nodes.map(n => Number(n.getAttribute('aria-valuenow')))))).toBeGreaterThan(0);
    await expect(page.locator('#dancinglights > div')).toHaveCount(24);
    await expect(page.getByRole('alert')).toBeEmpty();
    await page.screenshot({ path: `test-results/leptos-${rate}.png`, fullPage: true });
    // Falling meters retain the same DOM nodes and reach zero after silence.
    await page.evaluate(() => { window.originalMeters = [...document.querySelectorAll('.meter')]; });
    await page.evaluate(() => { window.testInputGain.gain.value = 0; });
    await expect.poll(() => page.getByRole('meter').evaluateAll(nodes => nodes.every(n => n.getAttribute('aria-valuenow') === '0'))).toBe(true);
    expect(await page.evaluate(() => window.originalMeters.every((node, i) => node === document.querySelectorAll('.meter')[i]))).toBe(true);
    expect(await page.locator('.bark-group').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).getPropertyValue('--band-color').trim()))).toEqual(bandColors);
    await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
    await expect.poll(() => page.evaluate(() => window.inputStream.getTracks().map(t => t.readyState))).toEqual(['ended']);
    await expect.poll(() => page.evaluate(() => window.audioContexts.map(c => c.state))).toEqual(['closed']);
    await expectOnlySphereAnimation(page);
    await expect(page.locator('.frame-rate, .diagnostic-fps')).toHaveCount(0);
    await expect(page.locator('.audio-card')).toHaveAttribute('data-preview', 'true');
    await page.evaluate(() => window.inputContext.close());
    await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
    await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
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
    MediaDevices.prototype.getUserMedia = () => new Promise(resolve => { window.resolveInput = resolve; });
  });
  await page.goto(leptos);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect.poll(() => page.evaluate(() => typeof window.resolveInput)).toBe('function');
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.audioContexts.map(c => c.state))).toEqual(['closed']);
  // Cancel drawing before the still-pending permission promise resolves.
  await expectAnimationStopped(page);
  await page.evaluate(async () => {
    window.lateSource = new AudioContext();
    const stream = lateSource.createMediaStreamDestination().stream;
    window.lateStream = stream;
    window.resolveInput(stream);
  });
  await expect.poll(() => page.evaluate(() => window.lateStream.getTracks().map(t => t.readyState))).toEqual(['ended']);
  // Keep the independent source alive until the application has stopped its track.
  expect(await page.evaluate(() => lateSource.state)).not.toBe('closed');
  await page.evaluate(() => lateSource.close());
  await expect.poll(() => page.evaluate(() => window.audioContexts.every(c => c.state === 'closed'))).toBe(true);
});

for (const colorScheme of ['light', 'dark']) {
  for (const width of [375, 768, 1440]) {
    test(`spectrum is centered and readable at ${width}px in ${colorScheme} mode`, async ({ page }) => {
      // This case checks 24 hovers, live audio, contrast, screenshots, and theme
      // changes. Allow the full sequence on software GPUs; each state assertion
      // still has its normal five-second deadline. Phone FPS has a separate gate.
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
      if (width === 375) {
        // Keep layout and input checks under slow scheduling as well.
        const cpu = await page.context().newCDPSession(page);
        await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      }
      await page.emulateMedia({ colorScheme });
      await page.addInitScript(() => {
        MediaDevices.prototype.getUserMedia = async () => {
          // Keep all 24 bands in the noise fixture even when a headset makes
          // the device's default context run at a lower sample rate.
          const context = new AudioContext({ sampleRate: 48000 });
          const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
          const samples = buffer.getChannelData(0);
          let seed = 1;
          for (let i = 0; i < samples.length; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            samples[i] = (seed / 2 ** 32 - 0.5) * 0.6;
          }
          const source = context.createBufferSource(); source.buffer = buffer; source.loop = true;
          const destination = context.createMediaStreamDestination();
          source.connect(destination); source.start(); await context.resume();
          window.noiseContext = context;
          return destination.stream;
        };
      });
      await page.goto(leptos);
      // This geometry/contrast fixture visits all 24 source columns. The idle
      // sine now scrolls them too; freeze scrolling for stationary hover targets.
      await page.locator('.scroll-lights').uncheck();
      await page.locator('.display-controls > summary').click();
      await page.locator('.camera-motion').uncheck();
      await page.locator('.display-controls > summary').click();
      await page.evaluate(() => window.scrollTo(0, 0));
      // The switch eases to a stop; wait for the displayed phase to settle.
      await page.waitForFunction(() => {
        const view = document.querySelector('#dancinglights').physics;
        return view?.current && view.previous
          && view.current[view.layout[20]] === view.previous[view.layout[20]];
      });
      const card = await page.locator('.audio-card').boundingBox();
      expect(Math.abs(card.x + card.width / 2 - width / 2)).toBeLessThan(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      const meters = await page.getByRole('meter').all();
      expect(meters).toHaveLength(24);
      const first = await meters[0].boundingBox();
      const last = await meters[23].boundingBox();
      expect(first.y).toBe(last.y);
      expect(last.x + last.width).toBeLessThan(card.x + card.width);
      await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeInViewport();
      await expect(page.locator('#dancinglights')).toBeInViewport({ ratio: 1 });
      const controls = await page.locator('.audio-controls').boundingBox();
      expect(first.y).toBeLessThan(controls.y + controls.height + 64);
      const description = await page.locator('.intro').boundingBox();
      expect(description.y).toBeGreaterThan(first.y + first.height);
      // Scrolling and camera motion are off for this geometry fixture. Read
      // all native hit points once instead of scrolling the same graph 24 times.
      for (const { x, y, label } of await meterPoints(page)) {
        await page.mouse.move(x, y);
        // Check visibility, text, and bounds together without waiting through
        // several software-rendered frames for separate protocol calls.
        await page.waitForFunction(label => {
          const node = document.querySelector('#frequency-readout');
          const box = node.getBoundingClientRect(), style = getComputedStyle(node);
          return node.textContent.trim() === label && box.width > 0 && box.height > 0
            && style.visibility !== 'hidden' && style.display !== 'none'
            && box.x >= 0 && box.right <= innerWidth;
        }, label, { timeout: 5000 });
      }
      await page.mouse.move(0, 0);
      await page.getByRole('checkbox', { name: 'Listening', exact: true }).focus();
      for (const selector of ['[data-help="listening-toggle"]', '[data-help="identify-song"]', '.motion-button', '[data-help="motion-button"]', '.scroll-lights', '[data-help="scroll-lights"]', '.video-button', '.fullscreen-button']) {
        await page.keyboard.press('Tab');
        await expect(page.locator(selector)).toBeFocused();
      }
      await expect(page.getByRole('checkbox', { name: 'Identify song', exact: true })).toBeDisabled();
      await page.keyboard.press('Tab');
      await expect(meters[0]).toBeFocused();
      await expect(page.locator('.control-help')).toBeHidden();
      await expect(page.locator('#frequency-readout')).toHaveText(await meters[0].getAttribute('aria-label'));
      // Exercise every colored bar through the real audio processor.
      // Include a collection pause before the first live bar attack.
      await page.requestGC();
      await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
      await expect.poll(() => page.getByRole('meter').evaluateAll(nodes => nodes.every(node => Number(node.getAttribute('aria-valuenow')) > 0))).toBe(true);
      // Check actual text colors against the background they use.
      const colors = await page.evaluate(() => {
        const luminance = rgb => {
          const linear = rgb.startsWith('color(srgb-linear ');
          const channels = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
            if (linear) return v;
            if (!rgb.startsWith('color(srgb ')) v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          });
          return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
        };
        const contrast = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        const text = ['.setting-switch', '.fullscreen-button', '.wake-status', '.mic-status', '.eyebrow', '.frequency-tooltip', '.meter-guide', '.spectrum-labels', 'h1', '.intro p', '.how-it-works p', 'nav a', 'footer a'].map(selector => {
          const node = document.querySelector(selector);
          let parent = node;
          while (getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)') parent = parent.parentElement;
          const fore = luminance(getComputedStyle(node).color);
          const back = luminance(getComputedStyle(parent).backgroundColor);
          return { selector, ratio: contrast(fore, back) };
        });
        const surfaces = [document.documentElement, document.querySelector('.audio-card'), document.querySelector('.spectrum-panel')]
          .map(node => luminance(getComputedStyle(node).backgroundColor));
        const meters = [...document.querySelectorAll('.bark-group')].map(node => {
          const color = getComputedStyle(node).getPropertyValue('--band-color').trim();
          // The fill or its permanent black canvas outline must delimit
          // each bar against the plot; bright fills need that outline in light mode.
          return { color, ratio: Math.max(contrast(luminance(color), surfaces[2]), contrast(0, surfaces[2])) };
        });
        return { text, surfaces, meters };
      });
      for (const surface of colors.surfaces) {
        if (colorScheme === 'dark') expect(surface).toBeLessThan(.1);
        else expect(surface).toBeGreaterThan(.8);
      }
      expect(new Set(colors.meters.map(meter => meter.color)).size).toBe(24);
      for (const { color, ratio } of colors.meters) {
        expect(ratio, color).toBeGreaterThanOrEqual(3);
      }
      for (const { selector, ratio } of colors.text) expect(ratio, selector).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({ path: `test-results/leptos-layout-${width}-${colorScheme}.png`, fullPage: true });
      if (width === 1440) {
        const session = await page.context().newCDPSession(page);
        for (const type of ['deuteranopia', 'protanopia', 'tritanopia']) {
          await session.send('Emulation.setEmulatedVisionDeficiency', { type });
          await page.screenshot({ path: `test-results/leptos-${type}-${colorScheme}.png`, fullPage: true });
        }
        await session.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
      }
      // A system setting change updates the open page without replacing the app.
      const background = await page.evaluate(() => {
        window.themeMeters = [...document.querySelectorAll('.meter')];
        return getComputedStyle(document.documentElement).backgroundColor;
      });
      await page.emulateMedia({ colorScheme: colorScheme === 'dark' ? 'light' : 'dark' });
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).not.toBe(background);
      expect(await page.evaluate(() => window.themeMeters.every((node, i) => node === document.querySelectorAll('.meter')[i]))).toBe(true);
      expect(await page.locator('.bark-group').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).getPropertyValue('--band-color').trim())))
        .toEqual(colors.meters.map(meter => meter.color));
      await page.emulateMedia({ colorScheme });
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(background);
      await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
      await page.evaluate(() => window.noiseContext.close());
    });
  }
}
