// Resolve and validate one native input point in one browser call, including
// scrolling, two stable frames, enabled state and the actual hit target. This
// avoids repeated driver round trips while a software renderer is busy.
export async function controlHitPoint(control, { nativeScroll = false } = {}) {
  // A keyboard resize can still be changing the browser's scroll position.
  // Let its native scroll/stability check finish before reading the hit point.
  if (nativeScroll) await control.scrollIntoViewIfNeeded();
  return control.evaluateAll(async (nodes, nativeScroll) => {
    if (nodes.length !== 1) throw new Error('Mouse input requires exactly one control');
    const node = nodes[0];
    if (!nativeScroll) {
      node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await new Promise(requestAnimationFrame);
      const before = node.getBoundingClientRect();
      await new Promise(requestAnimationFrame);
      const after = node.getBoundingClientRect();
      if (['x', 'y', 'width', 'height'].some(key => before[key] !== after[key])) {
        throw new Error('Mouse input requires a stable control after scrolling: ' + JSON.stringify({
          before: before.toJSON(), after: after.toJSON(), scroll: [scrollX, scrollY],
        }));
      }
    }
    const box = node.getBoundingClientRect();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (box.width < 44 || box.height < 44 || getComputedStyle(node).visibility !== 'visible'
      || node.matches(':disabled') || node.closest('[aria-disabled="true"]')
      || !node.contains(node.ownerDocument.elementFromPoint(x, y))) {
      throw new Error('Mouse input point must hit the requested enabled control: ' + JSON.stringify({
        box: box.toJSON(), visibility: getComputedStyle(node).visibility,
        disabled: node.matches(':disabled'), ariaDisabled: !!node.closest('[aria-disabled="true"]'),
        hit: node.ownerDocument.elementFromPoint(x, y)?.tagName,
        receivesInput: node.contains(node.ownerDocument.elementFromPoint(x, y)),
        viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale },
      }));
    }
    return { x, y, bounds: box.toJSON() };
  }, nativeScroll);
}

export async function clickControlAtHitPoint(page, control, options) {
  const point = await controlHitPoint(control, options);
  await page.mouse.click(point.x, point.y);
}
