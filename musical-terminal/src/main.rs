#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]

mod audio;

use audio::MicrophoneStream;
use embassy_executor::Spawner;
use musical_lights_core::{
    audio::{
        AWeighting, AggregatedBins, AggregatedBinsBuilder, AudioBuffer, BufferedFFT,
        ExponentialScaleBuilder, FFT, FlatWeighting,
    },
    lights::{DancingLights, Gradient},
    logging::{debug, info},
    windows::HanningWindow,
};
use std::env;

const MIC_SAMPLES: usize = 512;

/// TODO: 2048 or 4096? we need a macro for multiple sizes
const FFT_INPUTS: usize = 4096;

/// equal temperment == 120?
const NUM_BANDS: usize = 20;

const FFT_OUTPUTS: usize = FFT_INPUTS / 2;

type MyBufferedFFT = BufferedFFT<MIC_SAMPLES, FFT_INPUTS, FFT_OUTPUTS, HanningWindow<FFT_INPUTS>>;
type ScaleBuilder = ExponentialScaleBuilder<FFT_OUTPUTS, NUM_BANDS>;

/// TODO: should this involve a trait? mac needs to spawn a thread, but others have async io
/// TODO: use BufferedFFT instead of three seperate types.
#[embassy_executor::task]
async fn audio_task(
    mic_stream: MicrophoneStream,
    mut fft: MyBufferedFFT,
    scale_builder: ScaleBuilder,
    tx_loudness: flume::Sender<AggregatedBins<NUM_BANDS>>,
) {
    while let Ok(samples) = mic_stream.stream.recv_async().await {
        fft.push_samples(&samples);

        let fft_outputs = fft.fft();

        let x = fft_outputs.iter_mean_square_power_density();

        let loudness = scale_builder.sum_spectrum(fft_outputs.iter_mean_square_power_density());

        // TODO: decibels here?

        // TODO: shazam
        // TODO: beat detection
        // TODO: peak detection

        tx_loudness.send_async(loudness.0).await.unwrap();
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
    // let weighting = AWeighting::new(sample_rate);
    let weighting: FlatWeighting<4096> = FlatWeighting {};

    // TODO: rewrite this to use the BufferedFFT
    let fft = BufferedFFT::<_, _, _, HanningWindow<_>>::new();

    // TODO: have multiple scales and compare them. is "scale" the right term?
    // let bark_scale_builder = BarkScaleBuilder::new(sample_rate);
    // TODO: I'm never seeing anything in bin 0. that means its working right?
    // TODO: i'm also never seeing anything in bucket 0. that doesn't seem right. need to think more about bass
    let scale_builder = ExponentialScaleBuilder::new(20.0, 20_000.0, sample_rate);

    spawner.must_spawn(audio_task(mic_stream, fft, scale_builder, loudness_tx));
    spawner.must_spawn(lights_task(loudness_rx));

    debug!("all tasks spawned");
}
