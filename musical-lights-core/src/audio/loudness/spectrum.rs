//! Hearing threshold, critical-band corrections and upper masking slopes.
//! Tables and equations: ISO 532-1:2017; MoSQITo 1.2.1, Apache-2.0.
use super::{LoudnessError, SPECIFIC_BINS, SoundField, tables::*};
use num::Float;

pub(super) fn core_loudness(
    levels: &[f64; 28],
    field: SoundField,
) -> Result<[f64; 21], LoudnessError> {
    let mut intensity = [0.0; 11];
    for band in 0..11 {
        if levels[band] > 120.0 {
            return Err(LoudnessError::LevelOutOfRange { band });
        }
        let mut range = 0;
        while range < RAP.len() - 1 && levels[band] > RAP[range] - DLL[range][band] {
            range += 1;
        }
        intensity[band] = Float::powf(10.0, (levels[band] + DLL[range][band]) / 10.0);
    }
    let mut critical = [0.0; 20];
    for (band, range) in [0..6, 6..9, 9..11].into_iter().enumerate() {
        critical[band] = 10.0 * Float::log10(intensity[range].iter().sum::<f64>());
    }
    critical[3..].copy_from_slice(&levels[11..]);
    let mut main = [0.0; 21];
    for band in 0..20 {
        let level = critical[band] - A0[band]
            + if field == SoundField::Diffuse {
                DDF[band]
            } else {
                0.0
            };
        if level > LTQ[band] {
            let threshold = 0.0635 * Float::powf(10.0, 0.025 * LTQ[band]);
            let excitation = Float::powf(
                0.75 + 0.25 * Float::powf(10.0, 0.1 * (level - DCB[band] - LTQ[band])),
                0.25,
            ) - 1.0;
            main[band] = (threshold * excitation).max(0.0);
        }
    }
    main[0] *= (0.4 + 0.32 * Float::powf(main[0], 0.2)).min(1.0);
    Ok(main)
}

pub(super) fn spread(main: &[f64; 21]) -> (f64, [f64; SPECIFIC_BINS]) {
    let mut specific = [0.0; SPECIFIC_BINS];
    let (mut z1, mut n1, mut total) = (0.0_f64, 0.0_f64, 0.0_f64);
    let mut cursor = 0;
    for band in 0..21 {
        let upper = ZUP[band];
        let column = band.saturating_sub(1).min(7);
        while z1 < upper - 1e-12 {
            // Treat arithmetic residue below 1e-12 sone/Bark as equality.
            // Without this, the final zero crossing can have a positive height
            // whose horizontal extent rounds to zero at the current Bark value.
            let (z2, n2, slope) = if n1 <= main[band] + 1e-12 {
                n1 = main[band];
                (upper, n1, 0.0)
            } else {
                let mut range = 0;
                while range < RNS.len() - 1 && RNS[range] >= n1 - 1e-12 {
                    range += 1;
                }
                let slope = USL[range][column];
                let target = main[band].max(RNS[range]);
                let z2 = (z1 + (n1 - target) / slope).min(upper);
                (z2, n1 - (z2 - z1) * slope, slope)
            };
            total += (n1 + n2) * (z2 - z1) * 0.5;
            while cursor < SPECIFIC_BINS && (cursor + 1) as f64 * 0.1 <= z2 + 1e-12 {
                let z = (cursor + 1) as f64 * 0.1;
                specific[cursor] = (n1 - (z - z1) * slope).max(0.0);
                cursor += 1;
            }
            z1 = z2;
            n1 = n2;
        }
    }
    // ISO's reported precision is applied before the final temporal weighting.
    let precision = if total <= 16.0 { 1000.0 } else { 100.0 };
    (
        Float::floor(total.max(0.0) * precision + 0.5) / precision,
        specific,
    )
}
