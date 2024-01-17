use enterpolation::{
    bspline::{BSpline, BorderBuffer},
    Curve, Equidistant, Generator, Merge,
};
use palette::{chromatic_adaptation::AdaptInto, Hsluv, Mix, Srgb};
use smart_leds::RGB8;

// As HSL does neither implement multiplication with a scalar nor the merge trait in `topology-traits` crate,
// we need to use a newtype pattern
#[derive(Debug, Copy, Clone, Default)]
pub struct CustomHsluv(Hsluv);

impl From<Hsluv> for CustomHsluv {
    fn from(from: Hsluv) -> Self {
        CustomHsluv(from)
    }
}

// As HSL does not implement multiplication, we have to implement the Merge trait ourself to use enterpolation.
impl Merge<f32> for CustomHsluv {
    fn merge(self, other: Self, factor: f32) -> Self {
        self.0.mix(other.0, factor).into()
    }
}

/// TODO: generic for this
type MermaidSpline = BSpline<
    BorderBuffer<Equidistant<f32>>,
    [CustomHsluv; 5],
    enterpolation::ConstSpace<CustomHsluv, 4>,
>;

pub struct MermaidGradient {
    spline: MermaidSpline,
    domain_min: f32,
    domain_max: f32,
    width: f32,
}

impl MermaidGradient {
    pub fn new(width: usize) -> Self {
        let spline = mermaid_spline();
        let [domain_min, domain_max] = spline.domain();
        Self {
            spline,
            domain_min,
            domain_max,
            width: width as f32,
        }
    }

    pub fn get(&self, x: usize) -> RGB8 {
        let hsluv = self
            .spline
            .gen(remap(
                x as f32,
                0.0,
                self.width,
                self.domain_min,
                self.domain_max,
            ))
            .0;

        // TODO: do we want linear srgb? i think so, but not sure
        let srgb: Srgb = hsluv.adapt_into();

        let raw: (u8, u8, u8) = srgb.into_format().into_components();

        RGB8::new(raw.0, raw.1, raw.2)
    }
}

/// --cobalt-blue: #004AADff;
/// --medium-slate-blue: #865BDCff;
/// --blue-crayola: #5D79F7ff;
/// --silver: #A6A6A6ff;
/// --jade: #27B26Eff;
///
/// <https://www.hsluv.org/>
///
/// TODO: not sure how good silver will look. might have to cut that
pub fn mermaid_spline() -> MermaidSpline {
    //generate #004AAD
    let cobalt_blue: CustomHsluv = Hsluv::new(258.3, 1.0, 0.338).into();

    // generate #865BDC
    let slate_blue: CustomHsluv = Hsluv::new(275.1, 0.765, 0.492).into();

    // generate #5D79F7
    let crayola_blue: CustomHsluv = Hsluv::new(261.5, 0.938, 0.548).into();

    // generate #A6A6A6
    let silver: CustomHsluv = Hsluv::new(0.0, 0.0, 0.681).into();

    // generate #27B26E
    let jade: CustomHsluv = Hsluv::new(142.2, 0.933, 0.645).into();

    // we want to use a bspline with degree 3
    BSpline::builder()
        .clamped()
        .elements([cobalt_blue, slate_blue, crayola_blue, silver, jade])
        .equidistant::<f32>()
        .degree(3)
        .normalized()
        .constant::<4>()
        .build()
        .expect("As the curve is hardcoded, this should always work")
}

/// Map t in range [a, b] to range [c, d]
pub fn remap(t: f32, a: f32, b: f32, c: f32, d: f32) -> f32 {
    (t - a) * ((d - c) / (b - a)) + c
}
