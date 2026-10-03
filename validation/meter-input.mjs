// A source can split across the seam into a fragment below one CSS pixel.
// Choose its wider pointer surface and verify the native hit keeps that source.
export async function meterPoint(page, meter) {
  // Scroll the fixed graph, not a source column moving with the idle/live phase.
  await page.locator('#dancinglights').scrollIntoViewIfNeeded();
  return meter.evaluate(meter => {
    const graph = meter.closest('#dancinglights');
    const index = [...graph.querySelectorAll('[role=meter]')].indexOf(meter);
    const copy = graph.querySelector(`.bark-copy[data-source-band="${index}"]`);
    const surfaces = [meter, copy].filter(Boolean).map(node => node.getBoundingClientRect())
      .sort((a, b) => b.width - a.width);
    for (const box of surfaces) {
      const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
      const hit = meter.ownerDocument.elementFromPoint(x, y)?.closest('[role=meter], .bark-copy');
      if (hit !== meter && (!copy || hit !== copy)) continue;
      return { x, y, label: meter.getAttribute('aria-label'), color: getComputedStyle(meter).getPropertyValue('--band-color').trim() };
    }
    throw new Error('Input point must hit the requested spectrum source');
  });
}
