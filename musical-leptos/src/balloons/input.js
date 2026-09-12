// Optional sensor permission must begin in the Start listening click stack.
// Closing also invalidates pending permission promises before Rust drops callbacks.
export class BalloonInput {
  constructor(layer, onPointer, onTilt, onShake) {
    this.window = layer.ownerDocument.defaultView;
    this.closed = false;
    this.listeners = [];
    const angle = () => this.window.screen.orientation?.angle ?? 0;
    const clearPointer = () => onPointer(0, 0, false);
    this.listen('pointermove', event => {
      if (event.pointerType !== 'mouse') return;
      const box = layer.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width;
      const y = 1 - (event.clientY - box.top) / box.height;
      onPointer(x, y, x >= 0 && x <= 1 && y >= 0 && y <= 1);
    });
    this.listen('pointerout', event => { if (!event.relatedTarget) clearPointer(); });
    this.listen('blur', clearPointer);
    const orientation = event => {
      if (Number.isFinite(event.beta) && Number.isFinite(event.gamma)) {
        onTilt(event.beta, event.gamma, angle());
      }
    };
    const motion = event => {
      // Gravity is not a shake. If linear acceleration is unavailable, skip it.
      const acceleration = event.acceleration;
      if (Number.isFinite(acceleration?.x) && Number.isFinite(acceleration?.y)) {
        onShake(acceleration.x, acceleration.y, angle());
      }
    };
    const permission = Interface => {
      if (!Interface) return Promise.resolve(false);
      try {
        return typeof Interface.requestPermission === 'function'
          ? Promise.resolve(Interface.requestPermission()).then(value => value === 'granted')
          : Promise.resolve(true);
      } catch { return Promise.resolve(false); }
    };
    // Issue both requests before awaiting either. A rejection leaves mouse input.
    Promise.all([
      permission(this.window.DeviceOrientationEvent),
      permission(this.window.DeviceMotionEvent),
    ]).then(([tilt, shake]) => {
      if (this.closed || !tilt || !shake) return;
      this.listen('deviceorientation', orientation);
      this.listen('devicemotion', motion);
    }).catch(() => { /* Sensors are optional. */ });
  }

  listen(type, listener) {
    this.window.addEventListener(type, listener, { passive: true });
    this.listeners.push([type, listener]);
  }

  close() {
    this.closed = true;
    for (const [type, listener] of this.listeners) this.window.removeEventListener(type, listener);
    this.listeners = [];
  }
}
