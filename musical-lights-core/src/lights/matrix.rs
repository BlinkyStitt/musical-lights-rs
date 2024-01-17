// pub mod layout {
//     pub struct SimpleXY;
//     pub struct SnakeXY;
// }

// /// row-major
// pub fn n_to_xy<SimpleXY>(n: usize, width: usize) -> (usize, usize) {
//     let x = n % width;
//     let y = n / width;
//     (x, y)
// }

pub fn n_to_xy(n: usize, width: usize) -> (usize, usize) {
    let y = n / width;
    let x = match y % 2 {
        0 => n % width,               // Even rows: left to right
        _ => width - 1 - (n % width), // Odd rows: right to left
    };
    (x, y)
}

// /// row-major
// pub fn xy_to_n(x: usize, y: usize, width: usize) -> usize {
//     y * width + x
// }

pub fn xy_to_n(x: usize, y: usize, width: usize) -> usize {
    match y % 2 {
        0 => y * width + x,               // Even rows: left to right
        _ => y * width + (width - 1 - x), // Odd rows: right to left
    }
}

#[cfg(test)]
mod tests {
    use super::{n_to_xy, xy_to_n};

    // TODO: hypothesis based testing. test it goes back from n to xy and back again

    #[test]
    fn test_from_n() {
        assert_eq!(n_to_xy(0, 8), (0, 0));
        assert_eq!(n_to_xy(1, 8), (1, 0));
        assert_eq!(n_to_xy(2, 8), (2, 0));
        assert_eq!(n_to_xy(3, 8), (3, 0));
        assert_eq!(n_to_xy(4, 8), (4, 0));
        assert_eq!(n_to_xy(5, 8), (5, 0));
        assert_eq!(n_to_xy(6, 8), (6, 0));
        assert_eq!(n_to_xy(7, 8), (7, 0));
        assert_eq!(n_to_xy(8, 8), (7, 1));
        assert_eq!(n_to_xy(9, 8), (6, 1));
    }

    #[test]
    fn tets_from_xy() {
        assert_eq!(xy_to_n(0, 0, 8), 0);
        assert_eq!(xy_to_n(1, 0, 8), 1);
        assert_eq!(xy_to_n(2, 0, 8), 2);
        assert_eq!(xy_to_n(3, 0, 8), 3);
        assert_eq!(xy_to_n(4, 0, 8), 4);
        assert_eq!(xy_to_n(5, 0, 8), 5);
        assert_eq!(xy_to_n(6, 0, 8), 6);
        assert_eq!(xy_to_n(7, 0, 8), 7);
        assert_eq!(xy_to_n(7, 1, 8), 8);
        assert_eq!(xy_to_n(6, 1, 8), 9);
    }
}
