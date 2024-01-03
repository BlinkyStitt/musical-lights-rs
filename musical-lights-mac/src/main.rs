//! TODO: refactor this to use the types in microphone.rs

use std::{sync::mpsc::Sender, thread, time::Duration};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use musical_lights_core::{
    lights::DancingLights,
    microphone::{AudioProcessing, EqualLoudness},
};

fn record_microphone<const N: usize>(
    x: Duration,
    tx: Sender<EqualLoudness<N>>,
) -> anyhow::Result<()> {
    let host = cpal::default_host();

    // TODO: host.input_devices()?.find(|x| x.name().map(|y| y == opt.device).unwrap_or(false))
    let device = host
        .default_input_device()
        .expect("Failed to get default input device");

    let config = device.default_input_config().unwrap();

    let err_fn = move |err| {
        eprintln!("an error occurred on stream: {}", err);
    };

    // samples per second
    let sample_rate = config.sample_rate();
    println!("sample rate = {}", sample_rate.0);

    let buffer_size = config.buffer_size();
    println!("buffer size = {:?}", buffer_size);

    let audio_processing = AudioProcessing::<512, 768, 256, N>::new(sample_rate.0);

    let stream = match config.sample_format() {
        // cpal::SampleFormat::I8 => device.build_input_stream(
        //     &config.into(),
        //     move |data, _: &_| write_input_data::<i8>(data, &audio_processing),
        //     err_fn,
        //     None,
        // )?,
        // cpal::SampleFormat::I16 => device.build_input_stream(
        //     &config.into(),
        //     move |data, _: &_| write_input_data::<i16>(data, &audio_processing),
        //     err_fn,
        //     None,
        // )?,
        // cpal::SampleFormat::I32 => device.build_input_stream(
        //     &config.into(),
        //     move |data, _: &_| write_input_data::<i32>(data, &audio_processing),
        //     err_fn,
        //     None,
        // )?,
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data, _: &_| process_mic_data(data, &audio_processing, tx.clone()),
            err_fn,
            None,
        )?,
        sample_format => {
            return Err(anyhow::anyhow!(
                "Unsupported sample format '{sample_format}'"
            ))
        }
    };

    stream.play()?;

    // record for x seconds
    std::thread::sleep(x);

    drop(stream);

    // TODO: anything else here? if not, we can skip the explicit drop

    Ok(())
}

const N: usize = 24;

fn main() -> anyhow::Result<()> {
    println!("Hello, world!");

    // channel to send loudness levels from the microphone processor to the light processor
    let (tx_loudness, rx_loudness) = std::sync::mpsc::channel::<EqualLoudness<N>>();

    let mut dancing_lights = DancingLights::<N>::new();

    // read loudness from the microphone on another thread. this thread will close when the microphone is done recording.
    let handle = thread::spawn(move || {
        while let Ok(loudness) = rx_loudness.recv() {
            println!("loudness = {:?}", loudness.0);
            dancing_lights.update(loudness);
        }
    });

    // use the main thread to listen to the microphone
    record_microphone(Duration::from_secs(10), tx_loudness)?;

    handle.join().unwrap();

    Ok(())
}

fn process_mic_data<const S: usize, const BINS: usize, const BUF: usize, const FREQ: usize>(
    samples: &[f32],
    audio_processing: &AudioProcessing<S, BINS, BUF, FREQ>,
    tx: Sender<EqualLoudness<FREQ>>,
) {
    println!("heard {} samples", samples.len());

    assert_eq!(samples.len(), S);

    let samples: [f32; S] = samples[..S].try_into().unwrap();

    // TODO: only write half the samples? then sleep for a short time based on num samples and sample rate? then write the second half?
    let loudness = audio_processing.process_samples(samples);

    tx.send(loudness).unwrap();
}
