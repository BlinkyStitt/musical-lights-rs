use super::*;
use crate::audio::{loudness::Calibration, partial::PartialLoudnessMeter};

fn levels(value: f32) -> [BandLevel; DISPLAY_BANDS] {
    [BandLevel {
        activity: value,
        sones: value,
    }; DISPLAY_BANDS]
}

#[test]
fn shared_filter_is_fast_symmetric_and_preserves_proportional_histories() {
    let mut up = BrowserPresentation::new(0.0);
    let mut down = BrowserPresentation::new(0.0);
    down.filtered.fill(1.0);
    for _ in 0..16 {
        let values = core::array::from_fn(|i| BandLevel {
            activity: 0.5 * (i + 1) as f32 / 24.0,
            sones: 1.0,
        });
        up.smooth(values);
        down.smooth(core::array::from_fn(|i| BandLevel {
            activity: 1.0 - values[i].activity,
            sones: 1.0,
        }));
        for i in 0..24 {
            assert!((up.filtered[i] + down.filtered[i] - 1.0).abs() < 2e-7);
            assert!((up.filtered[i] / up.filtered[23] - (i + 1) as f64 / 24.0).abs() < 1e-7);
        }
    }
    assert!(up.filtered[23] >= 0.45);
    for _ in 0..2500 {
        up.smooth(levels(0.5));
    }
    assert!(up.filtered.iter().all(|x| (*x - 0.5).abs() < 1e-8));
}

#[test]
fn simultaneous_out_of_phase_jitter_is_reduced_without_mean_bias() {
    let mut p = BrowserPresentation::new(0.0);
    p.filtered.fill(0.5);
    let mut minimum = [1.0_f64; 24];
    let mut maximum = [0.0_f64; 24];
    let mut sum = [0.0; 24];
    for frame in 0..10000 {
        p.smooth(core::array::from_fn(|i| {
            let value = 0.5
                + 0.05
                    * Float::sin(
                        core::f64::consts::TAU * (8.0 * frame as f64 * DT + i as f64 / 24.0),
                    );
            BandLevel {
                activity: value as f32,
                sones: value as f32,
            }
        }));
        if frame >= 7500 {
            for i in 0..24 {
                minimum[i] = minimum[i].min(p.filtered[i]);
                maximum[i] = maximum[i].max(p.filtered[i]);
                sum[i] += p.filtered[i];
            }
        }
    }
    for i in 0..24 {
        assert!(maximum[i] - minimum[i] <= 0.04);
        assert!((sum[i] / 2500.0 - 0.5).abs() < 1e-5);
    }
}

#[test]
fn pulses_expire_exactly_and_transport_rejects_corruption() {
    let mut s = BrowserSnapshot::new(1.0);
    s.attacks[4] = Some(1.0);
    assert_eq!(s.frame(1.0).edges[4], 1.0);
    assert!((s.frame(1.05).edges[4] - 0.25).abs() < 1e-6);
    assert_eq!(s.frame(1.100001).edges[4], 0.0);
    s.reduced = true;
    assert_eq!(s.frame(1.0).edges[4], 0.5);
    let mut transport = [0.0; BrowserSnapshot::TRANSPORT_LEN];
    s.write_transport(&mut transport);
    assert_eq!(BrowserSnapshot::from_transport(&transport), Some(s));
    transport[2] = 3.0;
    assert!(BrowserSnapshot::from_transport(&transport).is_none());
    transport[2] = 4.0;
    transport[5] = f64::NAN;
    assert!(BrowserSnapshot::from_transport(&transport).is_none());
}

#[test]
fn real_fft_attacks_flash_once_but_sustains_and_modulation_do_not_retrigger() {
    for (frequency, vibrato, tremolo) in [
        (150.0, 0.0, 0.0),
        (1000.0, 0.0, 0.0),
        (8600.0, 0.0, 0.0),
        (1000.0, 0.04, 0.0),
        (1000.0, 0.0, 0.1),
    ] {
        let mut meter = PartialLoudnessMeter::new(Calibration::default());
        let mut p = BrowserPresentation::new(0.0);
        let mut phase = 0.0;
        let mut flashes = 0;
        let mut previous = [None; 24];
        for chunk in 0..1000 {
            let samples: [f32; HOP] = core::array::from_fn(|i| {
                let t = (chunk * HOP + i) as f64 / 48000.0;
                phase += core::f64::consts::TAU
                    * frequency
                    * (1.0 + vibrato * Float::sin(core::f64::consts::TAU * 6.0 * t))
                    / 48000.0;
                if (0.4..1.6).contains(&t) {
                    (0.2 * Float::sin(phase)
                        * (1.0 + tremolo * Float::sin(core::f64::consts::TAU * 8.0 * t)))
                        as f32
                } else {
                    0.0
                }
            });
            meter
                .push_pcm_with_spectrum(&samples, (chunk * HOP) as u64, |frame, spectrum| {
                    // Fixed shared scale separates onset behavior from slow AGC adaptation.
                    let values = frame.short_term_sones.map(|n| BandLevel {
                        sones: n as f32,
                        activity: (n / 4.0).min(1.0) as f32,
                    });
                    p.push(frame.sample_index as f64 / 48000.0, values, spectrum, false);
                    for (old, new) in previous.iter_mut().zip(p.snapshot.attacks) {
                        if *old != new {
                            flashes += 1;
                            *old = new;
                        }
                    }
                })
                .unwrap();
        }
        assert_eq!(
            flashes, 1,
            "f={frequency}, vibrato={vibrato}, tremolo={tremolo}"
        );
        assert!(p.snapshot.frame(2.0).edges.iter().all(|e| *e == 0.0));
    }
}

#[test]
fn gain_only_changes_silence_and_startup_cannot_flash() {
    let mut p = BrowserPresentation::new(0.0);
    let spectrum = [1.0; BINS];
    for n in 1..1000 {
        p.push(
            n as f64 * DT,
            levels(if n % 100 < 50 { 0.4 } else { 0.8 }),
            &spectrum,
            false,
        );
        assert_eq!(p.snapshot.attacks, [None; 24]);
    }
}

#[test]
fn repeated_attacks_rearm_but_swells_and_a_masked_weak_target_do_not_flash() {
    for (kind, expected) in [("repeated", 2), ("swell", 0), ("masked", 0), ("silence", 0)] {
        let mut meter = PartialLoudnessMeter::new(Calibration::default());
        let mut presentation = BrowserPresentation::new(0.0);
        let mut previous = [None; 24];
        let mut flashes = 0;
        for chunk in 0..1000 {
            let pcm: [f32; HOP] = core::array::from_fn(|i| {
                let t = (chunk * HOP + i) as f64 / 48000.0;
                let tone = Float::sin(core::f64::consts::TAU * 1000.0 * t);
                match kind {
                    "repeated" if (0.4..0.7).contains(&t) || (1.0..1.3).contains(&t) => {
                        (0.2 * tone) as f32
                    }
                    "swell" => (0.2 * tone * ((t - 0.4) / 0.8).clamp(0.0, 1.0)) as f32,
                    "masked" => {
                        (0.2 * tone
                            + if (0.4..1.6).contains(&t) {
                                0.002 * Float::sin(core::f64::consts::TAU * 840.0 * t)
                            } else {
                                0.0
                            }) as f32
                    }
                    _ => 0.0,
                }
            });
            meter
                .push_pcm_with_spectrum(&pcm, (chunk * HOP) as u64, |frame, spectrum| {
                    let levels = frame.short_term_sones.map(|n| BandLevel {
                        sones: n as f32,
                        activity: (n / 4.0).min(1.0) as f32,
                    });
                    presentation.push(frame.sample_index as f64 / 48000.0, levels, spectrum, false);
                    for (old, new) in previous.iter_mut().zip(presentation.snapshot.attacks) {
                        if *old != new {
                            flashes += 1;
                            *old = new;
                        }
                    }
                })
                .unwrap();
        }
        assert_eq!(flashes, expected, "{kind}");
    }
}
