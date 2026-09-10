import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const leptos = 'http://127.0.0.1:8101';

test('Leptos renders routes, 20 bars, and an increasing counter', async ({ page }) => {
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('page error:', error.message); });
  await page.goto(leptos);
  await expect(page.getByRole('heading', { name: 'Musical Lights' })).toBeVisible();
  await expect(page.locator('#dancinglights > div')).toHaveCount(20);
  await page.getByRole('button', { name: 'Click me: 0', exact: true }).click();
  await page.getByRole('button', { name: 'Click me: 1', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Click me: 2', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Old Arduino Code' })).toBeVisible();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('#dancinglights > div')).toHaveCount(20);
  await page.goto(`${leptos}/missing`);
  await expect(page.getByRole('heading')).toContainText("We couldn't find that page!");
  expect(errors).toEqual([]);
});

async function trackContexts(page) {
  await page.addInitScript(() => {
    window.audioContexts = [];
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(options) { super(options); window.audioContexts.push(this); }
    };
  });
}

test('microphone denial displays an error and closes the audio context', async ({ page }) => {
  await trackContexts(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Microphone denied', 'NotAllowedError'); };
  });
  await page.goto(leptos);
  await page.getByRole('button', { name: /Start Dancing/ }).click();
  await expect(page.getByRole('alert')).toContainText('Microphone denied');
  await expect(page.getByRole('button', { name: /Start Dancing/ })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.audioContexts.map(c => c.state))).toEqual(['closed']);
});

for (const rate of [44100, 48000]) {
  test(`real audio worklet updates 20 bars at ${rate} Hz and releases resources`, async ({ page }) => {
    const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('page error:', error.message); });
    await page.addInitScript(({ rate }) => {
      const NativeContext = window.AudioContext;
      window.audioContexts = [];
      window.AudioContext = class extends NativeContext {
        constructor(options) { super({ ...options, sampleRate: rate }); window.audioContexts.push(this); }
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new NativeContext({ sampleRate: rate });
        const oscillator = context.createOscillator();
        oscillator.frequency.value = 1000;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start(); await context.resume();
        window.inputStream = destination.stream; window.inputContext = context;
        return destination.stream;
      };
    }, { rate });
    await page.goto(leptos);
    await page.getByRole('button', { name: /Start Dancing/ }).click();
    await expect(page.getByText(`Sample Rate: ${rate} Hz`)).toBeVisible();
    await expect.poll(() => page.locator('#dancinglights').innerText()).toMatch(/M/);
    await expect(page.locator('#dancinglights > div')).toHaveCount(20);
    await expect(page.getByRole('alert')).toBeEmpty();
    await page.screenshot({ path: `test-results/leptos-${rate}.png` });
    await page.getByRole('button', { name: 'Stop listening' }).click();
    await expect.poll(() => page.evaluate(() => window.inputStream.getTracks().map(t => t.readyState))).toEqual(['ended']);
    await expect.poll(() => page.evaluate(() => window.audioContexts.map(c => c.state))).toEqual(['closed']);
    // Leptos uses invisible Unicode format characters as empty text anchors.
    await expect.poll(() => page.locator('#dancinglights').evaluate(e => e.textContent.replace(/\p{Cf}/gu, ''))).toBe('');
    await page.evaluate(() => window.inputContext.close());
    await page.getByRole('button', { name: /Start Dancing/ }).click();
    await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
    await page.getByRole('link', { name: 'About', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.inputStream.getTracks().map(t => t.readyState))).toEqual(['ended']);
    await expect.poll(() => page.evaluate(() => window.audioContexts.map(c => c.state))).toEqual(['closed', 'closed']);
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
  await page.getByRole('button', { name: /Start Dancing/ }).click();
  await expect.poll(() => page.evaluate(() => typeof window.resolveInput)).toBe('function');
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.audioContexts.map(c => c.state))).toEqual(['closed']);
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
  expect(processor.process([])).toBe(true);
  expect(messages.pop().data).toBe(null);
  expect(processor.process([[]])).toBe(true);
  expect(messages.pop().data).toBe(null);
  for (const length of [64, 128, 256, 511]) {
    processor.process([[new Float32Array(length).fill(0.5), new Float32Array(length).fill(-0.25)]]);
    const { data, transfer } = messages.pop();
    expect(Array.from(data)).toEqual(Array(length).fill(0.125));
    expect(transfer).toEqual([data.buffer]);
  }
});

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
