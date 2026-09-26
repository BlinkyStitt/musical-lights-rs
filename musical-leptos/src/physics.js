// Optional sensor permission must begin in the Start listening click stack.
// Closing also invalidates pending permission promises before Rust drops callbacks.
export class PhysicsInput {
  constructor(layer, onPointer, onTilt, onShake) {
    this.window = layer.ownerDocument.defaultView;
    this.closed = false;
    this.listeners = [];
    this.motion = null;
    const angle = () => this.window.screen.orientation?.angle ?? this.window.orientation ?? 0;
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
      const axes = ['x', 'y', 'z'];
      const linear = axes.map(axis => event.acceleration?.[axis]);
      if (linear.some(Number.isFinite)) {
        this.gravity = null;
        onShake(...linear.map(value => Number.isFinite(value) ? value : 0), angle());
        return;
      }
      // Some devices expose only gravity-inclusive readings. Estimate the slow
      // baseline, then remove it; a stationary phone must not become a shake.
      const raw = axes.map(axis => event.accelerationIncludingGravity?.[axis]);
      if (!raw.every(Number.isFinite)) return;
      const dt = (event.timeStamp - this.gravityAt) / 1000;
      if (!this.gravity || !(dt > 0 && dt < .5)) this.gravity = raw.slice();
      const alpha = Math.exp(-Math.max(0, dt || 0) / .25);
      const shake = raw.map((value, i) => {
        this.gravity[i] += (1 - alpha) * (value - this.gravity[i]);
        return value - this.gravity[i];
      });
      this.gravityAt = event.timeStamp;
      onShake(...shake, angle());
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
    // Request both in the click stack, but enable each independently. A pending
    // tilt request must not hold up already-authorized shake input (or vice versa).
    for (const [Interface, type, handler] of [
      [this.window.DeviceOrientationEvent, 'deviceorientation', this.orientation],
      [this.window.DeviceMotionEvent, 'devicemotion', this.acceleration],
    ]) {
      permission(Interface).then(granted => {
        if (granted && this.motion === session) this.listen(type, handler, session);
      });
    }
  }

  listen(type, listener, listeners = this.listeners) {
    this.window.addEventListener(type, listener, { passive: true });
    listeners.push([type, listener]);
  }

  stopMotion() {
    for (const [type, listener] of this.motion ?? []) this.window.removeEventListener(type, listener);
    this.motion = null;
    this.gravity = null;
    this.gravityAt = undefined;
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
