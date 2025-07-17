#![feature(type_alias_impl_trait)]
#![feature(impl_trait_in_assoc_type)]

use embassy_executor::Spawner;
use musical_lights_core::{
    audio::{AWeighting, AggregatedBins, AggregatedBinsBuilder, BarkScaleBuilder, BufferedFFT},
    lights::{DancingLights, Gradient},
    logging::{debug, info},
    windows::HanningWindow,
};
use musical_terminal::MicrophoneStream;
use std::env;

const MIC_SAMPLES: usize = 512;

/// TODO: 2048 or 4096? we need a macro for multiple sizes
const FFT_INPUTS: usize = 4096;

/// equal temperment == 120?
const NUM_BANDS: usize = 24;
// const NUM_BANDS: usize = 10;

const FFT_OUTPUTS: usize = FFT_INPUTS / 2;

type MyBufferedFFT = BufferedFFT<
    MIC_SAMPLES,
    FFT_INPUTS,
    FFT_OUTPUTS,
    HanningWindow<FFT_INPUTS>,
    AWeighting<FFT_OUTPUTS>,
    // FlatWeighting<FFT_OUTPUTS>,
>;
// type ScaleBuilder = ExponentialScaleBuilder<FFT_OUTPUTS, NUM_BANDS>;
type ScaleBuilder = BarkScaleBuilder<FFT_OUTPUTS>;

/// TODO: should this involve a trait? mac needs to spawn a thread, but others have async io
/// TODO: use BufferedFFT instead of three seperate types.
#[embassy_executor::task]
async fn audio_task(
    mic_stream: MicrophoneStream<512>,
    mut fft: MyBufferedFFT,
    scale_builder: ScaleBuilder,
    tx_loudness: flume::Sender<AggregatedBins<NUM_BANDS>>,
) {
    while let Ok(samples) = mic_stream.stream.recv_async().await {
        fft.push_samples(&samples);

        let fft_outputs = fft.fft();

        let loudness = scale_builder.loudness(&fft_outputs);

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
    // TODO: set decay based on time?
    let peak_decay = 0.5;

    let mut dancing_lights =
        DancingLights::<8, NUM_BANDS, { 8 * NUM_BANDS }>::new(gradient, peak_decay);

    // TODO: this is in the idf code. need to more to core
    // let mut mic_loudness = MicLoudnessPattern::new();

    // TODO: this channel should be an enum with anything that might modify the lights. or select on multiple bands
    while let Ok(loudness) = rx_loudness.recv_async().await {
        // debug!("loudness: {loudness:?}");
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

    let mic_stream = musical_terminal::MicrophoneStream::try_new().unwrap();

    let sample_rate = mic_stream.sample_rate.0 as f32;

    let weighting = AWeighting::new(sample_rate);
    // let weighting = FlatWeighting {};

    // TODO: rewrite this to use the BufferedFFT
    let fft = MyBufferedFFT::new(weighting);

    // TODO: have multiple scales and compare them. is "scale" the right term?
    // let bark_scale_builder = BarkScaleBuilder::new(sample_rate);
    // TODO: I'm never seeing anything in bin 0. that means its working right?
    // TODO: i'm also never seeing anything in bucket 0. that doesn't seem right. need to think more about bass
    // let scale_builder = ExponentialScaleBuilder::new(80.0, 20_000.0, sample_rate);
    let scale_builder = BarkScaleBuilder::new(sample_rate);

    spawner.must_spawn(audio_task(mic_stream, fft, scale_builder, loudness_tx));
    spawner.must_spawn(lights_task(loudness_rx));

    debug!("all tasks spawned");
}
