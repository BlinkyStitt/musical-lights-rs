#![feature(type_alias_impl_trait)]

mod audio;

use std::env;

use embassy_executor::Spawner;
use embassy_time::Timer;
use musical_lights_core::{
    audio::{AggregatedAmplitudesBuilder, AudioBuffer, BarkScaleAmplitudes, BarkScaleBuilder, FFT},
    lights::DancingLights,
    logging::{debug, error, info},
    windows::HanningWindow,
};

const MIC_SAMPLES: usize = 512;
const NUM_CHANNELS: usize = 24;
const FFT_INPUTS: usize = 2048;

const FFT_OUTPUTS: usize = FFT_INPUTS / 2;

#[embassy_executor::task]
async fn tick_task() {
    loop {
        info!("tick");
        Timer::after_secs(1).await;
    }
}

/// TODO: should this involve a trait? mac needs to spawn a thread, but others have async io
#[embassy_executor::task]
async fn audio_task(tx_loudness: flume::Sender<BarkScaleAmplitudes>) {
    match audio::MicrophoneStream::try_new() {
        Ok(x) => {
            let mut audio_buffer =
                AudioBuffer::<MIC_SAMPLES, FFT_INPUTS>::new::<HanningWindow<FFT_INPUTS>>();

            let fft: FFT<FFT_INPUTS, FFT_OUTPUTS> = FFT::default();

            let bark_scale_builder = BarkScaleBuilder::new(x.sample_rate.0);

            while let Ok(samples) = x.stream.recv_async().await {
                audio_buffer.buffer_samples(samples);

                let samples = audio_buffer.copy_windowed_samples();

                let amplitudes = fft.weighted_amplitudes(samples);

                let loudness = bark_scale_builder.build(amplitudes);

                // TODO: shazam
                // TODO: beat detection
                // TODO: peak detection

                tx_loudness.send_async(loudness).await.unwrap();
            }

            info!("audio task complete");
        }
        Err(err) => {
            error!("audio task failed: {:?}", err);
        }
    }
}

#[embassy_executor::task]
async fn lights_task(rx_loudness: flume::Receiver<BarkScaleAmplitudes>) {
    let mut dancing_lights = DancingLights::<NUM_CHANNELS>::new();

    // TODO: this channel should be an enum with anything that might modify the lights. or select on multiple channels
    while let Ok(loudness) = rx_loudness.recv_async().await {
        dancing_lights.update(loudness);
    }
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    env::set_var(
        "RUST_LOG",
        env::var("RUST_LOG").unwrap_or_else(|_| "debug".to_string()),
    );

    env_logger::builder()
        .format_timestamp_nanos()
        .parse_default_env()
        .init();

    info!("hello, world!");

    let (loudness_tx, loudness_rx) = flume::bounded(2);

    spawner.must_spawn(tick_task());
    spawner.must_spawn(audio_task(loudness_tx));
    spawner.must_spawn(lights_task(loudness_rx));

    debug!("all tasks spawned");
}
