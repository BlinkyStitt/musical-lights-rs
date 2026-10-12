import { test, expect } from '@playwright/test';
import { physicsReady } from '../physics-state.mjs';
const origin='http://127.0.0.1:8101';
test.describe('expanded recovery notice geometry', () => {
  test.use({ hasTouch: true });
  for (const route of ['/', '/advanced/']) for (const viewport of [{ width: 390, height: 844 }, { width: 568, height: 320 }]) {
    test(`notices appear and clear without resizing ${route} at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(() => localStorage.setItem('musical-lights-display-v1', JSON.stringify({ version: 1, mirrorCount: 6 })));
      await page.goto(origin + route); await physicsReady(page);
      await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
      await expect.poll(() => page.evaluate(() => {
        const v = document.querySelector('#dancinglights').physics;
        return v.canvasHeight === v.layer.getBoundingClientRect().height;
      })).toBe(true);
      const geometry = () => page.evaluate(() => {
        const v = document.querySelector('#dancinglights').physics, rect = v.layer.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, enclosure: v.input[32] };
      });
      await page.evaluate(() => document.querySelector('#dancinglights').physics.notice.clear());
      const before = await geometry();
      await page.evaluate(() => document.querySelector('#dancinglights').physics.notice.show('Motion updates are delayed.', 'Motion updates are delayed.'));
      expect(await geometry()).toEqual(before);
      await page.locator('.physics-status').scrollIntoViewIfNeeded();
      await expect(page.locator('.physics-status')).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const scene = rect('.balloon-layer'), notices = rect('.recovery-notices'), controls = rect('.scene-controls');
        return { belowScene: notices.top >= scene.bottom, aboveControls: notices.bottom <= controls.top };
      })).toEqual({ belowScene: true, aboveControls: true });
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeInViewport({ ratio: 1 });
      await page.evaluate(() => document.querySelector('#dancinglights').physics.notice.clear());
      await expect(page.locator('.physics-status')).toBeEmpty();
      await page.locator('.audio-card').evaluate(n => { n.scrollTop = 0; });
      expect(await geometry()).toEqual(before);
    });
  }
});
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
