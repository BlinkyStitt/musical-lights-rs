//! Based on the visualizer, but with some artistic choices to make the lights look they are dancing.
use smart_leds::{SmartLedsWrite, RGB8};
use smart_leds_matrix::layout::invert_axis::{InvertX, InvertXY, InvertY};
use smart_leds_matrix::{layout::invert_axis::NoInvert, SmartLedMatrix};

use crate::audio::BarkScaleAmplitudes;
use crate::logging::info;
use smart_leds_matrix::layout::Rectangular;

/// TODO: i think this should be a trait. the mac impl needs to draw a window, the hats need to control leds, etc.
pub struct DancingLights<const X: u32, const Y: u32, const N: usize, WRITER: SmartLedsWrite, INVERT>
{
    pub matrix: SmartLedMatrix<WRITER, Rectangular<INVERT>, N>,
}

macro_rules! impl_dancing_lights {
    ($invert_type:ty, $layout:expr) => {
        impl<const X: u32, const Y: u32, const N: usize, WRITER: SmartLedsWrite>
            DancingLights<X, Y, N, WRITER, $invert_type>
        {
            pub async fn new(writer: WRITER, default_brightness: u8) -> Self
            where
                WRITER::Color: From<RGB8>,
            {
                // // Compile-time dimensions check using static_assertions
                // static_assertions::assert_eq!(X as usize * Y as usize, N);

                let layout = $layout;

                let matrix = SmartLedMatrix::new(writer, layout);

                let mut x = Self { matrix };

                x.start(default_brightness).await;

                x
            }
        }
    };
}

impl_dancing_lights!(NoInvert, Rectangular::new(X, Y));
impl_dancing_lights!(InvertX, Rectangular::new_invert_x(X, Y));
impl_dancing_lights!(InvertY, Rectangular::new_invert_y(X, Y));
impl_dancing_lights!(InvertXY, Rectangular::new_invert_xy(X, Y));

/// TODO: macro for all the different inverts
impl<const X: u32, const Y: u32, const N: usize, WRITER: SmartLedsWrite, INVERT>
    DancingLights<X, Y, N, WRITER, INVERT>
{
    pub async fn start(&mut self, brightness: u8) {
        self.matrix.set_brightness(brightness);

        // clear the led matrix
        // TODO: where is the "clear" method? it's in the examples, but not here.
        // self.matrix.clear(Rgb888::new(0, 0, 0));

        // TODO: 1 red, 2 green, 3 blue, 4 white

        // TODO: sleep

        // TODO: clear the leds
    }
}

/// the jacket. 2 8x32 panels running the same pattern
/// TODO: how do we specify the layout? do we want them to be inverses of eachother?
impl<WRITER: SmartLedsWrite, INVERT> DancingLights<32, 8, 256, WRITER, INVERT> {
    pub fn update(&mut self, loudness: BarkScaleAmplitudes) {
        info!("{:?}", loudness);
    }
}
