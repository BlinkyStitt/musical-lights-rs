use itertools::Either;
use smart_leds::{
    RGB8,
    colors::{BLUE, RED, WHITE},
};

use crate::iter::LeftRightIter;

/// TODO: does this only work on odd sizes?
pub fn flag_stars_pattern<const X: usize>() -> impl Iterator<Item = RGB8> + Clone {
    let blue_and_white_iter = [BLUE, WHITE].iter().cycle();
    let white_and_blue_iter = [WHITE, BLUE].iter().cycle();
    let blue_iter = [BLUE].iter().cycle();

    // all blue
    blue_iter
        .clone()
        .take(X)
        // blue border
        .chain(blue_iter.clone().take(1))
        // star field (-2 for the border)
        .chain(blue_and_white_iter.take(X - 2))
        // blue border
        .chain(blue_iter.clone().take(1))
        // all blue
        .chain(blue_iter.clone().take(X))
        // blue border
        .chain(blue_iter.clone().take(1))
        // offset star field (-2 for the border)
        .chain(white_and_blue_iter.take(X - 2))
        // blue border
        .chain(blue_iter.clone().take(1))
        // repeat
        .cycle()
        // goodbye refs
        .copied()
}

/// TODO: i feel like this should use `repeat` but thats giving me weird reference errors
pub fn flag_stripes_pattern<const X: usize>() -> impl Iterator<Item = RGB8> + Clone {
    let red_iter = [RED].iter().cycle();
    let white_iter = [WHITE].iter().cycle();

    red_iter.take(X).chain(white_iter.take(X)).cycle().copied()
}

pub fn flag_pattern<const STAR_X: usize, const STRIPE_X: usize, const X: usize>()
-> impl Iterator<Item = RGB8> {
    assert!(STAR_X + STRIPE_X == X);

    let stars_iter = flag_stars_pattern::<STAR_X>();
    let stripes_iter = flag_stripes_pattern::<STRIPE_X>();

    let combined_iter = LeftRightIter::new(stars_iter, STAR_X, stripes_iter, STRIPE_X);

    combined_iter.map(|x| match x {
        Either::Left(left) => left,
        Either::Right(right) => right,
    })
}

// /// like Take, but is not a "fused" iterator. this will return None and then come back.
// /// Something tells me this is not the right way to solve my problem of merging two iterators like i'm doing.
// /// maybe i should have a more specific iterator that takes two iterators and does different amounts from each until they both end (or maybe only take cycles?)
// #[inline]
// fn take_every_n(self, n: usize) -> Take<Self>
// where
//     Self: Sized,
// {
//     TakeEveryN::new(self, n)
// }

// #[derive(Clone, Debug)]
// struct TakeEveryN {

// })

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stars() {
        const X: usize = 7;

        let mut x = flag_stars_pattern::<X>();

        for i in 0..10 {
            println!("loop {i}");

            // this should go
            // a row of all blue
            // 1 blue, a row of stars (blue, then white), 1 blue
            // a row of all blue
            // 1 blue, a row of stars (white, then blue), 1 blue
            // repeat

            // TODO: but its failing. its failing because "cycle" starts over. we want it to instead continue each inner iter where they left off
            // TODO: how do you do that? `take` and `cycle` aren't the right tools

            assert_eq!(
                x.next_chunk::<X>().unwrap(),
                [BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE]
            );

            assert_eq!(
                x.next_chunk::<X>().unwrap(),
                [BLUE, BLUE, WHITE, BLUE, WHITE, BLUE, BLUE]
            );

            assert_eq!(
                x.next_chunk::<X>().unwrap(),
                [BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE]
            );

            assert_eq!(
                x.next_chunk::<X>().unwrap(),
                [BLUE, WHITE, BLUE, WHITE, BLUE, WHITE, BLUE]
            );
        }
    }

    #[test]
    fn test_stripes() {
        const X: usize = 3;

        let mut x = flag_stripes_pattern::<X>();

        for i in 0..10 {
            println!("loop {i}");

            assert_eq!(x.next_chunk::<X>().unwrap(), [RED, RED, RED]);

            assert_eq!(x.next_chunk::<X>().unwrap(), [WHITE, WHITE, WHITE]);
        }
    }

    #[test]
    fn test_flag() {
        const X: usize = 10;
        const X_STARS: usize = 7;
        const X_STRIPES: usize = 3;

        assert_eq!(X, X_STARS + X_STRIPES);

        let mut x = flag_pattern::<X_STARS, X_STRIPES, X>();

        for i in 0..10 {
            println!("loop {i}");

            // TODO? it would actually help to grab a much larger chunk. i want to see the whole flag at once

            // flag #1
            // TODO: need a helper macro on these. also unique log lines
            let next_chunk = x.next_chunk::<X_STARS>().unwrap();
            println!("chunk  1 = {next_chunk:?}");
            assert_eq!(next_chunk, [BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE]);

            let next_chunk = x.next_chunk::<X_STRIPES>().unwrap();
            println!("chunk  2 = {next_chunk:?}");
            assert_eq!(next_chunk, [RED, RED, RED]);

            let next_chunk = x.next_chunk::<X_STARS>().unwrap();
            println!("chunk  3 = {next_chunk:?}");
            assert_eq!(next_chunk, [BLUE, BLUE, WHITE, BLUE, WHITE, BLUE, BLUE]);

            let next_chunk = x.next_chunk::<X_STRIPES>().unwrap();
            println!("chunk  4 = {next_chunk:?}");
            assert_eq!(next_chunk, [WHITE, WHITE, WHITE]);

            let next_chunk = x.next_chunk::<X_STARS>().unwrap();
            println!("chunk  5 = {next_chunk:?}");
            assert_eq!(next_chunk, [BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE]);

            let next_chunk = x.next_chunk::<X_STRIPES>().unwrap();
            println!("chunk  6 = {next_chunk:?}");
            assert_eq!(next_chunk, [RED, RED, RED]);

            let next_chunk = x.next_chunk::<X_STARS>().unwrap();
            println!("chunk  7 = {next_chunk:?}");
            assert_eq!(next_chunk, [BLUE, WHITE, BLUE, WHITE, BLUE, WHITE, BLUE]);

            let next_chunk = x.next_chunk::<X_STRIPES>().unwrap();
            println!("chunk  8 = {next_chunk:?}");
            assert_eq!(next_chunk, [WHITE, WHITE, WHITE]);

            let next_chunk = x.next_chunk::<X_STARS>().unwrap();
            println!("chunk  9 = {next_chunk:?}");
            assert_eq!(next_chunk, [BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE]);

            let next_chunk = x.next_chunk::<X_STRIPES>().unwrap();
            println!("chunk 10 = {next_chunk:?}");
            assert_eq!(next_chunk, [RED, RED, RED]);

            let next_chunk = x.next_chunk::<X_STARS>().unwrap();
            println!("chunk 11 = {next_chunk:?}");
            assert_eq!(next_chunk, [BLUE, BLUE, WHITE, BLUE, WHITE, BLUE, BLUE]);

            let next_chunk = x.next_chunk::<X_STRIPES>().unwrap();
            println!("chunk 12 = {next_chunk:?}");
            assert_eq!(next_chunk, [WHITE, WHITE, WHITE]);

            let next_chunk = x.next_chunk::<X_STARS>().unwrap();
            println!("chunk 13 = {next_chunk:?}");
            assert_eq!(next_chunk, [BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE]);

            let next_chunk = x.next_chunk::<X_STRIPES>().unwrap();
            println!("chunk 14 = {next_chunk:?}");
            assert_eq!(next_chunk, [RED, RED, RED]);

            let next_chunk = x.next_chunk::<X_STARS>().unwrap();
            println!("chunk 15 = {next_chunk:?}");
            assert_eq!(next_chunk, [BLUE, WHITE, BLUE, WHITE, BLUE, WHITE, BLUE]);

            let next_chunk = x.next_chunk::<X_STRIPES>().unwrap();
            println!("chunk 16 = {next_chunk:?}");
            assert_eq!(next_chunk, [WHITE, WHITE, WHITE]);
        }
    }
}
