// Optional sensor permission must begin in the Start listening click stack.
// Closing also invalidates pending permission promises before Rust drops callbacks.
class PhysicsInput {
  constructor(layer, onPointer, onTilt, onShake) {
    this.window = layer.ownerDocument.defaultView;
    this.closed = false;
    this.listeners = [];
    this.motion = null;
    const angle = () => this.window.screen.orientation?.angle ?? 0;
    const clearPointer = () => onPointer(0, 0, false);
    this.listen('pointermove', event => {
      if (event.pointerType !== 'mouse') return;
      const box = this.bounds;
      if (!box) return;
      const x = (event.clientX - box.left) / box.width;
      const y = 1 - (event.clientY - box.top) / box.height;
      onPointer(x, y, x >= 0 && x <= 1 && y >= 0 && y <= 1);
    });
    this.listen('pointerout', event => { if (!event.relatedTarget) clearPointer(); });
    this.listen('blur', clearPointer);
    this.orientation = event => {
      if (Number.isFinite(event.beta) && Number.isFinite(event.gamma)) {
        onTilt(event.beta, event.gamma, angle());
      }
    };
    this.acceleration = event => {
      // Gravity is not a shake. If linear acceleration is unavailable, skip it.
      const acceleration = event.acceleration;
      if (Number.isFinite(acceleration?.x) && Number.isFinite(acceleration?.y)) {
        onShake(acceleration.x, acceleration.y, angle());
      }
    };
  }

  startMotion() {
    if (this.closed || this.motion) return;
    const session = [];
    this.motion = session;
    const permission = Interface => {
      if (!Interface) return Promise.resolve(false);
      try {
        return typeof Interface.requestPermission === 'function'
          ? Promise.resolve(Interface.requestPermission()).then(value => value === 'granted').catch(() => false)
          : Promise.resolve(true);
      } catch { return Promise.resolve(false); }
    };
    // Issue both requests before awaiting either. A rejection leaves mouse input.
    Promise.all([
      permission(this.window.DeviceOrientationEvent),
      permission(this.window.DeviceMotionEvent),
    ]).then(([tilt, shake]) => {
      if (this.motion !== session) return;
      if (tilt) this.listen('deviceorientation', this.orientation, session);
      if (shake) this.listen('devicemotion', this.acceleration, session);
    }).catch(() => { /* Sensors are optional. */ });
  }

  listen(type, listener, listeners = this.listeners) {
    this.window.addEventListener(type, listener, { passive: true });
    listeners.push([type, listener]);
  }

  stopMotion() {
    for (const [type, listener] of this.motion ?? []) this.window.removeEventListener(type, listener);
    this.motion = null;
  }

  close() {
    this.closed = true;
    this.stopMotion();
    for (const [type, listener] of this.listeners) this.window.removeEventListener(type, listener);
    this.listeners = [];
  }
}

// Async module ownership also covers route changes during download or WASM compilation.
export class Scene {
  constructor(layer, palette, onFrame) {
    palette = new Float32Array(palette);
    this.closed = false;
    this.input = new PhysicsInput(layer,
      (...args) => this.view?.pointer(...args),
      (...args) => this.view?.orientation(...args),
      (...args) => this.view?.deviceAcceleration(...args));
    import(new URL('physics/view.js', document.baseURI)).then(({ PhysicsView }) => {
      if (this.closed) return;
      this.view = new PhysicsView(layer, palette, onFrame, this.input);
    }).catch(error => {
      if (!this.closed) layer.closest('.audio-card').querySelector('.physics-status').textContent = `Cannot start 3D physics: ${error}`;
    });
  }
  push(levels, edges) { this.view?.push(levels, edges); }
  startMotion() { this.input.startMotion(); }
  stopMotion() { this.input.stopMotion(); this.view?.stopMotion(); }
  close() { this.closed = true; this.input.close(); this.view?.close(); this.view = null; }
}
