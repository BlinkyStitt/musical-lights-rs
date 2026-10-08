import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { physicsReady, syntheticAudio } from '../physics-state.mjs';

const origin = 'http://127.0.0.1:8101';
async function normal(page) { const exit = page.getByRole('button', { name: 'Exit fullscreen', exact: true }); if (await exit.isVisible()) await exit.click(); }

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
        const point = new THREE.Vector3(0, [h - .003, h - max, max, .003][i], 0).project(v.camera);
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
      return { guides, corners, labelsVisible };
    });
    expect(Math.max(...alignment.guides)).toBeLessThan(1.5);
    expect(Math.max(...alignment.corners)).toBeLessThan(1);
    expect(alignment.labelsVisible).toBe(true);
  }
});

test('six one-way faces show bounded mirror images and preserve source pixels at oblique views', async ({ page }, info) => {
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
      const normals = v.enclosure.children.map(wall => new THREE.Vector3(0, 0, 1).applyQuaternion(wall.quaternion).toArray());
      const result = { changes, sourcePixels, normals, walls: v.enclosure.children.length,
        passes, targets: v.mirrors.meshes.length, pixels: v.canvas.width * v.canvas.height,
        negativeScales: v.mirrors.meshes.some(({ mesh }) => new THREE.Matrix4().fromArray(mesh.instanceMatrix.array).determinant() < 0) };
      v.renderer.setRenderTarget(null); target.dispose(); v.cameraBase = 0; v.setCamera(0); return result;
    }, angle);
    expect(state.changes).toBeGreaterThan(150);
    expect(state.sourcePixels).toBeGreaterThan(200);
    expect(state.walls).toBe(6); expect(state.targets).toBe(4); expect(state.negativeScales).toBe(false);
    expect(state.pixels).toBeLessThanOrEqual(200000);
    expect(state.passes).toBeLessThanOrEqual(15);
    expect(state.normals[4][0]).toBeCloseTo(1); expect(state.normals[5][0]).toBeCloseTo(-1);
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
      return [v.settings.mirrorCount, v.mirrors.count, v.balls.count, v.layout[21], v.sideBars.mesh.count,
        v.mirrors.meshes.every(({mesh},i)=>mesh===window.mirrorMeshes[i])];
    })).toEqual([count, count, 8, 8, 48, true]);
  }
  await expect.poll(()=>page.evaluate(()=>window.mirrorAudioFrames)).toBeGreaterThan(5);
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state','playing');
  await page.locator('.mirror-count').fill('1.5'); await page.locator('.mirror-count').dispatchEvent('change');
  expect(await page.evaluate(() => document.querySelector('.audio-card').preferences.mirrorCount)).toBe(17);
  await page.reload(); await physicsReady(page); await normal(page); await page.locator('.display-controls > summary').click();
  await expect(page.locator('.mirror-count')).toHaveValue('17');
  await page.locator('.display-reset').click(); await expect(page.locator('.mirror-count')).toHaveValue('6');
  expect(await page.evaluate(() => document.querySelector('#dancinglights').physics.mirrors.count)).toBe(6);
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

test('side walls reuse 12 source bands each and show different bar heights at steep angles', async ({ page }) => {
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
        const positions = Array.from({length:24},(_,i)=>v.sideBars.mesh.instanceMatrix.array[i*16+12]);
        const tips = Array.from({length:24},(_,i)=>v.sideBars.mesh.instanceMatrix.array[i*16+13]+v.layout[6]/2);
        results.push({ angle, changed: copy.reduce((n,x,i)=>n+Number(Math.abs(x-without[i])>8),0),
          left:positions.filter(x=>x<v.width/2).length,right:positions.filter(x=>x>v.width/2).length,
          tipError:Math.max(...tips.map((x,i)=>Math.abs(x-v.renderedHeight(i)))),balls:v.balls.count });
      }
    } finally { v.renderer.setRenderTarget(null); target.dispose(); }
    return results;
  });
  for (const result of results) {
    expect(result.left).toBe(12); expect(result.right).toBe(12); expect(result.balls).toBe(8);
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
        const scene = await page.locator('#dancinglights').boundingBox(); expect(scene.height).toBeGreaterThan(20);
      }
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
      await expect(page.locator('.audio-card')).not.toHaveAttribute('data-expanded', '');
      await page.setViewportSize({ width: 393, height: 852 });
    }
  } finally { await context.close(); }
});


test('mirror scissor preserves every pixel against the unrestricted ray portal', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${origin}/advanced/`); await physicsReady(page); await normal(page);
  const differences = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    const hooks = v.mirrors.meshes.map(({mesh}) => [mesh.onBeforeRender, mesh.onAfterRender]);
    const target = new THREE.WebGLRenderTarget(240,160), pixels = new Uint8Array(240*160*4), results=[];
    const render=()=>{v.renderer.setRenderTarget(target);v.renderer.render(v.scene,v.camera);v.renderer.readRenderTargetPixels(target,0,0,240,160,pixels);return pixels.slice();};
    try {
      for(const angle of [-40,-20,0,20,40]) {
        v.setCamera(angle,angle<0?-.14:.14);v.draw(performance.now());
        const actual=render();
        v.mirrors.meshes.forEach(({mesh})=>{mesh.onBeforeRender=()=>{};mesh.onAfterRender=()=>{};});
        const expected=render();
        v.mirrors.meshes.forEach(({mesh},i)=>{[mesh.onBeforeRender,mesh.onAfterRender]=hooks[i];});
        results.push({angle,changed:actual.reduce((n,value,i)=>n+Number(value!==expected[i]),0)});
      }
    } finally {v.renderer.setRenderTarget(null);target.dispose();v.mirrors.meshes.forEach(({mesh},i)=>{[mesh.onBeforeRender,mesh.onAfterRender]=hooks[i];});}
    return results;
  });
  for(const result of differences) expect(result.changed,JSON.stringify(result)).toBe(0);
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

test('whole-cell rejection preserves ray-portal pixels from both sides, above and below', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${origin}/advanced/`); await physicsReady(page); await normal(page);
  const results = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    const { invisibleCellCull } = await import(new URL(`${base}physics/mirrors.js`, document.baseURI));
    const target = new THREE.WebGLRenderTarget(240,160), pixels = new Uint8Array(240*160*4), results=[];
    const materials=v.mirrors.meshes.map(({mesh})=>mesh.material);
    const originals=materials.map(m=>[m.onBeforeCompile,m.customProgramCacheKey]);
    const render=()=>{v.renderer.setRenderTarget(target);v.renderer.render(v.scene,v.camera);v.renderer.readRenderTargetPixels(target,0,0,240,160,pixels);return pixels.slice();};
    const restore=()=>materials.forEach((m,i)=>{[m.onBeforeCompile,m.customProgramCacheKey]=originals[i];m.needsUpdate=true;});
    try {
      for(const [angle,vertical] of [[-40,0],[0,0],[40,0],[20,.8],[-20,-.8]]) {
        v.setCamera(angle,vertical);v.draw(performance.now());
        const actual=render();
        materials.forEach((m,i)=>{
          m.onBeforeCompile=shader=>{originals[i][0](shader);shader.vertexShader=shader.vertexShader.replace(invisibleCellCull,'');};
          m.customProgramCacheKey=()=>originals[i][1]()+'-reference-without-cell-rejection';m.needsUpdate=true;
        });
        const expected=render();restore();
        results.push({angle,vertical,changed:actual.reduce((n,x,i)=>n+Number(x!==expected[i]),0)});
      }
    } finally {restore();v.renderer.setRenderTarget(null);target.dispose();}
    return results;
  });
  for(const result of results) expect(result.changed,JSON.stringify(result)).toBe(0);
});
