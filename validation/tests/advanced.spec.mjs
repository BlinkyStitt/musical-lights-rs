import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { physicsReady, syntheticAudio, startFrozen } from '../physics-state.mjs';
const origin = 'http://127.0.0.1:8101';
const listening = page => page.getByRole('checkbox', { name: 'Listening', exact: true });
async function advanced(page) {
  await page.goto(`${origin}/advanced/`); await physicsReady(page);
}
async function start(page) { await listening(page).check(); await expect(listening(page)).toBeEnabled(); await expect(listening(page)).toBeChecked(); }
function stereoWave() {
  const rate = 48000, samples = 48000, bytes = Buffer.alloc(44 + samples * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 4, 40);
  for (let i = 0; i < samples; i++) { bytes.writeInt16LE(Math.round(2000 * Math.sin(2 * Math.PI * 250 * i / rate)), 44 + i * 4); bytes.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * 3400 * i / rate)), 46 + i * 4); }
  return bytes;
}

test.describe('Home touch input', () => {
test.use({ hasTouch: true });
test('Home has silent sine motion without audio access, and switches support keyboard and touch', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.microphoneRequests = 0; MediaDevices.prototype.getUserMedia = async () => { window.microphoneRequests++; throw new Error('Unexpected capture'); }; });
  await page.goto(origin); await physicsReady(page);
  await expect(listening(page)).not.toBeChecked();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-preview', 'true');
  await expect.poll(() => page.getByRole('meter').evaluateAll(nodes => nodes.filter(n => Number(n.getAttribute('aria-valuenow')) > 10).length)).toBe(24);
  const initial = await page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.input.slice(0, 24)));
  await expect.poll(() => page.evaluate(initial => Array.from(document.querySelector('#dancinglights').physics.input.slice(0, 24)).some((value, i) => Math.abs(value - initial[i]) > .01), initial)).toBe(true);
  expect(await page.evaluate(() => microphoneRequests)).toBe(0);
  await expect(page.locator('.calibration-controls, .physics-controls, .diagnostics-controls, .diagnostic-fps')).toHaveCount(0);
  const scroll = page.getByRole('checkbox', { name: 'Scroll lights', exact: true });
  await scroll.focus(); await page.keyboard.press('Space'); await expect(scroll).not.toBeChecked();
  await expect(scroll).toBeFocused(); expect(await scroll.evaluate(n => getComputedStyle(n).outlineStyle)).toBe('solid');
  expect(await scroll.locator('..').evaluate(n => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await scroll.tap(); await expect(scroll).toBeChecked();
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await expect.poll(() => page.evaluate(() => microphoneRequests)).toBe(1);
  await expect(page.locator('.audio-error')).toContainText('Unexpected capture');
  await expect(page.locator('.diagnostic-fps')).toHaveCount(0);
  await expect(page.locator('.frame-rate')).toHaveText(/^\d+ FPS$/);
  await expect(page.locator('.audio-card')).toHaveAttribute('data-preview', 'true');
  expect(errors).toEqual([]);
});
});

test('idle-to-listening transition clears preview meter values for microphone silence', async ({ page }) => {
  await syntheticAudio(page); await page.goto(origin); await physicsReady(page);
  await expect.poll(() => page.getByRole('meter').evaluateAll(nodes => Math.max(...nodes.map(n => Number(n.getAttribute('aria-valuenow')))))).toBeGreaterThan(10);
  await listening(page).check(); await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.mic-status')).toBeEmpty();
  await expect.poll(() => page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.input.slice(0, 24)).every(value => value === 0))).toBe(true);
  await expect.poll(() => page.getByRole('meter').evaluateAll(nodes => nodes.every(node => node.getAttribute('aria-valuenow') === '0'))).toBe(true);
  const wave = () => page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    const travel = v.current[v.layout[17] + 1] - v.layout[13];
    return Array.from({ length: 24 }, (_, i) => (v.renderedHeight(i) - v.layout[13]) / travel);
  });
  await expect.poll(async () => Math.max(...await wave())).toBeGreaterThan(.12);
  // Wait for the taller idle preview to retract to the listening floor.
  await expect.poll(async () => Math.max(...await wave())).toBeLessThan(.18);
  const before = await wave();
  expect(Math.max(...before)).toBeLessThan(.18);
  expect(Math.min(...before)).toBeLessThan(.04);
  await expect.poll(async () => (await wave()).some((value, i) => Math.abs(value - before[i]) > .02)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(async () => Math.max(...await wave())).toBeLessThan(.001);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await listening(page).uncheck();
  await expect.poll(() => page.getByRole('meter').evaluateAll(nodes => Math.max(...nodes.map(n => Number(n.getAttribute('aria-valuenow')))))).toBeGreaterThan(0);
});

for (const end of ['bottom', 'top']) {
test(`diagnostic plot separates ${end} render geometry and its clock from analysis and physics`, async ({ page }) => {
  await advanced(page);
  const { sample, moves, unverified } = await page.evaluate(end => {
    const card = document.querySelector('.audio-card'), review = card.review, view = document.querySelector('#dancinglights').physics;
    review.sessionId = 'clock-regression'; review.samples = [];
    const receivedAt = performance.timeOrigin + performance.now();
    view.renderedAt = receivedAt - 25;
    view.current[view.layout[9] + 8] = .7 * view.height;
    view.renderedEnclosureHeight = view.height;
    view.bars.instanceMatrix.array[8 * 16 + 5] = .2 * view.height;
    view.bars.instanceMatrix.array[(8 + 72) * 16 + 5] = -.2 * view.height;
    if (Math.abs(view.renderedHeight(8, end === 'top' ? 1 : 0) / view.height - .2) > 1e-5) throw Error('Wrong rendered end');
    const trace = new Float64Array(511);
    trace[364] = 1.1; trace[291 + 8] = 2.5; trace[368 + 4 * 8] = .5;
    const ctx = card.querySelector('.review-plot').getContext('2d'), original = ctx.moveTo, moves = [];
    ctx.moveTo = function(x, y) { moves.push([x, y]); return original.call(this, x, y); };
    try { card.dispatchEvent(new CustomEvent('tone-trace', { detail: { sessionId: review.sessionId, trace, traceStride: 511, receivedAt, receivedAudioTime: 1.25 } })); }
    finally { ctx.moveTo = original; }
    const sample = review.samples[0];
    card.dispatchEvent(new CustomEvent('tone-trace', { detail: { sessionId: review.sessionId, trace, traceStride: 511, receivedAt } }));
    return { sample, moves, unverified: review.samples[1] };
  }, end);
  expect(sample).toMatchObject({ at: 1.1, raw: 2.5, filtered: .5, barBase: 'both', renderedTime: 1.225, renderedTimeConfidence: 'host/context estimate' });
  expect(sample.collider).toBeCloseTo(.7, 5); expect(sample.rendered).toBeCloseTo(.2, 5);
  expect(moves).toHaveLength(3);
  expect(moves[0][0]).toBeCloseTo(1.1 / 1.225 * 900, 5);
  expect(moves[1][0]).toBeCloseTo(moves[0][0], 5);
  expect(moves[2][0]).toBe(900); expect(moves[2][1]).toBeCloseTo(200, 3);
  expect(unverified).toMatchObject({ renderedTime: null, renderedTimeConfidence: 'unverified' });
  await page.locator('.diagnostics-controls > summary').click();
  const download = page.waitForEvent('download'); await page.locator('.review-export').click();
  const exported = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(exported.diagnosticSamples[0].barBase).toBe('both');
  expect(exported.diagnosticSamples[0].rendered).toBeCloseTo(.2, 5);
});

}

test('saved Physics settings restore on reload while factory reset retains factory values', async ({ page }) => {
  await advanced(page); await page.locator('.physics-controls > summary').click();
  await page.locator('[data-config="2"]').fill('16');
  await page.locator('[data-config="6"]').fill('20');
  await page.getByRole('button', { name: 'Apply settings and reset', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.config[2])).toBe(16);
  await page.reload(); await physicsReady(page); await page.locator('.physics-controls > summary').click();
  await expect(page.locator('[data-config="2"]')).toHaveValue('16');
  await expect(page.locator('[data-config="6"]')).toHaveValue('20');
  const height = await page.evaluate(() => document.querySelector('#dancinglights').physics.height);
  await page.getByRole('button', { name: 'Restore defaults and reset', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.config[2])).toBe(8);
  await expect(page.locator('[data-config="6"]')).toHaveValue('40');
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.height)).toBe(height);
  await page.reload(); await physicsReady(page); await page.locator('.physics-controls > summary').click();
  await expect(page.locator('[data-config="2"]')).toHaveValue('8');
  await expect(page.locator('[data-config="6"]')).toHaveValue('40');
});

test('Display and Input resets are scoped; milliseconds and physics defaults preserve enclosure size', async ({ page }) => {
  await advanced(page);
  await expect(page.locator('.display-controls')).not.toHaveAttribute('open', '');
  await page.locator('.display-controls > summary').click();
  await expect(page.locator('.calibration-controls')).not.toHaveAttribute('open', '');
  await page.locator('.calibration-controls > summary').click();
  expect(await page.locator('.physics-controls').evaluate(n => n.open)).toBe(false);
  expect(await page.locator('.diagnostics-controls').evaluate(n => n.open)).toBe(false);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.locator('.camera-rotation').fill('25'); await page.locator('.scroll-lights').uncheck();
  const view = await page.evaluate(() => { const v = document.querySelector('#dancinglights').physics; return { tick: v.current[2], height: v.height, radius: v.current[10] }; });
  await page.getByRole('button', { name: 'Reset display', exact: true }).click();
  await expect(page.locator('.scroll-lights')).toBeChecked();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.cameraBase)).toBe(0);
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.current[2])).toBeGreaterThan(view.tick);
  await page.locator('.calibration-controls input[type=number]').first().fill('2');
  await page.locator('.calibration-controls input[type=number]').last().fill('86');
  await page.getByRole('button', { name: 'Reset fields', exact: true }).click();
  await expect(page.locator('.calibration-controls input[type=number]').first()).toHaveValue('1');
  await expect(page.locator('.calibration-controls input[type=number]').last()).toHaveValue('94');
  await page.locator('.physics-controls > summary').click();
  await expect(page.locator('[data-config="6"]')).toHaveValue('40');
  await page.locator('[data-config="6"]').fill('120');
  await page.getByRole('button', { name: 'Apply settings and reset', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.config[6])).toBeCloseTo(.12, 6);
  const height = await page.evaluate(() => document.querySelector('#dancinglights').physics.height);
  await page.getByRole('button', { name: 'Restore defaults and reset', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.config[6])).toBeCloseTo(.04, 6);
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.height)).toBe(height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.reduced-motion-note')).toBeVisible();
});

test('audio and motion switches stop independently and route exit closes both plus the idle preview', async ({ page }) => {
  await syntheticAudio(page); await advanced(page); await startFrozen(page);
  await page.evaluate(() => { window.savedView = document.querySelector('#dancinglights').physics; window.sendBars(Array(24).fill(.5)); });
  await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).uncheck();
  expect(await page.evaluate(() => Array.from(savedView.input.slice(0, 24)))).toEqual(Array(24).fill(.5));
  await expect(listening(page)).toBeChecked();
  await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).check();
  await listening(page).uncheck();
  await expect(page.getByRole('checkbox', { name: 'Phone motion', exact: true })).toBeChecked();
  // Read the force in the page's next frame, before its 150 ms sensor expiry.
  // A separate protocol request can arrive after that expiry on a busy runner.
  const force = await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => {
      window.dispatchEvent(Object.assign(new Event('devicemotion'), { acceleration: { x: 5, y: 6, z: 7 } }));
      requestAnimationFrame(() => resolve(Array.from(savedView.input.slice(24, 27))));
    });
  }));
  expect(force).toEqual([-5, -6, -7]);
  await expect(page.locator('.audio-card')).toHaveAttribute('data-preview', 'true');
  await page.getByRole('link', { name: 'About', exact: true }).click();
  expect(await page.evaluate(() => [savedView.closed, savedView.motion.closed, savedView.preview, testContext.state])).toEqual([true, true, null, 'closed']);
});

for (const clip of ['trumpet', 'music', 'local']) {
  test(`review source ${clip} preserves PCM, supports transport and exports notes without microphone requests`, async ({ page }) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { window.captureRequests = 0; MediaDevices.prototype.getUserMedia = async () => { window.captureRequests++; throw new Error('No microphone for digital sources'); }; });
    await advanced(page); await page.locator('.diagnostics-controls > summary').click();
    // These settings only control generated tones, not licensed/local PCM.
    await page.locator('.tone-frequency').fill(clip === 'trumpet' ? '19' : '');
    await page.locator('.tone-level').fill(clip === 'trumpet' ? '0' : '');
    await page.locator('.tone-trace').check();
    if (clip === 'local') { await page.locator('.calibration-controls > summary').click(); await page.locator('.calibration-controls input[type=number]').first().fill('2'); }
    if (clip === 'local') await page.locator('.review-file').setInputFiles({ name: 'stereo.wav', mimeType: 'audio/wav', buffer: stereoWave() });
    else await page.locator('.input-source').selectOption(clip);
    await expect(page.locator('.tone-audible')).toBeChecked();
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.mic-status')).toBeEmpty();
    await expect(listening(page)).not.toBeChecked();
    await expect(page.locator('.input-source')).toBeEnabled(); await expect(page.locator('.review-file')).toBeEnabled();
    await expect(page.locator('.input-source')).toHaveValue(clip);
    await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.toneRows)).toBeGreaterThan(0);
    const identity = await page.evaluate(() => document.querySelector('.audio-card').review.identity);
    expect(identity.pcmSha256).toMatch(/^[a-f0-9]{64}$/); expect(identity.channels).toBe(clip === 'local' ? 2 : 1);
    // Exercise native keyboard transport without repeated pointer movement
    // and layout-stability checks competing with the realtime audio graph.
    await expect(page.getByRole('button', { name: 'Pause playback', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Pause playback', exact: true }).press('Enter');
    await expect(page.getByRole('button', { name: 'Resume playback', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Resume playback', exact: true }).press('Enter');
    await expect(page.locator('.review-replay')).toBeEnabled();
    await page.locator('.review-replay').press('Enter');
    await page.locator('.review-device').fill('Mac test output'); await page.locator('.review-notes').fill('Automated playback check; human accents, swells and decay judgments pending.');
    await page.locator('.review-note').click();
    await expect.poll(() => page.evaluate(() => document.querySelector('.audio-card').review.sessions[0].timing.length)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => document.querySelector('.audio-card').review.samples.length)).toBeGreaterThan(0);
    const download = page.waitForEvent('download'); await page.locator('.review-export').click();
    const report = JSON.parse(await readFile(await (await download).path(), 'utf8'));
    expect(report.clip.pcmSha256).toBe(identity.pcmSha256); expect(report.playbackDevice).toBe('Mac test output');
    expect(report.observations[0].notes).toContain('judgments pending'); expect(report.sessions[0].source).toBe(clip);
    expect(report.sessions[0].timing.length).toBeGreaterThan(0); expect(report.diagnosticSamples.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => captureRequests)).toBe(0);
    expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.report.acceptanceWorkload())).toBe(false);
    await expect(page.locator('.review-stop')).toBeEnabled();
    await page.locator('.review-stop').press('Enter');
    await expect(page.locator('.input-source')).toBeEnabled();
    expect(await page.evaluate(() => document.querySelector('.audio-card').review.buffer)).toBeNull();
    expect(errors).toEqual([]);
  });
}

test('invalid file and unavailable channel fail without capture; replacement and route close release files', async ({ page }) => {
  await page.addInitScript(() => { window.captureRequests = 0; MediaDevices.prototype.getUserMedia = async () => { window.captureRequests++; throw new Error('Unexpected capture'); }; });
  await advanced(page); await page.locator('.input-source').selectOption('local');
  await page.locator('.review-file').setInputFiles({ name: 'bad.wav', mimeType: 'audio/wav', buffer: Buffer.from('not audio') });
  await expect(page.locator('.audio-error')).toContainText('could not be decoded'); await expect(listening(page)).not.toBeChecked();
  await page.locator('.calibration-controls > summary').click();
  await page.locator('.calibration-controls input[type=number]').first().fill('3');
  await page.locator('.review-file').setInputFiles({ name: 'replacement.wav', mimeType: 'audio/wav', buffer: stereoWave() });
  await expect(page.locator('.audio-error')).toContainText('channel 3 is unavailable'); await expect(listening(page)).not.toBeChecked();
  await page.locator('.calibration-controls input[type=number]').first().fill('1'); await page.locator('.review-start').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.mic-status')).toBeEmpty();
  await page.evaluate(() => { window.savedReview = document.querySelector('.audio-card').review; });
  await page.getByRole('link', { name: 'About', exact: true }).click();
  expect(await page.evaluate(() => [savedReview.closed, savedReview.buffer, savedReview.localFile])).toEqual([true, null, null]);
  expect(await page.evaluate(() => captureRequests)).toBe(0);
});

test('file picker shares the source row; selecting and replacing files starts audio with Listening off', async ({ page }) => {
  await syntheticAudio(page); await advanced(page);
  await expect(page.locator('.input-source-controls .review-file')).toBeVisible();
  // Read both rectangles in one layout. Separate browser calls can straddle
  // a startup resize and compare positions from different page layouts.
  const { row, file } = await page.locator('.input-source-controls').evaluate(node => {
    const row = node.getBoundingClientRect(), file = node.querySelector('.review-file').getBoundingClientRect();
    return { row: { top: row.top, bottom: row.bottom }, file: { top: file.top, bottom: file.bottom } };
  });
  expect(file.top).toBeGreaterThanOrEqual(row.top); expect(file.bottom).toBeLessThanOrEqual(row.bottom);
  await start(page); await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.mic-status')).toBeEmpty();
  await page.evaluate(() => { window.previousContext = testContext; });
  await page.locator('.review-file').setInputFiles({ name: 'first.wav', mimeType: 'audio/wav', buffer: stereoWave() });
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.mic-status')).toBeEmpty();
  await expect(listening(page)).not.toBeChecked(); await expect(page.locator('.input-source')).toHaveValue('local');
  expect(await page.evaluate(() => previousContext.state)).toBe('closed');
  await page.evaluate(() => { window.previousContext = testContext; });
  await page.locator('.review-file').setInputFiles({ name: 'second.wav', mimeType: 'audio/wav', buffer: stereoWave() });
  await expect(page.locator('.review-status')).toContainText('second.wav:');
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.mic-status')).toBeEmpty();
  expect(await page.evaluate(() => previousContext.state)).toBe('closed');
  await page.locator('.input-source').selectOption('microphone');
  await expect(listening(page)).toBeEnabled(); await expect(listening(page)).not.toBeChecked();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-preview', 'true');
  expect(await page.evaluate(() => document.querySelector('.audio-card').review.localFile)).toBeNull();
});

test('identical decoded PCM produces identical raw loudness and filtered targets in the live worklet', async ({ page }, info) => {
  const { flashTrace } = await import('../partial/flash-fixtures.mjs');
  const { observePCM } = await import('../pcm-probe.mjs');
  await observePCM(page, await readFile(new URL('../../musical-lights-worklet/pkg/processor.js', import.meta.url), 'utf8'));
  const module = new WebAssembly.Module(await readFile(new URL('../../musical-lights-worklet/pkg/loudness.wasm', import.meta.url)));
  await advanced(page); await page.locator('.diagnostics-controls > summary').click();
  await page.locator('.input-source').selectOption('local');
  await page.locator('.calibration-controls > summary').click();
  await page.locator('.calibration-controls input[type=number]').first().fill('2');
  await page.locator('.tone-trace').check();
  await page.evaluate(() => {
    document.querySelector('.audio-card').addEventListener('tone-trace', ({ detail }) => {
      if (detail.observedPCM) window.observedPCM = Array.from(detail.observedPCM);
    });
  });
  await page.locator('.review-file').setInputFiles({ name: 'channel-equality.wav', mimeType: 'audio/wav', buffer: stereoWave() });
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.report.toneRows)).toBeGreaterThan(200);
  await page.waitForFunction(() => window.observedPCM);
  const data = await page.evaluate(() => {
    const card = document.querySelector('.audio-card'), report = document.querySelector('#dancinglights').physics.report;
    const rows = report.toneChunks.flatMap(chunk => {
      const out = [];
      for (let i = 0; i < chunk.values.length; i += chunk.stride) out.push(Array.from(chunk.values.subarray(i, i + chunk.stride)));
      return out;
    });
    return { pcm: Array.from(card.review.buffer.getChannelData(1)), observedPCM: window.observedPCM, rows: rows.slice(0, 200), dropped: report.toneWorkletDropped, firstSample: report.toneChunks[0].inputStartSample };
  });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(info.outputPath('pcm-boundary.json'), JSON.stringify(data));
  expect(data.observedPCM).toEqual(data.pcm.slice(0, data.observedPCM.length));
  expect(Number.isSafeInteger(data.firstSample)).toBe(true);
  const expected = flashTrace(module, Float32Array.from(data.pcm), false, { firstSample: data.firstSample });
  expect(data.rows).toHaveLength(200);
  // Diagnostic delivery has bounded storage and can report dropped rows.
  // Match the original audio sample timestamps, never shifted traces or IPC
  // array positions. Raw loudness and filtered targets must remain exact.
  const bySample = new Map(expected.map(row => [row[0], row]));
  let previous = data.firstSample - 96, missing = 0;
  for (const row of data.rows) {
    expect(row[0]).toBeGreaterThan(previous);
    expect((row[0] - previous) % 96).toBe(0);
    missing += (row[0] - previous) / 96 - 1; previous = row[0];
    const reference = bySample.get(row[0]);
    expect(reference, `audio sample ${row[0]}`).toBeDefined();
    expect(row.slice(1, 266)).toEqual(Array.from(reference.slice(1, 266)));
    expect(row.slice(267, 316)).toEqual(Array.from(reference.slice(267, 316)));
    for (let b = 0; b < 24; b++) expect(row[368 + b * 4]).toBe(reference[368 + b * 4]);
  }
  expect(data.dropped).toBeGreaterThanOrEqual(missing);
  const raw = data.rows.at(-1).slice(291, 315);
  expect(raw.indexOf(Math.max(...raw))).toBe(16); // Channel 2's 3.4 kHz, not channel 1's 250 Hz.
});
