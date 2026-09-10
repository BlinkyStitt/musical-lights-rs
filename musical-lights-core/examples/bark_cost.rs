//! Wall-clock processing cost for warmed, contiguous audio blocks; run with --release --features std,log.
use musical_lights_core::audio::BarkBank;
use std::{hint::black_box, time::Instant};

fn main() {
    println!(
        "BarkBank state: {} bytes; processing uses no heap allocation",
        size_of::<BarkBank>()
    );
    for rate in [44_100.0, 48_000.0] {
        for block_len in [128usize, 794] {
            let samples: Vec<f32> = (0..rate as usize * 4)
                .map(|i| {
                    let time = i as f32 / rate;
                    (std::f32::consts::TAU * 1000.0 * time).sin() * 0.4
                        + (std::f32::consts::TAU * 80.0 * time).sin() * 0.4
                })
                .collect();
            let mut bank = BarkBank::new(rate).unwrap();
            for block in samples.chunks(block_len) {
                black_box(bank.push_samples(black_box(block)).unwrap().bands());
            }
            let start = Instant::now();
            let repeats = 10;
            for _ in 0..repeats {
                for block in samples.chunks(block_len) {
                    black_box(bank.push_samples(black_box(block)).unwrap().bands());
                }
            }
            let elapsed = start.elapsed();
            let seconds = samples.len() as f64 * repeats as f64 / rate as f64;
            let blocks = samples.len().div_ceil(block_len) * repeats;
            println!(
                "{rate:.0} Hz, {block_len} samples/block: {:.2} us/block, {:.2}% of real-time budget ({seconds:.1} s audio, {:.3} s wall time)",
                elapsed.as_secs_f64() * 1e6 / blocks as f64,
                elapsed.as_secs_f64() / seconds * 100.0,
                elapsed.as_secs_f64()
            );
        }
    }
}
