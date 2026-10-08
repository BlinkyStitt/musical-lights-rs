//! Native production paths. Browser profiles measure rendering separately.
use criterion::{BatchSize, BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use musical_lights_core::audio::{browser::BrowserSnapshot, tempo::TempoEstimator};
use musical_lights_physics::{COST_OFFSET, HZ, Simulation, SimulationConfig, SimulationInput};
use musical_lights_worklet as worklet;
use std::{ffi::c_void, hint::black_box, time::Duration};

const RATE: usize = 48_000;
const QUANTUM: usize = 128;
const TICKS: usize = HZ as usize * 2;

// Use the same exclusive handle ownership and input/snapshot boundary as JS.
struct Processor {
    handle: *mut c_void,
    sample: u64,
}
impl Processor {
    fn new() -> Self {
        let handle = worklet::processor_create(0, 2.0, 0);
        assert!(!handle.is_null());
        Self { handle, sample: 0 }
    }
    fn block(&mut self, pcm: &[f32]) {
        // SAFETY: this owner holds the live handle exclusively. The bounded
        // slice is copied before calling the processor; no view spans a call.
        unsafe {
            assert!(pcm.len() <= worklet::processor_capacity(self.handle));
            std::ptr::copy_nonoverlapping(
                pcm.as_ptr(),
                worklet::processor_input(self.handle).cast_mut(),
                pcm.len(),
            );
            assert_eq!(
                worklet::processor_process(self.handle, pcm.len(), self.sample),
                1
            );
        }
        self.sample += pcm.len() as u64;
    }
    fn snapshot(&mut self) -> BrowserSnapshot {
        // SAFETY: copy/parse the snapshot during exclusive access; retain no
        // borrowed processor memory after this function returns.
        unsafe {
            let pointer = worklet::processor_snapshot(self.handle);
            BrowserSnapshot::from_transport(std::slice::from_raw_parts(
                pointer,
                worklet::processor_snapshot_length(self.handle),
            ))
            .expect("valid production snapshot")
        }
    }
}
impl Drop for Processor {
    fn drop(&mut self) {
        // SAFETY: destroy exactly once, after every memory view has expired.
        unsafe { worklet::processor_destroy(self.handle) };
    }
}

fn pcm() -> Vec<f32> {
    (0..RATE * 2)
        .map(|i| {
            let t = i as f64 / RATE as f64;
            let beat = (1.0 - (t % 0.5) / 0.09).max(0.0);
            ((std::f64::consts::TAU * 80.0 * t).sin() * 0.04 * beat
                + (std::f64::consts::TAU * 1000.0 * t).sin() * 0.01) as f32
        })
        .collect()
}

fn analysis(c: &mut Criterion) {
    let pcm = pcm();
    let mut group = c.benchmark_group("production_audio");
    group.throughput(Throughput::Elements(pcm.len() as u64));
    for snapshot in [false, true] {
        let mut processor = Processor::new();
        // Warm FFT history, display gain and the causal tempo estimator.
        for _ in 0..3 {
            for block in pcm.chunks(QUANTUM) {
                processor.block(block);
            }
        }
        group.bench_with_input(
            BenchmarkId::new(
                "two_seconds",
                if snapshot {
                    "snapshot_240hz"
                } else {
                    "analysis"
                },
            ),
            &snapshot,
            |b, &snapshot| {
                b.iter(|| {
                    for (i, block) in pcm.chunks(QUANTUM).enumerate() {
                        processor.block(black_box(block));
                        // A 128-sample quantum reaches the 200-sample send
                        // threshold every second callback, as in processor.js.
                        if snapshot && i % 2 == 0 {
                            black_box(processor.snapshot());
                        }
                    }
                });
            },
        );
    }
    group.finish();
}

fn measured_levels() -> Vec<[f32; 24]> {
    let pcm = pcm();
    let mut processor = Processor::new();
    for _ in 0..2 {
        for block in pcm.chunks(QUANTUM) {
            processor.block(block);
        }
    }
    // At 120 Hz each tick receives exactly 400 PCM samples. Model windows
    // remain independent of the caller's block length.
    pcm.chunks(RATE / HZ as usize)
        .map(|tick| {
            for block in tick.chunks(QUANTUM) {
                processor.block(block);
            }
            processor.snapshot().filtered
        })
        .collect()
}

fn simulation(height: f32) -> Simulation {
    let mut sim = Simulation::new(
        SimulationConfig {
            height,
            ..Default::default()
        },
        [[0.5; 3]; 24],
    )
    .unwrap();
    sim.set_tempo(120.0);
    for _ in 0..HZ {
        sim.step();
    }
    sim
}

fn replay(sim: &mut Simulation, levels: &[[f32; 24]], full_attack: bool) -> f32 {
    let mut excess = 0.0_f32;
    for (tick, levels) in levels.iter().enumerate() {
        sim.apply(SimulationInput {
            tick: sim.tick,
            levels: if full_attack {
                [f32::from(tick < 16); 24]
            } else {
                *levels
            },
            height: sim.config.height,
            scrolling: !full_attack,
            ..Default::default()
        })
        .unwrap();
        sim.step();
        let snapshot = black_box(sim.snapshot());
        excess = excess.max(snapshot.values[COST_OFFSET + 1]);
    }
    excess
}

fn physics(c: &mut Criterion) {
    let levels = measured_levels();
    assert_eq!(levels.len(), TICKS);
    let mut group = c.benchmark_group("production_physics");
    group.throughput(Throughput::Elements(TICKS as u64));
    for (name, height, full_attack) in [
        ("music_portrait", 2.596923, false),
        ("music_landscape", 0.554502, false),
        ("full_attack_portrait", 2.596923, true),
    ] {
        assert_eq!(
            replay(&mut simulation(height), &levels, full_attack),
            0.0,
            "overload in {name}"
        );
        group.bench_function(name, |b| {
            b.iter_batched_ref(
                || simulation(height),
                |sim| black_box(replay(sim, black_box(&levels), full_attack)),
                BatchSize::PerIteration,
            );
        });
    }
    group.finish();
}

fn tempo(c: &mut Criterion) {
    let novelty: Vec<_> = (0..4000)
        .map(|i| [if i % 250 < 10 { 1.0 } else { 0.0 }; 24])
        .collect();
    let mut estimator = TempoEstimator::default();
    for frame in &novelty {
        estimator.push(frame);
    }
    let mut group = c.benchmark_group("production_tempo");
    group.throughput(Throughput::Elements(novelty.len() as u64));
    group.bench_function("eight_seconds_120bpm", |b| {
        b.iter(|| {
            for frame in &novelty {
                estimator.push(black_box(frame));
            }
            black_box(estimator.estimate());
        })
    });
    group.finish();
}

criterion_group! {
    name = benches;
    config = Criterion::default().sample_size(20).warm_up_time(Duration::from_secs(1)).measurement_time(Duration::from_secs(3));
    targets = analysis, physics, tempo
}
criterion_main!(benches);
