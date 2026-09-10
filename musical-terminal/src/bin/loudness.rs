//! Live ISO 532-1 activity, with optional input calibration.
use anyhow::{Context, bail, ensure};
use musical_lights_core::{audio::visual::DISPLAY_BANDS, lights::Bands};
use musical_terminal::loudness::{InputProfile, LiveLoudness};
use std::{
    fs,
    io::Write,
    thread,
    time::{Duration, Instant},
};

fn main() -> anyhow::Result<()> {
    env_logger::init();
    let mut args = std::env::args().skip(1);
    let (mut channel, mut settings, mut profile_path, mut reference, mut save, mut seconds) =
        (0, String::new(), None, None::<f64>, None, None::<f64>);
    while let Some(arg) = args.next() {
        if arg == "--help" {
            println!(
                "loudness [--channel N] [--profile FILE --settings TEXT] [--reference DB_SPL --save FILE --settings TEXT] [--seconds N]\nChannels start at 1. Disable capture processing and keep gain fixed. Calibration measures the first three seconds of a steady reference sound."
            );
            return Ok(());
        }
        let value = args.next().context("option requires a value")?;
        match arg.as_str() {
            "--channel" => {
                channel = value
                    .parse::<usize>()?
                    .checked_sub(1)
                    .context("channel starts at 1")?
            }
            "--settings" => settings = value,
            "--profile" => profile_path = Some(value),
            "--reference" => reference = Some(value.parse()?),
            "--save" => save = Some(value),
            "--seconds" => seconds = Some(value.parse()?),
            _ => bail!("unknown option {arg}; use --help"),
        }
    }
    ensure!(
        reference.is_some() == save.is_some(),
        "--reference and --save must be supplied together"
    );
    ensure!(
        reference.is_none() || (profile_path.is_none() && !settings.trim().is_empty()),
        "new calibration requires --settings and no existing profile"
    );
    ensure!(
        seconds.is_none_or(|s| s.is_finite() && s > 0.0),
        "duration must be finite and positive"
    );
    if let Some(level) = reference {
        ensure!(level.is_finite(), "reference level must be finite");
    }
    let profile = profile_path
        .map(|path| -> anyhow::Result<InputProfile> { Ok(sonic_rs::from_slice(&fs::read(path)?)?) })
        .transpose()?;
    // Create the destination exclusively, so a measurement never destroys a profile.
    let mut destination = save
        .map(|path| {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
        })
        .transpose()?;
    let input = LiveLoudness::new(channel, profile, settings)?;
    println!(
        "Input: {:?}\n{}",
        input.input,
        if input.calibrated {
            "Calibrated sones; bars show artistic activity."
        } else {
            "Uncalibrated: assumed 2 Pa per PCM unit. Bars show relative activity."
        }
    );
    let start = Instant::now();
    loop {
        thread::sleep(Duration::from_millis(20));
        let frame = input.latest()?;
        if let Some(level) = reference {
            if frame.reference_samples == u64::from(input.input.sample_rate) * 3 {
                let calibration = frame.reference_calibration(input.input.sample_rate, level)?;
                let profile = InputProfile {
                    input: input.input.clone(),
                    pascals_per_unit: calibration.pascals_per_unit(),
                };
                let output = destination.as_mut().unwrap();
                output.write_all(sonic_rs::to_string_pretty(&profile)?.as_bytes())?;
                output.write_all(b"\n")?;
                println!(
                    "Saved calibration: {} Pa per PCM unit",
                    profile.pascals_per_unit
                );
                return Ok(());
            }
        } else {
            let bars = Bands::<DISPLAY_BANDS, 255>(
                frame.display().levels.map(|v| (v * 255.0).round() as u8),
            );
            println!(
                "{:.3} {}sones; clipped {} | {bars}",
                frame.sones,
                if input.calibrated { "" } else { "assumed " },
                frame.clipped
            );
        }
        if seconds.is_some_and(|limit| start.elapsed().as_secs_f64() >= limit) {
            return Ok(());
        }
    }
}
