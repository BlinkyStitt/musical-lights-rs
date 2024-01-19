use enterpolation::{
    bspline::{BSpline, BorderBuffer},
    Curve, Equidistant, Merge,
};
use palette::{white_point, Hsluv, Mix};
use smart_leds::{colors::BLACK, RGB8};

use super::convert_color;

/// As pallete colors neither implement multiplication with a scalar nor the merge trait in `topology-traits` crate,
/// we need to use a newtype pattern
#[derive(Debug, Copy, Clone, Default)]
struct CustomColor<C: Mix>(C);

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

pub struct Gradient<const N: usize> {
    /// TODO: colors should probably be hsluv and convert later. then its easier to modify brightness and shift the color. but this is easier for now
    pub colors: [RGB8; N],
}

impl<const N: usize> Gradient<N> {
    pub fn new(iter: impl Iterator<Item = RGB8>) -> Self {
        let mut colors = [BLACK; N];

        for (x, color) in colors.iter_mut().zip(iter) {
            *x = color
        }

        Self { colors }
    }

    pub fn new_mermaid() -> Self {
        let spline = mermaid_spline();

        let color_iter = spline.take(N).map(|x| convert_color(x.0).into());

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
