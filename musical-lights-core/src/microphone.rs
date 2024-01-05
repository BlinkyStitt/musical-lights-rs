//! TODO: bark scale?

// use apodize::hanning_iter;

use crate::hanning::hanning_window;
use crate::logging::{info, trace};
use circular_buffer::CircularBuffer;
use defmt::Format;
use microfft::real::{rfft_2048, rfft_512};

// TODO: why does the linter think this is unused when math functions on f32 are used. something about std being enabled in the linter?
#[allow(unused_imports)]
use micromath::F32Ext;

/// S = number of microphone samples
#[derive(Debug, Format)]
pub struct Samples<const S: usize>(pub [f32; S]);

#[derive(Debug, Format)]
pub struct WindowedSamples<const S: usize>(pub [f32; S]);

/// N = number of amplitudes
/// IF N > S/2, there is an error
/// If N == S/2, there is no aggregation
/// If N < S/2,  there is aggregation
#[derive(Debug, Format)]
pub struct Amplitudes<const N: usize>(pub [f32; N]);

///  bin amounts scale exponentially
#[derive(Debug, Format)]
pub struct AggregatedAmplitudes<const N: usize>(pub [f32; N]);

#[derive(Debug, Format)]
pub struct Decibels<const N: usize>(pub [f32; N]);

#[derive(Debug, Format)]
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

// TODO: i feel like i need a macro or something for this
impl<const B: usize> Amplitudes<B> {
    /// TODO: this does not seem efficient. match and generics feel wrong. but i don't control the types on rfft_*. they require 256, 1024, etc. but we have B and S
    pub fn from_windows_samples<const S: usize>(x: WindowedSamples<S>) -> Self {
        // TODO: compile time assert
        debug_assert_eq!(B * 2, S);

        let mut amplitudes: [f32; B] = [0.0; B];

        // TODO: figure out how to handle the lifetime on the input to keep this DRY
        match S {
            512 => {
                // TODO: this copy_from_slice feels unnecessary. is there some unsafe or something i can do here to force it to work?
                let mut fft_input = [0.0; 512];
                fft_input.copy_from_slice(&x.0);

                let fft_output = rfft_512(&mut fft_input);

                fft_output[0].im = 0.0;

                for (x, &spectrum) in amplitudes.iter_mut().zip(fft_output.iter()) {
                    #[cfg(feature = "std")]
                    {
                        *x = spectrum.norm();
                    }

                    #[cfg(not(feature = "std"))]
                    {
                        *x = (spectrum.re * spectrum.re + spectrum.im * spectrum.im).sqrt();
                    }
                }
            }
            2048 => {
                let mut fft_input = [0.0; 2048];
                fft_input.copy_from_slice(&x.0);

                let fft_output = rfft_2048(&mut fft_input);

                fft_output[0].im = 0.0;

                for (x, &spectrum) in amplitudes.iter_mut().zip(fft_output.iter()) {
                    #[cfg(feature = "std")]
                    {
                        *x = spectrum.norm();
                    }

                    #[cfg(not(feature = "std"))]
                    {
                        *x = (spectrum.re * spectrum.re + spectrum.im * spectrum.im).sqrt();
                    }
                }
            }
            _ => panic!("Unsupported FFT size"),
        };

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
    samples: CircularBuffer<BUF, f32>,
    window_multipliers: [f32; BUF],
    amplitude_aggregation_map: [Option<usize>; BINS],
    equal_loudness_curve: [f32; CHANNELS],
}

impl<const S: usize, const BUF: usize, const BINS: usize, const FREQ: usize>
    AudioProcessing<S, BUF, BINS, FREQ>
{
    pub fn new(sample_rate_hz: u32) -> Self {
        // TODO: compile time assert
        assert_eq!(S, 512);
        assert!(BUF >= S);
        assert_eq!(BINS * 2, BUF);
        assert!(FREQ <= BINS);

        // TODO: allow different windows instead of hanning
        let mut window_multipliers = [1.0; BUF];
        for (i, x) in window_multipliers.iter_mut().enumerate() {
            let multiplier = hanning_window(i, BINS);

            *x = multiplier;
        }

        // TODO: map using the bark scale or something else?
        let mut amplitude_aggregation_map = [Some(0); BINS];
        for (i, x) in amplitude_aggregation_map.iter_mut().enumerate() {
            let f = bin_to_frequency(i, sample_rate_hz, BINS);

            // TODO: i don't think bark is what we want, but lets try it for now
            // TODO: zero everything over 20khz
            // bark is 1-24, but we want 0-23
            let b = bark(f).map(|x| x - 1);

            trace!("{} {} = {:?}", i, f, b);

            *x = b;
        }

        // TODO: actual equal loudness curve
        let equal_loudness_curve = [1.0; FREQ];

        // start with a buffer full of zeroes, NOT an empty buffer
        let samples = CircularBuffer::from([0.0; BUF]);

        Self {
            samples,
            window_multipliers,
            amplitude_aggregation_map,
            equal_loudness_curve,
        }
    }

    pub fn get_buffered_samples(&self) -> Samples<BUF> {
        let mut samples = [0.0; BUF];

        let (a, b) = self.samples.as_slices();

        samples[..a.len()].copy_from_slice(a);
        samples[a.len()..].copy_from_slice(b);

        Samples(samples)
    }

    pub fn process_samples(&mut self, samples: Samples<S>) -> EqualLoudness<FREQ> {
        trace!("new samples: {:?}", samples);

        self.samples.extend_from_slice(&samples.0);

        // TODO: this could probably be more efficient. benchmark

        let buffered_samples = self.get_buffered_samples();

        trace!("buffered {:?}", buffered_samples);

        let windowed_samples =
            WindowedSamples::from_samples(buffered_samples, &self.window_multipliers);

        trace!("{:?}", windowed_samples);

        let amplitudes = Amplitudes::from_windows_samples(windowed_samples);

        trace!("{:?}", amplitudes);

        let aggregated_amplitudes =
            AggregatedAmplitudes::from_amplitudes(amplitudes, &self.amplitude_aggregation_map);

        trace!("{:?}", aggregated_amplitudes);

        // TODO: i'm not sure if we want to convert to decibels. i think tracking a peak amplitude and then scaling logarithmically on that might be better
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

pub fn bark(f: f32) -> Option<usize> {
    // TODO: these formulas don't match the table on the wiki page. i guess a match is fine
    // let x = 13.0 * (0.00076 * f).atan() + 3.5 * ((f / 7500.0) * (f / 7500.0)).atan();

    // Traunmuller, 1990
    // let x = ((26.81 * f) / (1960.0 + f)) - 0.53;

    // Wang, Sekey & Gersho, 1992
    // let x = 6.0 * (f / 600.0).asinh();

    match f {
        f if f < 20.0 => None,
        f if f <= 100.0 => Some(1),
        f if f <= 200.0 => Some(2),
        f if f <= 300.0 => Some(3),
        f if f <= 400.0 => Some(4),
        f if f <= 510.0 => Some(5),
        f if f <= 630.0 => Some(6),
        f if f <= 770.0 => Some(7),
        f if f <= 920.0 => Some(8),
        f if f <= 1080.0 => Some(9),
        f if f <= 1270.0 => Some(10),
        f if f <= 1480.0 => Some(11),
        f if f <= 1720.0 => Some(12),
        f if f <= 2000.0 => Some(13),
        f if f <= 2320.0 => Some(14),
        f if f <= 2700.0 => Some(15),
        f if f <= 3150.0 => Some(16),
        f if f <= 3700.0 => Some(17),
        f if f <= 4400.0 => Some(18),
        f if f <= 5300.0 => Some(19),
        f if f <= 6400.0 => Some(20),
        f if f <= 7700.0 => Some(21),
        f if f <= 9500.0 => Some(22),
        f if f <= 12000.0 => Some(23),
        f if f <= 15500.0 => Some(24),
        _ => None,
    }
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
        assert_eq!(bark(1000.0), Some(9));
        assert_eq!(bark(1080.0), Some(9));
        assert_eq!(bark(1170.0), Some(10));
        assert_eq!(bark(1270.0), Some(10));
        assert_eq!(bark(1370.0), Some(11));
        assert_eq!(bark(1480.0), Some(11));
        assert_eq!(bark(1600.0), Some(12));
        assert_eq!(bark(1720.0), Some(12));
        assert_eq!(bark(1850.0), Some(13));
        assert_eq!(bark(2000.0), Some(13));
        assert_eq!(bark(2150.0), Some(14));
        assert_eq!(bark(2320.0), Some(14));
        assert_eq!(bark(2500.0), Some(15));
        assert_eq!(bark(2700.0), Some(15));
        assert_eq!(bark(2900.0), Some(16));
        assert_eq!(bark(3150.0), Some(16));
        assert_eq!(bark(3400.0), Some(17));
        assert_eq!(bark(3700.0), Some(17));
        assert_eq!(bark(4000.0), Some(18));
        assert_eq!(bark(4400.0), Some(18));
        assert_eq!(bark(4800.0), Some(19));
        assert_eq!(bark(5300.0), Some(19));
        assert_eq!(bark(5800.0), Some(20));
        assert_eq!(bark(6400.0), Some(20));
        assert_eq!(bark(7000.0), Some(21));
        assert_eq!(bark(7700.0), Some(21));
        assert_eq!(bark(8500.0), Some(22));
        assert_eq!(bark(9500.0), Some(22));
        assert_eq!(bark(10500.0), Some(23));
        assert_eq!(bark(12000.0), Some(23));
        assert_eq!(bark(13500.0), Some(24));
        assert_eq!(bark(15500.0), Some(24));
        assert_eq!(bark(16000.0), None); // Beyond the Bark scale
                                         // TODO: i might actually want to go higher than this to get to 18 or 20kHz
        assert_eq!(bark(f32::MAX), None);
    }
}
