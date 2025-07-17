//! instead of an FFT, use a bank of 24 filters. I think this will better match human hearing.
#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type, iterator_try_collect)]

use std::env;

use embassy_executor::Spawner;
use musical_lights_core::audio::{AggregatedBins, BarkBank};
use musical_lights_core::fps::FpsTracker;
use musical_lights_core::lights::{Bands, DancingLights, Gradient};
use musical_lights_core::logging::{debug, info, trace};
use musical_terminal::MicrophoneStream;

const NUM_BANDS: usize = 24;

#[embassy_executor::task]
async fn audio_task(
    mic_stream: MicrophoneStream<480>,
    mut bank: BarkBank,
    tx_loudness: flume::Sender<AggregatedBins<NUM_BANDS>>,
) {
    while let Ok(samples) = mic_stream.stream.recv_async().await {
        let x = bank.process_block(&samples.0);

        let mut buf = AggregatedBins([0.0; NUM_BANDS]);
        buf.0.copy_from_slice(x);

        tx_loudness.send_async(buf).await.unwrap();
    }
}

/// TODO: rewrite this whole thing. its just an easy way to get some legible logs for now
#[embassy_executor::task]
async fn lights_task(rx_loudness: flume::Receiver<AggregatedBins<NUM_BANDS>>) {
    let mut bands = Bands([0; NUM_BANDS]);
    let mut fps = FpsTracker::new("lights");

    while let Ok(loudness) = rx_loudness.recv_async().await {
        for (&x, b) in loudness.0.iter().zip(bands.0.iter_mut()) {
            *b = (x * 9.) as u8;
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

    let mic_stream = musical_terminal::MicrophoneStream::try_new().unwrap();

    let sample_rate = mic_stream.sample_rate.0 as f32;

    let filter_bank = BarkBank::new(sample_rate);

    spawner.must_spawn(audio_task(mic_stream, filter_bank, loudness_tx));
    spawner.must_spawn(lights_task(loudness_rx));

    debug!("all tasks spawned");
}
