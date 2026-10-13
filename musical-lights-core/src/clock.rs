//! Validated UTC for packet age, and a separate continuous presentation clock.
/// Conservative holdover bound; provisioned oscillator measurements must fit it.
pub const HOLDOVER_DRIFT_PPM: u16 = 100;
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ClockState {
    #[default]
    Untrusted,
    Acquiring,
    Locked,
    Holdover,
}
#[derive(Clone, Copy, Debug)]
pub struct Anchor {
    pub utc_ms: u64,
    pub monotonic_ms: u64,
    pub uncertainty_ms: u32,
}
#[derive(Default)]
pub struct UtcClock {
    state: ClockState,
    anchor: Option<Anchor>,
    candidate: Option<Anchor>,
    consecutive: u8,
}
impl UtcClock {
    pub fn state(&self) -> ClockState {
        self.state
    }
    pub fn anchor(&self) -> Option<Anchor> {
        self.anchor
    }
    pub fn accept(&mut self, next: Anchor) -> bool {
        self.update(next.monotonic_ms);
        if !(1577836800000..4102444800000).contains(&next.utc_ms) {
            self.consecutive = 0;
            return false;
        }
        if let Some(old) = self.candidate
            && (next.monotonic_ms <= old.monotonic_ms || next.utc_ms <= old.utc_ms)
        {
            return false;
        }
        if self.state == ClockState::Locked {
            let expected = self.anchor.unwrap();
            let prediction = expected
                .utc_ms
                .saturating_add(next.monotonic_ms.saturating_sub(expected.monotonic_ms));
            if prediction.abs_diff(next.utc_ms) <= 250 && next.uncertainty_ms <= 50 {
                self.anchor = Some(next);
                self.candidate = Some(next);
                return true;
            }
            self.state = ClockState::Acquiring;
            self.consecutive = 0;
        }
        if next.uncertainty_ms > 50 {
            self.state = ClockState::Acquiring;
            self.consecutive = 0;
            self.candidate = Some(next);
            return false;
        }
        let consistent = self.candidate.is_some_and(|old| {
            let elapsed = next.monotonic_ms.saturating_sub(old.monotonic_ms);
            (900..=1100).contains(&elapsed) && next.utc_ms.saturating_sub(old.utc_ms) == 1000
        });
        self.consecutive = if consistent {
            self.consecutive.saturating_add(1)
        } else {
            1
        };
        self.candidate = Some(next);
        self.state = ClockState::Acquiring;
        if self.consecutive >= 5 && next.uncertainty_ms <= 50 {
            self.anchor = Some(next);
            self.state = ClockState::Locked;
            return true;
        }
        false
    }
    pub fn update(&mut self, now: u64) {
        if let Some(anchor) = self.anchor {
            let age = now.saturating_sub(anchor.monotonic_ms);
            if self.state == ClockState::Locked && age > 3000 {
                self.state = ClockState::Holdover;
                self.consecutive = 0;
            }
            let uncertainty = anchor.uncertainty_ms as u64 + age.div_ceil(10000);
            if self.state == ClockState::Holdover && (age > 1800000 || uncertainty > 250) {
                self.state = ClockState::Untrusted;
                self.consecutive = 0;
            }
        }
    }
    pub fn utc(&self, now: u64) -> Option<(u64, u32)> {
        if !matches!(self.state, ClockState::Locked | ClockState::Holdover) {
            return None;
        }
        let anchor = self.anchor?;
        let elapsed = now.saturating_sub(anchor.monotonic_ms);
        let uncertainty = anchor.uncertainty_ms as u64 + elapsed.div_ceil(10000);
        if elapsed > 1800000 || uncertainty > 250 {
            return None;
        }
        Some((anchor.utc_ms.saturating_add(elapsed), uncertainty as u32))
    }
}

#[derive(Default)]
pub struct PatternClock {
    previous_ms: Option<u64>,
    presentation_ms: f64,
    correction_at: Option<u64>,
    locked_once: bool,
}
#[derive(Clone, Copy, Debug)]
pub struct PatternTime {
    pub seconds: f64,
    pub intensity: f32,
    pub synchronized: bool,
}
impl PatternClock {
    pub fn tick(&mut self, now: u64, utc: Option<(u64, u32)>) -> PatternTime {
        let elapsed = self.previous_ms.map_or(0, |last| now.saturating_sub(last));
        self.previous_ms = Some(now);
        self.presentation_ms += elapsed as f64;
        let mut intensity = 1.0;
        if utc.is_none() {
            self.correction_at = None;
        }
        if let Some((trusted, _)) = utc {
            let offset = trusted as f64 - self.presentation_ms;
            if (!self.locked_once || offset.abs() > 250.0) && self.correction_at.is_none() {
                self.correction_at = Some(now);
                self.locked_once = true;
            }
            if let Some(start) = self.correction_at {
                let age = now.saturating_sub(start);
                if age < 300 {
                    intensity = 1.0 - age as f32 / 300.0;
                } else if age < 600 {
                    self.presentation_ms = trusted as f64;
                    intensity = (age - 300) as f32 / 300.0;
                } else {
                    self.presentation_ms = trusted as f64;
                    self.correction_at = None;
                }
            } else {
                self.presentation_ms +=
                    offset.clamp(-(elapsed as f64) * 0.005, elapsed as f64 * 0.005);
            }
        }
        let synchronized = self.correction_at.is_none()
            && utc.is_some_and(|(trusted, error)| {
                error as f64 + (trusted as f64 - self.presentation_ms).abs() <= 50.0
            });
        PatternTime {
            seconds: self.presentation_ms / 1000.0,
            intensity,
            synchronized,
        }
    }
}
