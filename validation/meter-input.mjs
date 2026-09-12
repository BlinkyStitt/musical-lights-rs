// A narrow sample can be less than one CSS pixel. Use a browser input point
// and verify the meter actually hit there, rather than rounding a locator's
// center and requiring the browser to target a different neighboring sample.
export async function meterPoint(page, meter) {
  const box = await meter.boundingBox();
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const hit = await page.evaluate(({ x, y }) => {
    const node = document.elementFromPoint(x, y)?.closest('[role=meter]');
    if (!node) throw new Error('Input point must hit a spectrum meter');
    return { label: node.getAttribute('aria-label'), color: getComputedStyle(node.querySelector('.meter-fill')).backgroundColor };
  }, point);
  return { ...point, ...hit };
}
