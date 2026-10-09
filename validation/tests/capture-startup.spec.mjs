import { test, expect } from '@playwright/test';
import { normalView, physicsReady } from '../physics-state.mjs';
const origin = (process.env.MUSICAL_LIGHTS_CAPTURE_URL ?? 'http://127.0.0.1:8101').replace(/\/$/, '');
const listening = page => page.getByRole('checkbox', { name: 'Listening', exact: true });

for (const path of ['/', '/advanced/']) for (const action of ['Listening', 'Fullscreen']) {
  test(`${action} starts one live microphone session and captured bursts replace idle motion on ${path}`, async ({ page }, info) => {
    await page.addInitScript(() => {
      const Context = window.AudioContext;
      window.AudioContext = class extends Context {
        constructor(...args) { super(...args); window.testContext = this; }
      };
      window.captureStarts = 0; window.captureStates = [];
      document.addEventListener('audio-session', ({ detail }) => window.captureStates.push(detail), true);
      MediaDevices.prototype.getUserMedia = async () => {
        window.captureStarts++;
        const context = window.testContext, destination = context.createMediaStreamDestination();
        const silence = context.createConstantSource(); silence.offset.value = 0;
        silence.connect(destination); silence.start();
        window.captureTrack = destination.stream.getAudioTracks()[0];
        window.captureBurst = () => {
          const rate = context.sampleRate, pcm = new Float32Array(rate / 5);
          for (let i = 0; i < pcm.length; i++) pcm[i] = .08 * Math.sin(2 * Math.PI * 1000 * i / rate);
          const buffer = context.createBuffer(1, pcm.length, rate); buffer.copyToChannel(pcm, 0);
          const source = context.createBufferSource(); source.buffer = buffer;
          source.connect(destination); source.start();
        };
        return destination.stream;
      };
    });
    await page.goto(`${origin}${path}`); await physicsReady(page); await normalView(page);
    await expect(page.locator('.audio-card')).toHaveAttribute('data-preview', 'true');
    const entry = action === 'Fullscreen' ? page.getByRole('button', { name: 'Fullscreen', exact: true }) : listening(page);
    if (info.project.use.hasTouch) await entry.tap(); else await entry.click();
    try {
      await expect.poll(() => page.evaluate(() => ({
        checked: document.querySelector('.listening-toggle').checked,
        disabled: document.querySelector('.listening-toggle').disabled,
        context: window.testContext.state, count: window.captureStarts,
        state: document.querySelector('.audio-card').dataset.audioState,
        error: document.querySelector('.audio-error').textContent,
      }))).toEqual({ checked: true, disabled: false, context: 'running', count: 1, state: 'playing', error: '' });
    } catch (error) {
      await info.attach('capture-session-events', { body: JSON.stringify(await page.evaluate(() => captureStates)), contentType: 'application/json' });
      throw error;
    }
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.mic-status')).toBeEmpty();
    await expect(page.locator('.audio-card')).toHaveAttribute('data-preview', 'false');
    const targets = () => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.input.slice(0, 24)));
    const rendered = () => page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      return Math.max(...Array.from({ length: 24 }, (_, i) => v.renderedHeight(i) - v.layout[13]));
    });
    const renderedRatio = () => page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      const travel = v.current[v.layout[17] + 1] - v.layout[13];
      return Math.max(...Array.from({ length: 24 }, (_, i) => (v.renderedHeight(i) - v.layout[13]) / travel));
    });
    await expect.poll(targets).toBe(0);
    // Check past the reported one-second shutdown, then inject actual capture
    // PCM through the MediaStream source, worklet, DSP and renderer.
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => [testContext.state, captureTrack.readyState, captureStarts])).toEqual(['running', 'live', 1]);
    // Silence has a small decorative floor without fabricated audio targets.
    await expect.poll(renderedRatio).toBeGreaterThan(.12);
    await expect.poll(renderedRatio).toBeLessThan(.18);
    await page.evaluate(() => captureBurst());
    await expect.poll(targets, { intervals: [10] }).toBeGreaterThan(.2);
    await expect.poll(rendered, { intervals: [10] }).toBeGreaterThan(.05);
    await expect.poll(renderedRatio, { intervals: [10] }).toBeGreaterThan(.2);
    await expect.poll(targets).toBeLessThan(1e-6); // The filter decays asymptotically.
    if (action === 'Fullscreen') await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await expect(listening(page)).toBeChecked();
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    expect(await page.evaluate(() => captureStarts)).toBe(1);
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await page.getByRole('link', { name: 'About', exact: true }).click();
    expect(await page.evaluate(() => [testContext.state, captureTrack.readyState])).toEqual(['closed', 'ended']);
  });
}
