// Resolve and validate one native input point in one browser call, including
// scrolling, two stable frames, enabled state and the actual hit target. This
// avoids repeated driver round trips while a software renderer is busy.
export async function clickControlAtHitPoint(page, control) {
  const point = await control.evaluateAll(async nodes => {
    if (nodes.length !== 1) throw new Error('Mouse input requires exactly one control');
    const node = nodes[0];
    node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await new Promise(requestAnimationFrame);
    const before = node.getBoundingClientRect();
    await new Promise(requestAnimationFrame);
    const box = node.getBoundingClientRect();
    if (['x', 'y', 'width', 'height'].some(key => before[key] !== box[key])) {
      throw new Error('Mouse input requires a stable control after scrolling');
    }
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (box.width < 44 || box.height < 44 || getComputedStyle(node).visibility !== 'visible'
      || node.matches(':disabled') || node.closest('[aria-disabled="true"]')
      || !node.contains(node.ownerDocument.elementFromPoint(x, y))) {
      throw new Error('Mouse input point must hit the requested enabled control');
    }
    return { x, y };
  });
  await page.mouse.click(point.x, point.y);
}
