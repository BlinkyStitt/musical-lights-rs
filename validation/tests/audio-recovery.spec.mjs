import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { physicsReady, normalView } from '../physics-state.mjs';

async function recoveryPage(page, microphone = false) {
  await page.addInitScript(microphone => {
    const Context = window.AudioContext, Node = window.AudioWorkletNode;
    window.recoveryContexts = []; window.recoveryNodes = []; window.captureCalls = 0; window.recoveryFrames = 0; window.recoveryInjected = 0;
    window.AudioContext = class extends Context {
      constructor(...args) {
        super(...args); recoveryContexts.push(this);
        const prototype = Object.getPrototypeOf(this.audioWorklet), load = prototype.addModule;
        prototype.addModule = async function(url, options) {
          if (!new URL(url, document.baseURI).pathname.endsWith('/loudness/processor.js')) return load.call(this, url, options);
          // Mutate only the test-loaded module: drop one analysis callback while
          // the real browser clock and independent PCM playback advance.
          const response = await fetch(url); if (!response.ok) throw new Error('Cannot load test worklet');
          let source = await response.text();
          const port = 'this.port.onmessage = ({ data }) => {';
          const process = '    process(inputs) {';
          if (!source.includes(port) || !source.includes(process)) throw new Error('Worklet fault injection no longer matches source');
          source = source.replace(port, `${port}\n            if (data.type === 'validation-drop-quantum') { this.validationDrop = true; return; }\n            if (data.type === 'validation-clock-backstep') { this.validationClockShift = -128; return; }`);
          source = source.replace(process, `${process}\n        const currentFrame = globalThis.currentFrame + (this.validationClockShift ?? 0);\n        if (this.validationDrop) { this.validationDrop = false; return true; }`);
          const modified = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
          try { await load.call(this, modified, options); recoveryInjected++; } finally { URL.revokeObjectURL(modified); }
        };
      }
    };
    window.AudioWorkletNode = class extends Node {
      constructor(context, name, options) { super(context, name, options); recoveryNodes.push({ node: this, name, options }); if (name === 'loudness-processor') this.port.addEventListener('message', ({ data }) => { if (data.type === 'frame') recoveryFrames++; }); }
    };
    if (microphone) {
      const settings = { autoGainControl: false, echoCancellation: false, noiseSuppression: false, deviceId: 'recovery-test-input', sampleRate: 48000 };
      const key = `musical-lights-calibration:${JSON.stringify([settings, 0, 48000])}`;
      localStorage.setItem(key, JSON.stringify({ pascalsPerUnit: 1.5 })); window.recoveryCalibrationKey = key;
      MediaDevices.prototype.getUserMedia = async () => {
        captureCalls++;
        const context = recoveryContexts.at(-1), tone = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
        tone.frequency.value = 1000; gain.gain.value = .02;
        tone.connect(gain); gain.connect(destination); tone.start();
        const track = destination.stream.getAudioTracks()[0];
        Object.defineProperty(track, 'getSettings', { value: () => ({ ...settings }) });
        window.recoveryTrack = track;
        return destination.stream;
      };
    }
    else MediaDevices.prototype.getUserMedia = async () => { captureCalls++; throw new Error('Digital playback must not request microphone capture'); };
  }, microphone);
  await page.goto('http://127.0.0.1:8101/advanced/'); await physicsReady(page); await normalView(page);
}
async function dropQuantum(page, segment = 1, command = 'validation-drop-quantum') {
  await expect.poll(() => page.evaluate(() => recoveryFrames)).toBeGreaterThan(0);
  expect(await page.evaluate(() => recoveryInjected)).toBe(1);
  await page.evaluate(command => recoveryNodes.find(entry => entry.name === 'loudness-processor').node.port.postMessage({ type: command }), command);
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.audioState.continuity.segment)).toBe(segment);
}

test('a real audio gap preserves playback and monitor controls while exported traces declare it', async ({ page }, info) => {
  await recoveryPage(page);
  await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.tone-trace').check(); await page.locator('.tone-audible').check();
  await page.locator('.review-start').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect.poll(() => page.evaluate(() => document.querySelector('.audio-card').review.lastPlayback?.processingSeconds ?? 0)).toBeGreaterThan(.2);
  const before = await page.evaluate(() => ({ session: document.querySelector('.audio-card').dataset.audioSession, position: document.querySelector('.audio-card').review.lastPlayback.outputSeconds, nodes: recoveryNodes.length }));
  await dropQuantum(page);
  await expect(page.locator('.analysis-status')).toContainText('Audio recovered');
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.tone-repeat')).toBeChecked(); await expect(page.locator('.tone-audible')).toBeChecked();
  await expect(page.getByRole('alert')).toBeEmpty();
  const after = await page.evaluate(() => ({ session: document.querySelector('.audio-card').dataset.audioSession, position: document.querySelector('.audio-card').review.lastPlayback.outputSeconds, nodes: recoveryNodes.length, contexts: recoveryContexts.length, requests: captureCalls, continuity: document.querySelector('#dancinglights').physics.report.audioState.continuity }));
  expect(after.session).toBe(before.session); expect(after.nodes).toBe(before.nodes); expect(after.contexts).toBe(1); expect(after.requests).toBe(0);
  expect(after.position).toBeGreaterThanOrEqual(before.position); expect(after.position - before.position).toBeLessThan(2);
  expect(after.continuity.missingSamples).toBe(128); expect(after.continuity.receivedSample - after.continuity.expectedSample).toBe(128);
  await page.locator('.tone-pause').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'paused');
  await dropQuantum(page, 2);
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'paused');
  await expect(page.locator('.tone-pause')).toHaveText('Resume playback');
  await page.locator('.tone-pause').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  const download = page.waitForEvent('download'); await page.locator('.tone-export').click();
  const file = await download; const path = info.outputPath('recovered-tone-trace.json'); await file.saveAs(path);
  const trace = JSON.parse(await readFile(path, 'utf8'));
  expect(trace.type).toBe('musical-lights-tone-trace-v8');
  const rows = trace.chunks.flatMap(chunk => Array.from({ length: chunk.values.length / chunk.stride }, (_, row) => chunk.values.slice(row * chunk.stride, (row + 1) * chunk.stride)));
  expect(rows.some(row => row[465] === 0)).toBe(true); expect(rows.some(row => row[465] === 1)).toBe(true);
  for (const row of rows) if (row[465] === 1) expect(row[0]).toBeGreaterThanOrEqual(after.continuity.receivedSample);
  await page.locator('.review-stop').click();
  await expect(page.locator('.analysis-status')).toBeEmpty();
  expect(await page.evaluate(() => recoveryContexts[0].state)).toBe('closed');
});

test('a microphone gap cancels incomplete calibration and preserves capture and the accepted profile', async ({ page }) => {
  await recoveryPage(page, true);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await page.locator('.calibration-controls').evaluate(node => { node.open = true; });
  await expect(page.locator('.calibration-status')).toContainText('Calibrated');
  await expect.poll(() => page.evaluate(() => recoveryFrames)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Measure reference', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Measure reference', exact: true })).toBeDisabled();
  await dropQuantum(page);
  await expect(page.getByRole('button', { name: 'Measure reference', exact: true })).toBeEnabled();
  await expect(page.locator('.analysis-status')).toContainText('Calibration was interrupted');
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.getByRole('alert')).toBeEmpty();
  const current = await page.evaluate(() => ({ calls: captureCalls, contexts: recoveryContexts.length, nodes: recoveryNodes.length, track: recoveryTrack.readyState, profile: JSON.parse(localStorage.getItem(recoveryCalibrationKey)), continuity: document.querySelector('#dancinglights').physics.report.audioState.continuity }));
  expect(current.calls).toBe(1); expect(current.contexts).toBe(1); expect(current.nodes).toBe(1); expect(current.track).toBe('live');
  expect(current.profile.pascalsPerUnit).toBe(1.5); expect(current.continuity.calibrationCancellations).toBe(1);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
  await expect(page.locator('.analysis-status')).toBeEmpty();
  expect(await page.evaluate(() => [recoveryContexts[0].state, recoveryTrack.readyState])).toEqual(['closed', 'ended']);
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page.locator('[data-expanded]')).toHaveCount(0);
});


test('phone acceptance rejects a recovered sample gap even though playback continues', async ({ page }) => {
  await recoveryPage(page);
  await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.review-start').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await page.locator('.phone-device').fill('Browser test'); await page.locator('.phone-browser').fill('Browser emulation');
  await page.locator('.ios-version').fill('Test only'); await page.locator('.low-power-off').check();
  await page.locator('.phone-start').click();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.active)).toBe(true);
  await dropQuantum(page);
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.invalid.includes('Audio sample gap during test'))).toBe(true);
  await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.phone-finish').click();
  await page.locator('.review-stop').click();
});


test('a backward analysis clock keeps the same playback position and declares its overlap', async ({ page }) => {
  await recoveryPage(page);
  await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.tone-trace').check(); await page.locator('.review-start').click();
  await expect.poll(() => page.evaluate(() => document.querySelector('.audio-card').review.lastPlayback?.processingSeconds ?? 0)).toBeGreaterThan(.2);
  const before = await page.evaluate(() => ({ position: document.querySelector('.audio-card').review.lastPlayback.outputSeconds, session: document.querySelector('.audio-card').dataset.audioSession, nodes: recoveryNodes.length }));
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await dropQuantum(page, 1, 'validation-clock-backstep');
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.analysis-status')).toContainText('Audio recovered'); await expect(page.locator('.audio-error')).toBeEmpty();
  const after = await page.evaluate(() => ({ position: document.querySelector('.audio-card').review.lastPlayback.outputSeconds, session: document.querySelector('.audio-card').dataset.audioSession, nodes: recoveryNodes.length, contexts: recoveryContexts.length, continuity: document.querySelector('#dancinglights').physics.report.audioState.continuity, chunks: document.querySelector('#dancinglights').physics.report.toneChunks.map(c => ({ stride: c.stride, values: Array.from(c.values) })) }));
  expect(after.session).toBe(before.session); expect(after.nodes).toBe(before.nodes); expect(after.contexts).toBe(1);
  expect(after.position).toBeGreaterThanOrEqual(before.position); expect(after.position - before.position).toBeLessThan(2);
  expect(after.continuity.missingSamples).toBe(0); expect(after.continuity.overlapSamples).toBe(128);
  expect(after.continuity.expectedSample - after.continuity.receivedSample).toBe(128);
  expect(after.chunks.some(c => c.values.some((value, i) => i % c.stride === 465 && value === 1))).toBe(true);
  // Recovery keeps the fixed scene and leaves Exit available in the toolbar.
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await page.locator('.review-stop').click(); await expect(page.locator('.analysis-status')).toBeEmpty();
  expect(await page.evaluate(() => recoveryContexts[0].state)).toBe('closed');
});
