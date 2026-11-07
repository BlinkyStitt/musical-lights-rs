import { expect } from '@playwright/test';

// Check the entire compact row and each native hit target. Text help lives in
// Settings; the toolbar retains main's icons and checkbox focus/hover help.
export async function expectToolbarFits(page) {
  expect(await page.evaluate(() => {
    const bar = document.querySelector('.fullscreen-toolbar');
    const selectors = ['.fullscreen-button', '.rotate-display', '.motion-button',
      '.listening-toggle', '.fullscreen-settings-button'];
    const nodes = selectors.map(selector => bar.querySelector(selector));
    const missing = selectors.filter((_, i) => !nodes[i]);
    if (missing.length) return missing.map(selector => `${selector}: missing from toolbar`);
    const boxes = nodes.map(node => node.getBoundingClientRect());
    const failures = [];
    if (bar.scrollWidth > bar.clientWidth) failures.push('toolbar overflow');
    nodes.forEach((node, i) => {
      const box = boxes[i], name = selectors[i];
      if (box.width < 44 || box.height < 44) failures.push(`${name}: target smaller than 44px`);
      if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) failures.push(`${name}: outside viewport`);
      if (i && box.left < boxes[i - 1].right) failures.push(`${name}: overlaps preceding target`);
      // Rounded controls intentionally exclude their bounding-box corners.
      // Sample the center and all four edges within the actual painted target.
      const centerX = box.left + box.width / 2, centerY = box.top + box.height / 2;
      for (const [x, y] of [[centerX, centerY], [box.left + 2, centerY], [box.right - 2, centerY],
        [centerX, box.top + 2], [centerX, box.bottom - 2]]) {
        if (!node.contains(document.elementFromPoint(x, y))) failures.push(`${name}: obstructed at ${x},${y}`);
      }
    });
    return failures;
  })).toEqual([]);
  const exit = page.getByRole('button', { name: 'Exit fullscreen', exact: true });
  await expect(exit.locator('svg[aria-hidden="true"]')).toBeVisible();
}
