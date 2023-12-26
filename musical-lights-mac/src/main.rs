//! TODO: refactor this to use the types in microphone.rs

use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use musical_lights_core::microphone::AudioProcessing;

fn record_microphone(x: Duration) -> anyhow::Result<()> {
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

    let audio_processing = AudioProcessing::<512, 256, 768>::new();

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
            move |data, _: &_| write_input_data(data, &audio_processing),
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

    Ok(())
}

fn main() -> anyhow::Result<()> {
    println!("Hello, world!");

    // TODO: multiple threads
    record_microphone(Duration::from_secs(10))?;

    Ok(())
}

fn write_input_data<const S: usize, const BINS: usize, const BUF: usize>(
    samples: &[f32],
    audio_processing: &AudioProcessing<S, BINS, BUF>,
) {
    println!("heard {} samples", samples.len());

    assert_eq!(samples.len(), S);

    let samples: [f32; S] = samples[..S].try_into().unwrap();

    // TODO: only write half the samples? then sleep for a short time based on num samples and sample rate? then write the second half?
    let loudness = audio_processing.process_samples(samples);

    // // TODO: pretty graph instead of a big list of numbers
    // let positive_amplitudes = amplitudes
    //     .0
    //     .into_iter()
    //     .map(|x| if x < 0.0 { 0.0 } else { x })
    //     .collect::<Vec<_>>();
    //
    // let sum_amplitudes = amplitudes.0.iter().sum::<f32>();
    //
    // if sum_amplitudes > 0.0 {
    //     println!("amplitudes = {}: {:?}", sum_amplitudes, positive_amplitudes);
    // }

    println!("loudness = {:?}", loudness.0);

    // TODO: what should we do with the amplitudes? send them through a channel?
    // TODO: actually, i think we should just send the samples to a channel
}
