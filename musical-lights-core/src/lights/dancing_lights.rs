//! Based on the visualizer, but with some artistic choices to make the lights look they are dancing.

use crate::microphone::HumanHearingBalancedFFT;

pub struct DancingLights<const N: usize> {
    pub lights: [u8; N],
}

impl<const N: usize> DancingLights<N> {
    fn update(&mut self, sound: HumanHearingBalancedFFT<N>) {
        todo!();
    }
}
