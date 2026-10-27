import { test, expect } from '@playwright/test';
import { normalView, physicsReady, syntheticAudio } from '../physics-state.mjs';
const origin = 'http://127.0.0.1:8101';

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
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
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
        window.modalIdentity = { worker: v.worker, renderer: v.renderer, controls: document.querySelector('.listening-toggle'), render: v.renderer.render };
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
      await settings.click();
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
      for (const selector of ['.listening-toggle', '.identify-song', '.motion-button', '.scroll-lights', '.camera-rotation', '.depth-slider', '.display-controls > summary', '.visual-gain-mode']) {
        if (selector === '.visual-gain-mode' && !await page.locator('.audio-tuning').evaluate(n => n.closest('details').open)) await page.getByText('Audio response & readouts', { exact: true }).click();
        await page.locator(selector).scrollIntoViewIfNeeded();
        await expect(page.locator(selector)).toBeInViewport();
        expect(await page.locator(selector).evaluate(n => !!n.closest('dialog'))).toBe(true);
      }
      await page.locator('.camera-rotation').fill('17');
      await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.cameraBase)).toBe(17);
      await page.locator('.fullscreen-settings-body').evaluate(n => { n.scrollTop = n.scrollHeight; });
      await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => {
        const card = document.querySelector('.audio-card'), v = card.querySelector('#dancinglights').physics, box = v.layer.getBoundingClientRect();
        card.scrollTop = 1000;
        return { same: v.worker === modalIdentity.worker && v.renderer === modalIdentity.renderer && card.querySelector('.listening-toggle') === modalIdentity.controls,
          scroll: card.scrollTop, requests: micRequests, geometry: { x: box.x, y: box.y, width: box.width, height: box.height, enclosure: v.input[32] } };
      })).toEqual({ same: true, scroll: 0, requests: 1, geometry: before });
      await page.screenshot({ path: info.outputPath(`modal-${viewport.width}.png`) });
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
      await expect(settings).toBeFocused();
      await settings.click();
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await page.evaluate(() => { document.querySelector('#dancinglights').physics.renderer.render = modalIdentity.render; });
    }
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await expect(page.locator('.scene-controls')).toBeVisible();
    await expect(page.locator('.camera-rotation')).toHaveValue('17');
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
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
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
      const help = page.getByRole('button', { name: 'Phone motion', exact: true });
      await help.hover();
      await expect(page.locator('.control-help')).toContainText('Phone motion lets measured tilt');
      await page.mouse.move(0, 0);
      await expect(page.locator('.control-help')).toBeHidden();
      // Tab from Motion proves keyboard focus opens help without enabling sensors.
      await page.locator('.motion-button').focus(); await page.keyboard.press('Tab');
      await expect(help).toBeFocused();
      await expect(page.locator('.control-help')).toBeVisible();
      expect(await help.evaluate(n => getComputedStyle(n).outlineStyle)).not.toBe('none');
      await page.keyboard.press('Enter'); await page.keyboard.press('Space');
      await expect(page.locator('.rotate-display')).toHaveAccessibleName(`Rotate view clockwise, current rotation ${turn * 90} degrees`);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
      expect(await page.locator('.fullscreen-settings').evaluate((n, turn) => {
        const r = n.getBoundingClientRect();
        return [r.bottom <= innerHeight / 2, r.left >= innerWidth / 2, r.top >= innerHeight / 2, r.right <= innerWidth / 2][turn];
      }, turn)).toBe(true);
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();
      await page.locator('.rotate-display').click();
    }
    expect(await page.evaluate(() => modalContext === modalSession.context && modalContext.state === 'running'
      && document.querySelector('.audio-card').dataset.audioSession === modalSession.id)).toBe(true);
  });

  test(`settings close on native browser exit and route cleanup on ${path} (${reducedMotion})`, async ({ page }, info) => {
    await startFullscreenAudio(page, path, reducedMotion, info);
    await page.locator('.rotate-display').click();
    await expect(page.locator('.audio-card')).toHaveAttribute('data-display-rotation', '1');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
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
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
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
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
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
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
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
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
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
  expect(await page.evaluate(() => toolbarAudio.context.state)).toBe('closed');
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
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
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Box depth (cm)', exact: true }).click();
  const editor = page.getByRole('spinbutton', { name: 'Box depth (cm) value', exact: true });
  await editor.fill('90'); await editor.press('Escape');
  await expect(editor).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Box depth (cm)', exact: true })).toHaveValue('48');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).not.toBeVisible();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
});
