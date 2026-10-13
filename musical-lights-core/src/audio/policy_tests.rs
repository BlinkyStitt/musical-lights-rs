use super::{
    loudness::{Calibration, LoudnessMeter, SoundField},
    policy::{GainMode, MicrophoneGate, VisualOptions},
    presentation::LoudnessPresentation,
    processor::LoudnessProcessor,
    settings::AudioSettings,
    visual::VisualGain,
};

#[test]
fn gate_uses_ten_ms_rms_hysteresis_and_exact_closing_hold() {
    let mut gate = MicrophoneGate::default();
    gate.push(&[0.002; 479]);
    assert!(!gate.is_open());
    gate.push(&[0.002]);
    assert!(gate.is_open());
    gate.push(&[0.0012; 4800]); // Between closing and opening thresholds.
    assert!(gate.is_open());
    gate.push(&[0.0001; 4799]);
    assert!(gate.is_open());
    gate.push(&[0.0001]);
    assert!(!gate.is_open());
    gate.push(&[0.0012; 480]);
    assert!(!gate.is_open());
}

#[test]
fn gain_modes_preserve_ratios_and_use_the_specified_time_constants() {
    let settings = AudioSettings::default();
    let bands = core::array::from_fn(|i| (i + 1) as f32 * 0.001);
    let run = |mode, count| {
        let mut gain = VisualGain::default();
        gain.configure(
            settings,
            VisualOptions {
                gain_mode: mode,
                manual_gain: 3.0,
                ..Default::default()
            },
        );
        for _ in 0..count {
            gain.map_bands(bands, 1.0);
        }
        (gain.factor(), gain.map_bands(bands, 1.0))
    };
    let normal = run(GainMode::Normal, 40).0;
    assert!((normal - run(GainMode::Vivid, 10).0).abs() < 1e-12);
    assert!((normal - run(GainMode::Lazy, 80).0).abs() < 1e-12);
    let (gain, mapped) = run(GainMode::Off, 100);
    assert_eq!(gain, 3.0);
    for i in 0..24 {
        assert_eq!(mapped[i].sones, bands[i]);
        assert!((mapped[i].activity - bands[i] * 3.0).abs() < 1e-8);
    }
}

fn pcm() -> std::vec::Vec<f32> {
    (0..24_000)
        .map(|i| {
            if i < 12_000 {
                0.0
            } else {
                (core::f64::consts::TAU * 1000.0 * i as f64 / 48_000.0).sin() as f32 * 0.005
            }
        })
        .collect()
}

#[test]
fn defaults_match_the_established_pipeline_exactly() {
    let samples = pcm();
    let settings = AudioSettings::default();
    let mut meter = LoudnessMeter::new(Calibration::default(), SoundField::Free);
    let mut gain = VisualGain::new(settings);
    let mut presentation = LoudnessPresentation::new(0.0, settings);
    let mut reference = std::vec::Vec::new();
    meter
        .push_pcm(&samples, 0, |frame| {
            let levels = gain.map(&frame);
            presentation.push(&frame, levels, gain.factor(), false);
            reference.push((frame.specific_sones_per_bark, presentation.snapshot));
        })
        .unwrap();
    for block in [1, 13, 96, 128, 512, 4096] {
        let mut processor = LoudnessProcessor::default();
        let mut actual = std::vec::Vec::new();
        for (i, chunk) in samples.chunks(block).enumerate() {
            processor
                .push_pcm(chunk, (i * block) as u64, false, |frame| {
                    actual.push((frame.loudness.specific_sones_per_bark, *frame.snapshot));
                })
                .unwrap();
        }
        assert_eq!(actual, reference, "callback size {block}");
    }
}

#[test]
fn gated_microphone_keeps_raw_measurements_and_digital_bypasses_gate() {
    let samples = pcm();
    let options = VisualOptions {
        gate_enabled: true,
        gate_dbfs: -20.0,
        ..Default::default()
    };
    let mut raw = None;
    for microphone in [false, true] {
        for block in [13, 128, 4096] {
            let mut processor = LoudnessProcessor::default();
            processor.set_microphone(microphone);
            assert!(processor.queue_settings(1, AudioSettings::default(), options));
            let mut measurements = std::vec::Vec::new();
            for (i, chunk) in samples.chunks(block).enumerate() {
                processor
                    .push_pcm(chunk, (i * block) as u64, false, |frame| {
                        measurements.push(frame.loudness.sones);
                        if microphone {
                            assert_eq!(frame.snapshot.targets, [0.0; 24]);
                            assert_eq!(frame.snapshot.gain, 1.0);
                            assert_eq!(*frame.acoustic_events, [None; 24]);
                        }
                    })
                    .unwrap();
            }
            if let Some(raw) = &raw {
                assert_eq!(&measurements, raw);
            } else {
                raw = Some(measurements);
            }
            if !microphone {
                assert!(processor.snapshot().filtered.iter().any(|v| *v > 0.0));
            }
            if microphone {
                assert_eq!(processor.accent_sequence(), 0);
            }
        }
    }
}

#[test]
fn live_update_preserves_sample_continuity_and_waits_for_analysis_boundary() {
    let mut processor = LoudnessProcessor::default();
    processor.push_pcm(&[0.001; 128], 0, false, |_| {}).unwrap();
    let before = processor.snapshot();
    let options = VisualOptions {
        gain_mode: GainMode::Off,
        manual_gain: 2.0,
        ..Default::default()
    };
    assert!(processor.queue_settings(1, AudioSettings::default(), options));
    assert!(!processor.queue_settings(1, AudioSettings::default(), options));
    assert_eq!(processor.revision(), 0);
    processor
        .push_pcm(&[0.001; 128], 128, false, |frame| {
            assert_eq!(*frame.acoustic_events, [None; 24]);
        })
        .unwrap();
    assert_eq!(processor.revision(), 1);
    assert!(processor.snapshot().timestamp() > before.timestamp());
    assert_eq!(processor.snapshot().gain, 2.0);
    assert_eq!(processor.accent_sequence(), 0);
    assert!(!processor.queue_settings(0, AudioSettings::default(), options));
}

#[test]
fn visual_options_reject_invalid_records() {
    for values in [
        [2.0, -60.0, 1.0, 1.0],
        [0.0, -91.0, 1.0, 1.0],
        [0.0, -19.0, 1.0, 1.0],
        [0.0, -60.0, 4.0, 1.0],
        [0.0, -60.0, 1.0, 0.0],
        [0.0, -60.0, 1.0, f64::NAN],
    ] {
        assert!(VisualOptions::from_values(&values).is_none());
    }
    assert_eq!(
        VisualOptions::from_values(&VisualOptions::default().values()),
        Some(VisualOptions::default())
    );
}

#[test]
fn gate_opening_and_closing_keep_identical_frame_targets_across_callbacks() {
    let samples: std::vec::Vec<f32> = (0..24000)
        .map(|i| {
            let amplitude = if (4800..14400).contains(&i) {
                0.01
            } else {
                0.00001
            };
            (core::f64::consts::TAU * 1000.0 * i as f64 / 48000.0).sin() as f32 * amplitude
        })
        .collect();
    let mut reference = None;
    for size in [1, 13, 128, 512, 4096] {
        let mut processor = LoudnessProcessor::default();
        processor.set_microphone(true);
        assert!(processor.queue_settings(
            1,
            AudioSettings::default(),
            VisualOptions {
                gate_enabled: true,
                ..Default::default()
            }
        ));
        let mut frames = std::vec::Vec::new();
        for (index, chunk) in samples.chunks(size).enumerate() {
            processor
                .push_pcm(chunk, (index * size) as u64, false, |frame| {
                    frames.push(*frame.snapshot)
                })
                .unwrap();
        }
        if let Some(reference) = &reference {
            assert_eq!(&frames, reference, "callback size {size}");
        } else {
            reference = Some(frames);
        }
    }
}

#[test]
fn enabling_a_closed_gate_discards_an_already_pending_direction_draw() {
    let samples: std::vec::Vec<f32> = (0..48000)
        .map(|i| {
            if i < 24000 {
                0.0
            } else {
                (core::f64::consts::TAU * 1000.0 * i as f64 / 48000.0).sin() as f32 * 0.005
            }
        })
        .collect();
    let mut processor = LoudnessProcessor::default();
    processor.set_microphone(true);
    assert!(processor.queue_settings(
        1,
        AudioSettings::default(),
        VisualOptions {
            gate_dbfs: -20.0,
            ..Default::default()
        }
    ));
    let mut enabled = false;
    let mut previous = 0;
    for (index, chunk) in samples.chunks(96).enumerate() {
        let mut attack = false;
        processor
            .push_pcm(chunk, (index * 96) as u64, false, |frame| {
                attack |= frame.acoustic_events.iter().any(Option::is_some);
            })
            .unwrap();
        if attack && !enabled {
            previous = processor.accent_sequence();
            assert!(processor.queue_settings(
                2,
                AudioSettings::default(),
                VisualOptions {
                    gate_enabled: true,
                    gate_dbfs: -20.0,
                    ..Default::default()
                }
            ));
            enabled = true;
        } else if enabled {
            assert_eq!(
                processor.accent_sequence(),
                previous,
                "closed gate emitted a direction event"
            );
        }
    }
    assert!(enabled, "fixture must first confirm an acoustic attack");
}
