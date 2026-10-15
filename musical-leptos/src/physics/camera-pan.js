// Browser camera controls only. The anchor stays inside the main box in X/Y.
const KEYS = new Set(['w', 'a', 's', 'd']);
export function cameraEditing(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
}
export class CameraPan {
  constructor() { this.x = .5; this.y = .5; this.keys = new Set(); }
  press(event) {
    const key = event.key.toLowerCase();
    if (!KEYS.has(key) || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || cameraEditing(event.target)) return false;
    this.keys.add(key); return true;
  }
  release(event) { this.keys.delete(event.key.toLowerCase()); }
  clear() { this.keys.clear(); }
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
