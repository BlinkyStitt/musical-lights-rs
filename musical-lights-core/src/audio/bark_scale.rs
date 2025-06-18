use crate::audio::bin_to_frequency;

use super::amplitudes::{AggregatedAmplitudes, AggregatedAmplitudesBuilder, WeightedAmplitudes};

const BARK_SCALE_OUT: usize = 24;

pub struct BarkScaleBuilder<const IN: usize> {
    map: [Option<usize>; IN],
}

/// TODO: should this be a trait instead?
#[derive(Debug)]
#[cfg_attr(feature = "defmt", derive(defmt::Format))]
#[repr(transparent)]
pub struct BarkScaleAmplitudes(pub AggregatedAmplitudes<BARK_SCALE_OUT>);

impl<const BINS: usize> BarkScaleBuilder<BINS> {
    pub fn new(sample_rate_hz: f32) -> Self {
        let mut map = [Some(0); BINS];
        for (i, x) in map.iter_mut().enumerate() {
            let f = bin_to_frequency(i, sample_rate_hz, BINS);

            // bark is 1-24, but we want 0-23
            let b = bark_scale(f).map(|x| x - 1);

            // trace!("{} {} = {:?}", i, f, b);

            *x = b;
        }

        Self { map }
    }
}

impl<const IN: usize> AggregatedAmplitudesBuilder<IN, BARK_SCALE_OUT> for BarkScaleBuilder<IN> {
    type Output = BarkScaleAmplitudes;

    fn build(&self, x: WeightedAmplitudes<IN>) -> Self::Output {
        let x = AggregatedAmplitudes::<BARK_SCALE_OUT>::aggregate::<IN>(&self.map, x);

        BarkScaleAmplitudes(x)
    }

    fn build_into(&self, input: &[f32; IN], output: &mut [f32; BARK_SCALE_OUT]) {
        todo!();
    }
}

/// turn a frequency into a bark value
pub fn bark_scale(f: f32) -> Option<usize> {
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
    use super::bark_scale;

    #[test]
    fn test_bark_scale() {
        assert_eq!(bark_scale(-1.0), None);
        assert_eq!(bark_scale(0.0), None);
        assert_eq!(bark_scale(20.0), Some(1));
        assert_eq!(bark_scale(50.0), Some(1));
        assert_eq!(bark_scale(100.0), Some(1));
        assert_eq!(bark_scale(150.0), Some(2));
        assert_eq!(bark_scale(200.0), Some(2));
        assert_eq!(bark_scale(250.0), Some(3));
        assert_eq!(bark_scale(300.0), Some(3));
        assert_eq!(bark_scale(350.0), Some(4));
        assert_eq!(bark_scale(400.0), Some(4));
        assert_eq!(bark_scale(450.0), Some(5));
        assert_eq!(bark_scale(510.0), Some(5));
        assert_eq!(bark_scale(570.0), Some(6));
        assert_eq!(bark_scale(630.0), Some(6));
        assert_eq!(bark_scale(700.0), Some(7));
        assert_eq!(bark_scale(770.0), Some(7));
        assert_eq!(bark_scale(840.0), Some(8));
        assert_eq!(bark_scale(920.0), Some(8));
        assert_eq!(bark_scale(1000.0), Some(9));
        assert_eq!(bark_scale(1080.0), Some(9));
        assert_eq!(bark_scale(1170.0), Some(10));
        assert_eq!(bark_scale(1270.0), Some(10));
        assert_eq!(bark_scale(1370.0), Some(11));
        assert_eq!(bark_scale(1480.0), Some(11));
        assert_eq!(bark_scale(1600.0), Some(12));
        assert_eq!(bark_scale(1720.0), Some(12));
        assert_eq!(bark_scale(1850.0), Some(13));
        assert_eq!(bark_scale(2000.0), Some(13));
        assert_eq!(bark_scale(2150.0), Some(14));
        assert_eq!(bark_scale(2320.0), Some(14));
        assert_eq!(bark_scale(2500.0), Some(15));
        assert_eq!(bark_scale(2700.0), Some(15));
        assert_eq!(bark_scale(2900.0), Some(16));
        assert_eq!(bark_scale(3150.0), Some(16));
        assert_eq!(bark_scale(3400.0), Some(17));
        assert_eq!(bark_scale(3700.0), Some(17));
        assert_eq!(bark_scale(4000.0), Some(18));
        assert_eq!(bark_scale(4400.0), Some(18));
        assert_eq!(bark_scale(4800.0), Some(19));
        assert_eq!(bark_scale(5300.0), Some(19));
        assert_eq!(bark_scale(5800.0), Some(20));
        assert_eq!(bark_scale(6400.0), Some(20));
        assert_eq!(bark_scale(7000.0), Some(21));
        assert_eq!(bark_scale(7700.0), Some(21));
        assert_eq!(bark_scale(8500.0), Some(22));
        assert_eq!(bark_scale(9500.0), Some(22));
        assert_eq!(bark_scale(10500.0), Some(23));
        assert_eq!(bark_scale(12000.0), Some(23));
        assert_eq!(bark_scale(13500.0), Some(24));
        assert_eq!(bark_scale(15500.0), Some(24));
        assert_eq!(bark_scale(16000.0), None); // Beyond the Bark scale
        // TODO: i might actually want to go higher than this to get to 18 or 20kHz
        assert_eq!(bark_scale(f32::MAX), None);
    }
}
