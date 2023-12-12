//! TODO: refactor this to use the types in microphone.rs

use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use microfft::real::rfft_512;

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

    let stream = match config.sample_format() {
        // cpal::SampleFormat::I8 => device.build_input_stream(
        //     &config.into(),
        //     move |data, _: &_| write_input_data::<i8>(data, &fft),
        //     err_fn,
        //     None,
        // )?,
        // cpal::SampleFormat::I16 => device.build_input_stream(
        //     &config.into(),
        //     move |data, _: &_| write_input_data::<i16>(data, &fft),
        //     err_fn,
        //     None,
        // )?,
        // cpal::SampleFormat::I32 => device.build_input_stream(
        //     &config.into(),
        //     move |data, _: &_| write_input_data::<i32>(data, &fft),
        //     err_fn,
        //     None,
        // )?,
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            |data, _: &_| write_input_data(data),
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

fn write_input_data(input: &[f32]) {
    println!("heard {} samples", input.len());

    assert_eq!(input.len(), 512);

    let mut input: [f32; 512] = input[..512].try_into().unwrap();

    let spectrum = rfft_512(&mut input);

    // since the real-valued coefficient at the Nyquist frequency is packed into the
    // imaginary part of the DC bin, it must be cleared before computing the amplitudes
    spectrum[0].im = 0.0;

    let amplitudes: Vec<_> = spectrum.iter().map(|c| c.norm() as u32).collect();

    println!("sum amplitudes: {:?}", amplitudes);

    // TODO: what should we do with the amplitudes? send them through a channel?
}
