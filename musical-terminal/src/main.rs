#![feature(type_alias_impl_trait)]

mod audio;

use std::env;

use embassy_executor::Spawner;
use embassy_sync::{
    blocking_mutex::raw::ThreadModeRawMutex,
    channel::{Channel, Receiver, Sender},
};
use embassy_time::Timer;
use log::*;
use musical_lights_core::{
    lights::DancingLights,
    microphone::{AudioProcessing, EqualLoudness},
};

const MIC_SAMPLES: usize = 512;
const NUM_CHANNELS: usize = 24;

/// TODO: make sure SAMPLE_BUFFER >= MIC_SAMPLES
/// TODO: support SAMPLE_BUFFER > MIC_SAMPLES
const SAMPLE_BUFFER: usize = 2048;
const FFT_BINS: usize = SAMPLE_BUFFER / 2;

#[embassy_executor::task]
async fn tick_task() {
    loop {
        info!("tick");
        Timer::after_secs(1).await;
    }
}

/// TODO: should this involve a trait? mac needs to spawn a thread, but others have async io
#[embassy_executor::task]
async fn audio_task(tx_loudness: flume::Sender<EqualLoudness<NUM_CHANNELS>>) {
    match audio::MicrophoneStream::try_new() {
        Ok(x) => {
            let mut audio_processing =
                AudioProcessing::<MIC_SAMPLES, SAMPLE_BUFFER, FFT_BINS, NUM_CHANNELS>::new(
                    x.sample_rate.0,
                );

            while let Ok(samples) = x.stream.recv_async().await {
                let loudness = audio_processing.process_samples(samples);

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
async fn lights_task(rx_loudness: flume::Receiver<EqualLoudness<NUM_CHANNELS>>) {
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
