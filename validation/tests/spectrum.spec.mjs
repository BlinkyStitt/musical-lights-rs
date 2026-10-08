import { test, expect } from '@playwright/test';
import { physicsReady, physicsState } from '../physics-state.mjs';

const edges = [0,100,200,300,400,510,630,770,920,1080,1270,1480,1720,2000,2320,2700,3150,3700,4400,5300,6400,7700,9500,12000,15500];
for (const width of [320, 375, 1440]) {
  test(`spectrum has 24 rounded bars with exact frequency labels at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('http://127.0.0.1:8101');
    await expect(page.locator('.bark-group[role=group]')).toHaveCount(24);
    await expect(page.getByRole('meter')).toHaveCount(24);
    await expect(page.getByRole('tooltip')).toBeHidden();
    expect(await page.getByRole('meter').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))))
      .toEqual(edges.slice(0, -1).map((edge, i) => `≈ ${edge}–${edges[i + 1]} Hz`));
    await physicsReady(page);
    await page.locator('#dancinglights').scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(async () => {
      const base = document.querySelector('meta[name="musical-lights-assets"]').content;
      const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
      const groups = [...document.querySelectorAll('.bark-group')];
      const meters = [...document.querySelectorAll('.meter')];
      const track = document.querySelector('.meter-track').getBoundingClientRect();
      const graph = document.querySelector('#dancinglights').getBoundingClientRect();
      const guide = document.querySelector('.meter-guide > span:nth-child(3)').getBoundingClientRect();
      const view = document.querySelector('#dancinglights').physics;
      const front = view.bars.instanceMatrix.array[14] + view.bars.geometry.boundingBox.max.z;
      return {
        guideDifference: Math.abs(guide.y + guide.height / 2 - graph.y - (1 - new THREE.Vector3(0, view.current[view.layout[17] + 1], front).project(view.camera).y) * graph.height / 2),
        headroom: (track.top - graph.top) / graph.height,
        expectedHeadroom: (1 - new THREE.Vector3(0, view.current[view.layout[17]+1], front).project(view.camera).y) / 2,
        hitRegionError: Math.max(...meters.map((node,i) => {
          const box=node.getBoundingClientRect();
          const column = (i + view.renderedPhase) % 24;
          const center = column + Math.min(1, 24 - column) / 2;
          const point = new THREE.Vector3(center * view.layout[3], view.current[view.layout[17]] / 2, front).project(view.camera);
          const projected = graph.x + (point.x + 1) / 2 * graph.width;
          return Math.abs(box.x+box.width/2-projected);
        })),
        colors: groups.map(node => getComputedStyle(node).getPropertyValue('--band-color').trim()),
        counts: groups.map(node => node.querySelectorAll('[role=meter]').length),
        layout: document.querySelector('#dancinglights').physics.layout,
        canvas: document.querySelector('canvas').getBoundingClientRect().toJSON(),
        graph: graph.toJSON(),
      };
    });
    expect(geometry.guideDifference).toBeLessThan(1);
    expect(geometry.headroom).toBeCloseTo(geometry.expectedHeadroom, 3);
    expect(geometry.hitRegionError).toBeLessThan(1);
    expect(geometry.counts).toEqual(Array(24).fill(1));
    expect(new Set(geometry.colors).size).toBe(24);
    expect(geometry.layout[4]).toBeCloseTo(.002, 6);
    expect(geometry.layout[5]).toBeCloseTo(.012, 6);
    expect(geometry.canvas.width).toBe(geometry.graph.width);
    expect(geometry.canvas.height).toBe(geometry.graph.height);
    await page.getByRole('meter').nth(13).focus();
    await expect(page.getByRole('tooltip')).toHaveText('≈ 2000–2320 Hz');
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.locator('#dancinglights')).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.keyboard.press('Escape');
    await expect(page.locator('.meter-guide')).toBeVisible();
  });
}

test('non-finite motion transport closes audio and keeps sphere gravity', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const Context = window.AudioContext;
    window.AudioContext = class extends Context {
      constructor(...args) { super(...args); window.transportContext = this; this.addEventListener('statechange', event => { if (window.freezeTransport) event.stopImmediatePropagation(); }); }
    };
    const Node = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Node {
      constructor(...args) { super(...args); window.transportPort = this.port; }
    };
    MediaDevices.prototype.getUserMedia = async () => window.transportContext.createMediaStreamDestination().stream;
  });
  await page.goto('http://127.0.0.1:8101');
  // Keep the fake capture source after WebKit recreates its native wrapper.
  await page.requestGC();
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
  await page.evaluate(async () => {
    window.freezeTransport = true;
    await window.transportContext.suspend();
    // Establish a raised support before the invalid packet removes it. A slow
    // runner may otherwise observe balls already resting on the floor.
    await new Promise(resolve => setTimeout(resolve, 50));
    const state = new Float64Array(99);
    state.set([window.transportContext.currentTime + .1, 0, 4]);
    for (let i = 0; i < 24; i++) state.set([1, 1, -1, 0], 3 + i * 4);
    window.transportPort.dispatchEvent(new MessageEvent('message', { data: { type: 'frame', sessionId: Number(document.querySelector('.audio-card').dataset.audioSession), state } }));
  });
  await expect.poll(async () => {
    const state = await physicsState(page);
    return Math.min(...state.bars) / state.barMax;
  }).toBeGreaterThan(.99);
  const falling = await page.evaluate(async () => {
    const view = document.querySelector('#dancinglights').physics;
    const before = Array.from({ length: 24 }, (_, i) => view.current[4 + i * view.layout[8]]);
    const state = new Float64Array(99);
    state[0] = window.transportContext.currentTime;
    state[2] = NaN;
    window.transportPort.dispatchEvent(new MessageEvent('message', { data: { type: 'frame', sessionId: Number(document.querySelector('.audio-card').dataset.audioSession), state } }));
    // Observe in-page while shutdown occurs, independent of driver round trips.
    return new Promise(resolve => {
      const start = performance.now();
      const sample = now => {
        if (before.some((y, i) => view.current[4 + i * view.layout[8]] < y - .005)) resolve(true);
        else if (now - start > 3000) resolve(false);
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  });
  await expect(page.getByRole('alert')).toContainText('Invalid audio display state');
  await expect.poll(() => page.evaluate(() => window.transportContext.state)).toBe('closed');
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'stopped');
  await expect(page.locator('.listening-toggle')).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return v.idle && !!v.preview && v.tempo === 120;
  })).toBe(true);
  await physicsReady(page);
  const before = await physicsState(page);
  await expect.poll(async () => (await physicsState(page)).tick).toBeGreaterThan(before.tick + 10);
  expect(falling).toBe(true);
  expect(errors).toEqual([]);
});
