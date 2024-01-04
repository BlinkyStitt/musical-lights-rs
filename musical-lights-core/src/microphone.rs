//! TODO: bark scale?

use apodize::hanning_iter;
use flume::{Receiver, Sender};
use log::{debug, info, trace};
use microfft::real::rfft_512;

/// S = number of microphone samples
#[derive(Debug)]
pub struct Samples<const S: usize>(pub [f32; S]);

// TODO: add a buffer between Samples and WindowsSamples so that we can do rolling windows. re-use 50% of the samples from the previous window

#[derive(Debug)]
pub struct WindowedSamples<const S: usize>(pub [f32; S]);

/// N = number of amplitudes
/// IF N > S/2, there is an error
/// If N == S/2, there is no aggregation
/// If N < S/2,  there is aggregation
#[derive(Debug)]
pub struct Amplitudes<const N: usize>(pub [f32; N]);

///  bin amounts scale exponentially
#[derive(Debug)]
pub struct AggregatedAmplitudes<const N: usize>(pub [f32; N]);

#[derive(Debug)]
pub struct Decibels<const N: usize>(pub [f32; N]);

#[derive(Debug)]
pub struct EqualLoudness<const N: usize>(pub [f32; N]);

impl<const S: usize> WindowedSamples<S> {
    pub fn from_samples(x: Samples<S>, multipliers: &[f32; S]) -> Self {
        // TODO: actually use the multipliers!
        let mut inner = x.0;

        for (x, multiplier) in inner.iter_mut().zip(multipliers.iter()) {
            *x *= multiplier;
        }

        Self(inner)
    }
}

impl<const B: usize> Amplitudes<B> {
    pub fn from_windows_samples<const S: usize>(x: WindowedSamples<S>) -> Self {
        assert_eq!(S, 512);
        assert_eq!(S, B * 2);

        // TODO: make this work with different values of S. the mac microphone always gives 512 samples so it works for now. buffering will change this
        let mut input: [f32; 512] = x.0[..S].try_into().unwrap();

        let spectrum = rfft_512(&mut input);

        // // TODO: wtf does this cargo-culted comment from the microfft example mean? why does this only happen on the first entry?
        // since the real-valued coefficient at the Nyquist frequency is packed into the
        // imaginary part of the DC bin, it must be cleared before computing the amplitudes
        spectrum[0].im = 0.0;

        // TODO: convert to u32? example code does
        let mut amplitudes: [f32; B] = [0.0; B];

        for (i, &spectrum) in spectrum.iter().enumerate() {
            // TODO: `norm` requires std or libm!
            amplitudes[i] = spectrum.norm();
        }

        Self(amplitudes)
    }
}

impl<const AA: usize> AggregatedAmplitudes<AA> {
    pub fn from_amplitudes<const A: usize>(
        x: Amplitudes<A>,
        amplitude_map: &[Option<usize>; A],
    ) -> Self {
        let mut inner = [0.0; AA];

        for (x, &i) in x.0.iter().zip(amplitude_map.iter()) {
            if let Some(i) = i {
                if i >= AA {
                    // skip very high frequencies
                    // TODO: think about this more. the None check might be enough
                    break;
                }

                inner[i] += x;
            }
        }

        Self(inner)
    }
}

impl<const B: usize> Decibels<B> {
    fn from_floats(mut x: [f32; B]) -> Self {
        for i in x.iter_mut() {
            // TODO: is abs needed? aren't these always positive already?
            *i = 20.0 * i.abs().log10();
        }

        Self(x)
    }

    pub fn from_amplitudes(x: Amplitudes<B>) -> Self {
        Self::from_floats(x.0)
    }

    pub fn from_aggregated_amplitudes(x: AggregatedAmplitudes<B>) -> Self {
        Self::from_floats(x.0)
    }
}

/// TODO: this From won't work because we need some state (the precomputed equal loudness curves)
impl<const B: usize> EqualLoudness<B> {
    pub fn from_decibels(x: Decibels<B>, equal_loudness_curve: [f32; B]) -> Self {
        let mut inner = x.0;

        for (x, multiplier) in inner.iter_mut().zip(equal_loudness_curve.iter()) {
            *x *= multiplier;
        }

        Self(inner)
    }
}

/// TODO: I don't like the names for any of these constants
/// TODO: use BUF
pub struct AudioProcessing<
    const S: usize,
    const BUF: usize,
    const BINS: usize,
    const CHANNELS: usize,
> {
    window_multipliers: [f32; S],
    amplitude_aggregation_map: [Option<usize>; BINS],
    equal_loudness_curve: [f32; CHANNELS],
}

impl<const S: usize, const BUF: usize, const BINS: usize, const FREQ: usize>
    AudioProcessing<S, BUF, BINS, FREQ>
{
    pub fn new(sample_rate_hz: u32) -> Self {
        // TODO: it currently only works with one size S and a matching BUF. support buffering now that i figured out where to put a &mut
        // TODO: compile time assert
        assert_eq!(S, 512);
        assert_eq!(BUF, S);
        assert_eq!(BINS * 2, S);
        assert!(FREQ <= BINS);

        // TODO: allow different windows instead of hanning
        let mut window_multipliers = [1.0; S];
        for (x, multiplier) in window_multipliers.iter_mut().zip(hanning_iter(S)) {
            *x = multiplier as f32;
        }

        // TODO: map using the bark scale or something else?
        let mut amplitude_aggregation_map = [Some(0); BINS];
        for (i, x) in amplitude_aggregation_map.iter_mut().enumerate() {
            let f = bin_to_frequency(i, sample_rate_hz, BINS);

            // TODO: i don't think bark is what we want, but lets try it for now
            // TODO: zero everything over 20khz
            let b = bark(f);

            trace!("{} {} = {:?}", i, f, b);

            *x = b;
        }

        // TODO: actual equal loudness curve
        let equal_loudness_curve = [1.0; FREQ];

        Self {
            window_multipliers,
            amplitude_aggregation_map,
            equal_loudness_curve,
        }
    }

    /// TODO: i think if we put channels here, we are going to have troubles with no_std! think more about this
    pub async fn process_stream(
        &mut self,
        rx_samples: Receiver<[f32; S]>,
        tx_loudness: Sender<EqualLoudness<FREQ>>,
    ) {
        debug!("processing stream");

        while let Ok(samples) = rx_samples.recv_async().await {
            let loudness = self.process_samples(samples);

            tx_loudness.send_async(loudness).await.unwrap();
        }

        info!("done processing stream");
    }

    pub fn process_samples(&mut self, samples: [f32; S]) -> EqualLoudness<FREQ> {
        // TODO: add the samples to a ring buffer

        let samples = Samples(samples);

        trace!("{:?}", samples);

        let windowed_samples = WindowedSamples::from_samples(samples, &self.window_multipliers);

        trace!("{:?}", windowed_samples);

        let amplitudes = Amplitudes::from_windows_samples(windowed_samples);

        trace!("{:?}", amplitudes);

        let aggregated_amplitudes =
            AggregatedAmplitudes::from_amplitudes(amplitudes, &self.amplitude_aggregation_map);

        trace!("{:?}", aggregated_amplitudes);

        let decibels = Decibels::from_aggregated_amplitudes(aggregated_amplitudes);

        trace!("{:?}", decibels);

        let loudness = EqualLoudness::from_decibels(decibels, self.equal_loudness_curve);

        info!("{:?}", loudness);

        loudness
    }
}

pub fn bin_to_frequency(bin_index: usize, sample_rate_hz: u32, bins: usize) -> f32 {
    (bin_index as f32) * (sample_rate_hz as f32) / ((bins * 2) as f32)
}

// TODO: these formulas don't match the table on the wiki page. just do a simple match statement for now? return None for some of the bins, too
pub fn bark(f: f32) -> Option<usize> {
    // let x = 13.0 * (0.00076 * f).atan() + 3.5 * ((f / 7500.0) * (f / 7500.0)).atan();

    // Traunmuller, 1990
    let x = ((26.81 * f) / (1960.0 + f)) - 0.53;

    // Wang, Sekey & Gersho, 1992
    // let x = 6.0 * (f / 600.0).asinh();

    let x = x.round() as usize;

    Some(x)
}

#[cfg(test)]
mod tests {
    use super::bark;

    #[test]
    fn test_bark() {
        assert_eq!(bark(-1.0), None);
        assert_eq!(bark(0.0), None);
        assert_eq!(bark(20.0), Some(1));
        assert_eq!(bark(50.0), Some(1));
        assert_eq!(bark(100.0), Some(1));
        assert_eq!(bark(150.0), Some(2));
        assert_eq!(bark(200.0), Some(2));
        assert_eq!(bark(250.0), Some(3));
        assert_eq!(bark(300.0), Some(3));
        assert_eq!(bark(350.0), Some(4));
        assert_eq!(bark(400.0), Some(4));
        assert_eq!(bark(450.0), Some(5));
        assert_eq!(bark(510.0), Some(5));
        assert_eq!(bark(570.0), Some(6));
        assert_eq!(bark(630.0), Some(6));
        assert_eq!(bark(700.0), Some(7));
        assert_eq!(bark(770.0), Some(7));
        assert_eq!(bark(840.0), Some(8));
        assert_eq!(bark(920.0), Some(8));
        assert_eq!(bark(f32::MAX), None);
    }
}
