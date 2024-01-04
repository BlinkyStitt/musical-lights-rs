#![feature(type_alias_impl_trait)]

mod audio;

use std::env;

use embassy_executor::Spawner;
use embassy_time::Timer;
use flume::{Receiver, Sender};
use log::*;
use musical_lights_core::{
    lights::DancingLights,
    microphone::{AudioProcessing, EqualLoudness},
};

const MIC_SAMPLES: usize = 512;
const NUM_CHANNELS: usize = 24;

/// TODO: make sure SAMPLE_BUFFER >= MIC_SAMPLES
/// TODO: support SAMPLE_BUFFER > MIC_SAMPLES
const SAMPLE_BUFFER: usize = 512;
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
async fn audio_task(tx_loudness: Sender<EqualLoudness<NUM_CHANNELS>>) {
    match audio::MicrophoneStream::<MIC_SAMPLES>::try_new() {
        Ok(x) => {
            let mut audio_processing =
                AudioProcessing::<MIC_SAMPLES, SAMPLE_BUFFER, FFT_BINS, NUM_CHANNELS>::new(
                    x.sample_rate.0,
                );

            audio_processing.process_stream(x.stream, tx_loudness).await;

            info!("audio task complete");
        }
        Err(err) => {
            error!("audio task failed: {:?}", err);
        }
    }
}

#[embassy_executor::task]
async fn lights_task(rx_loudness: Receiver<EqualLoudness<NUM_CHANNELS>>) {
    let mut dancing_lights = DancingLights::<NUM_CHANNELS>::new();

    // // read loudness from the microphone on another task. this task will close when the microphone is done recording.
    while let Ok(loudness) = rx_loudness.recv_async().await {
        dancing_lights.update(loudness);
    }

    info!("lights task ended");
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

    // channel to send loudness levels from the microphone processor to the light processor
    // TODO: what size? I think we want to drop old values, so maybe this should be a watch?
    let (tx_loudness, rx_loudness) = flume::bounded(2);

    spawner.must_spawn(tick_task());
    spawner.must_spawn(audio_task(tx_loudness));
    spawner.must_spawn(lights_task(rx_loudness));

    debug!("all tasks spawned");
}
