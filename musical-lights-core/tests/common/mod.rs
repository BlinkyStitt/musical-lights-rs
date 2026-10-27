use musical_lights_core::audio::{
    loudness::{Calibration, LoudnessFrame, LoudnessMeter, SoundField},
    presentation::{LoudnessPresentation, LoudnessSnapshot},
    processor::LoudnessProcessor,
    settings::AudioSettings,
    tempo::TempoEstimate,
    visual::VisualGain,
};
use sha2::{Digest, Sha256};

pub const RATE: usize = 48_000;
pub const CHECKPOINT: usize = RATE / 2;

pub fn music(name: &str) -> Vec<f32> {
    let path = format!(
        "{}/tests/fixtures/tempo/{name}.f32le",
        env!("CARGO_MANIFEST_DIR")
    );
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(bytes.len(), RATE * 32 * 4);
    let expected = match name {
        "carefree" => "2af142bf22facc77f90bd49fd1f6cac498dc54d77fa7d70bc9907fc1eff5cc9e",
        "monkeys" => "e0f12da736f653c0577811a198d9c9921dce4a8f40b0f7b15602a3936fccebbd",
        _ => panic!("unknown frozen fixture"),
    };
    let digest: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(digest, expected, "fixture bytes changed");
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect()
}

#[derive(Debug)]
pub struct Checkpoint {
    pub sample: u64,
    pub elapsed: f64,
    pub tempo: TempoEstimate,
}

pub struct Trace {
    pub checkpoints: Vec<Checkpoint>,
    pub measurements: String,
    pub frames: usize,
}

/// Split real callbacks at exact input-grid checkpoints. Query tempo only after
/// push_pcm returns; no extra samples are added to flush the meter's delay.
pub fn feed(
    processor: &mut LoudnessProcessor,
    pcm: &[f32],
    origin: u64,
    partitions: &[usize],
) -> Trace {
    let mut checkpoints = Vec::new();
    let mut digest = Sha256::new();
    let mut frames = 0;
    let mut offset = 0;
    let mut callback = 0;
    while offset < pcm.len() {
        let end = (offset + partitions[callback % partitions.len()])
            .min((offset / CHECKPOINT + 1) * CHECKPOINT)
            .min(pcm.len());
        processor
            .push_pcm(&pcm[offset..end], origin + offset as u64, false, |frame| {
                hash_measurement(&mut digest, frame.loudness, frame.snapshot);
                frames += 1;
            })
            .unwrap();
        offset = end;
        callback += 1;
        if offset.is_multiple_of(CHECKPOINT) {
            checkpoints.push(Checkpoint {
                sample: origin + offset as u64,
                elapsed: offset as f64 / RATE as f64,
                tempo: processor.tempo(),
            });
        }
    }
    Trace {
        checkpoints,
        measurements: digest
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        frames,
    }
}

pub fn accurate(label: &str, expected: f32, trace: &Trace) {
    let window: Vec<_> = trace
        .checkpoints
        .iter()
        .filter(|c| c.elapsed >= 24.0)
        .collect();
    assert_eq!(window.len(), 17);
    for c in &window {
        eprintln!(
            "{label}: expected={expected}, actual={:.3}, confidence={:.3}, sample={}, elapsed={:.1}s",
            c.tempo.bpm, c.tempo.confidence, c.sample, c.elapsed
        );
    }
    assert!(
        window
            .iter()
            .all(|c| (c.tempo.bpm - expected).abs() <= 5.0 && c.tempo.confidence >= 0.45),
        "{label}: tempo accuracy/confidence failed (see checkpoints)"
    );
}

// The pre-tempo measurement path, also exercised by policy_tests. Running it
// independently avoids platform-specific libm/std last-bit golden values while
// requiring exact equality of every raw bin and both target stages.
pub fn measurement_reference(pcm: &[f32]) -> String {
    let settings = AudioSettings::default();
    let mut meter = LoudnessMeter::new(Calibration::default(), SoundField::Free);
    let mut gain = VisualGain::new(settings);
    let mut presentation = LoudnessPresentation::new(0.0, settings);
    let mut digest = Sha256::new();
    meter
        .push_pcm(pcm, 0, |frame| {
            let levels = gain.map(&frame);
            presentation.push(&frame, levels, gain.factor(), false);
            hash_measurement(&mut digest, &frame, &presentation.snapshot);
        })
        .unwrap();
    digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn hash_measurement(digest: &mut Sha256, loudness: &LoudnessFrame, snapshot: &LoudnessSnapshot) {
    let mut bytes = [0_u8; 8 + 240 * 8 + 48 * 4];
    bytes[..8].copy_from_slice(&loudness.sample_index.to_le_bytes());
    for (bytes, value) in bytes[8..8 + 240 * 8]
        .as_chunks_mut::<8>()
        .0
        .iter_mut()
        .zip(loudness.specific_sones_per_bark)
    {
        bytes.copy_from_slice(&value.to_le_bytes());
    }
    for (bytes, value) in bytes[8 + 240 * 8..]
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(snapshot.targets.into_iter().chain(snapshot.filtered))
    {
        bytes.copy_from_slice(&value.to_le_bytes());
    }
    digest.update(bytes);
}
