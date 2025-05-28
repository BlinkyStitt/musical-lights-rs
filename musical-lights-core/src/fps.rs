use crate::logging::info;

#[cfg(feature = "std")]
use std::time::{Duration, Instant};

#[cfg(all(not(feature = "std"), feature = "embassy"))]
use embassy_time::{Duration, Instant};

pub struct FpsTracker {
    last: Instant,
    count: u64,
}

impl Default for FpsTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl FpsTracker {
    pub fn new() -> Self {
        Self {
            last: Instant::now(),
            count: 0,
        }
    }

    pub fn tick(&mut self) {
        self.count += 1;
        let now = Instant::now();
        let elapsed = now.duration_since(self.last);

        if elapsed >= Duration::from_secs(1) {
            let fps = self.count * 1_000u64 / elapsed.as_millis();

            self.count = 0;
            self.last = now;

            info!("FPS: {}", fps);
        }
    }
}
