// Match the native Rust SettingSwitch markup; labels remain stable in every state.
export function settingSwitch(label, className, checked = false) {
  return `<label class="setting-switch"><input type="checkbox" tabindex="0" class="${className}"${checked ? ' checked' : ''}><span>${label}</span></label>`;
}
