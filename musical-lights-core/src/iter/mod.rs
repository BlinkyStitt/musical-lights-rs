use core::iter::Cycle;
use itertools::Either;

/// return some items from the left, then some items from the right
/// TODO: what should we name this? UnevenInterleave?
/// TODO: shouldn't L and R be constrainted to Iterator here? Take doesn't, so I won't. But I'm not sure why.
/// TODO: for my use, i want both to cycle forever. i'm not sure if that's what we actually want though.
#[derive(Debug, Clone)]
pub struct LeftRightIter<L, R> {
    left_iter: Cycle<L>,
    left_n_start: usize,
    left_n: usize,
    right_iter: Cycle<R>,
    right_n: usize,
    right_n_start: usize,
}

impl<L, R> LeftRightIter<L, R>
where
    L: Iterator + Clone,
    R: Iterator + Clone,
{
    /// TODO: whats the "proper" way to build a new iter?
    pub fn new(left_iter: L, left_n: usize, right_iter: R, right_n: usize) -> Self {
        Self {
            left_iter: left_iter.cycle(),
            left_n,
            left_n_start: left_n,
            right_iter: right_iter.cycle(),
            right_n,
            right_n_start: right_n,
        }
    }
}

/// TODO: implement more traits. this feels like a better path than doing take_every_n and not having it be fused.
impl<L, R> Iterator for LeftRightIter<L, R>
where
    L: Iterator + Clone,
    R: Iterator + Clone,
    // <R as Iterator>::Item = <L as Iterator>::Item,       // TODO: how does this work?
{
    /// TODO: how to constrain to L and R having shared types for Item? Or use the LeftRight enum type for this?
    type Item = Either<<L as Iterator>::Item, <R as Iterator>::Item>;

    /// TODO: rewrite this from Take to LeftRightIter
    /// TODO: think more about how to handle None. I think we might want to just move on to the next step immediatly
    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        if self.left_n != 0 {
            self.left_n -= 1;
            Some(Either::Left(self.left_iter.next()?))
        } else if self.right_n != 0 {
            self.right_n -= 1;
            Some(Either::Right(self.right_iter.next()?))
        } else {
            // left and right are both at 0! reset the loop
            self.left_n = self.left_n_start;
            self.right_n = self.right_n_start;

            // call next again and use that result. this will hit the left branch
            self.next()
        }
    }

    // TODO: implement more functions? lets just get this working and then we can optimize things if necessary
}
