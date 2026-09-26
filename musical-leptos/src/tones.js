// Deterministic Float32 PCM, shared by the phone page and offline diagnostics.
export const frequencies = [50,150,250,350,450,570,700,840,1000,1170,1370,1600,1850,2150,2500,2900,3400,4050,4800,5800,7000,8600,10700,13700];
export const toneCases = {
  stationary: 60, stepped: 48, sweep: 24, two: 30, volume: 90, bursts: 8, silence: 3, exercise: 6,
};
export function toneState(kind, t, frequency = 1000, amplitude = .02) {
  switch (kind) {
    case 'stationary': return { frequencies: [frequency], amplitude };
    case 'stepped': return { frequencies: [frequencies[Math.min(23, Math.floor(t / 2))]], amplitude };
    case 'sweep': return { frequencies: [50 * (13700 / 50) ** (t / toneCases.sweep)], amplitude };
    case 'two': return { frequencies: [frequency, 3400], amplitude };
    case 'volume': return { frequencies: [frequency], amplitude: amplitude * (t < 30 ? 1 : t < 60 ? .1 : .5) };
    case 'bursts': return { frequencies: [frequency], amplitude: t % 1 < .025 ? amplitude : 0 };
    case 'silence': return { frequencies: [], amplitude: 0 };
    case 'exercise': return { frequencies, amplitude };
    default: throw new Error(`Unknown tone: ${kind}`);
  }
}
export function tonePCM(kind, frequency = 1000, amplitude = .02, rate = 48000) {
  const pcm = new Float32Array(Math.round(toneCases[kind] * rate));
  const phases = new Float64Array(24);
  for (let i = 0; i < pcm.length; i++) {
    const t = i / rate, state = toneState(kind, t, frequency, amplitude);
    for (let j = 0; j < state.frequencies.length; j++) {
      const level = kind === 'exercise' ? ((Math.floor(t * 16) + j * 3) % 23 < 6 ? .02 : .0002) : state.amplitude / state.frequencies.length;
      pcm[i] += Math.sin(phases[j]) * level;
      phases[j] = (phases[j] + 2 * Math.PI * state.frequencies[j] / rate) % (2 * Math.PI);
    }
  }
  if (kind === 'exercise') {
    // Normalize the deterministic changing mixture before applying the user's
    // peak level. One scale for the entire loop preserves its tone pattern.
    let peak = 0;
    for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.fround(pcm[i] / peak) * amplitude;
  }
  return pcm;
}
