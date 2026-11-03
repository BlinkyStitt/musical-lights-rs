// Match a rendered threshold crossing only within the same band's attack.
// A short target can retract before reaching the threshold; a later note must
// remain a separate observation rather than a multi-second latency sample.
export function packetRenderCrossings(packets, renders, bands = 24, threshold = .1) {
  const crossings = [];
  for (let band = 0; band < bands; band++) {
    let previous = 0;
    const attacks = packets.filter(packet => {
      const level = packet.levels[band], rising = level >= threshold && previous < threshold;
      previous = level; return rising;
    });
    for (let i = 0; i < attacks.length; i++) {
      const packet = attacks[i], nextAttackAt = attacks[i + 1]?.at ?? null;
      const before = renders.findLast(frame => frame.at < packet.at);
      const alreadyAbove = (before?.levels[band] ?? 0) >= threshold;
      const frames = renders.filter(frame => frame.at >= packet.at && (nextAttackAt === null || frame.at < nextAttackAt));
      const rendered = alreadyAbove ? null : frames.find(frame => frame.levels[band] >= threshold);
      crossings.push({ band, alreadyAbove, receivedAt: packet.at, nextAttackAt,
        renderedAt: rendered?.at ?? null, delayMs: rendered ? rendered.at - packet.at : null,
        peakRenderedLevel: Math.max(0, ...frames.map(frame => frame.levels[band])),
        status: alreadyAbove ? 'already-visible' : rendered ? 'observed'
          : nextAttackAt === null ? 'not-observed-before-capture-end' : 'not-observed-before-next-attack' });
    }
  }
  return crossings;
}

export function packetRenderSummary(crossings) {
  const delays = crossings.filter(c => c.delayMs !== null).map(c => c.delayMs).sort((a, b) => a - b);
  return { crossings: crossings.length, matched: delays.length,
    alreadyAbove: crossings.filter(c => c.alreadyAbove).length,
    notObserved: crossings.filter(c => c.status.startsWith('not-observed')).length,
    captureEnded: crossings.filter(c => c.status === 'not-observed-before-capture-end').length,
    medianMs: delays[Math.floor(delays.length / 2)] ?? null,
    p95Ms: delays[Math.ceil(delays.length * .95) - 1] ?? null };
}
