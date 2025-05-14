use embassy_time::Instant;
use log::info;

pub struct FpsTracker {
    last: Instant,
    count: u32,
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

        if elapsed.as_millis() >= 1000 {
            let fps = self.count;
            self.count = 0;
            self.last = now;
            info!("FPS: {}", fps);
        }
    }
}
