//! Validated engineering controls. ISO coefficients and band definitions stay fixed.
macro_rules! settings {
    ($(($name:ident, $default:expr, $min:expr, $max:expr)),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq)]
        pub struct AudioSettings { $(pub(crate) $name: f64),+ }
        impl Default for AudioSettings {
            fn default() -> Self { Self { $($name: $default),+ } }
        }
        impl AudioSettings {
            pub const LEN: usize = [$(stringify!($name)),+].len();
            pub fn values(self) -> [f64; Self::LEN] { [$(self.$name),+] }
            pub fn from_values(values: &[f64]) -> Option<Self> {
                if values.len() != Self::LEN { return None; }
                let mut values = values.iter().copied();
                let result = Self { $($name: { let value = values.next()?;
                    if !value.is_finite() || !($min..=$max).contains(&value) { return None; }
                    value }),+ };
                (result.tempo_min < result.tempo_max && result.peak_seconds <= result.baseline_seconds).then_some(result)
            }
        }
    }
}
settings! {
    (gain_target, 0.8, 0.1, 1.0),
    (gain_down, 2.0, 0.05, 60.0),
    (gain_up, 20.0, 0.05, 120.0),
    (smooth_min, 1.0, 0.1, 30.0),
    (smooth_derivative, 1.0, 0.1, 30.0),
    (smooth_beta, 0.8, 0.0, 5.0),
    (compare_seconds, 0.010, 0.002, 0.020),
    (baseline_seconds, 0.100, 0.020, 0.100),
    (peak_seconds, 0.030, 0.002, 0.100),
    (startup_seconds, 0.250, 0.0, 2.0),
    (novelty_threshold, 0.010, 0.001, 1.0),
    (relative_rise, 0.15, 0.01, 1.0),
    (minimum_sones, 0.1, 0.0, 10.0),
    (prominence, 0.3, 0.0, 1.0),
    (acoustic_quiet, 0.010, 0.002, 0.200),
    (visual_interval, 0.160, 0.020, 2.0),
    (visual_quiet, 0.060, 0.002, 1.0),
    (flash_seconds, 0.180, 0.020, 1.0),
    (tempo_min, 60.0, 60.0, 190.0),
    (tempo_max, 200.0, 70.0, 200.0),
    (tempo_history, 8.0, 4.0, 8.0),
    (tempo_smoothing, 3.0, 0.1, 20.0),
    (tempo_silence, 2.0, 0.1, 10.0),
    (rms_seconds, 0.125, 0.010, 2.0),
    (background_seconds, 30.0, 1.0, 60.0),
    (background_percentile, 0.1, 0.0, 0.5),
    (readout_hz, 10.0, 1.0, 30.0),
    (message_hz, 240.0, 30.0, 500.0),
}
