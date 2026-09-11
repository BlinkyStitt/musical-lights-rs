//! Warmed production analysis and display cost. No input construction or I/O in timing.
use musical_lights_core::audio::{
    loudness::{Calibration, LoudnessMeter, SoundField},
    visual::{DisplaySnapshot, VisualGain},
};
use std::{hint::black_box, time::Instant};
fn main() {
    println!(
        "LoudnessMeter: {} bytes; core processing needs no allocator",
        size_of::<LoudnessMeter>()
    );
    let samples: Vec<_> = (0..192_000)
        .map(|i| {
            let time = i as f64 / 48_000.0;
            ((std::f64::consts::TAU * 80.0 * time).sin() * 0.4
                + (std::f64::consts::TAU * 1000.0 * time).sin() * 0.4) as f32
        })
        .collect();
    for size in [128, 768, 800] {
        let mut meter = LoudnessMeter::new(Calibration::default(), SoundField::Free);
        let mut gain = VisualGain::default();
        let mut snapshot = DisplaySnapshot::new(0.0);
        let mut offset = 0;
        let mut consume = || {
            for block in samples.chunks(size) {
                meter
                    .push_pcm(black_box(block), offset, |frame| {
                        snapshot.push(
                            frame.sample_index as f64 / 48_000.0,
                            gain.map(&frame).bands,
                            false,
                        );
                        black_box(frame.sones);
                    })
                    .unwrap();
                black_box(snapshot);
                offset += block.len() as u64;
            }
        };
        consume();
        let start = Instant::now();
        for _ in 0..10 {
            consume();
        }
        let elapsed = start.elapsed().as_secs_f64();
        println!(
            "{size} samples: 40 s audio in {elapsed:.4} s; {:.3}% of one host CPU core",
            elapsed / 40.0 * 100.0
        );
    }
}
