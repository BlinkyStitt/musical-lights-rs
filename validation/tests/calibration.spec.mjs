import { test, expect } from '@playwright/test';

async function input(page, pending = false) {
  await page.addInitScript(({ pending }) => {
    const NativeContext = AudioContext;
    const NativeNode = AudioWorkletNode;
    // Keep the reference generator on the capture clock. Independent realtime
    // contexts can underrun their MediaStream bridge on a loaded CI machine.
    window.AudioContext = class extends NativeContext {
      constructor(...args) { super(...args); window.sourceContext = this; }
    };
    window.AudioWorkletNode = class extends NativeNode {
      constructor(...args) {
        super(...args); window.analysisNode = this;
        window.initialMotion = args[2].processorOptions.reducedMotion;
        this.port.addEventListener('message', ({ data }) => { if (data.type === 'frame') window.producerMotion = data.state[1]; });
      }
    };
    window.captureSettings = { deviceId: 'calibration-fixture', channelCount: 2, sampleRate: 48000, autoGainControl: false, echoCancellation: false, noiseSuppression: false };
    MediaDevices.prototype.getUserMedia = async constraints => {
      window.requestedConstraints = constraints;
      if (pending) await new Promise(resolve => { window.allowMicrophone = resolve; });
      const context = window.sourceContext;
      const oscillator = context.createOscillator(); oscillator.frequency.value = 1000;
      const gain = context.createGain(); gain.gain.value = .1;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain); gain.connect(destination); oscillator.start();
      // The application owns resume: it deliberately builds the whole graph
      // while suspended to avoid gaps in the first render quanta.
      window.sourceContext = context;
      window.inputTrack = destination.stream.getAudioTracks()[0];
      window.inputTrack.getSettings = () => ({ ...window.captureSettings });
      return destination.stream;
    };
  }, { pending });
}

test('calibration is optional, measures a known reference, and binds to reported input settings', async ({ page }) => {
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await input(page);
  await page.goto('http://127.0.0.1:8101/advanced/');
  await page.locator('.calibration-controls > summary').click();
  await expect(page.locator('.calibration-status')).toContainText('Uncalibrated');
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
  expect(await page.evaluate(()=>window.requestedConstraints.audio)).toEqual({autoGainControl:false, echoCancellation:false, noiseSuppression:false});

  await page.getByRole('button', {name:'Measure reference'}).click();
  await expect(page.getByRole('button', {name:'Measure reference'})).toBeDisabled();
  await expect(page.locator('.calibration-status')).toHaveText('Calibrated for this input', {timeout:10000});
  const saved=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('musical-lights-calibration:')).map(key=>JSON.parse(localStorage.getItem(key))));
  expect(saved).toHaveLength(1);
  expect(saved[0].pascalsPerUnit).toBeCloseTo(2e-5 * 10**(94/20) / (.1/Math.sqrt(2)), 1);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
  await expect.poll(()=>page.evaluate(()=>window.inputTrack.readyState)).toBe('ended');
  await expect.poll(()=>page.evaluate(()=>window.sourceContext.state)).toBe('closed');
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  // The previous calibration label persists while the new session checks its
  // runtime and opens capture. Wait for this session before changing settings.
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
  await expect(page.locator('.calibration-status')).toHaveText('Calibrated for this input');
  // Changing capture settings invalidates the running session, even with no new user action.
  await page.evaluate(()=>{window.captureSettings.sampleRate=44100;});
  await expect(page.getByRole('alert')).toContainText('settings changed');
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeEnabled();
  await expect.poll(()=>page.evaluate(()=>window.inputTrack.readyState)).toBe('ended');
  await expect.poll(()=>page.evaluate(()=>window.sourceContext.state)).toBe('closed');
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
  await expect(page.locator('.calibration-status')).toContainText('Uncalibrated');
  expect(errors).toEqual([]);
});

for(const fault of ['mute','processorerror']) {
  test(`${fault} stops capture and clears the display`,async({page})=>{
    await input(page);
    await page.goto('http://127.0.0.1:8101/advanced/');
  await page.locator('.calibration-controls > summary').click();
    await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
    await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
    await page.evaluate(fault=>{(fault==='mute'?window.inputTrack:window.analysisNode).dispatchEvent(new Event(fault));},fault);
    await expect(page.getByRole('alert')).not.toBeEmpty();
    await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeEnabled();
    await expect.poll(()=>page.evaluate(()=>window.inputTrack.readyState)).toBe('ended');
    await expect(page.locator('.audio-card')).toHaveAttribute('data-preview', 'true');
    await expect(page.locator('.listening-toggle')).not.toBeChecked();
  });
}

test('Reduced Motion survives pending permission and updates the audio producer', async ({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await input(page, true);
  await page.goto('http://127.0.0.1:8101/advanced/');
  await page.locator('.calibration-controls > summary').click();
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect.poll(()=>page.evaluate(()=>typeof window.allowMicrophone)).toBe('function');
  // RAF can run many times while permission is pending.
  await page.waitForTimeout(100);
  await page.evaluate(()=>window.allowMicrophone());
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
  expect(await page.evaluate(()=>window.initialMotion)).toBe(true);
  await expect.poll(()=>page.evaluate(()=>window.producerMotion)).toBe(1);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await expect.poll(()=>page.evaluate(()=>window.producerMotion)).toBe(0);
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect.poll(()=>page.evaluate(()=>window.producerMotion)).toBe(1);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
  await expect.poll(()=>page.evaluate(()=>window.sourceContext.state)).toBe('closed');
});

test('forget calibration removes only the active input key and stops while reset fields is unavailable during capture', async ({ page }) => {
  await input(page); await page.goto('http://127.0.0.1:8101/advanced/');
  await page.locator('.calibration-controls > summary').click();
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.locator('.listening-toggle')).toBeEnabled(); await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.mic-status')).toBeEmpty();
  await expect(page.locator('.input-reset')).toBeDisabled();
  await page.evaluate(() => {
    window.activeCalibrationKey = 'musical-lights-calibration:' + JSON.stringify([inputTrack.getSettings(), 0, 48000]);
    localStorage.setItem(activeCalibrationKey, JSON.stringify({ pascalsPerUnit: 2 }));
    localStorage.setItem('musical-lights-calibration:other-input', JSON.stringify({ pascalsPerUnit: 3 }));
    localStorage.setItem('unrelated-history', 'keep');
  });
  await page.getByRole('button', { name: 'Forget this calibration and stop', exact: true }).click();
  await expect(page.locator('.listening-toggle')).not.toBeChecked();
  expect(await page.evaluate(() => [localStorage.getItem(activeCalibrationKey), JSON.parse(localStorage.getItem('musical-lights-calibration:other-input')).pascalsPerUnit, localStorage.getItem('unrelated-history')])).toEqual([null, 3, 'keep']);
  await expect.poll(() => page.evaluate(() => [inputTrack.readyState, sourceContext.state])).toEqual(['ended', 'closed']);
});
