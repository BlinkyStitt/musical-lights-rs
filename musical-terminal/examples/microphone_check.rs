//! Read ten seconds of microphone input, without saving or transmitting audio.
use musical_lights_core::{
    audio::{BarkBank, DISPLAY_BANDS},
    lights::Bands,
};
use musical_terminal::MicrophoneStream;
use std::time::Duration;
fn main() -> anyhow::Result<()> {
    env_logger::init();
    let microphone = MicrophoneStream::<128>::try_new(48_000)?;
    let mut bank = BarkBank::new(microphone.sample_rate as f32)?;
    let blocks = microphone.sample_rate as usize * 10 / 128;
    let mut peak = 0.0f32;
    let mut band_peaks = [0.0f32; DISPLAY_BANDS];
    for _ in 0..blocks {
        let block = microphone.stream.recv_timeout(Duration::from_secs(3))?;
        peak = block
            .0
            .iter()
            .fold(peak, |peak, sample| peak.max(sample.abs()));
        let display = bank.push_samples(&block.0)?;
        for (peak, value) in band_peaks.iter_mut().zip(display.0) {
            *peak = peak.max(value);
        }
        anyhow::ensure!(
            display
                .0
                .iter()
                .all(|x| x.is_finite() && (0.0..=1.0).contains(x)),
            "invalid display value"
        );
    }
    println!(
        "Microphone: {} Hz, {blocks} valid blocks, peak {peak}; all 20 outputs finite and bounded",
        microphone.sample_rate
    );
    let bands = Bands::<DISPLAY_BANDS, 255>(band_peaks.map(|value| (value * 255.0) as u8));
    println!("Peak display: {bands}");
    Ok(())
}
