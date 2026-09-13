use enterpolation::{
    Curve, Equidistant, Merge,
    bspline::{BSpline, BorderBuffer},
    linear::Linear,
};
#[allow(unused_imports)]
use micromath::F32Ext;
use palette::{Hsluv, LinSrgb, Mix, white_point};

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
    pub colors: [LinSrgb<f32>; N],
}

impl<const N: usize> Gradient<N> {
    pub fn new(iter: impl Iterator<Item = LinSrgb<f32>>) -> Self {
        let mut colors = [LinSrgb::new(0.0, 0.0, 0.0); N];

        for (x, color) in colors.iter_mut().zip(iter) {
            *x = color
        }

        Self { colors }
    }

    // TODO: put this behind a feature? maybe it should be a function that takes a spline and goes into a Gradient?
    pub fn new_mermaid() -> Self {
        let spline = mermaid_spline();

        let color_iter = spline.take(N).map(|x| convert_color(x.0));

        Self::new(color_iter)
    }

    // TODO: put this behind a feature?
    pub fn new_greg_caitlin_wedding() -> Self {
        let spline = greg_caitlin_wedding_spline();

        let color_iter = spline.take(N).map(|x| convert_color(x.0));

        Self::new(color_iter)
    }

    /// Red through orange, yellow, green, and blue to purple, in linear sRGB.
    /// Saturation and perceptual lightness use HSLuv's 0–100 scale.
    pub fn new_rainbow(saturation: f32, luminance: f32) -> Self {
        Self::new(
            Self::rainbow_hues()
                .into_iter()
                .map(|hue| convert_color(Hsluv::new(hue, saturation, luminance))),
        )
    }

    /// The same fixed hue anchors for each output's rainbow palette.
    pub fn rainbow_hues() -> [f32; N] {
        // HSLuv hue is in degrees, not the LED HSV byte range of 0–255.
        let lin = Linear::builder()
            .elements([12.0, 38.0, 85.0, 127.0, 192.0, 258.0, 285.0])
            .knots([
                0.0,
                1.0 / 6.0,
                2.0 / 6.0,
                3.0 / 6.0,
                4.0 / 6.0,
                5.0 / 6.0,
                1.0,
            ])
            .build()
            .unwrap();

        let mut hues = [0.0; N];
        for (hue, value) in hues.iter_mut().zip(lin.take(N)) {
            *hue = value;
        }
        hues
    }

    // /// TODO: i don't think this is right. need to read more examples and write some tests
    // pub fn get(&self, n: usize, width: usize) -> (u8, u8, u8) {
    //     let hsluv = self
    //         .spline
    //         .r#gen(remap(
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
    [CustomColor<Hsluv<white_point::D65>>; 8],
    enterpolation::ConstSpace<CustomColor<Hsluv<white_point::D65>>, 4>,
>;

/// TODO: pick colors
pub fn greg_caitlin_wedding_spline() -> GregCaitlinWeddingSpline {
    //generate #128CF6
    let dusty_blue: CustomColor<_> = Hsluv::<white_point::D65>::new(208., 92.7, 96.5).into();

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
        .constant::<4>()
        .build()
        .expect("As the curve is hardcoded, this should always work")
}

/// TODO: return traits to make this easier to change
type MermaidSpline = BSpline<
    BorderBuffer<Equidistant<f32>>,
    [CustomColor<Hsluv<white_point::D65>>; 4],
    enterpolation::ConstSpace<CustomColor<Hsluv<white_point::D65>>, 4>,
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
    let cobalt_blue: CustomColor<_> = Hsluv::<white_point::D65>::new(258.3, 100.0, 33.8).into();

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
    use crate::lights::{Gradient, convert_color, gradient::mermaid_spline};
    use enterpolation::{Curve, Signal};

    #[test]
    fn rainbow_runs_from_red_to_purple() {
        let colors = Gradient::<24>::new_rainbow(90.0, 58.0).colors;
        let red = colors[0];
        assert!(red.red > red.green * 4.0);
        assert!(red.red > red.blue * 4.0);
        let purple = colors[23];
        assert!(purple.blue > purple.red);
        assert!(purple.red > purple.green * 3.0);
        for (i, color) in colors.iter().enumerate() {
            assert!(!colors[..i].contains(color), "each band has its own color");
        }
    }

    #[test]
    fn rainbow_uses_balanced_hsluv_anchors() {
        let anchors = [12.0, 38.0, 85.0, 127.0, 192.0, 258.0, 285.0];
        let colors = Gradient::<7>::new_rainbow(90.0, 58.0).colors;

        for (color, hue) in colors.into_iter().zip(anchors) {
            let expected = convert_color(palette::Hsluv::new(hue, 90.0, 58.0));
            assert_eq!(color, expected, "anchor hue {hue}");
        }
    }

    #[test]
    fn rainbow_interpolates_endpoints_and_stays_finite() {
        let colors = Gradient::<24>::new_rainbow(90.0, 58.0).colors;
        assert_eq!(
            colors[0],
            convert_color(palette::Hsluv::new(12.0, 90.0, 58.0))
        );
        assert_eq!(
            colors[23],
            convert_color(palette::Hsluv::new(285.0, 90.0, 58.0))
        );
        assert!(colors.iter().all(|color| {
            [color.red, color.green, color.blue]
                .into_iter()
                .all(f32::is_finite)
        }));
    }

    #[test_log::test]
    fn test_mermaid_spline() {
        let spline = mermaid_spline();

        for hsluv in spline.take(8).map(|x| x.0) {
            convert_color(hsluv);
        }

        let start = spline.eval(0.0).0;
        let end = spline.eval(1.0).0;
        assert!((start.hue.into_inner() - 258.3).abs() < 0.001);
        assert!((start.l - 33.8).abs() < 0.001);
        assert!((end.hue.into_inner() - 142.2).abs() < 0.001);
        assert!((end.l - 64.5).abs() < 0.001);
        let midpoint = spline.eval(0.5).0;
        let expected_lightness = (33.8 + 3.0 * 49.2 + 3.0 * 54.8 + 64.5) / 8.0;
        assert!((midpoint.l - expected_lightness).abs() < 0.001);
    }
}
