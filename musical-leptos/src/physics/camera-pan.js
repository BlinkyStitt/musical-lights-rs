// Browser camera controls only. The anchor stays inside the main box in X/Y.
// Stable browser parameter IDs also serve as preference keys. Steps describe
// manual editors; continuous callers (keyboard now, modulation later) may use
// any finite value in bounds. Effective overrides never mutate manual values.
export const CAMERA_PARAMETERS = Object.freeze(Object.fromEntries([
  ['cameraAngle', 0, -40, 40, 1, 'degrees'],
  ['cameraZoom', 100, 25, 200, 1, '%'],
  ['cameraX', 50, 0, 100, 1, '%'],
  ['cameraY', 50, 0, 100, 1, '%'],
].map(([id, value, min, max, step, unit]) => [id, Object.freeze({ id, value, min, max, step, unit })])));
export const CAMERA_DEFAULTS = Object.freeze(Object.fromEntries(Object.values(CAMERA_PARAMETERS).map(p => [p.id, p.value])));
export function validCameraParameter(id, value) {
  const p = Object.hasOwn(CAMERA_PARAMETERS, id) && CAMERA_PARAMETERS[id];
  return !!p && Number.isFinite(value) && value >= p.min && value <= p.max;
}
export class CameraParameters {
  constructor(saved = {}) {
    this.values = { ...CAMERA_DEFAULTS };
    for (const id of Object.keys(CAMERA_PARAMETERS)) this.set(id, saved?.[id]);
  }
  get(id) { return this.values[id]; }
  set(id, value) {
    if (!validCameraParameter(id, value)) return false;
    this.values[id] = value; return true;
  }
  effective(id, override) { return validCameraParameter(id, override) ? override : this.get(id); }
  reset() { Object.assign(this.values, CAMERA_DEFAULTS); }
}
const KEYS = new Set(['w', 'a', 's', 'd']);
export function cameraEditing(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
}
export class CameraPan {
  constructor(parameters = new CameraParameters()) { this.parameters = parameters; this.keys = new Set(); }
  get x() { return this.parameters.get('cameraX') / 100; }
  set x(value) { this.parameters.set('cameraX', value * 100); }
  get y() { return this.parameters.get('cameraY') / 100; }
  set y(value) { this.parameters.set('cameraY', value * 100); }
  press(event) {
    const key = event.key.toLowerCase();
    if (!KEYS.has(key) || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || cameraEditing(event.target)) return false;
    this.keys.add(key); return true;
  }
  release(event) { this.keys.delete(event.key.toLowerCase()); if (!this.keys.size) this.onStop?.(); }
  clear() { this.keys.clear(); this.onStop?.(); }
  reset() { this.clear(); this.x = this.y = .5; }
  step(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    const dx = Number(this.keys.has('d')) - Number(this.keys.has('a'));
    const dy = Number(this.keys.has('w')) - Number(this.keys.has('s'));
    const length = Math.hypot(dx, dy);
    if (!length) return false;
    // Use elapsed time at every frame rate. Blur, visibility and pause clear
    // held keys; bounds contain long frames. Diagonals keep the same speed.
    const distance = seconds * .35 / length;
    const x = Math.max(0, Math.min(1, this.x + dx * distance));
    const y = Math.max(0, Math.min(1, this.y + dy * distance));
    const changed = x !== this.x || y !== this.y;
    this.x = x; this.y = y; return changed;
  }
}
