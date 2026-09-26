import { test, expect } from '@playwright/test';
import { physicsReady } from '../physics-state.mjs';

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    console.log('Tone failure state:', await page.evaluate(() => ({
      audio: document.querySelector('#dancinglights')?.physics?.report?.audioState,
      error: document.querySelector('.audio-error')?.textContent,
      context: window.exerciseContext?.state,
      audioTime: window.exerciseContext?.currentTime,
    })).catch(error => String(error)));
  }
});

async function acceptancePage(page, repeat = true) {
  await page.goto('http://127.0.0.1:8101/phone'); await physicsReady(page);
  await page.locator('.generated-audio').check();
  await page.locator('.ios-version').fill('test');
  await page.locator('.low-power-off').check();
  await page.locator('.tone-repeat').setChecked(repeat);
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(page.locator('.stop-listening')).toBeVisible();
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
      await page.locator('.physics-controls').evaluate(node => { node.open = true; });
      if (action === 'pause') await page.locator('.tone-pause').click();
      if (action === 'repeat-off') await page.locator('.tone-repeat').uncheck();
      if (action === 'stop') await page.locator('.stop-listening').click();
      if (action === 'interruption') await page.evaluate(() => window.exerciseContext.suspend());
      if (action === 'end') {
        // Turn looping off in the source, without the UI's change event, so
        // this exercises the natural AudioBufferSourceNode ended callback.
        await page.evaluate(() => {
          window.exerciseSource.loop = false;
          // Reach the actual buffer end promptly even when realtime audio
          // advances slowly on a contended host; do not synthesize onended.
          window.exerciseSource.playbackRate.value = 64;
        });
      }
      await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.invalid.length), { timeout: 10000 }).toBeGreaterThan(0);
      if (action === 'pause') await page.locator('.tone-pause').click();
      if (action === 'repeat-off') await page.locator('.tone-repeat').check();
      if (action === 'interruption') await page.evaluate(() => window.exerciseContext.resume());
      expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.report.invalid.length)).toBeGreaterThan(0);
    });
  }
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const create = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const source = create.call(this); window.exerciseSource = source; window.exerciseContext = this; return source;
    };
  });
});

test('each microphone session resets diagnostics and rejects stale tone packets', async ({ page }) => {
  await page.addInitScript(() => {
    MediaDevices.prototype.getUserMedia = async () => {
      const context = new AudioContext({ sampleRate: 48000 });
      const destination = context.createMediaStreamDestination(), tone = context.createOscillator();
      tone.connect(destination); tone.start(); await context.resume();
      return destination.stream;
    };
  });
  await page.goto('http://127.0.0.1:8101/phone'); await physicsReady(page);
  await page.locator('.generated-audio').check();
  await page.locator('.tone-trace').check();
  let previous;
  for (const source of ['generated', 'microphone', 'microphone']) {
    await page.locator('.generated-audio').setChecked(source === 'generated');
    await page.getByRole('button', { name: 'Start listening', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.toneRows)).toBeGreaterThan(0);
    const metadata = await page.evaluate(() => document.querySelector('#dancinglights').physics.report.toneMetadata);
    expect(metadata.source).toBe(source);
    await expect(page.locator('.mic-status')).toHaveText(source === 'generated' ? 'Test audio · Mic off' : 'Listening · Mic on');
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
    await page.locator('.stop-listening').click();
  }
});

for (const kind of ['stationary', 'stepped', 'sweep', 'two', 'volume', 'bursts', 'silence']) {
  test(`phone tone ${kind} uses the real worklet with synchronized diagnostics`, async ({ page }) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:8101/phone'); await physicsReady(page);
    await page.locator('.generated-audio').check();
    await page.locator('.tone-kind').selectOption(kind);
    await page.locator('.tone-trace').check();
    await page.getByRole('button', { name: 'Start listening', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toBeVisible();
    await expect(page.locator('.tone-status')).toContainText(kind);
    await expect(page.locator('.mic-status')).toHaveText('Test audio · Mic off');
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
    expect(data.stride).toBe(463); expect(data.error).toBeLessThan(2e-7);
    expect(data.metadata.kind).toBe(kind); expect(data.physics.tops).toHaveLength(24);
    expect(data.physics.velocities).toHaveLength(24);
    if (kind === 'silence') expect(data.sones).toBe(0);
    else expect(data.sones).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Pause tone', exact: true }).click();
    await expect(page.locator('.tone-status')).toContainText('paused');
    await page.getByRole('button', { name: 'Resume tone', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.audioState.state)).toBe('playing');
    const resumedRows = await page.evaluate(() => document.querySelector('#dancinglights').physics.report.toneRows);
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.toneRows)).toBeGreaterThan(resumedRows + 100);
    await expect(page.getByRole('alert')).toBeEmpty();
    await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause tone', exact: true })).toBeDisabled();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export tone trace', exact: true }).click();
    expect((await download).suggestedFilename()).toContain('musical-lights-tones-');
    expect(errors).toEqual([]);
  });
}

test('an old source ended callback cannot end a resumed session', async ({ page }) => {
  await acceptancePage(page);
  await page.evaluate(() => { window.oldEnded = window.exerciseSource.onended; });
  await page.locator('.tone-pause').click();
  await page.locator('.tone-pause').click();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.audioState.state)).toBe('playing');
  await page.evaluate(() => window.oldEnded());
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.report.audioState.state)).toBe('playing');
  await page.locator('.phone-start').click();
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.report.active)).toBe(true);
});

test('a new non-exercise session cannot restore an invalid acceptance run', async ({ page }) => {
  await acceptancePage(page);
  await page.locator('.phone-start').click();
  await page.locator('.stop-listening').click();
  await page.locator('.physics-controls').evaluate(node => { node.open = true; });
  await page.locator('.tone-kind').selectOption('stationary');
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(page.locator('.stop-listening')).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.report.invalid.length)).toBeGreaterThan(0);
  await page.locator('.phone-finish').click();
  await expect(page.locator('.phone-start')).toBeEnabled();
  await page.locator('.phone-start').click();
  expect(await page.evaluate(() => Boolean(document.querySelector('#dancinglights').physics.report.active))).toBe(false);
});

test('repeated pauses preserve recording continuity and resume audible tone output', async ({ page }) => {
  await page.goto('http://127.0.0.1:8101/phone'); await physicsReady(page);
  await page.locator('.generated-audio').check();
  await page.locator('.tone-kind').selectOption('stationary');
  await page.locator('.tone-trace').check();
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(page.locator('.stop-listening')).toBeVisible();
  for (let cycle = 0; cycle < 6; cycle++) {
    await page.getByRole('button', { name: 'Pause tone', exact: true }).click();
    // Use measured ISO loudness to prove that pause supplies silence while
    // the analysis clock continues, then that resume restores the signal.
    await expect.poll(() => page.evaluate(() => {
      const r = document.querySelector('#dancinglights').physics.report, c = r.toneChunks.at(-1);
      return c?.values[c.values.length - c.stride + 1];
    }), { timeout: 10000 }).toBeLessThan(.01);
    await page.getByRole('button', { name: 'Resume tone', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
      const r = document.querySelector('#dancinglights').physics.report, c = r.toneChunks.at(-1);
      return c?.values[c.values.length - c.stride + 1];
    })).toBeGreaterThan(1);
    await expect(page.getByRole('alert')).toBeEmpty();
  }
  await page.locator('.stop-listening').click();
});

test('a naturally ended tone restarts and ignores the replaced source callback', async ({ page }) => {
  await acceptancePage(page, false);
  await page.evaluate(() => { window.oldEnded = window.exerciseSource.onended; window.exerciseSource.playbackRate.value = 64; });
  await expect(page.getByRole('button', { name: 'Restart tone', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Restart tone', exact: true }).click();
  await page.evaluate(() => window.oldEnded());
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.audioState.state)).toBe('playing');
  await expect.poll(() => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.input.slice(0, 24)))).toBeGreaterThan(.1);
  await expect(page.getByRole('alert')).toBeEmpty();
  await page.locator('.stop-listening').click();
});

test('phone Start listens to microphone silence until real input arrives', async ({ page }) => {
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
  await page.goto('http://127.0.0.1:8101/phone'); await physicsReady(page);
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(page.locator('.stop-listening')).toBeVisible();
  const actual = await page.evaluate(() => ({
    requests: window.micRequests,
    source: document.querySelector('#dancinglights').physics.report.audioState.source,
    label: document.querySelector('.mic-status').textContent,
  }));
  expect(actual).toEqual({ requests: 1, source: 'microphone', label: 'Listening · Mic on' });
  const peak = () => page.evaluate(() => Math.max(...document.querySelector('#dancinglights').physics.input.slice(0, 24)));
  await page.waitForTimeout(500);
  expect(await peak()).toBe(0);
  await page.evaluate(() => { window.micGain.gain.value = .02; });
  await expect.poll(peak).toBeGreaterThan(.1);
  await page.evaluate(() => { window.micGain.gain.value = 0; });
  await expect.poll(peak, { timeout: 10000 }).toBeLessThan(.001);
  await expect(page.getByRole('alert')).toBeEmpty();
  await page.locator('.stop-listening').click();
});
