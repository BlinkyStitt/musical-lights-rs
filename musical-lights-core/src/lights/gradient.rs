use enterpolation::{
    Curve, Equidistant, Merge,
    bspline::{BSpline, BorderBuffer},
    linear::Linear,
};
use palette::{
    FromColor, Hsluv, Hsva, IntoColor, LinSrgb, Mix, Srgb,
    chromatic_adaptation::AdaptInto,
    convert::IntoColorUnclamped,
    white_point::{self, E},
};
use smart_leds::{RGB8, colors::BLACK, hsv::Hsv};

use super::convert_color;

/// As pallete colors neither implement multiplication with a scalar nor the merge trait in `topology-traits` crate,
/// we need to use a newtype pattern
///
/// TODO: I have no memory of this place.gif
#[derive(Debug, Copy, Clone, Default)]
pub struct CustomColor<C: Mix>(C);

impl<C: Mix> From<C> for CustomColor<C> {
    fn from(from: C) -> Self {
        CustomColor(from)
    }
}

/// As pallete colors do not implement multiplication, we have to implement the Merge trait ourself to use enterpolation.
impl<C: Mix<Scalar = f32>> Merge<f32> for CustomColor<C> {
    fn merge(self, other: Self, factor: f32) -> Self {
        self.0.mix(other.0, factor).into()
    }
}

#[derive(Copy, Clone)]
pub struct Gradient<const N: usize> {
    /// TODO: colors should probably be hsluv and convert later. then its easier to modify brightness and shift the color. but this is easier for now
    pub rgb_colors: [RGB8; N],
}

/// TODO: keep this in hsluv?
pub fn apply_greg_caitlin_wedding_spline<const N: usize>(buf: &mut [Hsv; N]) {
    let spline = greg_caitlin_wedding_spline();

    let color_iter = spline.take(N);

    for (x, color) in buf.iter_mut().zip(color_iter) {
        x.hue = ((color.0.hue.into_inner() / 360.0) * 255.0).round() as u8;
        x.sat = (color.0.saturation * 255.0) as u8;
        // TODO: whats the right way to convert luv to v?
        x.val = (color.0.l * 255.0) as u8;
    }
}

impl<const N: usize> Gradient<N> {
    pub fn new(iter: impl Iterator<Item = RGB8>) -> Self {
        let mut colors = [BLACK; N];

        for (x, color) in colors.iter_mut().zip(iter) {
            *x = color
        }

        Self { rgb_colors: colors }
    }

    // TODO: put this behind a feature? maybe it should be a function that takes a spline and goes into a Gradient?
    pub fn new_mermaid() -> Self {
        let spline = mermaid_spline();

        let color_iter = spline.take(N).map(|x| convert_color(x.0).into());

        Self::new(color_iter)
    }

    // TODO: put this behind a feature?
    pub fn new_greg_caitlin_wedding() -> Self {
        let spline = greg_caitlin_wedding_spline();

        let color_iter = spline.take(N).map(|x| convert_color(x.0).into());

        Self::new(color_iter)
    }

    // TODO: put this behind a feature?
    pub fn new_rainbow(saturation: f32, luminance: f32) -> Self {
        // TODO: interpolate the correct number of colors in Hsluv space. then convert to RGB8 with convert_color function
        let lin = Linear::builder()
            .elements([0.0, 255.0])
            .knots([0.0, 255.0])
            .build()
            .unwrap();

        let color_iter = lin
            .take(N)
            .map(|x| convert_color(Hsluv::new(x, saturation, luminance)).into());

        Self::new(color_iter)
    }

    // /// TODO: i don't think this is right. need to read more examples and write some tests
    // pub fn get(&self, n: usize, width: usize) -> (u8, u8, u8) {
    //     let hsluv = self
    //         .spline
    //         .gen(remap(
    //             n as f32,
    //             0.0,
    //             (width - 1) as f32,
    //             self.domain_min,
    //             self.domain_max,
    //         ))
    //         .0;

    //     convert_color(hsluv)
    // }
}

type GregCaitlinWeddingSpline = BSpline<
    BorderBuffer<Equidistant<f32>>,
    [CustomColor<Hsluv<white_point::E>>; 8],
    enterpolation::ConstSpace<CustomColor<Hsluv<white_point::E>>, 8>,
>;

/// TODO: pick colors
pub fn greg_caitlin_wedding_spline() -> GregCaitlinWeddingSpline {
    //generate #128CF6
    let dusty_blue: CustomColor<_> = Hsluv::<white_point::E>::new(208., 92.7, 96.5).into();

    // generate #FB3936
    let pastel_red: CustomColor<_> = Hsluv::new(1.0, 78.5, 98.4).into();

    // generate #875F9A
    let purple: CustomColor<_> = Hsluv::new(281., 38.3, 60.4).into();

    // we want to use a bspline with degree 3 i think. that needs at least 4 colors
    // we also want the colors to wrap back around.
    BSpline::builder()
        .clamped()
        .elements([
            dusty_blue, pastel_red, pastel_red, dusty_blue, dusty_blue, purple, purple, dusty_blue,
        ])
        .equidistant::<f32>()
        .degree(3)
        .normalized()
        .constant::<_>()
        .build()
        .expect("As the curve is hardcoded, this should always work")
}

/// TODO: return traits to make this easier to change
type MermaidSpline = BSpline<
    BorderBuffer<Equidistant<f32>>,
    [CustomColor<Hsluv<white_point::E>>; 4],
    enterpolation::ConstSpace<CustomColor<Hsluv<white_point::E>>, 4>,
>;

/// --cobalt-blue: #004AADff;
/// --medium-slate-blue: #865BDCff;
/// --blue-crayola: #5D79F7ff;
/// --silver: #A6A6A6ff;
/// --jade: #27B26Eff;
///
/// <https://www.hsluv.org/>
///
/// TODO: not sure how good silver will look. might have to cut that
/// TODO: return using Traits
fn mermaid_spline() -> MermaidSpline {
    //generate #004AAD
    let cobalt_blue: CustomColor<_> = Hsluv::<white_point::E>::new(258.3, 100.0, 33.8).into();

    // generate #865BDC
    let slate_blue: CustomColor<_> = Hsluv::new(275.1, 76.5, 49.2).into();

    // generate #5D79F7
    let crayola_blue: CustomColor<_> = Hsluv::new(261.5, 93.8, 54.8).into();

    // generate #27B26E
    let jade: CustomColor<_> = Hsluv::new(142.2, 93.3, 64.5).into();

    // we want to use a bspline with degree 3
    // TODO: more jade, but it doesn't wrap well (goes to close to black)
    BSpline::builder()
        .clamped()
        .elements([cobalt_blue, slate_blue, crayola_blue, jade])
        .equidistant::<f32>()
        .degree(3)
        .normalized()
        .constant::<4>()
        .build()
        .expect("As the curve is hardcoded, this should always work")
}

#[cfg(test)]
mod tests {
    use crate::lights::{convert_color, gradient::mermaid_spline};
    use enterpolation::Curve;

    #[test_log::test]
    fn test_mermaid_spline() {
        let spline = mermaid_spline();

        for hsluv in spline.take(8).map(|x| x.0) {
            convert_color(hsluv);
        }

        todo!("actually assert things");
    }
}
