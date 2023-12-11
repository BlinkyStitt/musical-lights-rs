pub enum BatteryStatus {
    Dead(f32),
    Low(f32),
    Ok(f32),
    Full(f32),
}

impl BatteryStatus {
    fn check_battery_voltage(vbat_pin_output: f32, reference_voltage: f32) -> f32 {
        // old comment that was cargo culted: we divided by 2, so multiply back
        let mut measured_vbat = vbat_pin_output * 2.0;
        // multiply our reference voltage (probably 3.3 or 5)
        measured_vbat *= reference_voltage;
        // convert to voltage
        measured_vbat /= 1024.0;

        measured_vbat
    }

    pub fn check(vbat_pin_output: f32, reference_voltage: f32, max_battery_voltage: f32) -> Self {
        let measured_voltage = Self::check_battery_voltage(vbat_pin_output, reference_voltage);

        if measured_voltage < reference_voltage {
            return BatteryStatus::Dead(measured_voltage);
        }

        // ranges are cargo culted
        // i think they match this graph: "docs/battery discharge profile"
        if measured_voltage < max_battery_voltage * 0.88 {
            return BatteryStatus::Low(measured_voltage);
        }

        if measured_voltage < max_battery_voltage * 0.97 {
            return BatteryStatus::Ok(measured_voltage);
        }

        BatteryStatus::Full(measured_voltage)
    }
}
