//! instead of an FFT, use a bank of 24 filters. I think this will better match human hearing.
#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type, iterator_try_collect)]

use std::env;

use embassy_executor::Spawner;
use musical_lights_core::audio::{AggregatedBins, BarkBank};
use musical_lights_core::fps::FpsTracker;
use musical_lights_core::lights::{Bands, Gradient};
use musical_lights_core::logging::{debug, info};
use musical_lights_core::remap;
use musical_terminal::MicrophoneStream;

/// TODO: import this from the core code
const NUM_BANDS: usize = 20;

const FPS_TARGET: f32 = 55.;

const MIC_SAMPLE_RATE: u32 = 44_100;

const MIC_SAMPLE_SIZE: usize = (MIC_SAMPLE_RATE as f32 / FPS_TARGET) as usize;

const DEBUGGING_Y: usize = 255;

#[embassy_executor::task]
async fn audio_task(
    mic_stream: MicrophoneStream<MIC_SAMPLE_SIZE>,
    mut bank: BarkBank,
    tx_loudness: flume::Sender<AggregatedBins<NUM_BANDS>>,
) {
    while let Ok(samples) = mic_stream.stream.recv_async().await {
        let x = bank.push_samples(&samples.0);
        tx_loudness.send_async(x).await.unwrap();
    }
}

/// TODO: rewrite this whole thing. its just an easy way to get some legible logs for now
#[embassy_executor::task]
async fn lights_task(rx_loudness: flume::Receiver<AggregatedBins<NUM_BANDS>>) {
    let mut bands: Bands<_, { DEBUGGING_Y as u8 }> = Bands([0; NUM_BANDS]);
    let mut fps = FpsTracker::new("lights");

    while let Ok(loudness) = rx_loudness.recv_async().await {
        for (&x, b) in loudness.0.iter().zip(bands.0.iter_mut()) {
            *b = remap(x, 0., 1., 0., DEBUGGING_Y as f32) as u8;
        }

        info!("bands: {bands}");

        fps.tick();
    }
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    unsafe {
        env::set_var(
            "RUST_LOG",
            env::var("RUST_LOG").unwrap_or_else(|_| "debug".to_string()),
        );
    }

    env_logger::builder()
        .format_timestamp_nanos()
        .parse_default_env()
        .init();

    info!("hello, world!");

    let (loudness_tx, loudness_rx) = flume::bounded(2);

    let mic_stream =
        musical_terminal::MicrophoneStream::<MIC_SAMPLE_SIZE>::try_new(MIC_SAMPLE_RATE).unwrap();

    let sample_rate = mic_stream.sample_rate.0 as f32;

    let filter_bank = BarkBank::new(FPS_TARGET, sample_rate);

    let gradient: Gradient<400> = Gradient::new_greg_caitlin_wedding();

    // TODO: how can we print this

    spawner.must_spawn(audio_task(mic_stream, filter_bank, loudness_tx));
    spawner.must_spawn(lights_task(loudness_rx));

    debug!("all tasks spawned");
}
