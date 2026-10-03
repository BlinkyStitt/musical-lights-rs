//! Warmed estimator only, excluding FFT/loudness work and fixture creation.
use musical_lights_core::audio::tempo::TempoEstimator;
use std::{hint::black_box, time::Instant};
fn main() {
    let mut estimator = TempoEstimator::default();
    let mut worst = 0.0_f64;
    let mut total = 0.0;
    for i in 0..30_000 {
        let value = if i % 250 < 10 { 1.0 } else { 0.0 };
        let novelty = [value; 24];
        let start = Instant::now();
        estimator.push(black_box(&novelty));
        let cost = start.elapsed().as_secs_f64();
        if i >= 4000 {
            total += cost;
            worst = worst.max(cost);
        }
        black_box(estimator.estimate());
    }
    println!(
        "TempoEstimator: {} bytes; 52 s envelope in {:.3} ms; {:.4}% host CPU; worst frame {:.3} ms; {:?}",
        size_of::<TempoEstimator>(),
        total * 1000.0,
        total / 52.0 * 100.0,
        worst * 1000.0,
        estimator.estimate()
    );
}
