#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]

mod audio;

use audio::MicrophoneStream;
use embassy_executor::Spawner;
use musical_lights_core::{
    audio::{
        AWeighting, AggregatedBins, AggregatedBinsBuilder, AudioBuffer, ExponentialScaleBuilder,
        FFT,
    },
    lights::{DancingLights, Gradient},
    logging::{debug, info},
    windows::HanningWindow,
};
use std::env;

const MIC_SAMPLES: usize = 512;
const FFT_INPUTS: usize = 2048;

/// equal temperment == 120?
const NUM_BANDS: usize = 8;

const FFT_OUTPUTS: usize = FFT_INPUTS / 2;

/// TODO: should this involve a trait? mac needs to spawn a thread, but others have async io
#[embassy_executor::task]
async fn audio_task(
    mic_stream: MicrophoneStream,
    mut audio_buffer: AudioBuffer<MIC_SAMPLES, FFT_INPUTS>,
    fft: FFT<FFT_INPUTS, FFT_OUTPUTS>,
    scale_builder: ExponentialScaleBuilder<FFT_OUTPUTS, NUM_BANDS>,
    tx_loudness: flume::Sender<AggregatedBins<NUM_BANDS>>,
) {
    while let Ok(samples) = mic_stream.stream.recv_async().await {
        audio_buffer.push_samples(&samples);

        let samples = audio_buffer.samples();

        let amplitudes = fft.weighted_amplitudes(samples);

        let mut loudness = AggregatedBins([0.0; NUM_BANDS]);
        scale_builder.sum_into(&amplitudes.0, &mut loudness.0);

        // TODO: decibels here?

        // TODO: shazam
        // TODO: beat detection
        // TODO: peak detection

        tx_loudness.send_async(loudness).await.unwrap();
    }

    info!("audio task complete");
}

#[embassy_executor::task]
async fn lights_task(rx_loudness: flume::Receiver<AggregatedBins<NUM_BANDS>>) {
    // TODO: what should these be?
    let gradient = Gradient::new_mermaid();
    let peak_decay = 0.99;

    let mut dancing_lights =
        DancingLights::<8, NUM_BANDS, { 8 * NUM_BANDS }>::new(gradient, peak_decay);

    // TODO: this channel should be an enum with anything that might modify the lights. or select on multiple bands
    while let Ok(loudness) = rx_loudness.recv_async().await {
        dancing_lights.update(loudness);
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

    let mic_stream = audio::MicrophoneStream::try_new().unwrap();

    let mut audio_buffer = AudioBuffer::<MIC_SAMPLES, FFT_INPUTS>::new();
    audio_buffer.init();

    let sample_rate = mic_stream.sample_rate.0 as f32;

    // TODO: a-weighting probably isn't what we want. also, our microphone frequency response is definitely not flat
    let weighting = AWeighting::new(sample_rate);

    // TODO: rewrite this to use the BufferedFFT
    let fft = FFT::new_with_window_and_weighting::<HanningWindow<FFT_INPUTS>, _>(weighting);

    // TODO: have multiple scales and compare them. is "scale" the right term?
    // let bark_scale_builder = BarkScaleBuilder::new(sample_rate);
    // TODO: I'm never seeing anything in bin 0. that means its working right?
    // TODO: i'm also never seeing anything in bucket 0. that doesn't seem right. need to think more about bass
    let scale_builder = ExponentialScaleBuilder::new(0.0, 20_000.0, sample_rate);

    spawner.must_spawn(audio_task(
        mic_stream,
        audio_buffer,
        fft,
        scale_builder,
        loudness_tx,
    ));
    spawner.must_spawn(lights_task(loudness_rx));

    debug!("all tasks spawned");
}
