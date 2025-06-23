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
            // TODO: track the stddev too?
            #[cfg(not(feature = "embassy"))]
            {
                let fps = self.count as f32 / elapsed.as_secs_f32();
                info!("{} FPS: {}", self.label, fps);
            }

            #[cfg(feature = "embassy")]
            {
                // TODO: this doesn't work with embassy. it doesn't have as_secs_f32. maybe use as_millis and display fps ?
                let fpms = self.count * 1000 / elapsed.as_millis() as u64;
                info!("{} FPMS: {}", self.label, fpms);
            }

            self.count = 0;
            self.last = now;
        }
    }
}
