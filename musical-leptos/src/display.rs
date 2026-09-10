use musical_lights_core::audio::DISPLAY_BANDS;

/// At most two automatic target changes per second. A flash requires two
/// opposing changes; this stays below WCAG's three-flashes-per-second limit.
pub const DISPLAY_INTERVAL_MS: f64 = 500.0;

pub struct DisplayPacer {
    last_update_ms: f64,
    peaks: [f32; DISPLAY_BANDS],
}

impl DisplayPacer {
    pub fn new(now_ms: f64) -> Self {
        Self {
            last_update_ms: now_ms,
            peaks: [0.0; DISPLAY_BANDS],
        }
    }

    /// Keep short transients within the display window. Use monotonic wall time,
    /// not audio sample time, so queued callbacks cannot cause catch-up flashes.
    pub fn push(
        &mut self,
        values: [f32; DISPLAY_BANDS],
        now_ms: f64,
    ) -> Option<[f32; DISPLAY_BANDS]> {
        for (peak, value) in self.peaks.iter_mut().zip(values) {
            *peak = peak.max(value);
        }
        if now_ms - self.last_update_ms < DISPLAY_INTERVAL_MS {
            return None;
        }
        self.last_update_ms = now_ms;
        Some(std::mem::replace(&mut self.peaks, [0.0; DISPLAY_BANDS]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rapid_changes_keep_transients_and_limit_updates() {
        let mut display = DisplayPacer::new(0.0);
        let mut updates = Vec::new();
        for ms in 1..=5000 {
            let value = if ms % 2 == 0 { 1.0 } else { 0.0 };
            if let Some(values) = display.push([value; DISPLAY_BANDS], ms as f64) {
                assert_eq!(values, [1.0; DISPLAY_BANDS]);
                updates.push(ms);
            }
        }
        assert_eq!(updates, (1..=10).map(|n| n * 500).collect::<Vec<_>>());
        assert_eq!(
            display.push([0.0; DISPLAY_BANDS], 5500.0),
            Some([0.0; DISPLAY_BANDS])
        );
    }

    #[test]
    fn delayed_callbacks_never_replay_a_burst_of_updates() {
        let mut display = DisplayPacer::new(0.0);
        assert!(display.push([1.0; DISPLAY_BANDS], 5000.0).is_some());
        for _ in 0..1000 {
            assert!(display.push([0.0; DISPLAY_BANDS], 5000.0).is_none());
        }
        assert!(display.push([0.0; DISPLAY_BANDS], 5499.0).is_none());
        assert_eq!(
            display.push([0.0; DISPLAY_BANDS], 5500.0),
            Some([0.0; DISPLAY_BANDS])
        );
    }
}
