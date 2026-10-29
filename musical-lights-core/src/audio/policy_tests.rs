use super::{
    loudness::{Calibration, LoudnessMeter, SoundField},
    policy::{GainMode, MicrophoneGate, VisualOptions},
    presentation::LoudnessPresentation,
    processor::LoudnessProcessor,
    settings::AudioSettings,
    visual::VisualGain,
};

#[test]
fn gate_uses_total_sones_equalities_and_exact_closing_hold() {
    let mut gate = MicrophoneGate::default();
    gate.push(0.099, 0.1);
    assert!(!gate.is_open());
    gate.push(0.1, 0.1);
    assert!(gate.is_open());
    for _ in 0..49 {
        gate.push(0.0, 0.1);
    }
    assert!(gate.is_open());
    gate.push(0.8 * 0.1, 0.1); // Equality resets the quiet hold.
    for _ in 0..49 {
        gate.push(0.0, 0.1);
    }
    assert!(gate.is_open());
    gate.push(0.0, 0.1);
    assert!(!gate.is_open());
    gate.push(0.09, 0.1);
    assert!(!gate.is_open());
    gate.push(0.1, 0.1);
    assert!(gate.is_open());
}

#[test]
fn floor_edits_clear_hold_and_enabling_starts_closed() {
    let old = VisualOptions {
        gate_enabled: true,
        ..Default::default()
    };
    let next = VisualOptions {
        gate_sones: 0.2,
        ..old
    };
    let mut gate = MicrophoneGate::default();
    gate.push(0.1, old.gate_sones);
    for _ in 0..49 {
        gate.push(0.0, old.gate_sones);
    }
    gate.configure(old, next);
    for _ in 0..49 {
        gate.push(0.0, next.gate_sones);
    }
    assert!(gate.is_open());
    gate.push(0.0, next.gate_sones);
    assert!(!gate.is_open());
    gate.push(0.2, next.gate_sones);
    gate.configure(VisualOptions::default(), next);
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
        gate_sones: 100.0,
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
        [2.0, 0.1, 1.0, 1.0],
        [0.0, 0.0, 1.0, 1.0],
        [0.0, -0.1, 1.0, 1.0],
        [0.0, 0.1, 4.0, 1.0],
        [0.0, 0.1, 1.0, 0.0],
        [0.0, 0.1, 1.0, f64::NAN],
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
    let samples: std::vec::Vec<f32> = (0..48000)
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
                    frames.push((*frame.snapshot, frame.gate_state))
                })
                .unwrap();
        }
        if let Some(reference) = &reference {
            assert_eq!(&frames, reference, "callback size {size}");
        } else {
            let states: std::vec::Vec<_> = frames.iter().map(|f| f.1).collect();
            assert!(states.windows(2).any(|p| p
                == [
                    super::policy::GateState::Closed,
                    super::policy::GateState::Open
                ]));
            assert!(states.windows(2).any(|p| p
                == [
                    super::policy::GateState::Open,
                    super::policy::GateState::Closed
                ]));
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
            gate_sones: 100.0,
            ..Default::default()
        }
    ));
    let mut enabled = false;
    let mut previous = 0;
    let mut closed_frames = 0;
    let mut reopened = false;
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
                    gate_sones: 100.0,
                    ..Default::default()
                }
            ));
            enabled = true;
        } else if enabled {
            closed_frames += 1;
            if closed_frames == 2 {
                assert!(processor.queue_settings(
                    3,
                    AudioSettings::default(),
                    VisualOptions {
                        gate_enabled: true,
                        gate_sones: 0.0001,
                        ..Default::default()
                    }
                ));
            }
            if closed_frames > 2 {
                reopened |= processor.gate_state() == super::policy::GateState::Open;
            }
            assert_eq!(
                processor.accent_sequence(),
                previous,
                "closure and early reopening released a stale direction event"
            );
        }
    }
    assert!(enabled, "fixture must first confirm an acoustic attack");
    assert!(reopened);
}

#[test]
fn equal_rms_spectra_gate_by_sones_independently_of_gain() {
    use super::policy::GateState;
    let tone = |hz: f64| -> std::vec::Vec<f32> {
        (0..48_000)
            .map(|i| (core::f64::consts::TAU * hz * i as f64 / 48_000.0).sin() as f32 * 0.001)
            .collect()
    };
    let low = tone(100.0);
    let high = tone(1000.0);
    let power = |pcm: &[f32]| pcm.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>();
    assert!((power(&low) - power(&high)).abs() < 1e-8);
    let measure = |pcm: &[f32]| {
        let mut meter = LoudnessMeter::new(Calibration::default(), SoundField::Free);
        let mut frames = std::vec::Vec::new();
        meter.push_pcm(pcm, 0, |f| frames.push(f)).unwrap();
        frames
    };
    let low_frames = measure(&low);
    let high_frames = measure(&high);
    let low_max = low_frames.iter().map(|f| f.sones).fold(0.0_f64, f64::max);
    let high_final = high_frames.last().unwrap().sones;
    assert!(high_final > low_max);
    let floor = (low_max + high_final) / 2.0;
    for (pcm, raw, final_state) in [
        (&low, &low_frames, GateState::Closed),
        (&high, &high_frames, GateState::Open),
    ] {
        let mut reference = None;
        for (mode, manual) in [
            (GainMode::Normal, 1.0),
            (GainMode::Vivid, 1.0),
            (GainMode::Lazy, 1.0),
            (GainMode::Off, 64.0),
        ] {
            let mut processor = LoudnessProcessor::default();
            processor.set_microphone(true);
            processor.queue_settings(
                1,
                AudioSettings::default(),
                VisualOptions {
                    gate_enabled: true,
                    gate_sones: floor,
                    gain_mode: mode,
                    manual_gain: manual,
                },
            );
            let mut states = std::vec::Vec::new();
            processor
                .push_pcm(pcm, 0, false, |f| {
                    let expected = &raw[states.len()];
                    assert_eq!(f.loudness.sones, expected.sones);
                    assert_eq!(
                        f.loudness.specific_sones_per_bark,
                        expected.specific_sones_per_bark
                    );
                    states.push(f.gate_state);
                })
                .unwrap();
            assert_eq!(states.last(), Some(&final_state));
            if let Some(reference) = &reference {
                assert_eq!(&states, reference);
            } else {
                reference = Some(states);
            }
        }
    }
}

#[test]
fn invalid_updates_and_reset_preserve_accepted_options() {
    use super::policy::GateState;
    let mut processor = LoudnessProcessor::default();
    processor.set_microphone(true);
    let options = VisualOptions {
        gate_enabled: true,
        gate_sones: 0.0001,
        ..Default::default()
    };
    assert!(processor.queue_settings(1, AudioSettings::default(), options));
    processor.push_pcm(&pcm(), 0, false, |_| {}).unwrap();
    assert_eq!(processor.gate_state(), GateState::Open);
    for floor in [0.0, -1.0, f64::INFINITY, f64::NAN] {
        assert!(!processor.queue_settings(
            2,
            AudioSettings::default(),
            VisualOptions {
                gate_sones: floor,
                ..options
            }
        ));
        assert_eq!(processor.revision(), 1);
        assert_eq!(processor.gate_state(), GateState::Open);
    }
    processor.reset(48000);
    assert_eq!(processor.gate_state(), GateState::Closed);
    processor
        .push_pcm(&[0.0; 9600], 48000, false, |f| {
            assert_eq!(f.options, options);
            assert_eq!(f.revision, 1);
            assert_eq!(f.gate_state, GateState::Closed);
        })
        .unwrap();
    for floor in [f64::MIN_POSITIVE, 0.00001, f64::MAX] {
        assert!(VisualOptions::from_values(&[1.0, floor, 1.0, 1.0]).is_some());
    }
}
