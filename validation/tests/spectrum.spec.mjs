import { test, expect } from '@playwright/test';

for (const width of [320, 375, 1440]) {
  test(`continuous spectrum keeps 240 accessible samples in 24 fixed regions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('http://127.0.0.1:8101');
    await expect(page.getByText('A detailed sound spectrum in 24 color regions.')).toBeVisible();
    await expect(page.locator('.bark-group[role=group]')).toHaveCount(24);
    await expect(page.getByRole('meter')).toHaveCount(240);
    await expect(page.getByRole('tooltip')).toBeHidden();
    const geometry = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('.bark-group')];
      const meters = [...document.querySelectorAll('.meter')];
      const labels = meters.map(n => n.getAttribute('aria-label').match(/\d+/g).map(Number));
      const guide = document.querySelector('.meter-guide > span').getBoundingClientRect();
      const fill = document.querySelector('.meter-fill');
      // Restore the transform after measuring the actual maximum fill area.
      const transform = fill.style.transform;
      fill.style.transform = 'scaleY(1)';
      const top = fill.getBoundingClientRect().top;
      fill.style.transform = transform;
      return {
        labels, guideDifference: Math.abs(guide.y + guide.height / 2 - top),
        groups: groups.map(n => ({ count: n.querySelectorAll('[role=meter]').length, label: n.getAttribute('aria-label'),
          colors: [...new Set([...n.querySelectorAll('.meter-fill')].map(n => getComputedStyle(n).backgroundColor))] })),
        gaps: meters.slice(1).map((n, i) => n.getBoundingClientRect().left - meters[i].getBoundingClientRect().right),
        styles: meters.map(n => ({ gap: getComputedStyle(n.parentElement).columnGap,
          radius: getComputedStyle(n.firstElementChild).borderRadius,
          outline: getComputedStyle(n).outlineStyle })),
        separators: groups.slice(1).map(n => ({ width: getComputedStyle(n, '::after').width, opacity: Number(getComputedStyle(n, '::after').opacity) })),
      };
    });
    expect(geometry.guideDifference).toBeLessThan(1);
    expect(geometry.gaps.every(gap => Math.abs(gap) < .02)).toBe(true);
    expect(geometry.groups.every(group => group.count === 10 && group.colors.length === 1)).toBe(true);
    expect(new Set(geometry.groups.map(group => group.colors[0])).size).toBe(24);
    expect(geometry.styles.every(s => s.radius === '0px' && s.outline === 'none' && ['normal', '0px'].includes(s.gap))).toBe(true);
    expect(geometry.separators.every(s => s.width === '1px' && s.opacity < .5)).toBe(true);
    const edges = [0,100,200,300,400,510,630,770,920,1080,1270,1480,1720,2000,2320,2700,3150,3700,4400,5300,6400,7700,9500,12000,15500];
    for (const [i, [lo, hi]] of geometry.labels.entries()) {
      expect(hi).toBeGreaterThan(lo);
      if (i > 0) expect(lo).toBe(geometry.labels[i - 1][1]);
      if (i % 10 === 0) expect(lo).toBe(edges[i / 10]);
    }
    expect(geometry.labels.at(-1)[1]).toBe(15500);
    await page.getByRole('meter').nth(137).focus();
    await expect(page.getByRole('tooltip')).toHaveText('≈ 2224–2256 Hz');
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect(page.locator('#dancinglights')).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.meter-guide')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.keyboard.press('Escape');
    await expect(page.locator('.meter-guide')).toBeVisible();
  });
}

test('inconsistent aggregate and fine transport closes audio and keeps sphere gravity', async ({ page }) => {
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
    navigator.mediaDevices.getUserMedia = async () => window.transportContext.createMediaStreamDestination().stream;
  });
  await page.goto('http://127.0.0.1:8101');
  await page.getByRole('button', { name: 'Start listening' }).click();
  await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
  await page.evaluate(async () => {
    await window.transportContext.suspend();
    const state = new Float64Array(1588);
    state[0] = window.transportContext.currentTime;
    state[146] = state[0] + 1;
    window.transportPort.dispatchEvent(new MessageEvent('message', { data: { type: 'frame', state } }));
  });
  await expect(page.getByRole('alert')).toContainText('Invalid audio display state');
  await expect.poll(() => page.evaluate(() => window.transportContext.state)).toBe('closed');
  await expect(page.getByRole('meter').first()).toHaveAttribute('aria-valuenow', '0');
  const sphere = page.locator('.balloon').nth(6);
  const top = await sphere.evaluate(n => n.style.top);
  await expect.poll(() => sphere.evaluate(n => n.style.top)).not.toBe(top);
  expect(errors).toEqual([]);
});
