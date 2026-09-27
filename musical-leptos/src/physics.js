// Optional sensor permission must begin in the Start listening click stack.
// Closing also invalidates pending permission promises before Rust drops callbacks.
export class PhysicsInput {
  constructor(layer, onPointer, onTilt, onShake, onStatus = () => {}) {
    this.window = layer.ownerDocument.defaultView;
    this.closed = false;
    this.listeners = [];
    this.motion = null;
    this.onStatus = onStatus;
    this.state = 'off';
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
        this.setStatus('active');
        this.gravity = null;
        onShake(...linear.map(value => Number.isFinite(value) ? value : 0), angle());
        return;
      }
      // Some devices expose only gravity-inclusive readings. Estimate the slow
      // baseline, then remove it; a stationary phone must not become a shake.
      const raw = axes.map(axis => event.accelerationIncludingGravity?.[axis]);
      if (!raw.every(Number.isFinite)) return;
      this.setStatus('active');
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
    this.setStatus('requesting');
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
      [this.window.DeviceMotionEvent, 'devicemotion', this.acceleration],
      [this.window.DeviceOrientationEvent, 'deviceorientation', this.orientation],
    ]) {
      permission(Interface).then(granted => {
        if (this.motion !== session) return;
        if (granted) this.listen(type, handler, session);
        if (type === 'devicemotion') this.setStatus(granted ? 'waiting' : Interface ? 'denied' : 'unavailable');
      });
    }
  }

  setStatus(state) {
    if (this.state === state) return;
    this.state = state;
    this.onStatus(state);
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
    this.setStatus('off');
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
    const card = layer.closest('.audio-card');
    this.motionButton = document.createElement('button');
    this.motionButton.className = 'motion-button';
    this.motionButton.textContent = 'Enable motion';
    this.motionButton.type = 'button';
    this.motionButton.setAttribute('aria-pressed', 'false');
    this.motionControls = document.createElement('div');
    this.motionControls.className = 'motion-controls';
    this.motionControls.append(this.motionButton);
    card.querySelector('.display-note').insertAdjacentElement('afterend', this.motionControls);
    this.motionStatus = document.createElement('p');
    this.motionStatus.className = 'motion-status';
    this.motionStatus.setAttribute('role', 'status');
    this.motionControls.append(this.motionStatus);
    this.input = new PhysicsInput(layer,
      (...args) => this.view?.pointer(...args),
      (...args) => this.view?.orientation(...args),
      (...args) => this.view?.deviceAcceleration(...args),
      state => {
        const on = state === 'active' || state === 'waiting';
        this.motionButton.textContent = on ? 'Disable motion' : 'Enable motion';
        this.motionButton.disabled = state === 'requesting';
        this.motionButton.setAttribute('aria-pressed', String(on));
        this.motionStatus.dataset.state = state;
        this.motionStatus.textContent = {
          off: '', requesting: 'Allow Motion & Orientation to shake the balls.',
          waiting: 'Motion allowed. Waiting for sensor readings…',
          active: matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'Motion on · Reduced Motion limits shaking.'
            : 'Motion on · shake your phone to move the balls.',
          denied: 'Motion access denied. Allow Motion & Orientation for this site, then tap Enable motion.',
          unavailable: 'This browser is not providing phone motion.',
        }[state];
      });
    // A dedicated gesture allows shaking without microphone access and makes
    // permission retry explicit. Display rotation lock is never consulted.
    this.motionButton.onclick = () => {
      if (['active', 'waiting'].includes(this.input.state)) {
        this.input.stopMotion(); this.view?.clearMotion();
      }
      else { this.input.stopMotion(); this.input.startMotion(); }
    };
    import(new URL(document.querySelector('meta[name="musical-lights-assets"]').content + 'physics/view.js', document.baseURI)).then(({ PhysicsView }) => {
      if (this.closed) return;
      this.view = new PhysicsView(layer, palette, onFrame, this.input);
    }).catch(error => {
      if (!this.closed) layer.closest('.audio-card').querySelector('.physics-status').textContent = `Cannot start 3D physics: ${error}`;
    });
  }
  push(levels, edges, scrolling) { this.view?.push(levels, edges, scrolling); }
  startMotion() { this.input.startMotion(); }
  stopMotion() { this.input.stopMotion(); this.view?.stopMotion(); }
  close() { this.closed = true; this.input.close(); this.view?.close(); this.view = null; this.motionControls.remove(); }
}
