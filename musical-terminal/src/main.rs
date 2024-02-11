#![feature(type_alias_impl_trait)]

mod audio;

use audio::MicrophoneStream;
use embassy_executor::Spawner;
use embassy_time::Timer;
use musical_lights_core::{
    audio::{
        AWeighting, AggregatedAmplitudesBuilder, AudioBuffer, BarkScaleAmplitudes,
        BarkScaleBuilder, FFT,
    },
    lights::{DancingLights, Gradient},
    logging::{debug, info},
    windows::HanningWindow,
};
use std::env;

const MIC_SAMPLES: usize = 512;
const FFT_INPUTS: usize = 2048;
const NUM_CHANNELS: usize = 24;

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
async fn audio_task(
    mic_stream: MicrophoneStream,
    mut audio_buffer: AudioBuffer<MIC_SAMPLES, FFT_INPUTS>,
    fft: FFT<FFT_INPUTS, FFT_OUTPUTS>,
    bark_scale_builder: BarkScaleBuilder<FFT_OUTPUTS>,
    tx_loudness: flume::Sender<BarkScaleAmplitudes>,
) {
    while let Ok(samples) = mic_stream.stream.recv_async().await {
        audio_buffer.push_samples(samples);

        let samples = audio_buffer.samples();

        let amplitudes = fft.weighted_amplitudes(samples);

        let loudness = bark_scale_builder.build(amplitudes);

        // TODO: shazam
        // TODO: beat detection
        // TODO: peak detection

        tx_loudness.send_async(loudness).await.unwrap();
    }

    info!("audio task complete");
}

#[embassy_executor::task]
async fn lights_task(rx_loudness: flume::Receiver<BarkScaleAmplitudes>) {
    // TODO: what should these be?
    let gradient = Gradient::new_mermaid();
    let peak_decay = 0.99;

    let mut dancing_lights =
        DancingLights::<8, NUM_CHANNELS, { 8 * NUM_CHANNELS }>::new(gradient, peak_decay);

    // TODO: this channel should be an enum with anything that might modify the lights. or select on multiple channels
    while let Ok(loudness) = rx_loudness.recv_async().await {
        dancing_lights.update(loudness.0);
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

    let mic_stream = audio::MicrophoneStream::try_new().unwrap();

    let audio_buffer = AudioBuffer::<MIC_SAMPLES, FFT_INPUTS>::new();

    let sample_rate = mic_stream.sample_rate.0 as f32;

    let weighting = AWeighting::new(sample_rate);

    let fft = FFT::new_with_window_and_weighting::<HanningWindow<FFT_INPUTS>, _>(weighting);

    // TODO: have multiple scales and compare them
    let bark_scale_builder = BarkScaleBuilder::new(sample_rate);

    spawner.must_spawn(tick_task());
    spawner.must_spawn(audio_task(
        mic_stream,
        audio_buffer,
        fft,
        bark_scale_builder,
        loudness_tx,
    ));
    spawner.must_spawn(lights_task(loudness_rx));

    debug!("all tasks spawned");
}
