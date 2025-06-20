use core::ffi::c_void;
use esp_idf_svc::sys::{uxTaskGetStackHighWaterMark, TaskHandle_t};
use musical_lights_core::logging::info;

/// Return the minimum free stack (high-water mark) ever seen for
/// `task`.  
/// • `task == None` ⟹ current task (pass a null handle).  
/// • Value is in **bytes** (ESP-IDF deviation from vanilla FreeRTOS).  
/// Safe wrapper around the raw FFI.
#[inline]
pub fn stack_high_water_mark(task: Option<TaskHandle_t>) -> usize {
    unsafe {
        let handle = task.unwrap_or(core::ptr::null_mut::<c_void>() as TaskHandle_t);
        uxTaskGetStackHighWaterMark(handle) as usize
    }
}

/// if task is None, then the current task is checked
#[inline]
pub fn log_stack_high_water_mark(label: &'static str, task: Option<TaskHandle_t>) {
    let high_water_mark = stack_high_water_mark(task);
    info!("high water for {}: {} bytes", label, high_water_mark);
}
