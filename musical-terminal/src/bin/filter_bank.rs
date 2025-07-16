//! instead of an FFT, use a bank of 24 filters. I think this will better match human hearing.
#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]

use std::env;

use embassy_executor::Spawner;
use musical_lights_core::audio::{AggregatedBins, BarkBank, ema_in_place, loudness_in_place};
use musical_lights_core::lights::{DancingLights, Gradient};
use musical_lights_core::logging::{debug, info};
use musical_terminal::MicrophoneStream;
use static_cell::ConstStaticCell;

/* frame & smoothing constants scoped to this task */
const SR_HZ: u32 = 48_000;
const BLOCK: usize = 480;
const I16_SCALE: f32 = 1.0 / 32_768.0;
const TAU_S: f32 = 0.030;

const NUM_BANDS: usize = 24;

#[embassy_executor::task]
async fn audio_task(
    mic_stream: MicrophoneStream,
    mut bank: BarkBank,
    tx_loudness: flume::Sender<AggregatedBins<24>>,
) {
    // TODO: EMA should be a part of the bank. we always want both together
    static EMA: ConstStaticCell<[f32; NUM_BANDS]> = ConstStaticCell::new([0.0; NUM_BANDS]); // state/out
    let ema = EMA.take();

    let ema_alpha: f32 = (-((BLOCK as f32) / (SR_HZ as f32) / TAU_S)).exp(); // ≈ 0.7165

    while let Ok(samples) = mic_stream.stream.recv_async().await {
        let mut buf = [0.0; NUM_BANDS];

        // TODO: I16_SCALE should be saved on the bank
        bank.power_block_into(&samples.0, &mut buf, I16_SCALE);

        // TODO: should all these calls be on the bank? then we just get back a buf and don't have to think about the middle steps?
        loudness_in_place(&mut buf);
        ema_in_place(&mut buf, ema, ema_alpha); // ema = smoothed loudness. it is copied into the buf, too

        tx_loudness.send_async(AggregatedBins(buf)).await.unwrap();
    }
}

/// TODO: rewrite this whole thing. its just an easy way to get some legible logs for now
#[embassy_executor::task]
async fn lights_task(rx_loudness: flume::Receiver<AggregatedBins<NUM_BANDS>>) {
    // TODO: what should these be?
    // let gradient = Gradient::new_mermaid();
    // TODO: set decay based on time?
    // TODO: its already got an EMA so I don't think decay here is what we want
    // let peak_decay = 0.5;

    // let mut dancing_lights =
    //     DancingLights::<8, NUM_BANDS, { 8 * NUM_BANDS }>::new(gradient, peak_decay);

    // TODO: this is in the idf code. need to more to core
    // let mut mic_loudness = MicLoudnessPattern::new();

    // TODO: this channel should be an enum with anything that might modify the lights. or select on multiple bands
    while let Ok(loudness) = rx_loudness.recv_async().await {
        debug!("loudness: {loudness:?}");
        // dancing_lights.update(loudness);
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
