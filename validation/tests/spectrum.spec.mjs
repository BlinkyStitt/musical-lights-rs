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
    const geometry = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('.bark-group')];
      const meters = [...document.querySelectorAll('.meter')];
      const track = document.querySelector('.meter-track').getBoundingClientRect();
      const graph = document.querySelector('#dancinglights').getBoundingClientRect();
      const guide = document.querySelector('.meter-guide > span').getBoundingClientRect();
      return {
        guideDifference: Math.abs(guide.y + guide.height / 2 - track.top),
        headroom: (track.top - graph.top) / graph.height,
        colors: groups.map(node => getComputedStyle(node).getPropertyValue('--band-color').trim()),
        counts: groups.map(node => node.querySelectorAll('[role=meter]').length),
        layout: document.querySelector('#dancinglights').physics.layout,
        canvas: document.querySelector('canvas').getBoundingClientRect().toJSON(),
        graph: graph.toJSON(),
      };
    });
    expect(geometry.guideDifference).toBeLessThan(1);
    expect(geometry.headroom).toBeCloseTo(.05, 3);
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
      constructor(...args) { super(...args); window.transportContext = this; }
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
  await page.getByRole('button', { name: 'Start listening' }).click();
  await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
  await page.evaluate(async () => {
    await window.transportContext.suspend();
    const state = new Float64Array(122);
    state[0] = window.transportContext.currentTime;
    state[2] = NaN;
    window.transportPort.dispatchEvent(new MessageEvent('message', { data: { type: 'frame', state } }));
  });
  await expect(page.getByRole('alert')).toContainText('Invalid audio display state');
  await expect.poll(() => page.evaluate(() => window.transportContext.state)).toBe('closed');
  await expect(page.getByRole('meter').first()).toHaveAttribute('aria-valuenow', '0');
  await physicsReady(page);
  const before = await physicsState(page);
  await expect.poll(async () => (await physicsState(page)).tick).toBeGreaterThan(before.tick + 10);
  await expect.poll(async () => (await physicsState(page)).balls.some((ball, i) => Math.abs(ball.position[1] - before.balls[i].position[1]) > .005)).toBe(true);
  expect(errors).toEqual([]);
});
