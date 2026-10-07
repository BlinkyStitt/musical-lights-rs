import { test, expect } from '@playwright/test';
import { physicsReady } from '../physics-state.mjs';

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    console.log('Tone failure state:', await page.evaluate(() => ({
      audio: document.querySelector('#dancinglights')?.physics?.report?.audioState,
      error: document.querySelector('.audio-error')?.textContent,
      context: window.exerciseContext?.state,
      audioTime: window.exerciseContext?.currentTime,
      events: window.audioEvents,
      focus: document.activeElement?.className,
      rows: document.querySelector('#dancinglights')?.physics?.report?.toneRows,
      lastISO: document.querySelector('#dancinglights')?.physics?.report?.toneChunks.at(-1)?.values.slice(-511, -508),
    })).catch(error => String(error)));
  }
});

async function acceptancePage(page, repeat = true) {
  await page.goto('http://127.0.0.1:8101/advanced'); await physicsReady(page); await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.phone-device').fill('test phone'); await page.locator('.phone-browser').fill('test browser'); await page.locator('.ios-version').fill('test');
  await page.locator('.low-power-off').check();
  await page.locator('.tone-repeat').setChecked(repeat);
  await page.locator('.review-start').click();
  await expect(page.locator('.review-start')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.audioState?.state)).toBe('playing');
}
test('non-repeating exercise cannot start phone acceptance', async ({ page }) => {
  await acceptancePage(page, false);
  await page.locator('.phone-start').click();
  expect(await page.evaluate(() => Boolean(document.querySelector('#dancinglights').physics.report.active))).toBe(false);
  await expect(page.locator('.phone-progress')).toContainText('repeating 24-tone exercise');
});
for (const stage of ['warmup', 'measurement']) {
  for (const action of ['pause', 'repeat-off', 'stop', 'end', 'interruption']) {
    test(`${action} invalidates ${stage} and resume cannot repair acceptance`, async ({ page }) => {
      await acceptancePage(page);
      await page.locator('.phone-start').click();
      await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.startMs != null)).toBe(true);
      if (stage === 'measurement') await page.evaluate(() => { document.querySelector('#dancinglights').physics.report.startMs -= 16000; });
      await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
      if (action === 'pause') await page.locator('.tone-pause').click();
      if (action === 'repeat-off') await page.locator('.tone-repeat').uncheck();
      if (action === 'stop') await page.locator('.review-stop').click();
      if (action === 'interruption') await page.evaluate(() => window.exerciseContext.suspend());
      if (action === 'end') {
        // Stop repeating the short fixture in the actual PCM processor.
        // Its real end acknowledgement invalidates the acceptance workload.
        await page.evaluate(() => {
          window.exerciseSource.port.postMessage({ type: 'repeat', repeat: false, sequence: 0 });
        });
      }
      await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.invalid.length), { timeout: 10000 }).toBeGreaterThan(0);
      if (action === 'pause') await page.locator('.tone-pause').click();
      if (action === 'repeat-off') await page.locator('.tone-repeat').check();
      if (action === 'interruption') await expect(page.locator('.listening-toggle')).not.toBeChecked();
      expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.report.invalid.length)).toBeGreaterThan(0);
    });
  }
}
test.beforeEach(async ({ page }, info) => {
  await page.addInitScript(shortEnd => {
    const Context = window.AudioContext, Worklet = window.AudioWorkletNode;
    window.AudioContext = class extends Context {
      constructor(...args) { super(...args); window.exerciseContext = this; }
    };
    window.AudioWorkletNode = class extends Worklet {
      constructor(context, name, options) {
        // Bound only the end-test fixture duration; retain the real processor,
        // output graph and natural completion message.
        if (name === 'pcm-playback' && shortEnd)
          options.processorOptions.pcm = options.processorOptions.pcm.slice(0, 96000);
        super(context, name, options);
        if (name === 'pcm-playback') window.exerciseSource = this;
      }
    };
    window.audioEvents = [];
    document.addEventListener('audio-session', ({ detail }) => window.audioEvents.push(detail), true);
  }, /end invalidates|naturally ended/.test(info.title));
});

test('each microphone session resets diagnostics and rejects stale tone packets', async ({ page }) => {
  await page.addInitScript(() => {
    const Context = window.AudioContext;
    window.AudioContext = class extends Context {
      constructor(...args) { super(...args); window.captureContext = this; }
    };
    MediaDevices.prototype.getUserMedia = async () => {
      const context = window.captureContext;
      const destination = context.createMediaStreamDestination(), tone = context.createOscillator();
      tone.connect(destination); tone.start();
      return destination.stream;
    };
  });
  await page.goto('http://127.0.0.1:8101/advanced'); await physicsReady(page); await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.tone-trace').check();
  let previous;
  for (const source of ['generated', 'microphone', 'microphone']) {
    await page.locator('.input-source').selectOption(source);
    if (source === 'microphone') await page.locator('.listening-toggle').check(); else await page.locator('.review-start').click();
    // A new session can still be unlocking its suspended graph. Do not read
    // the preceding session's recorded rows before acquisition resets them.
    if (source === 'microphone') await expect(page.locator('.listening-toggle')).toBeEnabled(); else await expect(page.locator('.review-start')).toBeDisabled();
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.mic-status')).toBeEmpty();
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.toneRows)).toBeGreaterThan(0);
    const metadata = await page.evaluate(() => document.querySelector('#dancinglights').physics.report.toneMetadata);
    expect(metadata.source).toBe(source);
    expect(metadata.sessionId).not.toBe(previous);
    if (source === 'microphone') expect(metadata.kind).toBeUndefined();
    const result = await page.evaluate(oldId => {
      const card = document.querySelector('.audio-card'), r = document.querySelector('#dancinglights').physics.report;
      const before = r.toneRows;
      card.dispatchEvent(new CustomEvent('tone-trace', { detail: { sessionId: oldId, trace: new Float64Array(389), traceStride: 389 } }));
      return { before, after: r.toneRows, sessions: r.toneChunks.map(c => c.sessionId) };
    }, previous ?? 'stale');
    expect(result.after).toBe(result.before);
    expect(result.sessions.every(id => id === metadata.sessionId)).toBe(true);
    previous = metadata.sessionId;
    if (source === 'microphone') await page.locator('.listening-toggle').uncheck(); else await page.locator('.review-stop').click();
  }
});

for (const kind of ['stationary', 'stepped', 'sweep', 'two', 'volume', 'bursts', 'silence']) {
  test(`phone tone ${kind} uses the real worklet with synchronized diagnostics`, async ({ page }) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:8101/advanced'); await physicsReady(page); await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
    await page.locator('.input-source').selectOption('generated');
    await page.locator('.tone-kind').selectOption(kind);
    await page.locator('.tone-trace').check();
    await page.locator('.review-start').click();
    await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).not.toBeChecked();
  await expect(page.locator('.review-start')).toBeDisabled();
    await expect(page.locator('.tone-status')).toContainText(kind);
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.mic-status')).toBeEmpty();
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.toneRows)).toBeGreaterThan(100);
    const data = await page.evaluate(() => {
      const report = document.querySelector('#dancinglights').physics.report;
      const rows = report.toneChunks.flatMap(c => {
        const out = [];
        for (let i = 0; i < c.values.length; i += c.stride) out.push(Array.from(c.values.slice(i, i + c.stride)));
        return out;
      });
      let error = 0;
      for (const row of rows) {
        const bands = row.slice(291, 315), peak = Math.max(...bands);
        const targets = bands.map((_, i) => row[367 + i * 4]), top = Math.max(...targets);
        if (peak) for (let i = 0; i < 24; i++) error = Math.max(error, Math.abs(targets[i] / top - bands[i] / peak));
      }
      return { error, metadata: report.toneMetadata, physics: report.tonePhysics.at(-1), stride: report.toneChunks[0].stride, sones: rows.at(-1)[1] };
    });
    expect(data.stride).toBe(511); expect(data.error).toBeLessThan(2e-7);
    expect(data.metadata.kind).toBe(kind); expect(data.physics.tops).toHaveLength(24);
    expect(data.physics.velocities).toHaveLength(24);
    if (kind === 'silence') expect(data.sones).toBe(0);
    else expect(data.sones).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Pause playback', exact: true }).click();
    await expect(page.locator('.tone-status')).toContainText('paused');
    await page.getByRole('button', { name: 'Resume playback', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.audioState?.state)).toBe('playing');
    const resumedRows = await page.evaluate(() => document.querySelector('#dancinglights').physics.report.toneRows);
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.toneRows)).toBeGreaterThan(resumedRows + 100);
    await expect(page.getByRole('alert')).toBeEmpty();
    await page.locator('.review-stop').click();
    await expect(page.getByRole('button', { name: 'Pause playback', exact: true })).toBeDisabled();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export tone trace', exact: true }).click();
    expect((await download).suggestedFilename()).toContain('musical-lights-tones-');
    expect(errors).toEqual([]);
  });
}

test('a stale completion message cannot end a resumed session', async ({ page }) => {
  await acceptancePage(page);
  await page.evaluate(() => { window.oldCompletion = window.exerciseSource.port.onmessage; });
  await page.locator('.tone-pause').click();
  await page.locator('.tone-pause').click();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.audioState?.state)).toBe('playing');
  await page.evaluate(() => window.oldCompletion({ data: { type: 'transport', sequence: 0, frame: 0, positionFrame: 0, state: 'ended', repeat: false } }));
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.report.audioState?.state)).toBe('playing');
  await page.locator('.phone-start').click();
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.report.active)).toBe(true);
});

test('a new non-exercise session cannot restore an invalid acceptance run', async ({ page }) => {
  await acceptancePage(page);
  await page.locator('.phone-start').click();
  await page.locator('.review-stop').click();
  await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.tone-kind').selectOption('stationary');
  await page.locator('.review-start').click();
  await expect(page.locator('.review-start')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.audioState?.state)).toBe('playing');
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.report.invalid.length)).toBeGreaterThan(0);
  await page.locator('.phone-finish').click();
  await expect(page.locator('.phone-start')).toBeEnabled();
  await page.locator('.phone-start').click();
  expect(await page.evaluate(() => Boolean(document.querySelector('#dancinglights').physics.report.active))).toBe(false);
});

test('repeated pauses preserve recording continuity and resume audible tone output', async ({ page }) => {
  await page.goto('http://127.0.0.1:8101/advanced'); await physicsReady(page); await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.tone-kind').selectOption('stationary');
  await page.locator('.tone-trace').check();
  await page.locator('.review-start').click();
  await expect(page.locator('.review-start')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.audioState?.state)).toBe('playing');
  const pause = page.getByRole('button', { name: 'Pause playback', exact: true });
  await expect(pause).toBeEnabled();
  await pause.focus();
  for (let cycle = 0; cycle < 6; cycle++) {
    // The same transport button keeps focus as its label changes. Send the
    // user's repeated keys without refocusing and scrolling it each time.
    await page.keyboard.press('Enter');
    // Use measured ISO loudness to prove that pause supplies silence while
    // the analysis clock continues, then that resume restores the signal.
    // Wait in the page so six cycles do not pay repeated protocol round trips
    // while the native analysis release runs. Keep the measured thresholds.
    await page.waitForFunction(() => {
      const r = document.querySelector('#dancinglights').physics.report, c = r.toneChunks.at(-1);
      return c?.values[c.values.length - c.stride + 1] < .01
        && document.querySelector('.tone-pause').textContent === 'Resume playback';
    }, null, { timeout: 10000 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const r = document.querySelector('#dancinglights').physics.report, c = r.toneChunks.at(-1);
      return c?.values[c.values.length - c.stride + 1] > 1
        && document.querySelector('.tone-pause').textContent === 'Pause playback'
        && document.querySelector('[role="alert"]').textContent.trim() === '';
    }, null, { timeout: 5000 });
  }
  await page.locator('.review-stop').press('Enter');
});

test('a naturally ended tone restarts and ignores the preceding completion', async ({ page }) => {
  await acceptancePage(page, false);
  await page.evaluate(() => { window.oldCompletion = window.exerciseSource.port.onmessage; });
  await expect(page.locator('.tone-pause')).toHaveText('Replay');
  await page.locator('.tone-repeat').check();
  await page.locator('.tone-pause').press('Enter');
  await page.evaluate(() => window.oldCompletion({ data: { type: 'transport', sequence: 0, frame: 0, positionFrame: 0, state: 'ended', repeat: false } }));
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.audioState?.state)).toBe('playing');
  await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.input.slice(0, 24)))).toBeGreaterThan(.1);
  await expect(page.getByRole('alert')).toBeEmpty();
  await page.locator('.review-stop').click();
});

test('Advanced Listening uses microphone silence until real input arrives', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(...args) { super(...args); window.micContext = this; }
    };
    window.micRequests = 0;
    MediaDevices.prototype.getUserMedia = async () => {
      window.micRequests++;
      const context = window.micContext, tone = context.createOscillator();
      tone.frequency.value = 1000;
      window.micGain = context.createGain(); window.micGain.gain.value = 0;
      const destination = context.createMediaStreamDestination();
      tone.connect(window.micGain); window.micGain.connect(destination); tone.start();
      return destination.stream;
    };
  });
  await page.goto('http://127.0.0.1:8101/advanced'); await physicsReady(page); await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.audioState?.state)).toBe('playing');
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.mic-status')).toBeEmpty();
  const actual = await page.evaluate(() => ({
    requests: window.micRequests,
    source: document.querySelector('#dancinglights').physics.report.audioState.source,
    label: document.querySelector('.mic-status').textContent,
  }));
  expect(actual).toEqual({ requests: 1, source: 'microphone', label: '' });
  const peak = () => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.input.slice(0, 24)));
  await page.waitForTimeout(500);
  expect(await peak()).toBe(0);
  await page.evaluate(() => { window.micGain.gain.value = .02; });
  await expect.poll(peak).toBeGreaterThan(.1);
  await page.evaluate(() => { window.micGain.gain.value = 0; });
  await expect.poll(peak, { timeout: 10000 }).toBeLessThan(.001);
  await expect(page.getByRole('alert')).toBeEmpty();
  await page.locator('.listening-toggle').uncheck();
});
