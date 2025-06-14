use crate::logging::info;

#[cfg(feature = "std")]
use std::time::{Duration, Instant};

#[cfg(all(not(feature = "std"), feature = "embassy"))]
use embassy_time::{Duration, Instant};

pub struct FpsTracker {
    label: &'static str,
    last: Instant,
    count: u64,
}

impl FpsTracker {
    /// TODO: add an "expected" framerate and we can print only if its outside the expected range?
    pub fn new(label: &'static str) -> Self {
        Self {
            label,
            last: Instant::now(),
            count: 0,
        }
    }

    pub fn tick(&mut self) {
        self.count += 1;
        let now = Instant::now();
        let elapsed = now.duration_since(self.last);

        if elapsed >= Duration::from_secs(1) {
            let fps = self.count * 1_000u64 / elapsed.as_millis() as u64;

            self.count = 0;
            self.last = now;

            info!("{} FPS: {}", self.label, fps);
        }
    }
}
