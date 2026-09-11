//! Exercise the production capture path for ten seconds; do not store raw audio.
use musical_terminal::loudness::LiveLoudness;
use std::{
    thread,
    time::{Duration, Instant},
};
fn main() -> anyhow::Result<()> {
    env_logger::init();
    let input = LiveLoudness::new(0, None, String::new())?;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        thread::sleep(Duration::from_millis(20));
        let frame = input.latest()?;
        anyhow::ensure!(
            frame.sones.is_finite()
                && frame
                    .display()
                    .levels
                    .iter()
                    .all(|v| v.is_finite() && (0.0..=1.0).contains(v)),
            "invalid loudness or display state"
        );
    }
    let frame = input.latest()?;
    println!(
        "{} Hz selected channel {}, {} samples processed, {} clipped; finite output",
        input.input.sample_rate,
        input.input.channel + 1,
        frame.input_samples,
        frame.clipped
    );
    Ok(())
}
