import { test, expect } from '@playwright/test';

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
    const geometry = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('.bark-group')];
      const meters = [...document.querySelectorAll('.meter')];
      const track = document.querySelector('.meter-track').getBoundingClientRect();
      const graph = document.querySelector('#dancinglights').getBoundingClientRect();
      const guide = document.querySelector('.meter-guide > span').getBoundingClientRect();
      return {
        guideDifference: Math.abs(guide.y + guide.height / 2 - track.top),
        headroom: (track.top - graph.top) / graph.height,
        groups: groups.map(node => ({ count: node.querySelectorAll('[role=meter]').length,
          color: getComputedStyle(node.querySelector('.meter-fill')).backgroundColor })),
        gaps: meters.slice(1).map((node, i) => node.getBoundingClientRect().left - meters[i].getBoundingClientRect().right),
        styles: meters.map(node => {
          const fill = node.querySelector('.meter-fill');
          const style = getComputedStyle(fill);
          return { width: fill.getBoundingClientRect().width, radius: Number.parseFloat(style.borderTopLeftRadius),
            rightRadius: style.borderTopRightRadius, leftRadius: style.borderTopLeftRadius,
            bottomRadii: [style.borderBottomLeftRadius, style.borderBottomRightRadius],
            outline: getComputedStyle(node).outlineStyle, overflow: style.overflow };
        }),
      };
    });
    expect(geometry.guideDifference).toBeLessThan(1);
    expect(geometry.headroom).toBeCloseTo(.05, 3);
    expect(geometry.groups.map(group => group.count)).toEqual(Array(24).fill(1));
    expect(new Set(geometry.groups.map(group => group.color)).size).toBe(24);
    for (const gap of geometry.gaps) expect(gap).toBeGreaterThanOrEqual(.98);
    for (const style of geometry.styles) {
      expect(style.radius).toBeCloseTo(style.width * .25, 1);
      expect(style.leftRadius).toBe(style.rightRadius);
      expect(style.bottomRadii).toEqual(['0px', '0px']);
      expect(style.outline).toBe('none');
      expect(style.overflow).toBe('hidden');
    }
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
    const state = new Float64Array(146);
    state[0] = window.transportContext.currentTime;
    state[2] = NaN;
    window.transportPort.dispatchEvent(new MessageEvent('message', { data: { type: 'frame', state } }));
  });
  await expect(page.getByRole('alert')).toContainText('Invalid audio display state');
  await expect.poll(() => page.evaluate(() => window.transportContext.state)).toBe('closed');
  await expect(page.getByRole('meter').first()).toHaveAttribute('aria-valuenow', '0');
  const sphere = page.locator('.balloon').nth(6);
  const top = await sphere.evaluate(node => node.style.getPropertyValue('--balloon-y'));
  await expect.poll(() => sphere.evaluate(node => node.style.getPropertyValue('--balloon-y'))).not.toBe(top);
  expect(errors).toEqual([]);
});
