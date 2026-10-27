import { test, expect, devices } from '@playwright/test';
import { physicsReady, scrollingIntersections } from '../physics-state.mjs';
import { meterPoint } from '../meter-input.mjs';

const origin = 'http://127.0.0.1:8101';

// Resolve native touch points in one browser call. Settings controls also need
// scrolling and two stable animation frames before the hit check. Keeping that
// work together avoids repeated driver/trace round trips on software renderers.
async function tapControlAtHitPoint(page, control, { scroll = false } = {}) {
  const point = await control.evaluateAll(async (nodes, scroll) => {
    if (nodes.length !== 1) throw new Error('Touch input requires exactly one visible control');
    const node = nodes[0];
    if (scroll) {
      node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await new Promise(requestAnimationFrame);
      const before = node.getBoundingClientRect();
      await new Promise(requestAnimationFrame);
      const after = node.getBoundingClientRect();
      if (['x', 'y', 'width', 'height'].some(key => before[key] !== after[key])) {
        throw new Error('Touch input requires a stable control after scrolling');
      }
    }
    const box = node.getBoundingClientRect();
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    if (box.width < 44 || box.height < 44 || getComputedStyle(node).visibility !== 'visible'
      || node.matches(':disabled') || node.closest('[aria-disabled="true"]')
      || !node.contains(node.ownerDocument.elementFromPoint(x, y))) {
      throw new Error('Touch input point must hit the requested enabled control');
    }
    return { x, y };
  }, scroll);
  await page.touchscreen.tap(point.x, point.y);
}

test('phone opens expanded without capture and keeps settings in the top half with notices, song and Exit in short landscape', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => { window.micRequests = 0; MediaDevices.prototype.getUserMedia = async () => { window.micRequests++; throw Error('Unexpected automatic capture'); }; });
    for (const route of ['/', '/advanced/']) {
      await page.goto(origin + route); await physicsReady(page);
      const initial = await page.evaluate(() => {
        const card = document.querySelector('.audio-card');
        const initial = { expanded: card.hasAttribute('data-expanded'), requests: window.micRequests, native: document.fullscreenElement };
        card.classList.add('video-active');
        const panel = card.querySelector('.video-panel'); panel.hidden = false;
        panel.querySelector('.youtube-frame').innerHTML = '<iframe title="Layout fixture" src="about:blank"></iframe>';
        card.querySelector('#dancinglights').physics.notice.show('Graphics recovery notice.', 'Graphics recovery notice.');
        const title = card.querySelector('.recognized-song'); title.hidden = false;
        title.querySelector('.song-title').textContent = 'An artist with a long name — A long song title '.repeat(4);
        return initial;
      });
      expect(initial).toEqual({ expanded: true, requests: 0, native: null });
      for (const width of [320, 393, 568]) {
        await page.setViewportSize({ width, height: 852 });
        expect(await page.locator('.fullscreen-toolbar').evaluate(toolbar => {
          const controls = [...toolbar.children], centers = controls.map(node => {
            const r = node.getBoundingClientRect(); return r.x + r.width / 2;
          });
          const gaps = centers.slice(1).map((x, i) => x - centers[i]);
          return { order: controls.map(node => node.matches('label') ? node.querySelector('input').className : node.className),
            evenlySpaced: Math.max(...gaps) - Math.min(...gaps) < 1,
            icons: controls.every(node => node.querySelector('svg[aria-hidden="true"]')?.checkVisibility()),
            text: toolbar.innerText.trim(), rotationHelp: !!toolbar.querySelector('.rotate-help'),
            switches: toolbar.querySelectorAll('input[type="checkbox"]').length };
        })).toEqual({ order: ['fullscreen-button', 'rotate-display', 'motion-button', 'listening-toggle', 'fullscreen-settings-button'],
          evenlySpaced: true, icons: true, text: '', rotationHelp: false, switches: 2 });
      }
      for (const viewport of [{ width: 393, height: 852 }, { width: 568, height: 320 }]) {
        await page.setViewportSize(viewport);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const selectors = ['label:has(.listening-toggle)', 'label:has(.identify-song)',
          'label:has(.motion-button)', 'label:has(.scroll-lights)', '.frame-rate', '.camera-rotation', '.camera-zoom', '.camera-x', '.camera-y'];
        expect(await scrollingIntersections(page, selectors)).toEqual(Object.fromEntries(selectors.map(selector => [selector, 1])));
        await page.locator('.camera-zoom').fill('25');
        await page.locator('.camera-x').fill('35'); await page.locator('.camera-y').fill('65');
        await expect(page.getByRole('button', { name: 'Edit Zoom', exact: true })).toHaveText('25%');
        await page.locator('.camera-rotation').fill('30');
        await expect.poll(() => page.evaluate(() => {
          const camera = document.querySelector('.camera-controls').getBoundingClientRect();
          const controls = document.querySelector('.audio-controls').getBoundingClientRect();
          const slider = document.querySelector('.camera-rotation'), box = slider.getBoundingClientRect();
          const row = slider.closest('.slider-control').getBoundingClientRect();
          const dialog = document.querySelector('.fullscreen-settings'), modal = dialog.getBoundingClientRect();
          return { dialogVisible: modal.width > 0 && modal.height > 0 && getComputedStyle(dialog).visibility === 'visible', angle: document.querySelector('#dancinglights').physics.cameraBase, separate: controls.bottom <= camera.top, touchSize: box.height >= 44,
            aligned: Math.abs(box.y + box.height / 2 - row.y - row.height / 2) < 1,
            touchable: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === slider };
        })).toEqual({ dialogVisible: true, angle: 30, separate: true, touchSize: true, aligned: true, touchable: true });
        await page.keyboard.press('ArrowLeft');
        await expect.poll(() => page.evaluate(() => ({
          angle: document.querySelector('#dancinglights').physics.cameraBase,
          sceneLarge: document.querySelector('#dancinglights').getBoundingClientRect().height >= 200,
          fps: /^\d+ FPS$/.test(document.querySelector('.frame-rate').textContent),
        }))).toEqual({ angle: 29, sceneLarge: true, fps: true });
        await page.getByRole('button', { name: 'Close settings', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).not.toBeVisible();
        expect(await scrollingIntersections(page, ['.physics-status', '.fullscreen-button'])).toEqual({ '.physics-status': 1, '.fullscreen-button': 1 });
      }
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
      await expect(page.locator('.audio-card')).not.toHaveAttribute('data-expanded', '');
      await page.setViewportSize({ width: 393, height: 852 });
    }
  } finally { await context.close(); }
});

for (const route of ['/', '/advanced/']) for (const reducedMotion of ['reduce', 'no-preference'])
for (const viewport of [{ width: 320, height: 568 }, { width: 393, height: 852 }, { width: 568, height: 320 }]) {
  test(`manual quarter turns fit the whole view and top-layer Settings on ${route} (${reducedMotion}, ${viewport.width}px)`, async ({ browser }, info) => {
    test.setTimeout(120000);
    const context = await browser.newContext({ ...devices['iPhone 13'], viewport });
    try {
      const page = await context.newPage();
      await page.emulateMedia({ reducedMotion });
      await page.addInitScript(() => {
        window.micRequests = 0; window.motionRequests = 0;
        for (const name of ['DeviceMotionEvent', 'DeviceOrientationEvent']) {
          if (!window[name]) window[name] = class {};
          Object.defineProperty(window[name], 'requestPermission', { configurable: true, value: async () => { motionRequests++; return 'denied'; } });
        }
        MediaDevices.prototype.getUserMedia = async () => { window.micRequests++; throw Error('Unexpected capture'); };
        Object.defineProperty(document, 'fullscreenEnabled', { value: false });
      });
      await page.goto(origin + route); await physicsReady(page);
      await page.evaluate(() => {
        const v = document.querySelector('#dancinglights').physics;
        window.rotationIdentity = { view: v, worker: v.worker, renderer: v.renderer, balls: v.balls, listening: document.querySelector('.listening-toggle') };
        window.rotationContinuity = [];
        const card = document.querySelector('.audio-card');
        let before;
        // Snapshot within the input task so legitimate later physical contacts
        // can still change position and pigment after the display turn.
        card.addEventListener('rotate-display', () => { before = { state: Array.from(v.current), pigments: Array.from(v.pigments) }; }, true);
        card.addEventListener('display-rotation', () => {
          if (before) rotationContinuity.push(before.state.every((n, i) => n === v.current[i]) && before.pigments.every((n, i) => n === v.pigments[i]));
          before = null;
        });
        document.addEventListener('pointerdown', event => {
          const hit = event.target.closest('[role=meter], .bark-copy');
          if (hit) window.tappedBand = hit.matches('.bark-copy') ? Number(hit.dataset.sourceBand) : [...card.querySelectorAll('[role=meter]')].indexOf(hit);
        }, true);
        document.addEventListener('click', event => {
          if (event.target.closest('[aria-label="Increase Camera angle (degrees)"]')) window.angleAtStep = Number(card.querySelector('.camera-rotation').value);
        }, true);
        window.rotationResets = 0;
        v.worker.addEventListener('message', ({ data }) => { if (data.type === 'reset') rotationResets++; });
      });
      for (const video of [false, true]) {
        await page.evaluate(video => {
          const card = document.querySelector('.audio-card');
          card.classList.toggle('video-active', video);
          card.querySelector('.video-panel').hidden = !video;
          card.querySelector('.youtube-frame').innerHTML = video ? '<iframe title="Rotation fixture" src="about:blank"></iframe>' : '';
        }, video);
        for (let turn = 0; turn < 4; turn++) {
          await expect(page.locator('.rotate-display')).toHaveAccessibleName(`Rotate view clockwise, current rotation ${turn * 90} degrees`);
          await expect.poll(() => page.evaluate(({ turn, video }) => {
            const card = document.querySelector('.audio-card'), v = card.querySelector('#dancinglights').physics;
            const box = card.getBoundingClientRect(), identity = window.rotationIdentity;
            const fits = r => r.left >= -.1 && r.top >= -.1 && r.right <= innerWidth + .1 && r.bottom <= innerHeight + .1;
            const buttons = [...card.querySelectorAll('.fullscreen-toolbar button, .fullscreen-toolbar label')];
            const toolbar = buttons.every(n => { const r = n.getBoundingClientRect(); return fits(r) && r.width >= 44 && r.height >= 44 && n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
            const scene = getComputedStyle(v.layer);
            return { fit: fits(box) && Math.abs(box.width - innerWidth) < 1 && Math.abs(box.height - innerHeight) < 1,
              dimensions: card.clientWidth === (turn % 2 ? innerHeight : innerWidth) && card.clientHeight === (turn % 2 ? innerWidth : innerHeight),
              canvas: Math.abs(v.canvasWidth - parseFloat(scene.width)) < .1 && Math.abs(v.canvasHeight - parseFloat(scene.height)) < .1,
              toolbar, video: !video || fits(card.querySelector('iframe').getBoundingClientRect()),
              identity: v === identity.view && v.worker === identity.worker && v.renderer === identity.renderer && v.balls === identity.balls && card.querySelector('.listening-toggle') === identity.listening,
              scrollLocked: getComputedStyle(document.documentElement).overflow === 'hidden',
              requests: window.micRequests + window.motionRequests };
          }, { turn, video })).toEqual({ fit: true, dimensions: true, canvas: true, toolbar: true, video: true, identity: true, scrollLocked: true, requests: 0 });
          const motionHelp = page.getByRole('button', { name: 'Phone motion', exact: true });
          await tapControlAtHitPoint(page, motionHelp);
          await expect.poll(() => page.evaluate(turn => {
            const card = document.querySelector('.audio-card'), node = card.querySelector('.control-help'), help = node.getBoundingClientRect();
            return { text: node.textContent.includes('Phone motion lets measured tilt'),
              unchanged: card.hasAttribute('data-expanded') && card.displayQuarterTurn === turn && micRequests === 0 && motionRequests === 0,
              visible: help.width > 0 && help.height > 0 && getComputedStyle(node).visibility === 'visible',
              fits: help.left >= 0 && help.top >= 0 && help.right <= innerWidth && help.bottom <= innerHeight };
          }, turn)).toEqual({ text: true, unchanged: true, visible: true, fits: true });
          const point = await meterPoint(page, page.getByRole('meter').nth(12), { scroll: false });
          await page.touchscreen.tap(point.x, point.y);
          // Scrolling continues under normal motion. The trusted pointer hit
          // supplies the source at tap time, after the point was resolved.
          await expect.poll(() => page.evaluate(reducedMotion => {
            const tooltip = document.querySelector('.frequency-tooltip'), box = tooltip.getBoundingClientRect();
            return { visible: box.width > 0 && box.height > 0 && getComputedStyle(tooltip).visibility === 'visible',
              band: tappedBand >= 0 && tappedBand < 24 && (reducedMotion !== 'reduce' || tappedBand === 12),
              described: document.querySelectorAll('[role=meter]')[tappedBand]?.getAttribute('aria-describedby') };
          }, reducedMotion)).toEqual({ visible: true, band: true, described: 'frequency-readout' });
          await tapControlAtHitPoint(page, page.getByRole('button', { name: 'Settings', exact: true }));
          // Keep the accessible dialog identity and read one coherent layout.
          const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
          await expect.poll(() => dialog.evaluateAll((nodes, turn) => nodes.map(node => {
            const r = node.getBoundingClientRect();
            const fits = r.left >= 0 && r.top >= 0 && r.right <= innerWidth + .1 && r.bottom <= innerHeight + .1;
            const half = [r.bottom <= innerHeight / 2 + .1, r.left >= innerWidth / 2 - .1, r.top >= innerHeight / 2 - .1, r.right <= innerWidth / 2 + .1][turn];
            const close = node.querySelector('button').getBoundingClientRect();
            return { fits, half, hit: document.elementFromPoint(close.x + close.width / 2, close.y + close.height / 2) === node.querySelector('button'),
              visible: r.width > 0 && r.height > 0 && getComputedStyle(node).visibility === 'visible',
              focused: document.activeElement === node.querySelector('button') };
          }), turn)).toEqual([{ fits: true, half: true, hit: true, visible: true, focused: true }]);
          await page.locator('.fullscreen-settings [data-help="listening-toggle"]').tap();
          const help = await page.evaluate(() => {
            const n = document.querySelector('.control-help');
            const a = n.getBoundingClientRect(), b = n.closest('dialog').getBoundingClientRect();
            return { fits: a.width > 0 && a.height > 0 && a.left >= b.left && a.top >= b.top && a.right <= b.right && a.bottom <= b.bottom };
          });
          expect(help.fits).toBe(true);
          await tapControlAtHitPoint(page, page.getByRole('button', { name: 'Increase Camera angle (degrees)', exact: true }), { scroll: true });
          await expect.poll(() => page.evaluate(() => Number(document.querySelector('.camera-rotation').value) === Math.min(40, angleAtStep + 1))).toBe(true);
          await page.getByRole('button', { name: 'Close settings', exact: true }).focus();
          await page.keyboard.press('Shift+Tab');
          expect(await page.evaluate(() => document.querySelector('.fullscreen-settings').contains(document.activeElement))).toBe(true);
          await page.keyboard.press('Escape');
          await expect.poll(() => page.evaluate(() => {
            const dialog = document.querySelector('.fullscreen-settings'), r = dialog.getBoundingClientRect();
            return { closed: !dialog.open && (r.width === 0 || r.height === 0 || getComputedStyle(dialog).visibility === 'hidden'),
              expanded: document.querySelector('.audio-card').hasAttribute('data-expanded') };
          })).toEqual({ closed: true, expanded: true });
          if (route === '/' && video && turn === 1) await info.attach(`rotation-${viewport.width}.png`, { body: await page.screenshot(), contentType: 'image/png' });
          await tapControlAtHitPoint(page, page.locator('.rotate-display'));
        }
      }
      expect(await page.evaluate(() => ({ count: rotationContinuity.length, preserved: rotationContinuity.every(Boolean), resets: rotationResets }))).toEqual({ count: 8, preserved: true, resets: 0 });
      await page.locator('.rotate-display').focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.audio-card')).toHaveAttribute('data-display-rotation', '1');
      const routeBeforeExit = page.url();
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
      await expect(page).toHaveURL(routeBeforeExit);
      await expect(page.locator('.audio-card')).not.toHaveAttribute('data-expanded', '');
      expect(await page.locator('.audio-card').evaluate(n => getComputedStyle(n).transform)).toBe('none');
      await page.getByRole('button', { name: 'Fullscreen', exact: true }).tap();
      await expect(page.locator('.rotate-display')).toHaveAccessibleName('Rotate view clockwise, current rotation 90 degrees');
      await page.setViewportSize({ width: 393, height: 852 });
    } finally { await context.close(); }
  });
}
