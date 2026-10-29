mod common;
use common::*;
use musical_lights_core::audio::{
    loudness::{Calibration, LoudnessError, SoundField},
    policy::{GainMode, GateState, VisualOptions},
    processor::LoudnessProcessor,
    settings::AudioSettings,
};

fn check_music(name: &str, expected: f32) {
    let samples = music(name);
    let trace = feed(&mut LoudnessProcessor::default(), &samples, 0, &[128]);
    assert_eq!(trace.frames, 16_000);
    assert_eq!(
        trace.measurements,
        measurement_reference(&samples),
        "{name}: pre-tempo loudness/targets"
    );
    for partitions in [&[13][..], &[4096][..], &[1, 511, 96, 800, 4096][..]] {
        let actual = feed(&mut LoudnessProcessor::default(), &samples, 0, partitions);
        same_trace(&trace, &actual);
    }
    accurate(name, expected, &trace);
}
#[test]
fn carefree() {
    check_music("carefree", 96.0);
}
#[test]
fn monkeys() {
    check_music("monkeys", 144.0);
}
#[test]
fn single_splice() {
    let mut processor = LoudnessProcessor::default();
    let a = music("carefree");
    let first = feed(&mut processor, &a, 0, &[128]);
    let second = feed(&mut processor, &music("monkeys"), a.len() as u64, &[128]);
    accurate("splice/carefree", 96.0, &first);
    accurate("splice/monkeys", 144.0, &second);
}

fn same_trace(a: &Trace, b: &Trace) {
    assert_eq!(a.frames, b.frames);
    assert_eq!(a.measurements, b.measurements);
    assert_eq!(a.checkpoints.len(), b.checkpoints.len());
    for (a, b) in a.checkpoints.iter().zip(&b.checkpoints) {
        assert_eq!(a.sample, b.sample);
        assert_eq!(a.tempo.bpm, b.tempo.bpm, "sample {}", a.sample);
        assert_eq!(
            a.tempo.confidence, b.tempo.confidence,
            "sample {}",
            a.sample
        );
    }
}

fn configured(microphone: bool, gate: bool) -> LoudnessProcessor {
    let mut values = AudioSettings::default().values();
    values[0] = 0.7; // A nondefault display setting must survive reset.
    let settings = AudioSettings::from_values(&values).unwrap();
    let mut p = LoudnessProcessor::new(
        Calibration::measured(1.5).unwrap(),
        SoundField::Free,
        settings,
    );
    p.set_microphone(microphone);
    assert!(p.queue_settings(
        7,
        settings,
        VisualOptions {
            gate_enabled: gate,
            gate_sones: 1.0,
            gain_mode: GainMode::Off,
            manual_gain: 2.0
        }
    ));
    p
}

#[test]
fn silence_holds_then_eases_without_resetting_measurements() {
    let samples = music("monkeys");
    let mut p = LoudnessProcessor::default();
    feed(&mut p, &samples, 0, &[128]);
    let before = p.tempo().bpm;
    let silence = feed(
        &mut p,
        &vec![0.0; RATE * 24],
        samples.len() as u64,
        &[13, 128, 4096],
    );
    let lost = silence
        .checkpoints
        .iter()
        .position(|c| c.tempo.confidence == 0.0)
        .unwrap();
    assert!(
        lost <= 3,
        "silence must invalidate recent beat evidence within 2 s"
    );
    for c in &silence.checkpoints[..lost + 4] {
        assert!(
            (c.tempo.bpm - before).abs() < 1.0,
            "two-second confidence-loss hold: {c:?}"
        );
    }
    let easing = &silence.checkpoints[lost + 4..];
    assert!(easing[0].tempo.bpm < before);
    for pair in easing.windows(2) {
        assert!(pair[1].tempo.bpm <= pair[0].tempo.bpm);
        assert!(pair[1].tempo.bpm >= 60.0);
        // Half-second exponential decay with the unchanged three-second setting.
        let expected = 60.0 + (pair[0].tempo.bpm - 60.0) * (-0.5_f32 / 3.0).exp();
        assert!((pair[1].tempo.bpm - expected).abs() < 0.05);
    }
    assert!((p.tempo().bpm - 60.0).abs() < 0.1);
    assert_eq!(p.tempo().confidence, 0.0);
    assert!(p.snapshot().sones.iter().all(|v| *v < 1e-6));
}

#[test]
fn microphone_gate_closes_reopens_and_digital_bypasses_it() {
    let music = music("monkeys");
    let quiet: Vec<_> = music.iter().map(|v| v * 0.001).collect();
    let mut reference = None;
    for partition in [13, 128, 4096] {
        let mut mic = configured(true, true);
        accurate(
            "microphone/open",
            144.0,
            &feed(&mut mic, &music, 0, &[partition]),
        );
        assert_eq!(mic.gate_state(), GateState::Open);
        let muted = feed(&mut mic, &quiet, music.len() as u64, &[partition]);
        assert_eq!(mic.gate_state(), GateState::Closed);
        assert_eq!(mic.tempo().confidence, 0.0);
        assert!((mic.tempo().bpm - 60.0).abs() < 0.1);
        assert_eq!(mic.snapshot().targets, [0.0; 24]);
        assert!(mic.snapshot().sones.iter().any(|v| *v > 0.0));
        if let Some(reference) = &reference {
            same_trace(reference, &muted);
        } else {
            reference = Some(muted);
        }
        accurate(
            "microphone/reopened",
            144.0,
            &feed(&mut mic, &music, (music.len() * 2) as u64, &[partition]),
        );
        assert_eq!(mic.gate_state(), GateState::Open);
        assert_eq!(mic.revision(), 7);
    }
    let bypass = feed(&mut configured(false, true), &quiet, 0, &[128]);
    let ungated = feed(&mut configured(false, false), &quiet, 0, &[128]);
    same_trace(&bypass, &ungated);
    // Attenuation changes the canonical loudness novelty near hearing threshold.
    // Bypass must equal the ungated digital path, not invent a reliable beat.
    assert!(
        bypass
            .checkpoints
            .iter()
            .any(|c| c.tempo.confidence >= 0.45)
    );
}

#[test]
fn invalid_pcm_and_gaps_reject_before_state_changes_and_reset_reacquires() {
    let samples = music("monkeys");
    let mut p = configured(true, true);
    feed(&mut p, &samples, 0, &[128]);
    let at = samples.len() as u64;
    let tempo = p.tempo();
    let snapshot = p.snapshot();
    for (pcm, offset, error) in [
        (vec![], at, LoudnessError::EmptyBlock),
        (
            vec![0.0, f32::NAN],
            at,
            LoudnessError::NonFiniteSample { index: 1 },
        ),
        (
            vec![f32::INFINITY],
            at,
            LoudnessError::NonFiniteSample { index: 0 },
        ),
        (
            vec![0.0; 128],
            at + 128,
            LoudnessError::Discontinuity {
                expected: at,
                received: at + 128,
            },
        ),
        (
            vec![0.0; 128],
            at - 128,
            LoudnessError::Discontinuity {
                expected: at,
                received: at - 128,
            },
        ),
    ] {
        assert_eq!(
            p.push_pcm(&pcm, offset, false, |_| panic!("rejected block emitted")),
            Err(error)
        );
        assert_eq!(p.snapshot(), snapshot);
        assert_eq!(p.tempo().bpm, tempo.bpm);
        assert_eq!(p.tempo().confidence, tempo.confidence);
        assert_eq!(p.check_continuity(at), Ok(()));
    }
    let origin = at + 997; // Keep real, non-grid-aligned indices, without padding.
    p.reset(origin);
    assert_eq!(p.tempo().bpm, 60.0);
    assert_eq!(p.tempo().confidence, 0.0);
    let actual = feed(&mut p, &samples, origin, &[128]);
    let mut fresh = configured(true, true);
    fresh.reset(origin);
    let expected = feed(&mut fresh, &samples, origin, &[4096]);
    same_trace(&actual, &expected);
    accurate("gap/reacquired", 144.0, &actual);
    assert_eq!(p.revision(), 7);
    assert_eq!(p.snapshot().gain, 2.0);
}
