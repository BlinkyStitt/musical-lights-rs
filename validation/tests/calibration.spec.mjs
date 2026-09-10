import { test, expect } from '@playwright/test';

async function input(page) {
  await page.addInitScript(() => {
    const NativeContext = AudioContext;
    const NativeNode = AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode { constructor(...args) { super(...args); window.analysisNode = this; } };
    window.captureSettings = { deviceId: 'calibration-fixture', channelCount: 2, sampleRate: 48000, autoGainControl: false, echoCancellation: false, noiseSuppression: false };
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.requestedConstraints = constraints;
      const context = new NativeContext({ sampleRate: 48000 });
      const oscillator = context.createOscillator(); oscillator.frequency.value = 1000;
      const gain = context.createGain(); gain.gain.value = .1;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain); gain.connect(destination); oscillator.start(); await context.resume();
      window.sourceContext = context;
      window.inputTrack = destination.stream.getAudioTracks()[0];
      window.inputTrack.getSettings = () => ({ ...window.captureSettings });
      return destination.stream;
    };
  });
}

test('calibration is optional, measures a known reference, and binds to actual input settings', async ({ page }) => {
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await input(page);
  await page.goto('http://127.0.0.1:8101');
  await expect(page.locator('.calibration-status')).toContainText('Uncalibrated');
  await page.getByRole('button', { name: 'Start listening' }).click();
  await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
  expect(await page.evaluate(()=>window.requestedConstraints.audio)).toEqual({autoGainControl:false, echoCancellation:false, noiseSuppression:false});
  await page.getByText('Input calibration', {exact:true}).click();
  await page.getByRole('button', {name:'Measure reference'}).click();
  await expect(page.getByRole('button', {name:'Measure reference'})).toBeDisabled();
  await expect(page.locator('.calibration-status')).toHaveText('Calibrated for this input', {timeout:10000});
  const saved=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('musical-lights-calibration:')).map(key=>JSON.parse(localStorage.getItem(key))));
  expect(saved).toHaveLength(1);
  expect(saved[0].pascalsPerUnit).toBeCloseTo(2e-5 * 10**(94/20) / (.1/Math.sqrt(2)), 1);
  await page.getByRole('button', {name:'Stop listening'}).click();
  await expect.poll(()=>page.evaluate(()=>window.inputTrack.readyState)).toBe('ended');
  await page.evaluate(()=>window.sourceContext.close());
  await page.getByRole('button', {name:'Start listening'}).click();
  await expect(page.locator('.calibration-status')).toHaveText('Calibrated for this input');
  // Changing capture settings invalidates the running session, even with no new user action.
  await page.evaluate(()=>{window.captureSettings.sampleRate=44100;});
  await expect(page.getByRole('alert')).toContainText('settings changed');
  await expect(page.getByRole('button', {name:'Start listening'})).toBeEnabled();
  await expect.poll(()=>page.evaluate(()=>window.inputTrack.readyState)).toBe('ended');
  await page.evaluate(()=>window.sourceContext.close());
  await page.getByRole('button', {name:'Start listening'}).click();
  await expect(page.locator('.calibration-status')).toContainText('Uncalibrated');
  expect(errors).toEqual([]);
});

for(const fault of ['mute','processorerror']) {
  test(`${fault} stops capture and clears the display`,async({page})=>{
    await input(page);
    await page.goto('http://127.0.0.1:8101');
    await page.getByRole('button',{name:'Start listening'}).click();
    await expect(page.getByRole('button',{name:'Stop listening'})).toBeVisible();
    await page.evaluate(fault=>{(fault==='mute'?window.inputTrack:window.analysisNode).dispatchEvent(new Event(fault));},fault);
    await expect(page.getByRole('alert')).not.toBeEmpty();
    await expect(page.getByRole('button',{name:'Start listening'})).toBeEnabled();
    await expect.poll(()=>page.evaluate(()=>window.inputTrack.readyState)).toBe('ended');
    await expect.poll(()=>page.getByRole('meter').evaluateAll(nodes=>nodes.every(n=>n.getAttribute('aria-valuenow')==='0'))).toBe(true);
  });
}

test('Reduced Motion survives pending permission and updates the audio producer', async ({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await input(page);
  await page.addInitScript(()=>{
    const acquire=navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia=async options=>{
      await new Promise(resolve=>{window.allowMicrophone=resolve;});
      return acquire(options);
    };
    const NativeNode=AudioWorkletNode;
    window.AudioWorkletNode=class extends NativeNode {
      constructor(...args){
        super(...args); window.initialMotion=args[2].processorOptions.reducedMotion;
        this.port.addEventListener('message',({data})=>{if(data.type==='frame')window.producerMotion=data.state[1];});
      }
    };
  });
  await page.goto('http://127.0.0.1:8101');
  await page.getByRole('button',{name:'Start listening'}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.allowMicrophone)).toBe('function');
  // RAF can run many times while permission is pending.
  await page.waitForTimeout(100);
  await page.evaluate(()=>window.allowMicrophone());
  await expect(page.getByRole('button',{name:'Stop listening'})).toBeVisible();
  expect(await page.evaluate(()=>window.initialMotion)).toBe(true);
  await expect.poll(()=>page.evaluate(()=>window.producerMotion)).toBe(1);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await expect.poll(()=>page.evaluate(()=>window.producerMotion)).toBe(0);
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect.poll(()=>page.evaluate(()=>window.producerMotion)).toBe(1);
  await page.getByRole('button',{name:'Stop listening'}).click();
  await page.evaluate(()=>window.sourceContext.close());
});
