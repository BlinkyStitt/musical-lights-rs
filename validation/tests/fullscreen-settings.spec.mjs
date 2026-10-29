import { test, expect } from '@playwright/test';
import { clickControlAtHitPoint } from '../control-input.mjs';
import { normalView, physicsReady, scrollingIntersections, syntheticAudio } from '../physics-state.mjs';
const origin = 'http://127.0.0.1:8101';

test.describe('compact mobile controls', () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  for (const path of ['/', '/advanced/']) {
    test(`compact toolbar toggles show pressed state and preserve native controls on ${path}`, async ({ page }, info) => {
      await page.setViewportSize({ width: 393, height: 852 });
      await page.addInitScript(() => {
        window.compactCaptures = 0;
        MediaDevices.prototype.getUserMedia = () => { compactCaptures++; return new Promise(() => {}); };
        for (const name of ['DeviceMotionEvent', 'DeviceOrientationEvent']) {
          if (!window[name]) window[name] = class {};
          Object.defineProperty(window[name], 'requestPermission', { configurable: true, value: () => Promise.resolve('granted') });
        }
      });
      await page.goto(origin + path); await physicsReady(page);
      await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
      const motion = page.getByRole('checkbox', { name: 'Phone motion', exact: true });
      const listening = page.getByRole('checkbox', { name: 'Listening', exact: true });
      const face = control => control.evaluate(input => ({
        color: getComputedStyle(input).backgroundColor, shadow: getComputedStyle(input).boxShadow,
        mark: getComputedStyle(input, '::after').content, markVisible: getComputedStyle(input, '::after').display !== 'none',
      }));
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme });
        for (const width of [320, 393, 568]) {
          await page.setViewportSize({ width, height: 852 });
          expect(await page.locator('.fullscreen-toolbar').evaluate(toolbar => [...toolbar.children].every(node => {
            const r = node.getBoundingClientRect();
            return Math.abs(r.height - 44) < 1 && r.width >= 44
              && node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          }))).toBe(true);
        }
        await page.setViewportSize({ width: 393, height: 852 });
        const off = await face(motion);
        expect(off.markVisible).toBe(false);
        await motion.focus(); await page.keyboard.press('Space');
        await expect(motion).toBeChecked();
        const on = await face(motion);
        expect(on.color).not.toBe(off.color); expect(on.shadow).toContain('inset');
        expect(on.mark).toContain('✓'); expect(on.markVisible).toBe(true);
        expect(await page.evaluate(() => compactCaptures)).toBe(0);
        await page.mouse.move(0, 0); await motion.blur();
        await page.locator('.fullscreen-toolbar').screenshot({ path: info.outputPath(`compact-motion-on-${colorScheme}.png`) });
        await motion.focus(); await page.keyboard.press('Space');
        await expect(motion).not.toBeChecked(); expect(await face(motion)).toEqual(off);
      }
      await listening.tap();
      await expect(listening).toBeChecked();
      await expect.poll(() => page.evaluate(() => compactCaptures)).toBe(1);
      expect((await face(listening)).shadow).toContain('inset');
      await page.locator('.fullscreen-toolbar').screenshot({ path: info.outputPath('compact-listening-on.png') });
      await page.evaluate(() => { window.compactInputs = [document.querySelector('.motion-button'), document.querySelector('.listening-toggle')]; });
      await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Settings', exact: true }));
      expect(await page.evaluate(() => compactInputs.every(n => n.closest('dialog[open]')))).toBe(true);
      await expect(page.getByRole('button', { name: 'Phone motion', exact: true })).toBeVisible();
      await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Close settings', exact: true }));
      expect(await page.evaluate(() => compactInputs.every(n => n.closest('.fullscreen-toolbar')))).toBe(true);
      await expect(listening).toBeChecked();
      await listening.uncheck(); await expect(listening).not.toBeChecked();
      expect((await face(listening)).markVisible).toBe(false);
      expect(await page.evaluate(() => compactCaptures)).toBe(1);
    });
  }
});

for (const path of ['/', '/advanced/']) {
  test(`fullscreen settings cover only the top half and preserve the scene on ${path}`, async ({ page }, info) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      Object.defineProperty(document, 'fullscreenEnabled', { value: false });
      window.micRequests = 0;
      MediaDevices.prototype.getUserMedia = async () => { window.micRequests++; throw new Error('Test microphone denied'); };
    });
    await page.goto(origin + path); await physicsReady(page);
    await normalView(page);
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
    // The entry action still requests Listening. Opening settings adds no input.
    await expect.poll(() => page.evaluate(() => micRequests)).toBe(1);
    await expect(page.locator('.listening-toggle')).toBeEnabled();
    await expect(page.locator('.audio-error')).toBeEmpty({ timeout: 5000 });
    for (const viewport of [{ width: 390, height: 844 }, { width: 568, height: 320 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.evaluate(() => {
        const v = document.querySelector('#dancinglights').physics;
        return v.canvasHeight === v.layer.getBoundingClientRect().height;
      })).toBe(true);
      // Close can reveal Listening under the pointer. Compare the scene with
      // hover help dismissed, including after a viewport orientation change.
      await page.mouse.move(0, 0);
      await expect(page.locator('.control-help')).not.toBeVisible();
      const before = await page.evaluate(() => {
        const v = document.querySelector('#dancinglights').physics;
        window.modalIdentity = { worker: v.worker, renderer: v.renderer, zoom: document.querySelector('.camera-zoom'), controls: document.querySelector('.listening-toggle'), render: v.renderer.render };
        v.renderer.render = () => {};
        const box = v.layer.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, enclosure: v.input[32] };
      });
      const clip = { x: 0, y: Math.ceil(viewport.height / 2), width: viewport.width, height: Math.floor(viewport.height / 2) };
      const uncovered = await page.screenshot({ clip });
      const settings = page.getByRole('button', { name: 'Settings', exact: true });
      await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => {
        const toggle = document.querySelector('.listening-toggle'), label = toggle.closest('label');
        const gear = document.querySelector('.fullscreen-settings-button');
        const left = label.getBoundingClientRect(), right = gear.getBoundingClientRect();
        return { toolbar: !!label.closest('.fullscreen-toolbar'), left: left.right <= right.left,
          touch: toggle.getBoundingClientRect().height >= 44, gearWidth: right.width >= 44,
          icon: gear.querySelector('svg')?.getAttribute('aria-hidden'), text: gear.textContent.trim(),
          count: document.querySelectorAll('.listening-toggle').length };
      })).toEqual({ toolbar: true, left: true, touch: true, gearWidth: true, icon: 'true', text: '', count: 1 });
      await clickControlAtHitPoint(page, settings);
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      await expect(dialog).toBeVisible();
      await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      expect(await dialog.evaluate(n => n.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toBeFocused();
      const box = await dialog.boundingBox();
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height / 2);
      const covered = await page.screenshot({ clip });
      if (!covered.equals(uncovered)) {
        await info.attach(`bottom-before-${viewport.width}.png`, { body: uncovered, contentType: 'image/png' });
        await info.attach(`bottom-after-${viewport.width}.png`, { body: covered, contentType: 'image/png' });
        await info.attach('pixel-layout.json', { body: JSON.stringify(await page.evaluate(() => {
          const v = document.querySelector('#dancinglights').physics;
          return { canvas: [v.canvas.width, v.canvas.height, v.canvasWidth, v.canvasHeight], scene: v.layer.getBoundingClientRect().toJSON(),
            modal: document.querySelector('dialog').getBoundingClientRect().toJSON(), viewport: [innerWidth, innerHeight], pending: v.resizePending };
        })), contentType: 'application/json' });
      }
      expect(covered.equals(uncovered), 'bottom-half pixels remain visible through the modal backdrop').toBe(true);
      const selectors = ['.listening-toggle', '.identify-song', '.motion-button', '.scroll-lights', '.camera-rotation', '.camera-zoom', '.camera-x', '.camera-y', '.depth-slider', '.ball-count', '.small-ball', '.big-ball', '.display-controls > summary'];
      // Observe each control after its real scroll, in one browser call. Keep
      // visibility and modal ownership checks for every original selector.
      for (const [selector, ratio] of Object.entries(await scrollingIntersections(page, selectors))) {
        expect(ratio, `${selector} intersects the viewport`).toBeGreaterThan(0);
      }
      if (!await page.locator('.audio-tuning').evaluate(n => n.closest('details').open)) await page.getByText('Audio response & readouts', { exact: true }).click();
      expect((await scrollingIntersections(page, ['.visual-gain-mode']))['.visual-gain-mode']).toBeGreaterThan(0);
      selectors.push('.visual-gain-mode');
      expect(await page.evaluate(selectors => selectors.map(selector => !!document.querySelector(selector)?.closest('dialog')), selectors)).toEqual(selectors.map(() => true));
      await page.locator('.camera-rotation').fill('17');
      await page.locator('.camera-zoom').fill('40');
      await page.locator('.camera-x').fill('30'); await page.locator('.camera-y').fill('60');
      await expect(page.getByRole('button', { name: 'Edit Zoom', exact: true })).toHaveText('40%');
      expect(await page.locator('.camera-zoom').evaluate(n => n.getBoundingClientRect().height >= 44)).toBe(true);
      await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.cameraBase)).toBe(17);
      await page.locator('.fullscreen-settings-body').evaluate(n => { n.scrollTop = n.scrollHeight; });
      await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => {
        const card = document.querySelector('.audio-card'), v = card.querySelector('#dancinglights').physics, box = v.layer.getBoundingClientRect();
        card.scrollTop = 1000;
        return { same: v.worker === modalIdentity.worker && v.renderer === modalIdentity.renderer && document.querySelector('.camera-zoom') === modalIdentity.zoom && card.querySelector('.listening-toggle') === modalIdentity.controls,
          scroll: card.scrollTop, requests: micRequests, geometry: { x: box.x, y: box.y, width: box.width, height: box.height, enclosure: v.input[32] } };
      })).toEqual({ same: true, scroll: 0, requests: 1, geometry: before });
      await page.screenshot({ path: info.outputPath(`modal-${viewport.width}.png`) });
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
      await expect(settings).toBeFocused();
      await clickControlAtHitPoint(page, settings);
      await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Close settings', exact: true }));
      await expect(dialog).not.toBeVisible();
      await page.evaluate(() => { document.querySelector('#dancinglights').physics.renderer.render = modalIdentity.render; });
    }
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Exit fullscreen', exact: true }));
    await expect(page.locator('.scene-controls')).toBeVisible();
    await expect(page.locator('.camera-rotation')).toHaveValue('17');
    await expect(page.locator('.camera-zoom')).toHaveValue('40');
    await expect(page.locator('.camera-x')).toHaveValue('30'); await expect(page.locator('.camera-y')).toHaveValue('60');
    expect(await page.evaluate(() => document.querySelector('.listening-toggle') === modalIdentity.controls)).toBe(true);
    expect(errors).toEqual([]);
  });
}

async function startFullscreenAudio(page, path, reducedMotion, info) {
  await page.emulateMedia({ reducedMotion });
  await syntheticAudio(page);
  await page.addInitScript(() => {
    const Context = window.AudioContext;
    window.AudioContext = class extends Context {
      constructor(...args) { super(...args); window.modalContext = this; this.closeCalls = 0; }
      close() { this.closeCalls++; return super.close(); }
    };
  });
  await page.goto(origin + path); await physicsReady(page); await normalView(page);
  if (path === '/advanced/') {
    await page.locator('.input-source').selectOption('generated');
    await page.locator('.review-start').click();
  } else await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await page.evaluate(() => { window.modalSession = { context: modalContext, id: document.querySelector('.audio-card').dataset.audioSession }; });
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
  if (info.project.name === 'chromium') await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.querySelector('.visualizer-screen'))).toBe(true);
}

for (const path of ['/', '/advanced/']) for (const reducedMotion of ['reduce', 'no-preference']) {
  test(`all turns retain native fullscreen and switch help on ${path} (${reducedMotion})`, async ({ page }, info) => {
    await startFullscreenAudio(page, path, reducedMotion, info);
    for (let turn = 0; turn < 4; turn++) {
      if (info.project.name === 'chromium') {
        expect(await page.evaluate(() => document.fullscreenElement === document.querySelector('.visualizer-screen'))).toBe(true);
      }
      await expect.poll(() => page.locator('.audio-card').evaluate((n, turn) => {
        const r = n.getBoundingClientRect();
        return n.displayQuarterTurn === turn && Math.abs(r.width - innerWidth) < 1 && Math.abs(r.height - innerHeight) < 1;
      }, turn)).toBe(true);
      const motion = page.getByRole('checkbox', { name: 'Phone motion', exact: true });
      await motion.hover();
      await expect(page.locator('.control-help')).toContainText('Phone motion lets measured tilt');
      await page.mouse.move(0, 0);
      await expect(page.locator('.control-help')).toBeHidden();
      // The single toolbar control receives focus without enabling sensors.
      await page.locator('.rotate-display').focus(); await page.keyboard.press('Tab');
      await expect(motion).toBeFocused();
      await expect(page.locator('.control-help')).toBeVisible();
      await expect(motion).not.toBeChecked();
      expect(await motion.evaluate(n => getComputedStyle(n).outlineStyle)).not.toBe('none');
      await expect(page.locator('.rotate-display')).toHaveAccessibleName(`Rotate view clockwise, current rotation ${turn * 90} degrees`);
      await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Settings', exact: true }));
      await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
      const help = page.getByRole('button', { name: 'Phone motion', exact: true });
      await help.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Space');
      await expect(page.locator('.control-help')).toBeVisible();
      await expect(motion).not.toBeChecked();
      expect(await page.locator('.fullscreen-settings').evaluate((n, turn) => {
        const r = n.getBoundingClientRect();
        return [r.bottom <= innerHeight / 2, r.left >= innerWidth / 2, r.top >= innerHeight / 2, r.right <= innerWidth / 2][turn];
      }, turn)).toBe(true);
      await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Close settings', exact: true }));
      await clickControlAtHitPoint(page, page.locator('.rotate-display'));
    }
    expect(await page.evaluate(() => modalContext === modalSession.context && modalContext.state === 'running'
      && document.querySelector('.audio-card').dataset.audioSession === modalSession.id)).toBe(true);
  });

  test(`camera sliders preserve one live fullscreen session through all turns on ${path} (${reducedMotion})`, async ({ page }, info) => {
    await startFullscreenAudio(page, path, reducedMotion, info);
    await page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      window.rotatingCameraResources = [v.worker, v.renderer, v.balls];
    });
    // Keep the complete four-turn camera workflow separate from the complete
    // help/keyboard workflow above. Each retains the normal 30-second deadline.
    for (let turn = 0; turn < 4; turn++) {
      await expect(page.locator('.rotate-display')).toHaveAccessibleName(`Rotate view clockwise, current rotation ${turn * 90} degrees`);
      await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Settings', exact: true }));
      await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
      // Camera clicks must work while the existing switch help is open too.
      await page.getByRole('button', { name: 'Phone motion', exact: true }).focus();
      await expect(page.locator('.control-help')).toBeVisible();
      await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Increase Zoom', exact: true }));
      await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Increase Horizontal position', exact: true }));
      await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Decrease Vertical position', exact: true }));
      // Sample readout, shared parameters, geometry and resource ownership in
      // one browser call; separate traced reads needlessly stall CI rendering.
      await expect.poll(() => page.evaluate(turn => {
        const card = document.querySelector('.audio-card'), v = card.querySelector('#dancinglights').physics;
        const r = document.querySelector('.fullscreen-settings').getBoundingClientRect();
        return { values: [v.cameraParameters.get('cameraZoom'), v.cameraPan.x * 100, v.cameraPan.y * 100],
          readout: card.querySelector('.camera-zoom').closest('.slider-control').querySelector('.slider-value').textContent,
          same: [v.worker, v.renderer, v.balls].every((value, i) => value === rotatingCameraResources[i])
            && modalContext === modalSession.context && modalContext.state === 'running'
            && card.dataset.audioSession === modalSession.id && modalContext.closeCalls === 0,
          motion: card.querySelector('.motion-button').checked,
          topHalf: [r.bottom <= innerHeight / 2, r.left >= innerWidth / 2, r.top >= innerHeight / 2, r.right <= innerWidth / 2][turn],
          native: document.fullscreenElement === document.querySelector('.visualizer-screen') };
      }, turn)).toMatchObject({ values: [101 + turn, 51 + turn, 49 - turn], readout: `${101 + turn}%`,
        same: true, motion: false, topHalf: true, ...(info.project.name === 'chromium' ? { native: true } : {}) });
      await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Close settings', exact: true }));
      await clickControlAtHitPoint(page, page.locator('.rotate-display'));
    }
    await expect(page.locator('.rotate-display')).toHaveAccessibleName('Rotate view clockwise, current rotation 0 degrees');
    expect(await page.evaluate(() => modalContext === modalSession.context && modalContext.state === 'running'
      && document.querySelector('.audio-card').dataset.audioSession === modalSession.id)).toBe(true);
  });

  test(`settings close on native browser exit and route cleanup on ${path} (${reducedMotion})`, async ({ page }, info) => {
    await startFullscreenAudio(page, path, reducedMotion, info);
    await clickControlAtHitPoint(page, page.locator('.rotate-display'));
    await expect(page.locator('.audio-card')).toHaveAttribute('data-display-rotation', '1');
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Settings', exact: true }));
    if (info.project.name === 'chromium') {
      expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
      await page.evaluate(() => document.exitFullscreen());
    } else {
      // iPhone has page expansion without the native API. Use its screen owner.
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    }
    await expect(page.locator('.audio-card')).not.toHaveAttribute('data-expanded', '');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if (path === '/advanced/') await expect(page.locator('.input-source')).toHaveValue('generated');
    else await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
    expect(await page.evaluate(() => ({ same: modalContext === modalSession.context, state: modalContext.state, id: document.querySelector('.audio-card').dataset.audioSession }))).toEqual({ same: true, state: 'running', id: await page.evaluate(() => modalSession.id) });
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Settings', exact: true }));
    await page.evaluate(() => { window.oldModal = document.querySelector('dialog'); document.querySelector('nav a[href="/about"]').click(); });
    await expect(page.locator('.audio-card')).toHaveCount(0);
    expect(await page.evaluate(() => oldModal.open || oldModal.isConnected)).toBe(false);
    expect(await page.evaluate(() => ({ retired: modalSession.context.audioRetired, closeCalls: modalSession.context.closeCalls }))).toEqual({ retired: true, closeCalls: 1 });
    await expect.poll(() => page.evaluate(() => modalSession.context.state)).toBe('closed');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe('hidden');
    await page.getByRole('link', { name: 'Home', exact: true }).click(); await physicsReady(page);
    await expect(page.locator('dialog')).toHaveCount(1);
    expect(await page.locator('.audio-card').evaluate(n => n.displayQuarterTurn)).toBe(0);
  });
}


test('Escape respects focused controls, closes Settings, and exits with action help open', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await page.locator('.input-source').selectOption('generated');
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Settings', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  const input = page.locator('.camera-rotation');
  // A focused editor can consume Escape before the dialog's native cancel.
  await input.evaluate(node => node.addEventListener('keydown', event => {
    if (event.key === 'Escape') event.preventDefault();
  }, { once: true }));
  await input.focus(); await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
  await page.getByRole('button', { name: 'Close settings', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).focus();
  await expect(page.locator('.control-help')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.audio-card')).not.toHaveAttribute('data-expanded', '');
  await expect(page.locator('.control-help')).not.toBeVisible();
  await expect(page.locator('.listening-toggle')).toBeVisible();
});


test('queued dialog close keeps new action help and Escape usable', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await page.locator('.input-source').selectOption('generated');
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Settings', exact: true }));
  const result = await page.evaluate(async () => {
    const card = document.querySelector('.audio-card'), dialog = card.querySelector('dialog');
    const closed = new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
    // Isolate the event ordering in one browser turn. Trusted pointer close
    // and focus return have separate coverage in the layout test above.
    dialog.querySelector('.close-fullscreen-settings').click();
    card.querySelector('.fullscreen-button').focus();
    await closed;
    return { open: dialog.open, help: !card.querySelector('.control-help').hidden,
      exitFocused: document.activeElement === card.querySelector('.fullscreen-button') };
  });
  expect(result).toEqual({ open: false, help: true, exitFocused: true });
  await page.keyboard.press('Escape');
  await expect(page.locator('.audio-card')).not.toHaveAttribute('data-expanded', '');
});


for (const path of ['/', '/advanced/']) {
  test(`narrow rotation toolbar fits fallback fonts and safe areas on ${path}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage();
      await page.goto(origin + path); await physicsReady(page);
      // Font metrics differ across hosts. A wide fallback exercises intrinsic
      // sizing without relying on the CI host's installed Comic Sans substitute.
      await page.addStyleTag({ content: '.fullscreen-toolbar { font-family: monospace; }' });
      await page.evaluate(() => {
        const card = document.querySelector('.audio-card');
        for (const side of ['top', 'right', 'bottom', 'left']) card.style.setProperty(`--safe-${side}`, '12px');
        card.querySelector('#dancinglights').physics.notice.show('Graphics recovery notice.', 'Graphics recovery notice.');
      });
      for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
        await page.setViewportSize(viewport);
        for (let turn = 0; turn < 4; turn++) {
          await expect.poll(() => page.evaluate(() => {
            const bar = document.querySelector('.fullscreen-toolbar');
            const controls = [...bar.querySelectorAll('button, label')];
            const rects = controls.map(n => n.getBoundingClientRect());
            const fits = r => r.left >= 12 && r.top >= 12 && r.right <= innerWidth - 12 && r.bottom <= innerHeight - 12;
            const separate = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
            const label = bar.querySelector('label'), gear = bar.querySelector('.fullscreen-settings-button');
            const notice = document.querySelector('.recovery-notices').getBoundingClientRect();
            return {
              overflow: bar.scrollWidth > bar.clientWidth,
              controls: rects.every((r, i) => fits(r) && r.width >= 44 && r.height >= 44
                && controls[i].contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))),
              separate: rects.every((a, i) => rects.slice(i + 1).every(b => separate(a, b))),
              textFits: label.scrollWidth <= label.clientWidth,
              listeningLeft: label.offsetLeft + label.offsetWidth <= gear.offsetLeft,
              notice: fits(notice) && rects.every(r => separate(r, notice)),
            };
          })).toEqual({ overflow: false, controls: true, separate: true, textFits: true, listeningLeft: true, notice: true });
          await page.getByRole('button', { name: 'Settings', exact: true }).tap();
          await page.getByRole('button', { name: 'Close settings', exact: true }).tap();
          await page.locator('.rotate-display').tap();
          await expect(page.locator('.rotate-display')).toHaveAccessibleName(`Rotate view clockwise, current rotation ${((turn + 1) % 4) * 90} degrees`);
        }
      }
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
      await expect(page.locator('.audio-card')).not.toHaveAttribute('data-expanded', '');
    } finally { await context.close(); }
  });
}

test('toolbar Listening keeps one microphone session through Settings and restores on exit', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await syntheticAudio(page);
  await page.addInitScript(() => {
    const capture = MediaDevices.prototype.getUserMedia;
    window.toolbarCaptures = 0;
    MediaDevices.prototype.getUserMedia = async (...args) => { toolbarCaptures++; return capture.call(navigator.mediaDevices, ...args); };
  });
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
  const listening = page.getByRole('checkbox', { name: 'Listening', exact: true });
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(listening).toBeChecked();
  await expect(listening).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => {
    const bar = document.querySelector('.fullscreen-toolbar'), label = bar.querySelector('label');
    const gear = bar.querySelector('.fullscreen-settings-button'), exit = bar.querySelector('.fullscreen-button');
    return { textFits: label.scrollWidth <= label.clientWidth, fits: bar.scrollWidth <= bar.clientWidth,
      order: exit.getBoundingClientRect().right <= label.getBoundingClientRect().left && label.getBoundingClientRect().right <= gear.getBoundingClientRect().left };
  })).toEqual({ textFits: true, fits: true, order: true });
  await page.evaluate(() => { window.toolbarAudio = { context: testContext, input: document.querySelector('.listening-toggle'), session: document.querySelector('.audio-card').dataset.audioSession }; });
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Settings', exact: true }));
  await expect(listening).toBeChecked();
  expect(await listening.evaluate(n => !!n.closest('dialog'))).toBe(true);
  const close = page.getByRole('button', { name: 'Close settings', exact: true });
  if (info.project.use.hasTouch) await close.tap(); else await close.click();
  await expect(listening).toBeChecked();
  await expect(listening).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => ({ same: testContext === toolbarAudio.context && document.querySelector('.listening-toggle') === toolbarAudio.input,
    session: document.querySelector('.audio-card').dataset.audioSession === toolbarAudio.session, state: testContext.state, captures: toolbarCaptures }))).toEqual({ same: true, session: true, state: 'running', captures: 1 });
  await listening.uncheck();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'stopped');
  await expect.poll(() => page.evaluate(() => toolbarAudio.context.state)).toBe('closed');
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Exit fullscreen', exact: true }));
  expect(await listening.evaluate(n => !!n.closest('.audio-controls') && !n.closest('.fullscreen-toolbar'))).toBe(true);
  await expect(listening).not.toBeChecked();
  await expect(listening).toHaveCount(1);
});

// The native number editor owns cancellation before its containing dialog.
test('Escape cancels a typed slider value before it closes fullscreen Settings', async ({ page }) => {
  // Browser-native Escape can leave fullscreen before DOM key dispatch.
  // Native exit has separate coverage; editor ownership uses page expansion.
  await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  await page.locator('.input-source').selectOption('generated');
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Settings', exact: true }));
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Edit Box depth (cm)', exact: true }));
  const editor = page.getByRole('spinbutton', { name: 'Box depth (cm) value', exact: true });
  await editor.fill('90'); await editor.press('Escape');
  await expect(editor).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Box depth (cm)', exact: true })).toHaveValue('48');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).not.toBeVisible();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
});

for (const path of ['/', '/advanced/']) {
  test(`ball controls apply live, persist and reuse scene resources on ${path}`, async ({ page }) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await syntheticAudio(page);
    await page.addInitScript(() => { Object.defineProperty(document, 'fullscreenEnabled', { value: false }); });
    await page.goto(origin + path); await physicsReady(page); await normalView(page);
    await page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      window.ballScene = { balls: v.balls, bars: v.bars, canvas: v.canvas, worker: v.worker, geometries: v.renderer.info.memory.geometries };
    });
    const count = page.getByRole('slider', { name: 'Ball count', exact: true });
    const small = page.getByRole('slider', { name: 'Small ball (cm)', exact: true });
    const big = page.getByRole('slider', { name: 'Big ball (cm)', exact: true });
    // Camera and ball preferences share the relocated controls and reset owner.
    await page.locator('.camera-zoom').fill('135');
    await expect(count).toHaveValue('8'); await expect(small).toHaveValue('2.64'); await expect(big).toHaveValue('19.2');
    for (const n of [0, 16, 8, 0, 16, 8]) {
      await count.fill(String(n));
      // Normal-page settings can scroll the scene out of view. Return to the
      // scene to inspect the rendered instances, as a viewer does after editing.
      expect((await scrollingIntersections(page, ['#dancinglights']))['#dancinglights']).toBeGreaterThan(0);
      await expect.poll(() => page.evaluate(() => {
        const v = document.querySelector('#dancinglights').physics;
        return [v.current[v.layout[30]], v.balls.count];
      })).toEqual([n, n]);
      if (n === 0) expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.lighting.uniforms.glowBallColor.value.every(c => c.r === 0 && c.g === 0 && c.b === 0))).toBe(true);
    }
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Settings', exact: true }));
    const modal = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
    const audioSession = await page.locator('.audio-card').getAttribute('data-audio-session');
    await page.evaluate(() => { window.ballAudioContext = document.querySelector('.audio-card').activeAudioContext; });
    for (const control of [count, small, big, page.locator('.depth-slider')]) {
      expect(await control.evaluate(n => !!n.closest('dialog'))).toBe(true);
      await expect(control).toHaveCount(1);
    }
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Edit Small ball (cm)', exact: true }));
    const editor = page.getByRole('spinbutton', { name: 'Small ball (cm) value', exact: true });
    await editor.fill('19.2'); await editor.press('Enter');
    await expect(small).toHaveValue('19.2'); await expect(big).toHaveAttribute('min', '19.2');
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Decrease Big ball (cm)', exact: true }));
    await expect(big).toHaveValue('19.2');
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Edit Big ball (cm)', exact: true }));
    const bigEditor = page.getByRole('spinbutton', { name: 'Big ball (cm) value', exact: true });
    await bigEditor.fill('19.19'); await bigEditor.press('Enter');
    await expect(bigEditor).toBeVisible(); await expect(big).toHaveValue('19.2');
    await bigEditor.press('Escape'); await expect(modal).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      return Array.from({ length: v.balls.count }, (_, i) => {
        const m = v.balls.instanceMatrix.array, at = i * 16;
        return Math.abs(v.current[3 + i * v.layout[8] + 7] - .096) < 1e-6
          && Math.abs(Math.hypot(m[at], m[at + 1], m[at + 2]) - .096) < 1e-6;
      }).every(Boolean);
    })).toBe(true);
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Decrease Ball count', exact: true })); await expect(count).toHaveValue('7');
    await count.focus(); await count.press('ArrowRight'); await expect(count).toHaveValue('8');
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Edit Ball count', exact: true }));
    await page.getByRole('spinbutton', { name: 'Ball count value', exact: true }).fill('0');
    await page.keyboard.press('Escape'); await expect(count).toHaveValue('8');
    expect(await page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics, old = window.ballScene;
      return v.balls === old.balls && v.bars === old.bars && v.canvas === old.canvas && v.worker === old.worker && v.renderer.info.memory.geometries === old.geometries;
    })).toBe(true);
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-session', audioSession);
    expect(await page.evaluate(() => document.querySelector('.audio-card').activeAudioContext === window.ballAudioContext && window.ballAudioContext.state === 'running')).toBe(true);
    await page.keyboard.press('Escape'); await expect(modal).not.toBeVisible();
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Exit fullscreen', exact: true }));
    await page.reload(); await physicsReady(page); await normalView(page);
    await expect(small).toHaveValue('19.2'); await expect(count).toHaveValue('8');
    await expect(page.locator('.camera-zoom')).toHaveValue('135');
    await page.locator('.display-controls > summary').click(); await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Reset display', exact: true }));
    await expect(small).toHaveValue('2.64'); await expect(big).toHaveValue('19.2'); await expect(count).toHaveValue('8');
    await expect(page.locator('.camera-zoom')).toHaveValue('100');
    expect(errors).toEqual([]);
  });
}

test('ball settings transitions render the room and bodies from the same applied tick', async ({ page }, info) => {
  await page.goto(origin + '/advanced/'); await physicsReady(page);
  const results = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const { default: init, PhysicsSimulation } = await import(new URL(`${base}physics/physics.js`, document.baseURI));
    const wasm = await init();
    cancelAnimationFrame(v.request); v.stopPreview();
    const results = [];
    for (const beforeCount of [0, 16]) {
      const config = PhysicsSimulation.defaults(); config[0] = .4; config[5] = .2;
      config[8] = beforeCount; config[9] = config[10] = beforeCount ? .0264 : .192;
      const sim = new PhysicsSimulation(config, new Float32Array(v.palette));
      try {
        const previous = new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), v.layout[12]).slice();
        const input = new Float32Array(v.layout[22]); input[32] = .4; input[62] = .2; input.set([16, .192, .192], 64);
        sim.input(input); sim.step();
        v.previous = previous;
        v.current = new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), v.layout[12]).slice();
        v.pigments = new Float32Array(wasm.memory.buffer, sim.pigments_ptr(), 16 * 9).slice();
        v.config[5] = .2;
        const now = performance.now(); v.received = now; v.draw(now);
        const matrix = v.balls.instanceMatrix.array;
        const contained = Array.from({ length: v.balls.count }, (_, i) => {
          const at = i * 16, radius = Math.hypot(matrix[at], matrix[at + 1], matrix[at + 2]);
          const x = matrix[at + 12], y = matrix[at + 13], z = matrix[at + 14];
          return x - radius >= -.001 && x + radius <= v.width + .001
            && y - radius >= -.001 && y + radius <= v.renderedEnclosureHeight + .001
            && Math.abs(z) + radius <= v.renderedDepth / 2 + .001;
        }).every(Boolean);
        results.push({ beforeCount, count: v.balls.count, applied: v.current[v.layout[17]], rendered: v.renderedEnclosureHeight, contained, alpha: v.renderAlpha });
      } finally { sim.free(); }
    }
    return results;
  });
  await info.attach('ball-setting-transitions', { body: JSON.stringify(results), contentType: 'application/json' });
  for (const result of results) {
    expect(result.count).toBe(16);
    expect(result.rendered).toBeCloseTo(result.applied, 6);
    expect(result.contained).toBe(true);
    expect(result.alpha).toBe(1);
  }
});

for (const path of ['/', '/advanced/']) {
  test(`activation floor recovery and help share keyboard and touch controls on ${path}`, async ({ page }, info) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('seededActivation')) {
        localStorage.setItem('musical-lights-display-v1', JSON.stringify({ version: 1, visual: [1, -60, 3, 2], youtubeLink: '' }));
        sessionStorage.setItem('seededActivation', 'true');
      }
      MediaDevices.prototype.getUserMedia = async () => { throw Error('No microphone needed'); };
      Object.defineProperty(document, 'fullscreenEnabled', { value: false });
    });
    await page.goto(origin + path); await physicsReady(page);
    await normalView(page);
    await page.getByText('Audio response & readouts', { exact: true }).click();
    await expect(page.locator('.gate-reset-notice')).toContainText('disabled / 0.1 sones');
    await expect(page.locator('.visual-gain-mode')).toHaveValue('3');
    await expect(page.locator('.manual-visual-gain')).toHaveValue('2');
    const help = page.getByRole('button', { name: 'Activation floor help', exact: true });
    await help.focus(); await expect(page.locator('.control-help')).toContainText('does not remove fans');
    await page.keyboard.press('Escape'); await expect(page.locator('.control-help')).not.toBeVisible();
    if (info.project.use.hasTouch) await help.tap(); else await help.click();
    await expect(page.locator('.control-help')).toContainText('calibration is optional');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.floorIdentity = document.querySelector('.microphone-floor'); });
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const floor = page.getByLabel('Activation floor (sones)', { exact: true });
    await floor.fill('.00001'); await floor.press('Tab');
    await expect(floor).toHaveValue('0.00001');
    expect(await floor.evaluate(n => n === window.floorIdentity && !!n.closest('dialog') && n.getBoundingClientRect().height >= 44)).toBe(true);
    await expect(page.locator('.microphone-gate-status')).toHaveText('Activation gate: unavailable');
    const lowerScene = await page.evaluate(() => {
      const view = document.querySelector('#dancinglights').physics;
      window.activationRender = view.renderer.render; view.renderer.render = () => {};
      document.querySelector('.audio-card').presentation.hideHelp();
      return { x: 0, y: Math.ceil(innerHeight / 2), width: innerWidth, height: Math.floor(innerHeight / 2) };
    });
    const withoutHelp = await page.screenshot({ clip: lowerScene });
    await page.evaluate(() => document.querySelector('.audio-card').presentation.showHelp(document.querySelector('.activation-help'), 'activation-floor'));
    await expect(page.locator('.control-help')).toBeVisible();
    await expect(page.locator('.control-help')).toHaveCSS('pointer-events', 'auto');
    const withHelp = await page.screenshot({ clip: lowerScene });
    if (!withHelp.equals(withoutHelp)) {
      await info.attach('scene-without-help.png', { body: withoutHelp, contentType: 'image/png' });
      await info.attach('scene-with-help.png', { body: withHelp, contentType: 'image/png' });
    }
    expect(withHelp.equals(withoutHelp), 'help preserves every lower-half rendered pixel').toBe(true);
    const helpBounds = await page.evaluate(() => {
      const help = document.querySelector('.control-help').getBoundingClientRect();
      const body = document.querySelector('.fullscreen-settings-body').getBoundingClientRect();
      return { inside: help.top >= body.top && help.bottom <= body.bottom, lowerSceneClear: help.bottom <= innerHeight / 2 };
    });
    expect(helpBounds).toEqual({ inside: true, lowerSceneClear: true });
    await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('activation-floor-settings.png') });
    await page.evaluate(() => { document.querySelector('#dancinglights').physics.renderer.render = window.activationRender; });
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.reload(); await physicsReady(page); await normalView(page);
    await page.getByText('Audio response & readouts', { exact: true }).click();
    await expect(floor).toHaveValue('0.00001');
    await expect(page.locator('.visual-gain-mode')).toHaveValue('3');
    await expect(page.locator('.manual-visual-gain')).toHaveValue('2');
    await expect(page.locator('.microphone-gate')).not.toBeChecked();
    await expect(page.locator('.gate-reset-notice')).toBeEmpty();
    await expect(page.locator('.audio-card')).not.toHaveAttribute('data-audio-session');
  });
}
