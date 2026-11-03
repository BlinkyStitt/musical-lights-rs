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
    const renderedRatio = () => page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      const travel = v.renderedTravel;
      return Math.max(...Array.from({ length: 24 }, (_, i) => (v.renderedHeight(i) - v.renderedBaseline) / travel));
    });
    await expect.poll(targets).toBe(0);
    // Check past the reported one-second shutdown, then inject actual capture
    // PCM through the MediaStream source, worklet, DSP and renderer.
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => [testContext.state, captureTrack.readyState, captureStarts])).toEqual(['running', 'live', 1]);
    // Silence has a small decorative floor without fabricated audio targets.
    await expect.poll(renderedRatio).toBeGreaterThan(.12);
    await expect.poll(renderedRatio).toBeLessThan(.18);
    // Observe the short burst in the page. Separate protocol/trace snapshots
    // can take longer than the burst on a software renderer. Require actual
    // rendered travel and its ratio in the same frame, beyond the idle floor.
    const burst = await page.evaluate(() => new Promise(resolve => {
      const v = document.querySelector('#dancinglights').physics;
      const start = performance.now(), peak = { target: 0, rendered: 0, ratio: 0 };
      const sample = () => {
        peak.target = Math.max(peak.target, ...v.input.slice(0, 24));
        const rendered = Math.max(...Array.from({ length: 24 }, (_, i) => v.renderedHeight(i) - v.renderedBaseline));
        const ratio = rendered / v.renderedTravel;
        if (ratio > peak.ratio) { peak.rendered = rendered; peak.ratio = ratio; }
        if ((peak.target > .2 && peak.rendered > .05 && peak.ratio > .2) || performance.now() - start >= 5000) {
          resolve(peak); return;
        }
        requestAnimationFrame(sample);
      };
      captureBurst(); sample();
    }));
    expect(burst.target).toBeGreaterThan(.2);
    expect(burst.rendered).toBeGreaterThan(.05);
    expect(burst.ratio).toBeGreaterThan(.2);
    await expect.poll(targets).toBeLessThan(1e-6); // The filter decays asymptotically.
    if (action === 'Fullscreen') await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await expect(listening(page)).toBeChecked();
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    expect(await page.evaluate(() => captureStarts)).toBe(1);
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await page.getByRole('link', { name: 'About', exact: true }).click();
    // Cleanup stops tracks synchronously; AudioContext.close() completes later.
    expect(await page.evaluate(() => captureTrack.readyState)).toBe('ended');
    await expect.poll(() => page.evaluate(() => testContext.state)).toBe('closed');
  });
}
