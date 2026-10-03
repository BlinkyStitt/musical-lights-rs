import { test, expect } from '@playwright/test';
import { physicsReady } from '../physics-state.mjs';
const origin='http://127.0.0.1:8101';
test('physics incidents expire, rearm after recovery, and keep stopped state', async ({page}) => {
  await page.goto(origin);await physicsReady(page);
  // Only the isolated notice uses this clock; no WASM timer handles are involved.
  await page.evaluate(async () => {
    const {PhysicsNotice}=await import(document.querySelector('meta[name="musical-lights-assets"]').content + 'physics/view.js');
    document.querySelector('#dancinglights').physics.close();
    window.notice=new PhysicsNotice(document.querySelector('.physics-status'));
  });
  const clockStart = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart);
  const status=page.locator('.physics-status');
  await page.evaluate(()=>notice.sample({overloadTicks:1,debt:0,snapshotAgeMs:0},0,1000/120));
  await expect(status).toContainText('physics work limit');
  await page.clock.runFor(3000);
  await page.evaluate(()=>notice.sample({overloadTicks:20,debt:0,snapshotAgeMs:0},3000,1000/120));
  await page.clock.runFor(999);await expect(status).not.toBeEmpty();
  await page.clock.runFor(1);await expect(status).toBeEmpty();
  await page.evaluate(()=>notice.sample({overloadTicks:21,debt:0,snapshotAgeMs:0},4000,1000/120));
  await expect(status).toBeEmpty();
  await page.evaluate(()=>{
    notice.sample({overloadTicks:21,debt:0,snapshotAgeMs:0},4100,1000/120);
    notice.sample({overloadTicks:21,debt:0,snapshotAgeMs:0},5100,1000/120);
    notice.sample({overloadTicks:22,debt:0,snapshotAgeMs:0},5200,1000/120);
  });
  await expect(status).not.toBeEmpty();
  await page.evaluate(()=>notice.show('Physics stopped: test failure','Motion stopped. Reload to restart.'));
  await page.clock.runFor(4000);await expect(status).toHaveText('Motion stopped. Reload to restart.');
  await page.evaluate(()=>notice.clear());await expect(status).toBeEmpty();
  await page.evaluate(()=>notice.show('Old warning'));
  await page.clock.runFor(3000);
  await page.evaluate(()=>notice.show('Replacement warning'));
  await page.clock.runFor(1000);await expect(status).toHaveText('Replacement warning');
  await page.clock.runFor(3000);await expect(status).toBeEmpty();
});
test('microphone failure details expire while recovery status remains, and restart clears it', async ({page}) => {
  await page.addInitScript(()=>{MediaDevices.prototype.getUserMedia=async()=>{throw new Error('Permission denied for expiry test')};});
  await page.goto(`${origin}/advanced/`);await physicsReady(page);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).click();
  await expect(page.locator('.audio-error')).toContainText('Permission denied for expiry test');
  await expect(page.locator('.mic-status')).toHaveText('Microphone unavailable.');
  await expect(page.locator('.audio-error')).toBeEmpty({timeout:5000});
  await expect(page.locator('.audio-stopped')).toContainText('Audio stopped');
  await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.review-start').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.mic-status')).toBeEmpty();
  await expect(page.locator('.audio-stopped')).toBeEmpty();
  await page.getByRole('link',{name:'About',exact:true}).click();
});
