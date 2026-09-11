use super::*;
extern crate std;
use std::{vec, vec::Vec};

fn signal(seconds: f64, hz: f64, pressure_peak: f64) -> Vec<f32> {
    (0..(seconds * SAMPLE_RATE as f64) as usize)
        .map(|i| {
            (Float::sin(core::f64::consts::TAU * hz * i as f64 / SAMPLE_RATE as f64)
                * pressure_peak) as f32
        })
        .collect()
}

fn trace(samples: &[f32], chunks: &[usize]) -> Vec<LoudnessFrame> {
    let mut meter = LoudnessMeter::new(Calibration::measured(1.0).unwrap(), SoundField::Free);
    let mut frames = Vec::new();
    let (mut offset, mut chunk) = (0, 0);
    while offset < samples.len() {
        let end = (offset + chunks[chunk % chunks.len()]).min(samples.len());
        meter
            .push_pcm(&samples[offset..end], offset as u64, |f| frames.push(f))
            .unwrap();
        offset = end;
        chunk += 1;
    }
    meter.finish(|f| frames.push(f)).unwrap();
    frames
}

#[test]
fn every_frame_survives_arbitrary_callback_boundaries() {
    let mut samples = vec![0.0; 48_017];
    let burst = signal(0.010, 1000.0, 0.0894427191); // 70 dB SPL
    samples[4800..4800 + burst.len()].copy_from_slice(&burst);
    let expected = trace(&samples, &[1]);
    assert_eq!(
        expected.len(),
        samples.len().div_ceil(FRAME_SAMPLES as usize)
    );
    let peak = expected.iter().map(|f| f.sones).fold(0.0_f64, f64::max);
    // MoSQITo 1.2.1, exact rectangular sine burst above (the ISO burst has
    // different rise/fall shaping and therefore a different peak).
    assert!((peak - 5.828783755771111).abs() < 1e-5, "{peak}");
    for chunks in [&[128][..], &[800], &[48_017], &[1, 67, 800, 13, 4096]] {
        let actual = trace(&samples, chunks);
        assert_eq!(actual.len(), expected.len());
        for (a, b) in actual.iter().zip(&expected) {
            assert_eq!(a.sample_index, b.sample_index);
            assert_eq!(a.sones, b.sones);
            assert_eq!(a.specific_sones_per_bark, b.specific_sones_per_bark);
        }
    }
}

#[test]
fn sustained_bass_remains_steady_without_learning_a_noise_floor() {
    for frequency in [20.0, 40.0, 50.0, 60.0, 80.0] {
        let samples = signal(4.0, frequency, 1.0);
        let frames = trace(&samples, &[128]);
        let steady = &frames[1000..];
        let low = steady.iter().map(|f| f.sones).fold(f64::INFINITY, f64::min);
        let high = steady.iter().map(|f| f.sones).fold(0.0_f64, f64::max);
        assert!(low > 0.0, "{frequency} Hz disappeared");
        assert!(high / low < 1.01, "{frequency} Hz varies: {low}..{high}");
    }
}

#[test]
fn silence_and_short_final_blocks_have_exact_sample_times() {
    for length in [1, 24, 25, 48, 95, 96, 97, 800] {
        let frames = trace(&vec![0.0; length], &[13]);
        assert_eq!(frames.len(), length.div_ceil(96));
        for (index, frame) in frames.iter().enumerate() {
            assert_eq!(frame.sample_index, index as u64 * 96);
            assert_eq!(frame.sones, 0.0);
            assert_eq!(frame.specific_sones_per_bark, [0.0; 240]);
        }
    }
}

#[test]
fn invalid_blocks_do_not_change_state_and_gaps_require_reset() {
    let mut meter = LoudnessMeter::new(Calibration::default(), SoundField::Free);
    meter.push_pcm(&[0.1; 128], 0, |_| {}).unwrap();
    let mut untouched = meter.clone();
    assert_eq!(
        meter.push_pcm(&[0.0, f32::NAN], 128, |_| {}),
        Err(LoudnessError::NonFiniteSample { index: 1 })
    );
    assert_eq!(
        meter.push_pcm(&[], 128, |_| {}),
        Err(LoudnessError::EmptyBlock)
    );
    assert_eq!(
        meter.push_pcm(&[0.0; 128], 256, |_| {}),
        Err(LoudnessError::Discontinuity {
            expected: 128,
            received: 256
        })
    );
    let mut actual = Vec::new();
    let mut expected = Vec::new();
    meter
        .push_pcm(&[0.0; 128], 128, |f| actual.push(f.sones))
        .unwrap();
    untouched
        .push_pcm(&[0.0; 128], 128, |f| expected.push(f.sones))
        .unwrap();
    assert_eq!(actual, expected);
    meter.reset(1024);
    let mut frames = Vec::new();
    meter
        .push_pcm(&[0.0; 128], 1024, |f| frames.push(f))
        .unwrap();
    meter.finish(|f| frames.push(f)).unwrap();
    assert_eq!(
        frames.iter().map(|f| f.sample_index).collect::<Vec<_>>(),
        [1024, 1120]
    );
    assert!(frames.iter().all(|f| f.sones == 0.0));
    assert_eq!(
        meter.push_pcm(&[0.0], 1152, |_| {}),
        Err(LoudnessError::Finished)
    );
}

#[test]
fn calibration_has_physical_units_and_does_not_hide_model_limits() {
    let calibration = Calibration::from_reference(0.5, 94.0).unwrap();
    assert!((calibration.pascals_per_unit() - 2.004749).abs() < 1e-5);
    assert!(calibration.is_measured());
    assert!(!Calibration::default().is_measured());
    for bad in [0.0, -1.0, f32::NAN, f32::INFINITY] {
        assert_eq!(
            Calibration::measured(bad),
            Err(LoudnessError::InvalidCalibration)
        );
    }
    let mut meter = LoudnessMeter::new(Calibration::default(), SoundField::Free);
    assert!(matches!(
        meter.push_pcm(&[f32::MAX; 128], 0, |_| {}),
        Err(LoudnessError::LevelOutOfRange { .. })
    ));
    assert_eq!(
        meter.push_pcm(&[0.0], 128, |_| {}),
        Err(LoudnessError::Finished)
    );
    meter.reset(0);
    meter.push_pcm(&[1.0, -1.0, 0.0, 0.5], 0, |_| {}).unwrap();
    assert_eq!(meter.clipped_samples(), 2);
}

#[test]
fn review_regression_fifty_hz_is_steady_after_thirty_seconds() {
    let samples = signal(30.0, 50.0, 0.5);
    let mut meter = LoudnessMeter::new(Calibration::default(), SoundField::Free);
    let mut gain = crate::audio::visual::VisualGain::default();
    let mut low = f32::INFINITY;
    let mut high = 0.0_f32;
    for (index, block) in samples.chunks(128).enumerate() {
        meter
            .push_pcm(block, index as u64 * 128, |frame| {
                let bass = gain.map(&frame).bands[0].activity;
                if frame.sample_index >= 29 * 48_000 {
                    low = low.min(bass);
                    high = high.max(bass);
                }
            })
            .unwrap();
    }
    assert!(
        low > 0.0 && high - low < 0.01,
        "50 Hz bass activity {low}..{high}"
    );
}
