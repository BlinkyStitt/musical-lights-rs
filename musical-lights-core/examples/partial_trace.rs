//! Binary offline interface for the source-band model. See validation/partial.
use musical_lights_core::audio::{
    loudness::Calibration,
    partial::{BINS, PartialLoudnessMeter, PartialSpectrum},
};
use std::io::{self, BufWriter, Read, Write};
fn main() -> io::Result<()> {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "pcm".into());
    let mut data = Vec::new();
    io::stdin().read_to_end(&mut data)?;
    let mut output = BufWriter::new(io::stdout().lock());
    if mode == "spectrum" {
        let mut model = PartialSpectrum::default();
        for (i, row) in data.as_chunks::<{ BINS * 8 }>().0.iter().enumerate() {
            let powers = core::array::from_fn(|j| {
                f64::from_le_bytes(row[j * 8..j * 8 + 8].try_into().unwrap())
            });
            let frame = model.process(&powers, (i * 96 + 96) as u64);
            for value in model
                .weighted
                .iter()
                .chain(model.excitation.iter().flatten())
                .chain(model.specific.iter().flatten())
                .chain(frame.instantaneous_sones.iter())
                .chain(frame.short_term_sones.iter())
            {
                output.write_all(&value.to_le_bytes())?;
            }
        }
    } else {
        let pcm: Vec<f32> = data
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
            .collect();
        let chunk = std::env::args()
            .nth(2)
            .map_or(128, |s| s.parse::<usize>().unwrap());
        let mut meter = PartialLoudnessMeter::new(Calibration::default());
        for (i, block) in pcm.chunks(chunk).enumerate() {
            meter
                .push_pcm(block, (i * chunk) as u64, |frame| {
                    for value in core::iter::once(frame.sample_index as f64)
                        .chain(frame.instantaneous_sones)
                        .chain(frame.short_term_sones)
                    {
                        output.write_all(&value.to_le_bytes()).unwrap();
                    }
                })
                .unwrap();
        }
    }
    output.flush()
}
