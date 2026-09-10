//! Single-owner I2S receive channel with explicit DMA overflow detection.
use esp_idf_svc::{
    hal::{
        gpio::{Gpio25, Gpio26, Gpio33},
        i2s::I2S0,
    },
    sys::*,
};
use std::sync::atomic::{AtomicBool, Ordering};
static OVERFLOW: AtomicBool = AtomicBool::new(false);

#[link_section = ".iram1.text"]
unsafe extern "C" fn overflow(
    _channel: i2s_chan_handle_t,
    _event: *mut i2s_event_data_t,
    _context: *mut core::ffi::c_void,
) -> bool {
    // This sticky flag carries no other data; atomicity is sufficient.
    OVERFLOW.store(true, Ordering::Relaxed);
    false
}

pub struct Capture<'d> {
    handle: i2s_chan_handle_t,
    enabled: bool,
    _pins: (I2S0<'d>, Gpio26<'d>, Gpio33<'d>, Gpio25<'d>),
}
impl<'d> Capture<'d> {
    pub fn new(
        i2s: I2S0<'d>,
        bclk: Gpio26<'d>,
        ws: Gpio33<'d>,
        din: Gpio25<'d>,
        frames: usize,
    ) -> eyre::Result<Self> {
        let channel = i2s_chan_config_t {
            id: 0,
            role: i2s_role_t_I2S_ROLE_MASTER,
            dma_desc_num: 4,
            dma_frame_num: frames as u32,
            ..Default::default()
        };
        let config = i2s_std_config_t {
            clk_cfg: i2s_std_clk_config_t {
                sample_rate_hz: 48_000,
                clk_src: soc_module_clk_t_SOC_MOD_CLK_APLL as _,
                mclk_multiple: i2s_mclk_multiple_t_I2S_MCLK_MULTIPLE_256,
                ..Default::default()
            },
            slot_cfg: i2s_std_slot_config_t {
                data_bit_width: i2s_data_bit_width_t_I2S_DATA_BIT_WIDTH_16BIT,
                slot_bit_width: i2s_slot_bit_width_t_I2S_SLOT_BIT_WIDTH_AUTO,
                slot_mode: i2s_slot_mode_t_I2S_SLOT_MODE_MONO,
                slot_mask: i2s_std_slot_mask_t_I2S_STD_SLOT_LEFT,
                ws_width: 16,
                ws_pol: false,
                bit_shift: true,
                msb_right: true,
            },
            gpio_cfg: i2s_std_gpio_config_t {
                mclk: -1,
                bclk: 26,
                ws: 33,
                dout: -1,
                din: 25,
                ..Default::default()
            },
        };
        let mut handle = core::ptr::null_mut();
        // All config pointers remain alive for the synchronous SDK calls.
        esp!(unsafe { i2s_new_channel(&channel, core::ptr::null_mut(), &mut handle) })?;
        let mut this = Self {
            handle,
            enabled: false,
            _pins: (i2s, bclk, ws, din),
        };
        esp!(unsafe { i2s_channel_init_std_mode(handle, &config) })?;
        let callbacks = i2s_event_callbacks_t {
            on_recv_q_ovf: Some(overflow),
            ..Default::default()
        };
        esp!(unsafe {
            i2s_channel_register_event_callback(handle, &callbacks, core::ptr::null_mut())
        })?;
        OVERFLOW.store(false, Ordering::Relaxed);
        esp!(unsafe { i2s_channel_enable(handle) })?;
        this.enabled = true;
        Ok(this)
    }
    pub fn read_exact(&mut self, mut output: &mut [u8]) -> eyre::Result<()> {
        self.check_continuity()?;
        while !output.is_empty() {
            let mut count = 0;
            // The SDK writes at most output.len() bytes and reports its count.
            esp!(unsafe {
                i2s_channel_read(
                    self.handle,
                    output.as_mut_ptr().cast(),
                    output.len(),
                    &mut count,
                    1000,
                )
            })?;
            eyre::ensure!(
                count > 0 && count <= output.len(),
                "invalid I2S read length"
            );
            output = &mut output[count..];
        }
        self.check_continuity()
    }
    pub fn check_continuity(&self) -> eyre::Result<()> {
        eyre::ensure!(
            !OVERFLOW.load(Ordering::Relaxed),
            "I2S DMA overflow: samples lost; restart capture"
        );
        Ok(())
    }
}
impl Drop for Capture<'_> {
    fn drop(&mut self) {
        // This value owns the handle. Disable stops callbacks before deletion.
        unsafe {
            if self.enabled {
                let _ = i2s_channel_disable(self.handle);
            }
            let _ = i2s_del_channel(self.handle);
        }
    }
}
