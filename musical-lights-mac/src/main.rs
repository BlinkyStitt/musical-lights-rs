use std::sync::mpsc::Sender;

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Sample,
};

fn main() -> anyhow::Result<()> {
    println!("Hello, world!");

    let host = cpal::default_host();

    // TODO: host.input_devices()?.find(|x| x.name().map(|y| y == opt.device).unwrap_or(false))
    let device = host
        .default_input_device()
        .expect("Failed to get default input device");

    let config = device.default_input_config().unwrap();

    let err_fn = move |err| {
        eprintln!("an error occurred on stream: {}", err);
    };

    let fft = ();

    let stream = match config.sample_format() {
        cpal::SampleFormat::I8 => device.build_input_stream(
            &config.into(),
            move |data, _: &_| write_input_data::<i8>(data, &fft),
            err_fn,
            None,
        )?,
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |data, _: &_| write_input_data::<i16>(data, &fft),
            err_fn,
            None,
        )?,
        cpal::SampleFormat::I32 => device.build_input_stream(
            &config.into(),
            move |data, _: &_| write_input_data::<i32>(data, &fft),
            err_fn,
            None,
        )?,
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data, _: &_| write_input_data::<f32>(data, &fft),
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

    // Let recording go for roughly three seconds.
    std::thread::sleep(std::time::Duration::from_secs(1));
    drop(stream);

    Ok(())
}

fn write_input_data<T>(input: &[T], fft: &())
where
    T: Sample,
{
    println!("heard {} samples", input.len());
}
