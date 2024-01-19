use super::Weighting;

pub struct FlatWeighting<const N: usize>;

impl<const N: usize> Weighting<N> for FlatWeighting<N> {
    fn weight(&self, _i: usize) -> f32 {
        // TODO: skip the first bin or no?
        // if i == 0 {
        //     // we skip the first bin. it is special (i think. at least it was in other code. here it seems to be the average?)
        //     0.0
        // } else {
        1.0
        // }
    }
}
