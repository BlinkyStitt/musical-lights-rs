import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { clickControlAtHitPoint } from '../control-input.mjs';
import { openFullscreenSettings, closeFullscreenSettings, normalView, physicsReady, syntheticAudio } from '../physics-state.mjs';
const origin = 'http://127.0.0.1:8101';

test('batched control input requires a stable enabled hit target and emits trusted input', async ({ page }) => {
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1">
    <button style="width:100px;height:44px;position:absolute;left:50px;top:50px">Control</button>
    <div id="cover" style="position:absolute;inset:0"></div>`);
  const button = page.getByRole('button', { name: 'Control', exact: true });
  await expect(clickControlAtHitPoint(page, button)).rejects.toThrow('must hit');
  await page.locator('#cover').evaluate(node => node.remove());
  await button.evaluate(node => { node.disabled = true; });
  await expect(clickControlAtHitPoint(page, button)).rejects.toThrow('must hit');
  await button.evaluate(node => { node.disabled = false; node.style.height = '20px'; });
  await expect(clickControlAtHitPoint(page, button)).rejects.toThrow('must hit');
  await button.evaluate(node => {
    node.style.height = '44px';
    window.controlAnimation = node.animate([{ left: '50px' }, { left: '250px' }], { duration: 1000, iterations: Infinity });
  });
  await expect(clickControlAtHitPoint(page, button)).rejects.toThrow('stable control');
  await button.evaluate(node => {
    controlAnimation.cancel();
    window.controlClicks = [];
    node.addEventListener('click', event => controlClicks.push(event.isTrusted));
  });
  await clickControlAtHitPoint(page, button);
  expect(await page.evaluate(() => controlClicks)).toEqual([true]);
});

async function setup(page, path = '/', progressingVideo = false, nativeFullscreen = false) {
  await syntheticAudio(page);
  await page.addInitScript(nativeFullscreen => {
    if (!nativeFullscreen) Object.defineProperty(document, 'fullscreenEnabled', { value: false });
    window.micRequests = 0; window.microphones = []; window.players = [];
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      window.micRequests++;
      if (window.denyMicrophone) throw new DOMException('Test permission denied', 'NotAllowedError');
      const stream = await acquire(...args);
      if (!window.deferMicrophone) { window.microphones.push({ stream }); return stream; }
      return new Promise(resolve => window.microphones.push({ stream, resolve: () => resolve(stream) }));
    };
    window.setTabHidden = hidden => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    let type = 'auto'; window.audioTypes = [];
    Object.defineProperty(navigator, 'audioSession', { configurable: true, value: { get type() { return type; }, set type(value) { type = value; window.audioTypes.push(value); } } });
    window.YT = { Player: class {
      constructor(frame, options) { this.frame = frame; this.options = options; this.states = []; window.videoPlayer = this; window.players.push(this); setTimeout(() => options.events.onReady({ target: this }), 0); }
      state(data) { this.states.push(data); this.options.events.onStateChange({ target: this, data }); }
      getPlayerState() { return this.states.at(-1); }
      playVideo() { this.state(1); this.frame.contentWindow?.postMessage('play', 'https://www.youtube-nocookie.com'); }
      pauseVideo() { this.state(2); this.frame.contentWindow?.postMessage('pause', 'https://www.youtube-nocookie.com'); }
      error(data) { this.options.events.onError({ target: this, data }); }
      destroy() { this.destroyed = true; this.frame.remove(); }
    } };
  }, nativeFullscreen);
  const movie = progressingVideo ? await readFile(new URL('../fixtures/rotation-clock.mp4', import.meta.url)) : null;
  // Inline a generated clip longer than the test deadline (fixtures/README.md).
  // Exercise the browser media clock without looping, a live provider or HTTP range mocks.
  // Start unmuted via the explicit Play gesture, as with normal YouTube playback.
  // The clip has no audio track. Muting it makes WebKit suspend video rendering
  // in a rotated iframe, even though the visible player still reports playing.
  await page.route('https://www.youtube-nocookie.com/**', route => {
    return route.fulfill({ contentType: 'text/html', body: progressingVideo ? `<!doctype html>
      <video playsinline src="data:video/mp4;base64,${movie.toString('base64')}" style="width:100%;height:100%;position:fixed;inset:0"></video>
      <button style="position:fixed;bottom:8px;right:8px;min-height:44px">Play test video</button>
      <script>
        const video = document.querySelector('video');
        window.videoFrames = 0; window.videoPauses = 0; window.mediaEvents = [];
        for (const type of ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ended', 'error']) video.addEventListener(type, () => {
          mediaEvents.push({ type, time: video.currentTime, ready: video.readyState, wall: performance.now() });
          if (mediaEvents.length > 64) mediaEvents.shift();
        });
        document.querySelector('button').onclick = () => video.play();
        video.addEventListener('pause', () => videoPauses++);
        function frame(now, metadata) { videoFrames++; window.mediaTime = metadata.mediaTime; video.requestVideoFrameCallback(frame); }
        video.requestVideoFrameCallback(frame);
        addEventListener('message', event => { if (event.data === 'play') video.play(); if (event.data === 'pause') video.pause(); });
      </script>` : '<!doctype html><body style="background:#142b40;color:white">Mock YouTube player</body>' });
  });
  await page.route('https://www.youtube.com/**', route => route.abort());
  await page.goto(origin + path); await physicsReady(page); await normalView(page);
}
async function load(page) {
  await openFullscreenSettings(page);
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Video', exact: true }));
  await page.locator('.youtube-link').fill('https://youtu.be/abcDEF012_-?t=1m23s');
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Load video', exact: true }));
  await expect(page.locator('.youtube-status')).toBeEmpty();
  await expect(page.locator('.youtube-frame iframe')).toBeVisible();
}
test('normal page places video and lights above common controls and extra settings', async ({ page }) => {
  await setup(page, '/advanced/'); await load(page);
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const video = rect('.video-panel'), scene = rect('.spectrum-panel'), controls = rect('.audio-controls'), settings = rect('.display-controls');
      return { sceneAboveControls: scene.bottom <= controls.top, videoAboveControls: video.bottom <= controls.top,
        settingsBelowControls: settings.top >= controls.bottom, videoFits: innerWidth < 1000 ? video.bottom <= scene.top : video.right <= scene.left,
        noOverflow: document.documentElement.scrollWidth <= innerWidth };
    })).toEqual({ sceneAboveControls: true, videoAboveControls: true, settingsBelowControls: true, videoFits: true, noOverflow: true });
  }
});
for (const resizeLayout of [false, true]) {
  test(`expanded video entry overlays the scene during ${resizeLayout ? 'layout' : 'visual'} keyboard resizing`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // An on-screen keyboard is not available in headless browsers. Model the
    // two viewport resize contracts, including Safari's visual viewport pan.
    await page.addInitScript(() => {
      const viewport = Object.assign(new EventTarget(), { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      window.keyboardViewport = (height, offsetTop = 0) => {
        viewport.width = innerWidth; viewport.height = height; viewport.offsetTop = offsetTop;
        viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll'));
      };
    });
    await setup(page); await load(page);
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
    await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
    await page.evaluate(() => {
      const card = document.querySelector('.audio-card');
      const song = card.querySelector('.recognized-song'); song.hidden = false;
      song.querySelector('.song-title').textContent = 'A long artist name — A long recognized song title '.repeat(3);
      const status = card.querySelector('.recognition-status'); delete status.dataset.routine;
      status.textContent = 'No song recognized. Try again during a clearer part of the song.';
      card.querySelector('.audio-error').textContent = 'Microphone capture was interrupted.';
      // Use the notice owner so an earlier incident timer cannot clear this
      // fixed layout input while keyboard geometry is measured.
      card.querySelector('#dancinglights').physics.notice.show(
        'Motion updates are delayed.', 'Motion updates are delayed.');
    });
    const geometry = () => page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { width: r.width, height: r.height }; };
      const view = document.querySelector('#dancinglights').physics;
      return { scene: rect('.balloon-layer'), video: rect('.youtube-frame'), enclosure: view.input[32] };
    });
    // Wait for the expanded layout and its physical enclosure resize.
    await expect.poll(() => page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      return v.canvasHeight === document.querySelector('.balloon-layer').getBoundingClientRect().height;
    })).toBe(true);
    const before = await geometry();
    await openFullscreenSettings(page);
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Video', exact: true }));
    await expect(page.locator('.youtube-link')).toBeFocused();
    expect(await geometry()).toEqual(before);
    await page.evaluate(() => window.keyboardViewport(320, 40));
    if (resizeLayout) await page.setViewportSize({ width: 390, height: 360 });
    await expect.poll(geometry).toEqual(before);
    const editor = page.locator('.video-form');
    const box = await editor.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(40); expect(box.y + box.height).toBeLessThanOrEqual(360);
    expect(before.scene.height).toBeGreaterThanOrEqual(200); // The keyboard does not squash the enclosure.
    for (const name of ['Clear YouTube link', 'Load video', 'Remove video']) {
      const rect = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(rect.height).toBeGreaterThanOrEqual(44); expect(rect.y + rect.height).toBeLessThanOrEqual(360);
    }
    await page.screenshot({ path: info.outputPath('floating-youtube-keyboard.png') });
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Load video', exact: true }));
    await expect(editor).toBeHidden(); await expect(page.locator('.youtube-link')).not.toBeFocused();
    expect(await page.locator('.audio-card').evaluate(n => n.style.getPropertyValue('--expanded-height'))).toBe('');
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => window.keyboardViewport(844));
    await openFullscreenSettings(page);
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Video', exact: true }));
    await page.setViewportSize({ width: 844, height: 390 }); await page.evaluate(() => window.keyboardViewport(390));
    await expect.poll(() => page.locator('.audio-card').evaluate(n => n.getBoundingClientRect().height)).toBe(390);
    await page.keyboard.press('Escape');
    await expect(page.locator('.fullscreen-settings')).not.toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.audio-card')).not.toHaveAttribute('data-expanded', '');
    await expect(page.locator('.youtube-link')).not.toBeFocused();
    expect(await page.locator('.audio-card').evaluate(n => n.style.getPropertyValue('--expanded-height'))).toBe('');
    await page.getByRole('link', { name: 'About', exact: true }).click();
    expect(await page.evaluate(() => window.videoPlayer.destroyed)).toBe(true);
  });
}
test('expanded entry without a loaded video does not reserve or resize the scene', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await setup(page);
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
  await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
  const sceneHeight = await page.locator('.balloon-layer').evaluate(n => n.getBoundingClientRect().height);
  await openFullscreenSettings(page);
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Video', exact: true }));
  expect(await page.locator('.balloon-layer').evaluate(n => n.getBoundingClientRect().height)).toBe(sceneHeight);
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Clear YouTube link', exact: true }));
  await page.locator('.youtube-link').fill('https://example.com/video');
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Load video', exact: true }));
  await expect(page.locator('.youtube-status')).toContainText('Use a link to one YouTube video');
  await expect(page.locator('.video-form')).toBeVisible();
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Remove video', exact: true }));
  await expect(page.locator('.video-panel')).toBeHidden();
  await expect(page.locator('.youtube-link')).not.toBeFocused();
  expect(await page.locator('.audio-card').evaluate(n => n.style.getPropertyValue('--expanded-height'))).toBe('');
});
test('default video is ready to load and the clear button preserves playback and an empty preference', async ({ page }) => {
  await setup(page);
  await openFullscreenSettings(page);
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Video', exact: true }));
  await expect(page.locator('.youtube-link')).toHaveValue('https://www.youtube.com/watch?v=6d4NOjyd2Ik');
  await expect(page.locator('.youtube-frame iframe')).toHaveCount(0);
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Load video', exact: true }));
  await expect(page.locator('.youtube-frame iframe')).toHaveAttribute('src', /embed\/6d4NOjyd2Ik/);
  await page.evaluate(() => window.videoPlayer.playVideo());
  const clear = page.getByRole('button', { name: 'Clear YouTube link', exact: true });
  await openFullscreenSettings(page);
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Video', exact: true }));
  expect(await clear.evaluate(n => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await clear.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.youtube-link')).toHaveValue('');
  await expect(page.locator('.youtube-link')).toBeFocused();
  expect(await page.evaluate(() => window.videoPlayer.destroyed ?? false)).toBe(false);
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('playback');
  expect(await page.evaluate(() => window.micRequests)).toBe(0);
  await page.reload(); await physicsReady(page); await normalView(page);
  await openFullscreenSettings(page);
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Video', exact: true }));
  await expect(page.locator('.youtube-link')).toHaveValue('');
});
for (const path of ['/', '/advanced/']) {
  test(`YouTube loads without microphone capture and reserves fullscreen regions on ${path}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 }); await setup(page, path); await load(page);
    expect(await page.evaluate(() => window.micRequests)).toBe(0);
    await expect(page.locator('.youtube-frame iframe')).toHaveAttribute('src', /start=83/);
    await expect(page.locator('.youtube-frame iframe')).toHaveAttribute('credentialless', '');
    await expect(page.locator('.youtube-frame iframe')).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    await page.evaluate(() => window.videoPlayer.playVideo());
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
    expect(await page.evaluate(() => window.micRequests)).toBe(1);
    expect(await page.evaluate(() => document.querySelector('.audio-card').presentation.videoPlaying)).toBe(true);
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(async () => page.evaluate(() => {
        const video = document.querySelector('.youtube-frame').getBoundingClientRect(), scene = document.querySelector('.balloon-layer').getBoundingClientRect();
        const portrait = innerHeight > innerWidth;
        return { minimum: video.width >= 200 && video.height >= 200, bounded: scene.bottom <= innerHeight, separated: portrait ? video.bottom <= scene.top : video.right <= scene.left, fits: document.documentElement.scrollWidth <= innerWidth };
      })).toEqual({ minimum: true, bounded: true, separated: true, fits: true });
      await closeFullscreenSettings(page);
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeInViewport({ ratio: 1 });
      await expect.poll(() => page.evaluate(() => {
        const v = document.querySelector('#dancinglights').physics;
        return Math.abs(v.current[1] - v.height);
      })).toBeLessThan(.005);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: testInfo.outputPath(`youtube-${viewport.width}.png`) });
    }
    expect(await page.evaluate(() => window.videoPlayer.destroyed ?? false)).toBe(false);
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Exit fullscreen', exact: true }));
    await page.getByRole('link', { name: 'About', exact: true }).click();
    expect(await page.evaluate(() => window.videoPlayer.destroyed)).toBe(true);
    expect(await page.evaluate(() => navigator.audioSession.type)).toBe('auto');
  });
}
for (const reducedMotion of ['reduce', 'no-preference']) {
  test(`short landscape keeps the scene fixed and puts controls in top-half settings with ${reducedMotion}`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion, colorScheme: reducedMotion === 'reduce' ? 'light' : 'dark' });
    await page.setViewportSize({ width: 568, height: 320 });
    await setup(page); await load(page);
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
    await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
    await page.evaluate(() => {
      const card = document.querySelector('.audio-card');
      const song = card.querySelector('.recognized-song'); song.hidden = false;
      song.querySelector('.song-title').textContent = 'An artist with a very long name — A song title long enough to wrap across many lines on a small landscape screen. '.repeat(4);
      const recognition = card.querySelector('.recognition-status'); delete recognition.dataset.routine;
      recognition.textContent = 'No song recognized. Try again during a clearer part of the song.';
      card.querySelector('.audio-error').textContent = 'Microphone capture was interrupted. Turn Listening off and on to restart when the microphone is available. '.repeat(3);
    });
    await expect.poll(() => page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const video = rect('.youtube-frame iframe'), scene = rect('.balloon-layer'), recovery = rect('.recovery-notices');
      const card = document.querySelector('.audio-card');
      return { videoVisible: video.width >= 200 && video.height >= 200, sceneVisible: scene.height >= 200,
        separated: video.right <= scene.left, topNotices: recovery.bottom <= innerHeight / 2,
        fixed: card.scrollHeight === card.clientHeight, widthFits: document.documentElement.scrollWidth <= innerWidth };
    })).toEqual({ videoVisible: true, sceneVisible: true, separated: true, topNotices: true, fixed: true, widthFits: true });
    await openFullscreenSettings(page);
    await page.locator('.recognition-status').scrollIntoViewIfNeeded();
    await expect(page.locator('.recognition-status')).toBeInViewport();
    for (const name of ['Listening', 'Identify song', 'Phone motion', 'Scroll lights']) {
      const control = page.getByRole('checkbox', { name, exact: true });
      await control.locator('..').scrollIntoViewIfNeeded();
      await expect(control.locator('..')).toBeInViewport({ ratio: 1 });
      expect(await control.evaluate(n => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole('button', { name: 'Video', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Video', exact: true })).toBeInViewport({ ratio: 1 });
    await closeFullscreenSettings(page);
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeInViewport({ ratio: 1 });
    if (reducedMotion === 'reduce') {
      expect(await page.locator('.recognized-song').evaluate(n => n.querySelector('.song-window').getBoundingClientRect().top >= n.getBoundingClientRect().top)).toBe(true);
    }
    await page.screenshot({ path: info.outputPath('short-landscape-youtube-notices.png') });
    // Exit remains reachable after scrolling through the footer.
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Exit fullscreen', exact: true }));
    await expect(page.locator('.audio-card')).not.toHaveAttribute('data-expanded', '');
  });
}
test('speaker playback and microphone capture share an audio session, and stopping Listening leaves playback active', async ({ page }) => {
  await setup(page); await load(page); await page.evaluate(() => window.videoPlayer.playVideo());
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('playback');
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('play-and-record');
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).uncheck();
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('playback');
  expect(await page.evaluate(() => window.videoPlayer.destroyed ?? false)).toBe(false);
  await openFullscreenSettings(page);
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Video', exact: true }));
  await page.locator('.youtube-link').fill('https://example.com/video');
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Load video', exact: true }));
  await expect(page.locator('.youtube-status')).toContainText('Use a link to one YouTube video');
  // A rejected replacement must not invalidate the current player's callbacks.
  await page.evaluate(() => window.videoPlayer.pauseVideo());
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('auto');
});
test('YouTube buffering retains playback routing without repeated audio mode changes', async ({ page }) => {
  await setup(page); await load(page);
  await page.evaluate(() => { videoPlayer.playVideo(); window.audioTypes = []; videoPlayer.state(3); videoPlayer.playVideo(); videoPlayer.playVideo(); });
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('playback');
  expect(await page.evaluate(() => audioTypes)).toEqual([]);
  await page.evaluate(() => videoPlayer.state(0));
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('auto');
});
test('Listening cancels a pending microphone and late capture cannot change video routing', async ({ page }) => {
  await setup(page); await load(page); await page.evaluate(() => { videoPlayer.playVideo(); window.deferMicrophone = true; });
  const listen = page.getByRole('checkbox', { name: 'Listening', exact: true });
  await listen.click();
  await expect.poll(() => page.evaluate(() => microphones.length)).toBe(1);
  await expect(listen).toBeChecked(); await expect(listen).toBeEnabled();
  // Hold the native operation, not its reported state. Ownership must retire
  // before asynchronous close completes, while capture is still pending.
  await page.evaluate(() => {
    const close = testContext.close.bind(testContext);
    testContext.close = () => new Promise((resolve, reject) => {
      window.completeAudioClose = () => close().then(resolve, reject);
    });
  });
  await listen.uncheck();
  expect(await page.evaluate(() => ({ retired: testContext.audioRetired, closeRequested: !!window.completeAudioClose }))).toEqual({ retired: true, closeRequested: true });
  await expect.poll(() => page.evaluate(() => navigator.audioSession.type)).toBe('playback');
  expect(await page.evaluate(() => testContext.state)).not.toBe('closed');
  await page.evaluate(() => { microphones[0].resolve(); window.deferMicrophone = false; });
  await expect.poll(() => page.evaluate(() => microphones[0].stream.getTracks()[0].readyState)).toBe('ended');
  await page.evaluate(() => completeAudioClose());
  await expect.poll(() => page.evaluate(() => testContext.state)).toBe('closed');
  await listen.check(); await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  expect(await page.evaluate(() => [micRequests, navigator.audioSession.type])).toEqual([2, 'play-and-record']);
  await listen.uncheck();
  await expect.poll(() => page.evaluate(() => navigator.audioSession.type)).toBe('playback');
});
test('a blocked startup resume can be canceled without muting video or blocking the next start', async ({ page }) => {
  await setup(page); await load(page); await page.evaluate(() => {
    videoPlayer.playVideo();
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      if (!window.releaseResume) return new Promise((resolve, reject) => { window.releaseResume = () => resume.call(this).then(resolve, reject); });
      return resume.call(this);
    };
  });
  const listen = page.getByRole('checkbox', { name: 'Listening', exact: true });
  await listen.click(); await expect.poll(() => page.evaluate(() => Boolean(window.releaseResume))).toBe(true);
  await listen.uncheck(); await expect.poll(() => page.evaluate(() => testContext.state)).toBe('closed');
  await page.evaluate(() => releaseResume());
  expect(await page.evaluate(() => [micRequests, navigator.audioSession.type])).toEqual([0, 'playback']);
  await listen.check(); await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  expect(await page.evaluate(() => micRequests)).toBe(1);
});
test('hiding and showing an uninterrupted tab preserves both independent audio owners', async ({ page }) => {
  await setup(page); await load(page); await page.evaluate(() => videoPlayer.playVideo());
  const listen = page.getByRole('checkbox', { name: 'Listening', exact: true });
  await listen.check(); await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await page.evaluate(() => { setTabHidden(true); videoPlayer.state(3); videoPlayer.playVideo(); setTabHidden(false); });
  await expect(listen).toBeChecked();
  expect(await page.evaluate(() => [micRequests, navigator.audioSession.type, testContext.state])).toEqual([1, 'play-and-record', 'running']);
  await listen.uncheck(); expect(await page.evaluate(() => navigator.audioSession.type)).toBe('playback');
});
test('digital source replacement and YouTube play hand audio ownership back without acquiring a microphone', async ({ page }) => {
  await setup(page, '/advanced/'); await load(page); await page.evaluate(() => videoPlayer.playVideo());
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.review-start').click(); await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  expect(await page.evaluate(() => document.querySelector('.audio-card').presentation.videoPlaying)).toBe(false);
  await page.evaluate(() => videoPlayer.playVideo());
  await expect(page.locator('.input-source')).toHaveValue('microphone');
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => testContext.state)).toBe('closed');
  expect(await page.evaluate(() => [micRequests, navigator.audioSession.type])).toEqual([1, 'playback']);
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
});
for (const outcome of ['pause', 'buffer', 'error', 'keep playing']) {
  test(`tab interruption releases capture and permits explicit recovery with YouTube ${outcome}`, async ({ page }) => {
    await setup(page); await load(page); await page.evaluate(() => videoPlayer.playVideo());
    const listen = page.getByRole('checkbox', { name: 'Listening', exact: true });
    await listen.check(); await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
    await page.evaluate(async outcome => {
      setTabHidden(true);
      if (outcome === 'pause') videoPlayer.pauseVideo();
      if (outcome === 'buffer') videoPlayer.state(3);
      if (outcome === 'error') videoPlayer.error(100);
      await testContext.suspend(); // Model the OS interruption separately from visibility.
    }, outcome);
    await expect(listen).not.toBeChecked(); await expect(listen).toBeEnabled();
    await expect.poll(() => page.evaluate(() => testContext.state)).toBe('closed');
    await expect.poll(() => page.evaluate(() => microphones[0].stream.getTracks()[0].readyState)).toBe('ended');
    const playing = ['buffer', 'keep playing'].includes(outcome);
    await expect.poll(() => page.evaluate(() => navigator.audioSession.type)).toBe(playing ? 'playback' : 'auto');
    await page.evaluate(() => setTabHidden(false));
    expect(await page.evaluate(() => micRequests)).toBe(1); // Visibility alone must not acquire input.
    await listen.check(); await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
    expect(await page.evaluate(() => micRequests)).toBe(2);
    await page.evaluate(() => { videoPlayer.playVideo(); videoPlayer.pauseVideo(); videoPlayer.playVideo(); });
    expect(await page.evaluate(() => navigator.audioSession.type)).toBe('play-and-record');
    await listen.uncheck(); await expect.poll(() => page.evaluate(() => navigator.audioSession.type)).toBe('playback');
  });
}
test('rapid video and Listening clicks retain one live microphone and release every stopped stream', async ({ page }) => {
  await setup(page); await load(page);
  const listen = page.getByRole('checkbox', { name: 'Listening', exact: true });
  for (let i = 0; i < 3; i++) {
    await listen.check(); await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
    await page.evaluate(() => { videoPlayer.playVideo(); videoPlayer.pauseVideo(); videoPlayer.state(3); videoPlayer.playVideo(); });
    expect(await page.evaluate(() => navigator.audioSession.type)).toBe('play-and-record');
    await listen.uncheck(); await expect.poll(() => page.evaluate(() => navigator.audioSession.type)).toBe('playback');
    expect(await page.evaluate(() => microphones.map(m => m.stream.getTracks()[0].readyState))).toEqual(Array(i + 1).fill('ended'));
  }
  expect(await page.evaluate(() => micRequests)).toBe(3);
});
test('denied microphone leaves YouTube playing and can recover after permission changes', async ({ page }) => {
  await setup(page); await load(page); await page.evaluate(() => { videoPlayer.playVideo(); window.denyMicrophone = true; });
  const listen = page.getByRole('checkbox', { name: 'Listening', exact: true });
  await listen.click(); await expect.poll(() => page.evaluate(() => micRequests)).toBe(1);
  await expect(listen).toBeEnabled(); await expect(listen).not.toBeChecked();
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('playback');
  expect(await page.evaluate(() => videoPlayer.destroyed ?? false)).toBe(false);
  await page.evaluate(() => { window.denyMicrophone = false; });
  await listen.check(); await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
});
test('stale replaced or removed video callbacks cannot change the current microphone or audio route', async ({ page }) => {
  await setup(page); await load(page); await page.evaluate(() => videoPlayer.playVideo());
  await load(page); await page.evaluate(() => videoPlayer.playVideo());
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await page.evaluate(() => { players[0].pauseVideo(); players[0].error(100); });
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('play-and-record');
  await expect(page.locator('.youtube-status')).toBeEmpty();
  await openFullscreenSettings(page);
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Video', exact: true }));
  await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Remove video', exact: true }));
  await page.evaluate(() => players[1].playVideo());
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('play-and-record');
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await page.evaluate(() => { players.forEach(p => { p.playVideo(); p.error(100); }); setTabHidden(true); setTabHidden(false); });
  expect(await page.evaluate(() => [navigator.audioSession.type, micRequests, players.every(p => p.destroyed), microphones[0].stream.getTracks()[0].readyState])).toEqual(['auto', 1, true, 'ended']);
});
test('help labels explain state without toggling; preferences restore without starting capture', async ({ page }) => {
  await setup(page); await page.locator('[data-help="listening-toggle"]').click();
  await expect(page.locator('.control-help')).toContainText('Microphone: off');
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).not.toBeChecked();
  await page.keyboard.press('Escape'); await expect(page.locator('.control-help')).toBeHidden();
  await page.locator('.display-controls > summary').click(); await page.locator('.direction-high-chance').fill('24'); await page.locator('.direction-high-chance').dispatchEvent('change');
  await page.locator('.camera-motion').uncheck(); await page.locator('.camera-rotation').fill('25'); await page.locator('.scroll-lights').uncheck();
  await page.reload(); await physicsReady(page); await normalView(page); await page.locator('.display-controls > summary').click();
  await expect(page.locator('.direction-high-chance')).toHaveValue('24');
  await expect(page.locator('.camera-motion')).not.toBeChecked(); await expect(page.locator('.scroll-lights')).not.toBeChecked();
  await expect(page.locator('.camera-rotation')).toHaveValue('25');
  expect(await page.evaluate(() => window.micRequests)).toBe(0);
});
test('camera slider tracks the rendered view and Reduced Motion removes automatic motion', async ({ page }) => {
  await setup(page);
  await expect.poll(() => page.evaluate(() => Math.abs(Number(document.querySelector('.camera-rotation').value) - document.querySelector('#dancinglights').physics.rotation))).toBeLessThan(1);
  await page.evaluate(() => { window.cameraBefore = document.querySelector('#dancinglights').physics.rotation; });
  await expect.poll(() => page.evaluate(() => Math.abs(document.querySelector('#dancinglights').physics.rotation - window.cameraBefore)), { timeout: 3000 }).toBeGreaterThan(.2);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.rotation)).toBe(0);
  await expect(page.locator('.camera-rotation')).toHaveValue('0');
});

for (const path of ['/', '/advanced/']) for (const reducedMotion of ['reduce', 'no-preference']) {
  test(`native fullscreen rotation preserves video on ${path} (${reducedMotion})`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion });
    await setup(page, path, true, true); await load(page);
    const video = page.frameLocator('.youtube-frame iframe').locator('video');
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
    await page.frameLocator('.youtube-frame iframe').getByRole('button', { name: 'Play test video', exact: true }).click();
    await page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      window.nativeVideoIdentity = { player: videoPlayer, frame: videoPlayer.frame, worker: v.worker,
        renderer: v.renderer, balls: v.balls, context: testContext, session: document.querySelector('.audio-card').dataset.audioSession };
    });
    for (let turn = 0; turn < 4; turn++) {
      if (info.project.name === 'chromium') await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.querySelector('.visualizer-screen'))).toBe(true);
      await openFullscreenSettings(page); await closeFullscreenSettings(page);
      await clickControlAtHitPoint(page, page.locator('.rotate-display'));
      await expect(page.locator('.rotate-display')).toHaveAccessibleName(`Rotate view clockwise, current rotation ${((turn + 1) % 4) * 90} degrees`);
      const before = await video.evaluate(v => ({ time: v.currentTime, frames: videoFrames }));
      await expect.poll(() => video.evaluate((v, before) => !v.paused && !v.error
        && v.currentTime > before.time + .1 && videoFrames > before.frames + 2, before)).toBe(true);
      expect(await page.evaluate(() => {
        const v = document.querySelector('#dancinglights').physics, old = nativeVideoIdentity;
        return videoPlayer === old.player && videoPlayer.frame === old.frame && !old.player.destroyed
          && v.worker === old.worker && v.renderer === old.renderer && v.balls === old.balls
          && testContext === old.context && testContext.state === 'running'
          && document.querySelector('.audio-card').dataset.audioSession === old.session;
      })).toBe(true);
    }
  });
}

for (const path of ['/', '/advanced/']) for (const reducedMotion of ['reduce', 'no-preference']) for (const resizeLayout of [false, true])
for (const viewport of [{ width: 390, height: 844, keyboard: 440 }, { width: 568, height: 320, keyboard: 180 }]) {
  test(`manual rotation preserves playback on ${path} with a ${resizeLayout ? 'layout' : 'visual'} keyboard viewport (${viewport.width}px, ${reducedMotion})`, async ({ page }, info) => {
    test.setTimeout(60000);
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 390, height: 844 });
    // Headless browsers have no on-screen keyboard. Model both resize contracts.
    await page.addInitScript(() => {
      const viewport = Object.assign(new EventTarget(), { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      window.rotationKeyboard = height => { viewport.width = innerWidth; viewport.height = height; viewport.dispatchEvent(new Event('resize')); };
    });
    await setup(page, path, true); await load(page);
    const video = page.frameLocator('.youtube-frame iframe').locator('video');
    await video.evaluate(v => { window.rotationVideo = v; });
    await expect.poll(() => video.evaluate(v => v.readyState)).toBeGreaterThanOrEqual(2);
    // Keep the original frame for continuity checks. Re-resolving the iframe
    // and video locator for each sample adds several driver round trips.
    const frame = page.frames().find(frame => frame.url().startsWith('https://www.youtube-nocookie.com/'));
    expect(frame).toBeTruthy();
    await page.frameLocator('.youtube-frame iframe').getByRole('button', { name: 'Play test video', exact: true }).click();
    await expect.poll(() => video.evaluate(v => v.currentTime)).toBeGreaterThan(0);
    await page.evaluate(() => {
      // Feed a real, non-silent signal through the synthetic microphone stream.
      // A running context alone would also pass with a disconnected input graph.
      const destination = AudioContext.prototype.createMediaStreamDestination;
      AudioContext.prototype.createMediaStreamDestination = function(...args) {
        const stream = destination.apply(this, args), tone = this.createOscillator(), gain = this.createGain();
        tone.frequency.value = 1000; gain.gain.value = .02;
        tone.connect(gain); gain.connect(stream); tone.start();
        return stream;
      };
      const Worklet = AudioWorkletNode;
      window.rotationAudio = { sample: 0 };
      window.AudioWorkletNode = class extends Worklet {
        constructor(context, name, options) {
          // Home has no diagnostic controls. Enable the real processor's trace
          // in this fixture; never fabricate frames or advance its sample clock.
          if (name === 'loudness-processor') options.processorOptions.diagnostics = true;
          super(context, name, options);
          if (name === 'loudness-processor') this.port.addEventListener('message', ({ data }) => {
            if (data.type !== 'frame' || !data.trace?.length) return;
            window.rotationAudio = { sample: data.trace[data.trace.length - data.traceStride],
              session: data.sessionId, rms: data.readouts[0], continuity: data.continuity };
          });
        }
      };
    });
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
    await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
    await expect.poll(() => page.evaluate(() => rotationAudio.rms ?? -160)).toBeGreaterThan(-45);
    await page.evaluate(() => {
      videoPlayer.playVideo();
      const card = document.querySelector('.audio-card'), v = document.querySelector('#dancinglights').physics;
      window.rotationAudioStates = [];
      card.addEventListener('audio-session', ({ detail }) => rotationAudioStates.push(detail.state));
      window.playbackIdentity = { player: videoPlayer, frame: videoPlayer.frame, worker: v.worker, renderer: v.renderer,
        context: testContext, requests: micRequests, session: Number(card.dataset.audioSession) };
    });
    await expect.poll(() => video.evaluate(v => v.currentTime)).toBeGreaterThan(0);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate(height => rotationKeyboard(height), viewport.height);
    for (let turn = 0; turn < 4; turn++) {
      await expect(page.locator('.rotate-display')).toHaveAccessibleName(`Rotate view clockwise, current rotation ${turn * 90} degrees`);
      await openFullscreenSettings(page);
      await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Video', exact: true }));
      await expect.poll(() => page.evaluate(() => {
        const v = document.querySelector('#dancinglights').physics, style = getComputedStyle(v.layer);
        return !v.resizePending && Math.abs(v.canvasWidth - parseFloat(style.width)) < .1 && Math.abs(v.canvasHeight - parseFloat(style.height)) < .1;
      })).toBe(true);
      const geometry = () => page.evaluate(() => {
        const v = document.querySelector('#dancinglights').physics;
        return [v.canvasWidth, v.canvasHeight, v.input[32]];
      });
      const before = await geometry();
      if (resizeLayout) await page.setViewportSize({ width: viewport.width, height: viewport.keyboard });
      await page.evaluate(height => {
        rotationKeyboard(height);
        // Duplicate native notifications must not release frozen editor sizing.
        const descriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.querySelector('.visualizer-screen') });
        try { document.dispatchEvent(new Event('fullscreenchange')); }
        finally { if (descriptor) Object.defineProperty(document, 'fullscreenElement', descriptor); else delete document.fullscreenElement; }
      }, viewport.keyboard);
      await page.locator('.youtube-link').scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(({ width, keyboard }) => {
        const fits = node => { const r = node.getBoundingClientRect(); return r.left >= -.1 && r.top >= -.1 && r.right <= width + .1 && r.bottom <= keyboard + .1 && r.width >= 44 && r.height >= 44; };
        const close = document.querySelector('.close-fullscreen-settings'), box = close.getBoundingClientRect();
        return { modal: fits(document.querySelector('.fullscreen-settings')), field: fits(document.querySelector('.youtube-link')),
          close: fits(close) && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === close };
      }, viewport)).toEqual({ modal: true, field: true, close: true });
      await expect.poll(geometry).toEqual(before);
      if (resizeLayout) await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.evaluate(height => rotationKeyboard(height), viewport.height);
      await closeFullscreenSettings(page);
      await clickControlAtHitPoint(page, page.locator('.rotate-display'));
      await expect(page.locator('.rotate-display')).toHaveAccessibleName(`Rotate view clockwise, current rotation ${((turn + 1) % 4) * 90} degrees`);
      // Require at least 100 ms of newly analyzed samples AFTER every click,
      // including the fourth turn back to zero. Queued pre-click packets and
      // an advancing AudioContext clock cannot satisfy this check.
      const [videoAfterClick, afterClick] = await Promise.all([
        frame.evaluate(() => ({ frames: window.videoFrames, time: document.querySelector('video').currentTime })),
        page.evaluate(() => Math.ceil(testContext.currentTime * testContext.sampleRate)),
      ]);
      try {
        // Observe both video clocks together inside the frame. Repeated driver
        // calls to the busy video frame cost hundreds of milliseconds each on
        // software renderers. Keep the same thresholds and five-second deadline.
        await Promise.all([
          frame.evaluate(before => new Promise((resolve, reject) => {
            const v = document.querySelector('video');
            let frame;
            const timer = setTimeout(() => {
              cancelAnimationFrame(frame);
              reject(new Error(`Video did not advance: time=${v.currentTime}, frames=${window.videoFrames}`));
            }, 5000);
            const sample = () => {
              if (window.videoFrames > before.frames + 2 && v.currentTime > before.time + .1) {
                clearTimeout(timer); resolve();
              } else frame = requestAnimationFrame(sample);
            };
            sample();
          }), videoAfterClick),
          page.waitForFunction(afterClick => rotationAudio.sample > afterClick + 4800, afterClick, { timeout: 5000 }),
        ]);
      } catch (error) {
        await info.attach('video-progress.json', { contentType: 'application/json', body: JSON.stringify(await frame.evaluate(() => {
          const v = document.querySelector('video');
          return {
            time: v.currentTime, duration: v.duration, paused: v.paused, ended: v.ended, ready: v.readyState, seeking: v.seeking,
            frames: window.videoFrames, mediaTime: window.mediaTime, events: window.mediaEvents,
            decoded: v.getVideoPlaybackQuality().totalVideoFrames, dropped: v.getVideoPlaybackQuality().droppedVideoFrames,
          };
        })) });
        throw error;
      }
      expect(await frame.evaluate(() => {
        const v = document.querySelector('video');
        return { same: v === window.rotationVideo, paused: v.paused, error: v.error, pauses: window.videoPauses };
      })).toEqual({ same: true, paused: false, error: null, pauses: 0 });
      const audio = await page.evaluate(() => ({
        ...rotationAudio, expectedSession: playbackIdentity.session, state: document.querySelector('.audio-card').dataset.audioState,
        transitions: rotationAudioStates, video: videoPlayer.getPlayerState(), videoTransitions: videoPlayer.states,
        identity: (() => {
          const v = document.querySelector('#dancinglights').physics, old = playbackIdentity;
          return videoPlayer === old.player && videoPlayer.frame === old.frame && !old.player.destroyed
            && v.worker === old.worker && v.renderer === old.renderer && testContext === old.context
            && testContext.state === 'running' && micRequests === old.requests;
        })(),
      }));
      expect(audio.session).toBe(audio.expectedSession);
      expect(audio.continuity).toMatchObject({ segment: 0, missingSamples: 0, overlapSamples: 0 });
      expect(audio.rms).toBeGreaterThan(-45);
      expect(audio.state).toBe('playing');
      expect(audio.transitions.every(state => state === 'playing')).toBe(true);
      expect(audio.video).toBe(1);
      expect(audio.videoTransitions).toEqual([1]);
      expect(audio.identity).toBe(true);
    }
  });
}

for (const path of ['/', '/advanced/']) for (const reducedMotion of ['reduce', 'no-preference']) for (const resizeLayout of [false, true]) {
  test(`rotated Load and Remove dismiss the ${resizeLayout ? 'layout' : 'visual'} keyboard on ${path} (${reducedMotion})`, async ({ page }) => {
    test.setTimeout(60000);
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 568, height: 320 });
    await page.addInitScript(() => {
      const viewport = Object.assign(new EventTarget(), { width: 568, height: 320, offsetTop: 0, offsetLeft: 0 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      window.setEditorHeight = height => { viewport.height = height; viewport.dispatchEvent(new Event('resize')); };
    });
    await setup(page, path);
    await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Fullscreen', exact: true }));
    for (let turn = 0; turn < 4; turn++) {
      for (const action of ['Load video', 'Remove video']) {
        await openFullscreenSettings(page);
        await clickControlAtHitPoint(page, page.getByRole('button', { name: 'Video', exact: true }));
        await page.locator('.youtube-link').fill('https://youtu.be/abcDEF012_-?t=83');
        await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.resizePending)).toBe(false);
        const before = await page.evaluate(() => {
          const v = document.querySelector('#dancinglights').physics;
          return [v.canvasWidth, v.canvasHeight, v.input[32]];
        });
        if (resizeLayout) await page.setViewportSize({ width: 568, height: 180 });
        await page.evaluate(() => setEditorHeight(180));
        const button = page.getByRole('button', { name: action, exact: true });
        await button.scrollIntoViewIfNeeded();
        expect(await button.evaluate(n => {
          const r = n.getBoundingClientRect();
          return r.left >= 0 && r.top >= 0 && r.right <= 568 && r.bottom <= 180 && r.width >= 44 && r.height >= 44
            && n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        })).toBe(true);
        expect(await page.evaluate(() => {
          const v = document.querySelector('#dancinglights').physics;
          return [v.canvasWidth, v.canvasHeight, v.input[32]];
        })).toEqual(before);
        await clickControlAtHitPoint(page, button);
        await expect(page.locator('.fullscreen-settings')).not.toBeVisible();
        expect(await page.evaluate(() => {
          const card = document.querySelector('.audio-card');
          return !document.activeElement.matches('input') && !card.style.getPropertyValue('--expanded-width')
            && !card.style.getPropertyValue('--expanded-height');
        })).toBe(true);
        if (action === 'Load video') await expect(page.locator('.youtube-frame iframe')).toBeVisible();
        else {
          await expect(page.locator('.youtube-frame iframe')).toHaveCount(0);
          expect(await page.evaluate(() => videoPlayer.destroyed)).toBe(true);
        }
        if (resizeLayout) await page.setViewportSize({ width: 568, height: 320 });
        await page.evaluate(() => setEditorHeight(320));
      }
      await clickControlAtHitPoint(page, page.locator('.rotate-display'));
      await expect(page.locator('.rotate-display')).toHaveAccessibleName(`Rotate view clockwise, current rotation ${((turn + 1) % 4) * 90} degrees`);
    }
  });
}
