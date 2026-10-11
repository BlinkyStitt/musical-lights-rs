use super::*;
use crate::audio::{
    jacket::{JacketAudio, adc_pcm},
    loudness::{Calibration, LoudnessMeter, SoundField},
    processor::LoudnessProcessor,
    settings::AudioSettings,
};
fn pcm() -> std::vec::Vec<f32> {
    (0..48_000)
        .map(|i| {
            let t = i as f64 / 48_000.0;
            let envelope = if (0.35..0.44).contains(&t) || (0.65..0.74).contains(&t) {
                0.2
            } else {
                0.0
            };
            (Float::sin(core::f64::consts::TAU * 1000.0 * t) * envelope) as f32
        })
        .collect()
}
#[test]
fn all_block_partitions_retain_measurement_targets_and_attacks() {
    let pcm = pcm();
    let mut reference = std::vec::Vec::new();
    LoudnessProcessor::default()
        .push_pcm(&pcm, 0, false, |r| {
            reference.push((r.loudness.clone(), *r.snapshot))
        })
        .unwrap();
    assert!(
        reference
            .iter()
            .any(|(_, s)| s.attacks.iter().any(Option::is_some)),
        "musical bursts must produce attacks"
    );
    for block in [1, 13, 96, 128, 256, 512, 768, 1024, 4096] {
        let mut p = LoudnessProcessor::default();
        let mut actual = std::vec::Vec::new();
        let mut offset = 0;
        for chunk in pcm.chunks(block) {
            p.push_pcm(chunk, offset, false, |r| {
                actual.push((r.loudness.clone(), *r.snapshot))
            })
            .unwrap();
            offset += chunk.len() as u64;
        }
        assert_eq!(actual.len(), reference.len());
        for ((a, sa), (b, sb)) in actual.iter().zip(&reference) {
            assert_eq!(a.sample_index, b.sample_index);
            assert_eq!(a.sones, b.sones);
            assert_eq!(a.specific_sones_per_bark, b.specific_sones_per_bark);
            assert_eq!(sa, sb);
        }
    }
}
#[test]
fn shared_processor_preserves_iso_values_and_one_bark_integrals() {
    let pcm = pcm();
    let mut iso = std::vec::Vec::new();
    LoudnessMeter::new(Calibration::default(), SoundField::Free)
        .push_pcm(&pcm, 0, |f| iso.push(f))
        .unwrap();
    let mut n = 0;
    LoudnessProcessor::default()
        .push_pcm(&pcm, 0, false, |r| {
            assert_eq!(r.loudness.sones, iso[n].sones);
            assert_eq!(
                r.loudness.specific_sones_per_bark,
                iso[n].specific_sones_per_bark
            );
            assert_eq!(r.snapshot.sones, iso[n].bands());
            n += 1;
        })
        .unwrap();
    assert_eq!(n, iso.len());
}
#[test]
fn settings_do_not_change_raw_loudness() {
    let pcm = pcm();
    let mut values = AudioSettings::default().values();
    values[0] = 0.2;
    values[3] = 10.0;
    values[5] = 0.0;
    let mut a = LoudnessProcessor::default();
    let mut b = LoudnessProcessor::new(
        Calibration::default(),
        SoundField::Free,
        AudioSettings::from_values(&values).unwrap(),
    );
    a.push_pcm(&pcm, 0, false, |_| {}).unwrap();
    b.push_pcm(&pcm, 0, false, |_| {}).unwrap();
    assert_eq!(a.snapshot().sones, b.snapshot().sones);
    assert_eq!(a.snapshot().total_sones, b.snapshot().total_sones);
    assert_ne!(a.snapshot().filtered, b.snapshot().filtered);
    assert_eq!(a.snapshot().attacks, b.snapshot().attacks);
}
#[test]
fn sustained_notes_and_gentle_swells_do_not_flash_repeatedly() {
    for swell in [false, true] {
        let pcm: std::vec::Vec<_> = (0..144_000)
            .map(|i| {
                let t = i as f64 / 48_000.0;
                let amp = if swell { 0.1 * t / 3.0 } else { 0.1 };
                (amp * Float::sin(core::f64::consts::TAU * 1000.0 * t)) as f32
            })
            .collect();
        let mut p = LoudnessProcessor::default();
        let mut events = std::vec::Vec::new();
        p.push_pcm(&pcm, 0, false, |r| {
            for &at in &r.snapshot.attacks {
                if let Some(at) = at
                    && !events.contains(&at)
                {
                    events.push(at);
                }
            }
        })
        .unwrap();
        assert!(
            events.is_empty(),
            "startup sustain or gentle swell: {events:?}"
        );
    }
}
#[test]
fn snapshot_validation_and_flash_envelope() {
    let mut s = LoudnessSnapshot::new(2.0);
    s.attacks[3] = Some(2.0);
    s.filtered[3] = 0.4;
    let mut wire = [0.0; LoudnessSnapshot::TRANSPORT_LEN];
    s.write_transport(&mut wire);
    assert_eq!(LoudnessSnapshot::from_transport(&wire), Some(s));
    assert_eq!(s.frame(2.0).edges[3], 1.0);
    assert_eq!(s.frame(2.2).edges[3], 0.0);
    s.reduced = true;
    assert_eq!(s.frame(2.0).edges[3], 0.5);
    for index in 0..wire.len() {
        let before = wire[index];
        wire[index] = f64::NAN;
        assert!(LoudnessSnapshot::from_transport(&wire).is_none());
        wire[index] = before;
    }
}
#[test]
fn jacket_normalization_partition_and_gap_reset() {
    assert_eq!(adc_pcm(0), -1.0);
    assert_eq!(adc_pcm(2048), 0.0);
    assert_eq!(adc_pcm(4095), 2047.0 / 2048.0);
    let counts: std::vec::Vec<u16> = pcm()
        .iter()
        .map(|v| (2048.0 + *v * 2048.0) as u16)
        .collect();
    let normalized: std::vec::Vec<_> = counts.iter().copied().map(adc_pcm).collect();
    let mut reference = LoudnessProcessor::default();
    reference.push_pcm(&normalized, 0, false, |_| {}).unwrap();
    for block in [1, 13, 96, 128, 512, 768, 4096] {
        let mut jacket = JacketAudio::default();
        for chunk in counts.chunks(block) {
            jacket.push_adc(chunk).unwrap();
        }
        assert_eq!(jacket.snapshot(), reference.snapshot());
        jacket.reset();
        assert_eq!(jacket.snapshot(), JacketAudio::default().snapshot());
    }
    let mut p = LoudnessProcessor::default();
    p.push_pcm(&normalized[..128], 0, false, |_| {}).unwrap();
    assert!(p.push_pcm(&normalized[..128], 256, false, |_| {}).is_err());
    p.reset(256);
    let mut fresh = LoudnessProcessor::default();
    fresh.reset(256);
    p.push_pcm(&normalized, 256, false, |_| {}).unwrap();
    fresh.push_pcm(&normalized, 256, false, |_| {}).unwrap();
    assert_eq!(p.snapshot(), fresh.snapshot());
}
#[test]
fn settings_reject_nonfinite_out_of_range_and_inconsistent_controls() {
    let defaults = AudioSettings::default().values();
    assert!(AudioSettings::from_values(&defaults).is_some());
    for i in 0..defaults.len() {
        for bad in [f64::NAN, f64::INFINITY, -1.0] {
            let mut values = defaults;
            values[i] = bad;
            assert!(AudioSettings::from_values(&values).is_none(), "index {i}");
        }
    }
    let mut values = defaults;
    values[18] = 190.0;
    values[19] = 100.0;
    assert!(AudioSettings::from_values(&values).is_none());
}

#[test]
fn net_aggregates_shared_filtered_bass_once_and_preserves_layout_ratios() {
    let mut snapshot = LoudnessSnapshot::new(1.0);
    snapshot.filtered = [0.4; DISPLAY_BANDS];
    snapshot.attacks[2] = Some(1.0);
    snapshot.attacks[5] = Some(0.91);
    let net = snapshot.panel_frame(1.0);
    assert_eq!(net.levels.len(), 20);
    assert_eq!(net.levels[0], 1.0);
    assert_eq!(net.levels[1..], [0.2; 19]);
    assert_eq!(net.edges[0], 1.0);
    assert!((net.edges[1] - 0.5).abs() < 1e-6);
    assert_eq!(net.edges[2..], [0.0; 18]);
    assert_eq!(snapshot.filtered, [0.4; DISPLAY_BANDS]);
}
