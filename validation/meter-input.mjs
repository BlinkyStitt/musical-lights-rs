// A narrow sample can be less than one CSS pixel. Use a browser input point
// and verify the meter actually hit there, rather than rounding a locator's
// center and requiring the browser to target a different neighboring sample.
export async function meterPoint(page, meter) {
  return meter.evaluate(meter => {
    const box = meter.getBoundingClientRect();
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    const node = meter.ownerDocument.elementFromPoint(x, y)?.closest('[role=meter]');
    if (!node) throw new Error('Input point must hit a spectrum meter');
    return { x, y, label: node.getAttribute('aria-label'), color: getComputedStyle(node).getPropertyValue('--band-color').trim() };
  });
}
