//! Export every model frame for independent numerical validation.
use musical_lights_core::audio::loudness::{Calibration, LoudnessMeter, SoundField};
use std::{
    env, fs,
    io::{BufWriter, Write},
    time::Instant,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().collect();
    if args.len() != 6 {
        return Err(
            "usage: loudness_trace PCM.f32 FRAMES.bin BLOCK_SIZE PA_PER_UNIT free|diffuse".into(),
        );
    }
    let bytes = fs::read(&args[1])?;
    if bytes.len() % 4 != 0 {
        return Err("PCM file must contain complete little-endian f32 samples".into());
    }
    let samples: Vec<_> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|x| f32::from_le_bytes(*x))
        .collect();
    let chunk: usize = args[3].parse()?;
    if chunk == 0 {
        return Err("block size must be positive".into());
    }
    let field = match args[5].as_str() {
        "free" => SoundField::Free,
        "diffuse" => SoundField::Diffuse,
        _ => return Err("unknown sound field".into()),
    };
    let mut meter = LoudnessMeter::new(Calibration::measured(args[4].parse()?)?, field);
    let mut output = BufWriter::new(fs::File::create(&args[2])?);
    let mut write_error = None;
    let mut count = 0;
    let mut emit = |frame: musical_lights_core::audio::loudness::LoudnessFrame| {
        let result = (|| -> std::io::Result<()> {
            output.write_all(&frame.sample_index.to_le_bytes())?;
            output.write_all(&frame.sones.to_le_bytes())?;
            for value in frame.specific_sones_per_bark {
                output.write_all(&value.to_le_bytes())?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            write_error = Some(error);
        }
        count += 1;
    };
    let started = Instant::now();
    let mut offset = 0;
    for block in samples.chunks(chunk) {
        meter.push_pcm(block, offset, &mut emit)?;
        offset += block.len() as u64;
    }
    meter.finish(&mut emit)?;
    if let Some(error) = write_error {
        return Err(error.into());
    }
    output.flush()?;
    eprintln!(
        "{count} frames; {:.3}s including trace export; {} bytes model state",
        started.elapsed().as_secs_f64(),
        size_of::<LoudnessMeter>()
    );
    Ok(())
}
