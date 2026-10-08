import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { physicsReady, syntheticAudio, startFrozen } from '../physics-state.mjs';

const origin = 'http://127.0.0.1:8101';
async function normal(page) { const exit = page.getByRole('button', { name: 'Exit fullscreen', exact: true }); if (await exit.isVisible()) await exit.click(); }

test('normal scenes fill a larger centered frame before and after fullscreen', async ({ page }) => {
  await syntheticAudio(page);
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const route of ['/', '/advanced/']) {
      await page.goto(origin + route); await physicsReady(page); await normal(page);
      for (let pass = 0; pass < 2; pass++) {
        await expect.poll(() => page.evaluate(() => {
          const v = document.querySelector('#dancinglights').physics;
          const graph = v.graph.getBoundingClientRect(), panel = v.graph.parentElement.getBoundingClientRect();
          return { centeredX: Math.abs(graph.x + graph.width / 2 - panel.x - panel.width / 2) < 1,
            centeredY: Math.abs(graph.y + graph.height / 2 - panel.y - panel.height / 2) < 1,
            sized: v.canvasWidth === graph.width && v.canvasHeight === graph.height,
            large: graph.height >= (innerWidth >= 1000 ? 500 : 320),
            bounded: v.canvas.width * v.canvas.height <= 200000,
            noOverflow: graph.x >= 0 && graph.right <= innerWidth };
        })).toEqual({ centeredX: true, centeredY: true, sized: true, large: true, bounded: true, noOverflow: true });
        if (pass === 0) {
          await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
          await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
          await normal(page);
        }
      }
    }
  }
});

test('all five bar banks share source lighting without internal wall partitions', async ({ page }) => {
  await syntheticAudio(page); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(origin + '/advanced/'); await normal(page); await startFrozen(page);
  await page.evaluate(() => window.sendBars(Array(24).fill(.4), 1));
  await expect.poll(() => page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return v.renderedHeight(0) / v.current[v.layout[17] + 1];
  })).toBeGreaterThan(.39);
  const result = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    v.draw(performance.now());
    const camera = new THREE.OrthographicCamera(-v.width * 2.5, v.width * 2.5, v.height / 2, -v.height / 2, .01, 20);
    camera.position.set(v.width / 2, v.height / 2, 2); camera.lookAt(v.width / 2, v.height / 2, 0); camera.updateMatrixWorld();
    const target = new THREE.WebGLRenderTarget(1440, 360), pixels = new Uint8Array(1440 * 360 * 4);
    try {
      v.renderer.setRenderTarget(target); v.renderer.render(v.scene, camera);
      v.renderer.readRenderTargetPixels(target, 0, 0, 1440, 360, pixels);
      const colors = [];
      for (let band = 0; band < 24; band++) {
        const source = v.bars.instanceMatrix.array;
        const rgb = [-2, -1, 0, 1, 2].map(box => {
          const point = new THREE.Vector3(source[band * 16 + 12] + box * v.width, v.renderedHeight(band) * .3, v.config[5] / 2).project(camera);
          const offset = (Math.floor((point.y + 1) * 180) * 1440 + Math.floor((point.x + 1) * 720)) * 4;
          return Array.from(pixels.slice(offset, offset + 3));
        });
        colors.push(rgb);
      }
      return { colors, walls: v.enclosure.count, wallWidth: v.enclosure.instanceMatrix.array[0],
        width: v.width, wallCenter: v.enclosure.instanceMatrix.array[12],
        outlines: v.scene.children.some(n => n.isLine), lights: v.attackLights.length,
        copyMaterials: v.mirrors.meshes.map(({ mesh }) => mesh.material.type) };
    } finally { v.renderer.setRenderTarget(null); target.dispose(); }
  });
  for (const banks of result.colors) {
    expect(Math.max(...banks[2])).toBeGreaterThan(150);
    for (const rgb of banks) expect(Math.max(...rgb.map((value, i) => Math.abs(value - banks[2][i])))).toBeLessThanOrEqual(3);
  }
  expect(result.walls).toBe(1); expect(result.wallWidth).toBeCloseTo(result.width * 5, 5);
  expect(result.wallCenter).toBeCloseTo(result.width / 2, 5);
  expect(result.outlines).toBe(false); expect(result.lights).toBe(4);
  expect(result.copyMaterials).toEqual(Array(3).fill('MeshLambertMaterial'));
});

test('paired physical bars and both Quiet/Loud guides follow the rotated camera', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${origin}/advanced/`); await physicsReady(page); await normal(page);
  await page.locator('.display-controls > summary').click();
  for (const angle of [-35, 0, 35]) {
    await page.locator('.camera-rotation').fill(String(angle));
    await expect.poll(() => page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      const h = v.renderedEnclosureHeight;
      let error = 0;
      for (let i = 0; i < 24; i++) error = Math.max(error, Math.abs(v.renderedHeight(i) - v.renderedHeight(i, 1)));
      return { error: error < .00001, count: v.bars.count, base: v.card.dataset.barBase, fits: Math.max(...v.current.slice(v.layout[9], v.layout[10])) * 2 < h };
    })).toEqual({ error: true, count: 144, base: 'both', fits: true });
    const alignment = await page.evaluate(async () => {
      const v = document.querySelector('#dancinglights').physics;
      const base = document.querySelector('meta[name="musical-lights-assets"]').content;
      const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
      v.draw(performance.now());
      const graph = v.graph.getBoundingClientRect(), h = v.current[v.layout[17]], max = v.current[v.layout[17] + 1];
      const guides = [...v.graph.querySelector('.meter-guide').children].map((node, i) => {
        const point = new THREE.Vector3(0, [h - .003, h - max, max, .003][i], v.config[5] / 2).project(v.camera);
        const box = node.getBoundingClientRect();
        return Math.abs(box.y + box.height / 2 - graph.y - (1 - point.y) * graph.height / 2);
      });
      const corners = Array.from({ length: 8 }, (_, i) => {
        const point = new THREE.Vector3(i & 1 ? v.width : 0, i & 2 ? h : 0, (i & 4 ? 1 : -1) * v.config[5] / 2).project(v.camera);
        return Math.max(Math.abs(point.x), Math.abs(point.y));
      });
      const labelsVisible = [...v.graph.querySelector('.meter-guide').children].every(node => {
        const box = node.getBoundingClientRect();
        return box.x >= graph.x && box.right <= graph.right && box.y >= graph.y && box.bottom <= graph.bottom;
      });
      const guideStyle = getComputedStyle(v.graph.querySelector('.meter-guide'));
      return { guides, corners, labelsVisible,
        guideAboveScene: Number(guideStyle.zIndex) > Number(getComputedStyle(v.layer).zIndex),
        guidesIgnorePointer: guideStyle.pointerEvents === 'none' };
    });
    expect(Math.max(...alignment.guides)).toBeLessThan(1.5);
    expect(Math.max(...alignment.corners)).toBeLessThan(1);
    expect(alignment.labelsVisible).toBe(true);
    expect(alignment.guideAboveScene).toBe(true);
    expect(alignment.guidesIgnorePointer).toBe(true);
  }
});

test('one transparent enclosure shows bounded depth copies and preserves source pixels at oblique views', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto(`${origin}/advanced/`); await physicsReady(page); await normal(page);
  await page.locator('.display-controls > summary').click();
  for (const angle of [-35, 0, 35]) {
    const state = await page.evaluate(async angle => {
      const v = document.querySelector('#dancinglights').physics;
      const base = document.querySelector('meta[name="musical-lights-assets"]').content;
      const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
      v.cameraBase = angle; v.setCamera(angle); v.draw(performance.now());
      const target = new THREE.WebGLRenderTarget(240, 160), pixels = new Uint8Array(240 * 160 * 4);
      const render = () => { v.renderer.setRenderTarget(target); v.renderer.render(v.scene, v.camera); v.renderer.readRenderTargetPixels(target, 0, 0, 240, 160, pixels); return pixels.slice(); };
      const reflected = render(), passes = v.renderer.info.render.calls;
      v.mirrors.meshes.forEach(({ mesh }) => { mesh.visible = false; });
      const plain = render(); v.mirrors.meshes.forEach(({ mesh }) => { mesh.visible = true; });
      let changes = 0, sourcePixels = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.abs(reflected[i] - plain[i]) + Math.abs(reflected[i + 1] - plain[i + 1]) + Math.abs(reflected[i + 2] - plain[i + 2]) > 12) changes++;
        if (plain[i] + plain[i + 1] + plain[i + 2] > 60) sourcePixels++;
      }
      const normals = Array.from({length:6},(_,i)=>new THREE.Vector3().fromBufferAttribute(v.enclosure.geometry.attributes.normal,i*4).negate().toArray());
      const result = { changes, sourcePixels, normals, walls: v.enclosure.geometry.groups.length,
        passes, targets: v.mirrors.meshes.length, pixels: v.canvas.width * v.canvas.height,
        negativeScales: v.mirrors.meshes.some(({ mesh }) => new THREE.Matrix4().fromArray(mesh.instanceMatrix.array).determinant() < 0) };
      v.renderer.setRenderTarget(null); target.dispose(); v.cameraBase = 0; v.setCamera(0); return result;
    }, angle);
    expect(state.changes).toBeGreaterThan(150);
    expect(state.sourcePixels).toBeGreaterThan(200);
    expect(state.walls).toBe(6); expect(state.targets).toBe(3); expect(state.negativeScales).toBe(false);
    expect(state.pixels).toBeLessThanOrEqual(200000);
    expect(state.passes).toBeLessThanOrEqual(12);
    expect(state.normals[0][0]).toBeCloseTo(-1); expect(state.normals[1][0]).toBeCloseTo(1);
    await info.attach(`mirror-${angle}.json`, { body: JSON.stringify(state), contentType: 'application/json' });
  }
  await page.locator('#dancinglights').scrollIntoViewIfNeeded();
  const timing = await page.evaluate(() => new Promise(resolve => {
    const view = document.querySelector('#dancinglights').physics;
    const start = performance.now(), initial = { ...view.metrics }, times = []; let previous = start;
    const sample = now => { times.push(now - previous); previous = now;
      if (now - start < 4000) requestAnimationFrame(sample);
      else resolve({ fps: times.length * 1000 / (now - start), p95FrameMs: times.toSorted((a,b)=>a-b)[Math.ceil(times.length*.95)-1],
        meanRenderMs: (view.metrics.renderMs-initial.renderMs)/(view.metrics.frames-initial.frames), physicalDevice: false });
    }; requestAnimationFrame(sample);
  }));
  await info.attach('mirror-frame-cost.json', { body: JSON.stringify(timing), contentType: 'application/json' });
  await writeFile(info.outputPath('mirror-frame-cost.json'), JSON.stringify(timing));
  await page.locator('#dancinglights').screenshot({ path: info.outputPath('mirror-front.png') });
  await page.locator('.camera-rotation').fill('35');
  await page.waitForTimeout(100);
  await page.locator('#dancinglights').screenshot({ path: info.outputPath('mirror-side.png') });
  expect(errors).toEqual([]);
});

test('Advanced saves bounded direction endpoints and curve without starting audio', async ({ page }) => {
  await page.goto(`${origin}/advanced/`); await physicsReady(page); await normal(page);
  await page.locator('.display-controls > summary').click();
  for (const [selector, value] of [['slow-bpm', '80'], ['fast-bpm', '180'], ['low-chance', '10'], ['high-chance', '70'], ['curve', '2']]) {
    await page.locator(`.direction-${selector}`).fill(value); await page.locator(`.direction-${selector}`).dispatchEvent('change');
  }
  expect(await page.evaluate(() => document.querySelector('.audio-card').preferences.directionOdds)).toEqual([80, 180, .1, .7, 2]);
  await page.locator('.direction-slow-bpm').fill('190'); await page.locator('.direction-slow-bpm').dispatchEvent('change');
  await expect(page.locator('.direction-error')).toContainText('increasing BPM');
  expect(await page.evaluate(() => document.querySelector('.audio-card').preferences.directionOdds)).toEqual([80, 180, .1, .7, 2]);
  await page.reload(); await physicsReady(page); await normal(page); await page.locator('.display-controls > summary').click();
  await expect(page.locator('.direction-curve')).toHaveValue('2');
  await page.locator('.display-reset').click();
  expect(await page.evaluate(() => document.querySelector('.audio-card').preferences.directionOdds)).toEqual([60, 200, .05, .5, 1]);
  await expect(page.locator('.tempo-readout')).toBeHidden();
  await expect(page.locator('.tempo-readout')).toHaveText('');
  await expect(page.locator('.tempo-readout')).toHaveAttribute('aria-live', 'off');
  await expect(page.locator('.listening-toggle')).not.toBeChecked();
});

test('mirror count saves, rejects fractions and resets without changing physics', async ({ page }) => {
  await syntheticAudio(page); await page.goto(`${origin}/advanced/`); await physicsReady(page); await normal(page);
  await page.locator('.display-controls > summary').click();
  await page.evaluate(() => { window.mirrorMeshes = document.querySelector('#dancinglights').physics.mirrors.meshes.map(({mesh})=>mesh); });
  await page.locator('.listening-toggle').check();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state','playing');
  await page.evaluate(() => { window.mirrorAudioFrames=0;document.querySelector('.audio-card').addEventListener('audio-tempo',()=>window.mirrorAudioFrames++); });
  for (const count of [0, 1, 17]) {
    await page.locator('.mirror-count').fill(String(count)); await page.locator('.mirror-count').dispatchEvent('change');
    expect(await page.evaluate(() => {
      const v = document.querySelector('#dancinglights').physics;
      return [v.settings.mirrorCount, v.mirrors.count, v.balls.count, v.layout[21], v.sideBars.capacity,
        v.mirrors.meshes.every(({mesh},i)=>mesh===window.mirrorMeshes[i])];
    })).toEqual([count, count, 8, 8, 200, true]);
  }
  await expect.poll(()=>page.evaluate(()=>window.mirrorAudioFrames)).toBeGreaterThan(5);
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state','playing');
  await page.locator('.mirror-count').fill('1.5'); await page.locator('.mirror-count').dispatchEvent('change');
  expect(await page.evaluate(() => document.querySelector('.audio-card').preferences.mirrorCount)).toBe(17);
  await page.reload(); await physicsReady(page); await normal(page); await page.locator('.display-controls > summary').click();
  await expect(page.locator('.mirror-count')).toHaveValue('17');
  await page.locator('.display-reset').click(); await expect(page.locator('.mirror-count')).toHaveValue('3');
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.mirrors.count)).toBe(3);
});

test('idle hides tempo and actual silent microphone PCM stays at 60 BPM', async ({ page }) => {
  await syntheticAudio(page); await page.goto(`${origin}/advanced/`); await physicsReady(page);
  await expect(page.locator('.tempo-readout')).toBeHidden();
  await page.locator('.listening-toggle').check();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect(page.locator('.tempo-readout')).toBeVisible();
  await expect(page.locator('.tempo-readout')).toHaveText('60 BPM');
  await page.locator('.listening-toggle').uncheck();
  await expect(page.locator('.tempo-readout')).toBeHidden(); await expect(page.locator('.tempo-readout')).toHaveText('');
});

test('full-size background boxes repeat all source bands beside the physical center box', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${origin}/advanced/`); await physicsReady(page); await normal(page);
  const results = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    v.draw(performance.now());
    const target = new THREE.WebGLRenderTarget(240, 160), pixels = new Uint8Array(240 * 160 * 4);
    const render = () => { v.renderer.setRenderTarget(target); v.renderer.render(v.scene, v.camera); v.renderer.readRenderTargetPixels(target, 0, 0, 240, 160, pixels); return pixels.slice(); };
    const results = [];
    try {
      for (const angle of [-40, 40]) {
        v.setCamera(angle); v.draw(performance.now());
        const copy = render(); v.sideBars.mesh.visible = false;
        const without = render(); v.sideBars.mesh.visible = true;
        const offsets = [...v.sideBars.offsets.slice(0,v.sideBars.mesh.count)];
        const bands = [...v.sideBars.sourceBands.slice(0,v.sideBars.mesh.count)];
        const tips = bands.map((band,i)=>Math.abs(v.sideBars.mesh.instanceMatrix.array[i*16+5])-v.renderedHeight(band));
        results.push({ angle, changed: copy.reduce((n,x,i)=>n+Number(Math.abs(x-without[i])>8),0),
          banks:[-2,-1,1,2].map(box=>new Set(bands.filter((_,i)=>Math.abs(offsets[i]-box*v.width)<1e-6)).size),
          tipError:Math.max(...tips.map(Math.abs)),balls:v.balls.count,
          depth:v.bars.geometry.parameters.depth,physicalDepth:v.config[5],
          width:v.sideBars.geometry.parameters.width,sourceWidth:v.bars.geometry.parameters.width,
          boxes:v.enclosure.count });
      }
    } finally { v.renderer.setRenderTarget(null); target.dispose(); }
    return results;
  });
  for (const result of results) {
    expect(result.banks).toEqual([24,24,24,24]); expect(result.balls).toBe(8);
    expect(result.boxes).toBe(1); expect(result.depth).toBeCloseTo(result.physicalDepth,6);
    expect(result.width).toBe(result.sourceWidth);
    expect(result.tipError).toBeLessThan(.00001); expect(result.changed,JSON.stringify(result)).toBeGreaterThan(100);
  }
});

test('phone opens expanded without capture and keeps video, notices, song and Exit visible in short landscape', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => { window.micRequests = 0; MediaDevices.prototype.getUserMedia = async () => { window.micRequests++; throw Error('Unexpected automatic capture'); }; });
    for (const route of ['/', '/advanced/']) {
      await page.goto(origin + route); await physicsReady(page);
      await expect(page.locator('.audio-card')).toHaveAttribute('data-expanded', '');
      expect(await page.evaluate(() => [window.micRequests, document.fullscreenElement])).toEqual([0, null]);
      await page.evaluate(() => {
        const card = document.querySelector('.audio-card'); card.classList.add('video-active');
        const panel = card.querySelector('.video-panel'); panel.hidden = false;
        panel.querySelector('.youtube-frame').innerHTML = '<iframe title="Layout fixture" src="about:blank"></iframe>';
        card.querySelector('#dancinglights').physics.notice.show('Graphics recovery notice.', 'Graphics recovery notice.');
        const title = card.querySelector('.recognized-song'); title.hidden = false;
        title.querySelector('.song-title').textContent = 'An artist with a long name — A long song title '.repeat(4);
      });
      for (const viewport of [{ width: 393, height: 852 }, { width: 568, height: 320 }]) {
        await page.setViewportSize(viewport);
        for (const label of ['Listening', 'Identify song', 'Phone motion', 'Scroll lights']) await expect(page.getByRole('checkbox', { name: label, exact: true }).locator('..')).toBeInViewport({ ratio: 1 });
        await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeInViewport({ ratio: 1 });
        await expect(page.locator('.physics-status')).toBeVisible();
        await expect(page.locator('.camera-rotation')).toBeInViewport({ ratio: 1 });
        await expect(page.locator('.frame-rate')).toHaveText(/^\d+ FPS$/);
        await expect(page.locator('.frame-rate')).toBeInViewport({ ratio: 1 });
        expect(await page.evaluate(() => {
          const camera = document.querySelector('.camera-controls').getBoundingClientRect();
          const controls = document.querySelector('.audio-controls').getBoundingClientRect();
          const slider = document.querySelector('.camera-rotation'), box = slider.getBoundingClientRect();
          return { separate: camera.bottom <= controls.top, touchSize: box.height >= 44,
            aligned: Math.abs(box.y + box.height / 2 - camera.y - camera.height / 2) < 1,
            touchable: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === slider };
        })).toEqual({ separate: true, touchSize: true, aligned: true, touchable: true });
        await page.locator('.camera-rotation').fill('30');
        await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.cameraBase)).toBe(30);
        await page.locator('.camera-rotation').focus(); await page.keyboard.press('ArrowLeft');
        await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.cameraBase)).toBe(29);
        const scene = await page.locator('#dancinglights').boundingBox(); expect(scene.height).toBeGreaterThan(20);
      }
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
      await expect(page.locator('.audio-card')).not.toHaveAttribute('data-expanded', '');
      await page.setViewportSize({ width: 393, height: 852 });
    }
  } finally { await context.close(); }
});


test('center supports and neighboring bars fill the same physical depth', async ({ page }) => {
  await syntheticAudio(page); await page.goto(`${origin}/advanced/`); await startFrozen(page);
  await page.evaluate(() => window.sendBars(Array.from({length:24},(_,i)=>.15+.65*i/23)));
  await page.waitForTimeout(150);
  const result=await page.evaluate(()=>{
    const v=document.querySelector('#dancinglights').physics; v.draw(performance.now());
    const source=v.bars.instanceMatrix.array, side=v.sideBars.mesh.instanceMatrix.array;
    return {depth:v.bars.geometry.parameters.depth,physicalDepth:v.config[5],sideDepth:v.sideBars.geometry.parameters.depth,
      centers:Array.from({length:24},(_,i)=>source[i*16+14]),
      widths:[v.bars.geometry.parameters.width,v.sideBars.geometry.parameters.width],
      heightError:Math.max(...Array.from({length:v.sideBars.mesh.count},(_,i)=>Math.abs(Math.abs(side[i*16+5])-v.renderedHeight(v.sideBars.sourceBands[i])))),
      shifts:[...new Set(v.sideBars.offsets.slice(0,v.sideBars.mesh.count))],width:v.width,
      outerWidth:v.enclosure.instanceMatrix.array[0],outerCenter:v.enclosure.instanceMatrix.array[12],coatings:v.enclosure.count,
      bodyCount:v.layout[21],physicalBalls:v.balls.count};
  });
  expect(result.depth).toBeCloseTo(result.physicalDepth,6); expect(result.sideDepth).toBe(result.depth);
  expect(result.centers.every(z=>z===0)).toBe(true); expect(result.widths[0]).toBe(result.widths[1]);
  expect(result.heightError).toBeLessThan(.000001);
  expect(result.shifts).toHaveLength(4);
  for (const [i, offset] of [-2,-1,1,2].entries()) expect(result.shifts[i]).toBeCloseTo(offset*result.width,6);
  expect(result.coatings).toBe(1);
  expect(result.outerWidth).toBeCloseTo(5*result.width,6);
  expect(result.outerCenter).toBeCloseTo(result.width/2,6);
  expect(result.bodyCount).toBe(8); expect(result.physicalBalls).toBe(8);
});

test('offscreen rendering stops while audio and physics keep running', async ({ page }) => {
  await page.goto(`${origin}/advanced/`); await physicsReady(page); await normal(page);
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.review-start').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state','playing');
  await page.locator('#dancinglights').scrollIntoViewIfNeeded();
  await expect.poll(()=>page.evaluate(()=>document.querySelector('#dancinglights').physics.sceneVisible)).toBe(true);
  await page.locator('footer').scrollIntoViewIfNeeded();
  await expect.poll(()=>page.evaluate(()=>document.querySelector('#dancinglights').physics.sceneVisible)).toBe(false);
  const before=await page.evaluate(()=>{const v=document.querySelector('#dancinglights').physics;return {frames:v.metrics.frames,tick:v.current[2]};});
  await expect.poll(()=>page.evaluate(()=>document.querySelector('#dancinglights').physics.current[2])).toBeGreaterThan(before.tick+20);
  expect(await page.evaluate(()=>document.querySelector('#dancinglights').physics.metrics.frames)).toBe(before.frames);
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state','playing');
  await page.locator('#dancinglights').scrollIntoViewIfNeeded();
  await expect.poll(()=>page.evaluate(()=>document.querySelector('#dancinglights').physics.metrics.frames)).toBeGreaterThan(before.frames);
});

test('instanced depth copies match literal translated geometry from both camera sides', async ({ page }) => {
  await page.emulateMedia({ reducedMotion:'reduce' });
  await page.goto(`${origin}/advanced/`); await physicsReady(page); await normal(page);
  const results=await page.evaluate(async()=>{
    const v=document.querySelector('#dancinglights').physics;
    const base=document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE=await import(new URL(`${base}physics/three.module.js`,document.baseURI));
    const target=new THREE.WebGLRenderTarget(240,160),pixels=new Uint8Array(240*160*4),results=[];
    const render=()=>{v.renderer.setRenderTarget(target);v.renderer.render(v.scene,v.camera);v.renderer.readRenderTargetPixels(target,0,0,240,160,pixels);return pixels.slice();};
    try {
      for(const [angle,vertical] of [[-40,0],[0,0],[40,0],[20,.8],[-20,-.8]]) {
        v.setCamera(angle,vertical);v.draw(performance.now());const actual=render(),references=[];
        for(const entry of v.mirrors.meshes) {
          entry.mesh.visible=false;
          const {source,capacity,matrices,colors,attributes}=entry.staged;
          for(let layer=0;layer<v.mirrors.count;layer++) {
            const geometry=entry.mesh.geometry.clone();
            for(const {name,attr,values} of attributes) geometry.setAttribute(name,new THREE.InstancedBufferAttribute(values.slice(),attr.itemSize));
            const material=source.material.clone();
            material.defines={...source.material.defines};
            material.onBeforeCompile=shader=>{
              source.material.onBeforeCompile(shader);
              // Literal transforms move geometry. Undo only the depth shift
              // in the lighting position, independently of copy projection.
              const shift=(layer+1)*v.config[5];
              shader.vertexShader=shader.vertexShader.replace('vViewPosition = -(modelViewMatrix * vec4(world, 1.0)).xyz;',`vViewPosition = -(modelViewMatrix * vec4(world + vec3(0.0, 0.0, ${shift}), 1.0)).xyz;`);
              shader.vertexShader=shader.vertexShader.replace('vViewPosition = - mvPosition.xyz;',`vViewPosition = -(mvPosition.xyz + (modelViewMatrix * vec4(0.0, 0.0, ${shift}, 0.0)).xyz);`);
              shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`outgoingLight *= ${.72**(layer+1)};\n#include <opaque_fragment>`);
            };
            material.customProgramCacheKey=()=>`literal-depth-${entry.staged.kind}-${layer}`;
            const mesh=new THREE.InstancedMesh(geometry,material,capacity);mesh.frustumCulled=false;
            mesh.instanceMatrix.array.set(matrices);mesh.instanceColor=new THREE.InstancedBufferAttribute(colors.slice(),3);
            // Translate the copied transforms independently of the production
            // shader. Both paths use instance coordinates, so touching surfaces
            // do not compare two different model-view rounding orders.
            for(let i=0;i<capacity;i++) mesh.instanceMatrix.array[i*16+14]-=(layer+1)*v.config[5];
            v.scene.add(mesh);references.push(mesh);
          }
        }
        const expected=render();let error=0,changed=0;
        for(let i=0;i<actual.length;i+=4){let delta=0;for(let c=0;c<3;c++)delta+=Math.abs(actual[i+c]-expected[i+c]);error+=delta;if(delta>6)changed++;}
        results.push({angle,vertical,meanError:error/(240*160*3),changed});
        for(const mesh of references){v.scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();mesh.dispose();}
        v.mirrors.meshes.forEach(({mesh})=>{mesh.visible=true;});
      }
    } finally {v.renderer.setRenderTarget(null);target.dispose();}
    return results;
  });
  for(const result of results){expect(result.meanError,JSON.stringify(result)).toBeLessThan(1);expect(result.changed,JSON.stringify(result)).toBeLessThan(240*160*.005);}
});

test('digital tempo is visible with Listening off and hides on pause and natural end', async ({ page }) => {
  await page.goto(`${origin}/advanced/`); await physicsReady(page); await normal(page);
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.tone-repeat').check(); await page.locator('.tone-audible').uncheck();
  await page.locator('.review-start').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state','playing');
  await expect(page.locator('.listening-toggle')).not.toBeChecked();
  await expect(page.locator('.tempo-readout')).toBeVisible();
  await page.locator('.tone-pause').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state','paused');
  await expect(page.locator('.tempo-readout')).toBeHidden();
  await page.locator('.tone-pause').click();
  await expect(page.locator('.tempo-readout')).toBeVisible();
  await page.locator('.tone-repeat').uncheck();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state','ended',{timeout:15000});
  await expect(page.locator('.tempo-readout')).toBeHidden(); await expect(page.locator('.tempo-readout')).toHaveText('');
});


test('full-size background bands show lit faces and depth copies separate at oblique angles', async ({ page }, info) => {
  await syntheticAudio(page); await page.goto(`${origin}/advanced/`); await startFrozen(page);
  await page.evaluate(() => { const v = document.querySelector('#dancinglights').physics; v.settings.cameraMotion = false; window.sendBars(Array(24).fill(.8)); });
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.input[0])).toBeCloseTo(.8, 5);
  await page.waitForTimeout(150);
  const results = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    const target = new THREE.WebGLRenderTarget(900, 500), pixels = new Uint8Array(900 * 500 * 4), results = [];
    v.balls.visible = false;
    try {
      for (const angle of [-40, 40]) {
        v.setCamera(angle); v.draw(performance.now());
        const camera = v.camera.clone();
        // Fit all five boxes for the all-band pixel check. The normal camera
        // deliberately frames the physical center; neighbors enter on rotation.
        const center = new THREE.Vector3(v.width / 2, v.visibleHeight / 2, 0);
        camera.position.sub(center).multiplyScalar(5).add(center);
        camera.lookAt(center); camera.updateMatrixWorld();
        v.renderer.setRenderTarget(target); v.renderer.render(v.scene, camera);
        v.renderer.readRenderTargetPixels(target, 0, 0, 900, 500, pixels);
        const fills = [];
        for (let i = 0; i < v.sideBars.mesh.count; i++) {
          const matrix = new THREE.Matrix4().fromArray(v.sideBars.mesh.instanceMatrix.array, i * 16);
          const point = new THREE.Vector3().setFromMatrixPosition(matrix);
          point.z = v.config[5] / 2; point.project(camera);
          const x = Math.floor((point.x + 1) * 450), y = Math.floor((point.y + 1) * 250);
          let brightness = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const offset = ((y + dy) * 900 + x + dx) * 4;
            brightness = Math.max(brightness, ...pixels.slice(offset, offset + 3));
          }
          fills.push(brightness);
        }
        const source = new THREE.Vector3(v.width / 2, v.renderedHeight(12), v.config[5] / 2);
        const depths = [0, -1, -2].map(z => source.clone().add(new THREE.Vector3(0, 0, z * v.config[5])).project(v.camera).toArray());
        results.push({ angle, fills, depths, physicalBalls: v.balls.count, triangles: v.bars.geometry.index.count / 3 });
      }
    } finally { v.balls.visible = true; v.renderer.setRenderTarget(null); target.dispose(); }
    return results;
  });
  for (const result of results) {
    expect(result.fills.length).toBeGreaterThanOrEqual(192);
    for (const brightness of result.fills) expect(brightness, JSON.stringify(result)).toBeGreaterThan(70);
    expect(result.physicalBalls).toBe(8); expect(result.triangles).toBe(12);
    expect(Math.abs(result.depths[0][0] - result.depths[1][0])).toBeGreaterThan(.01);
    expect(Math.abs(result.depths[1][0] - result.depths[2][0])).toBeGreaterThan(.01);
  }
  await info.attach('visible-background-fills.json', { body: JSON.stringify(results), contentType: 'application/json' });
});

test('all bars show current physical travel without a previous-snapshot delay', async ({ page }, info) => {
  await syntheticAudio(page); await page.goto(`${origin}/advanced/`); await startFrozen(page);
  await page.evaluate(() => window.sendBars(Array.from({ length: 24 }, (_, i) => .1 + .7 * i / 23)));
  const errors = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics, errors = [];
    for (let frame = 0; frame < 12; frame++) {
      await new Promise(resolve => requestAnimationFrame(resolve)); v.draw(performance.now());
      errors.push(Math.max(...Array.from({ length: 24 }, (_, i) => Math.abs(v.renderedHeight(i) - v.current[v.layout[9] + i]))));
    }
    return errors;
  });
  expect(Math.max(...errors)).toBeLessThan(.000001);
  await info.attach('all-band-render-travel.json', { body: JSON.stringify(errors), contentType: 'application/json' });
});

test('expanded mode shows actual rendered FPS without adding a footer row', async ({ page }) => {
  await page.addInitScript(() => { MediaDevices.prototype.getUserMedia = async () => { throw new Error('Capture disabled for presentation check'); }; });
  await page.goto(origin); await physicsReady(page);
  if (!await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  const fps = page.locator('.frame-rate');
  await expect(fps).toHaveText(/^\d+ FPS$/);
  expect(Number((await fps.textContent()).split(' ')[0])).toBeGreaterThan(0);
  for (const viewport of [{width:390,height:664},{width:568,height:320}]) {
    await page.getByRole('button',{name:'Exit fullscreen',exact:true}).click();
    await page.setViewportSize(viewport);
    await page.getByRole('button',{name:'Fullscreen',exact:true}).click();
    await expect(fps).toHaveText(/^\d+ FPS$/);
    await expect(fps).toBeInViewport({ratio:1});
    await expect(page.locator('.camera-rotation')).toBeInViewport({ratio:1});
    await expect(page.getByRole('button',{name:'Exit fullscreen',exact:true})).toBeInViewport({ratio:1});
    expect(await fps.evaluate(node => node.parentElement.className)).toBe('camera-controls');
  }
  await page.getByRole('button',{name:'Exit fullscreen',exact:true}).click();
  await expect(fps).toHaveCount(0);
  await expect(page.locator('.diagnostic-fps')).toHaveCount(0);
});

test('camera sweep turns smoothly on the horizontal plane without attack shake', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(origin); await physicsReady(page);
  const result = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    cancelAnimationFrame(v.request); v.request = null;
    document.activeElement?.blur(); v.cameraBase = 0; v.cameraAt = null; v.cameraTime = 0;
    const samples = [];
    for (let now = 0; now <= 24000; now += 250) {
      v.updateCamera(now);
      const before = v.rotation;
      v.card.dispatchEvent(new CustomEvent('audio-tempo', { detail: { bpm: 160, confidence: 1, accentSequence: now + 1 } }));
      v.updateCamera(now);
      samples.push({time:now,yaw:v.rotation,y:v.camera.position.y,attackDelta:v.rotation-before});
    }
    const nearTurn = samples.filter(s=>Math.abs(s.time-6000)<=250).map(s=>s.yaw);
    v.cameraBase = 35; v.cameraAt = null; v.cameraTime = 0;
    const bounded=[];
    for(let now=0;now<=24000;now+=1000){v.updateCamera(now);bounded.push(v.rotation);}
    v.cameraControl.focus(); v.updateCamera(25000);
    return {samples,nearTurn,bounded,manual:v.rotation,centerY:v.visibleHeight/2,
      outlines:v.scene.children.some(node=>node.isLineSegments)};
  });
  expect(result.outlines).toBe(false);
  expect(result.manual).toBe(35);
  expect(Math.min(...result.bounded)).toBeCloseTo(30,6); expect(Math.max(...result.bounded)).toBeCloseTo(40,6);
  for(const sample of result.samples){expect(sample.y).toBeCloseTo(result.centerY,8);expect(sample.attackDelta).toBe(0);}
  for(const [start,end,direction] of [[0,6000,1],[6000,18000,-1],[18000,24000,1]]) {
    const span=result.samples.filter(s=>s.time>=start&&s.time<=end);
    for(let i=1;i<span.length;i++) expect(direction*(span[i].yaw-span[i-1].yaw)).toBeGreaterThan(0);
  }
  expect(result.nearTurn[1]).toBeCloseTo(30,6);
  expect(Math.max(...result.nearTurn)-Math.min(...result.nearTurn)).toBeLessThan(.1);
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect.poll(() => page.evaluate(() => document.querySelector('#dancinglights').physics.reduced.matches)).toBe(true);
  expect(await page.evaluate(()=>{const v=document.querySelector('#dancinglights').physics;v.cameraControl.blur();v.cameraBase=12;v.updateCamera(30000);return v.rotation;})).toBe(12);
});

test('depth-copy uploads follow the active count and keep pooled geometry', async ({ page }) => {
  await page.goto(`${origin}/advanced/`); await physicsReady(page);
  const evidence = await page.evaluate(() => {
    const v=document.querySelector('#dancinglights').physics,gl=v.renderer.getContext();
    v.draw(performance.now());
    const pools=v.mirrors.meshes.map(({mesh})=>mesh);
    const original=gl.bufferSubData,records=[];
    try {
      for(const count of [0,1,3,17,3]) {
        v.mirrors.setCount(count);
        const arrays=new Map();
        for(const {mesh,staged} of v.mirrors.meshes) {
          for(const attr of [mesh.instanceMatrix,mesh.instanceColor,...staged.attributes.map(({name})=>mesh.geometry.attributes[name])])
            arrays.set(attr.array,mesh.count*attr.itemSize*attr.array.BYTES_PER_ELEMENT);
        }
        const uploads=[];
        gl.bufferSubData=function(target,offset,data,start=0,length) {
          if(arrays.has(data)) uploads.push({expected:arrays.get(data),actual:(length ?? data.length-start)*data.BYTES_PER_ELEMENT});
          return original.apply(this,arguments);
        };
        v.draw(performance.now());
        records.push({count,uploads,pooled:v.mirrors.meshes.every(({mesh},i)=>mesh===pools[i]),
          balls:v.balls.count,boxes:v.enclosure.count});
      }
    } finally {gl.bufferSubData=original;v.mirrors.setCount(v.settings.mirrorCount);}
    return records;
  });
  for(const record of evidence) {
    expect(record.pooled).toBe(true);expect(record.balls).toBe(8);expect(record.boxes).toBe(1);
    if(record.count===0) expect(record.uploads).toHaveLength(0);
    else {
      expect(record.uploads.length).toBeGreaterThanOrEqual(6);
      for(const upload of record.uploads) expect(upload.actual).toBe(upload.expected);
    }
  }
});
