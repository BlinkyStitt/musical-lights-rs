// Querying permission never opens a prompt. Unsupported descriptors stay unknown;
// storage and previous visits are deliberately not evidence of browser permission.
export class PermissionStatus {
  constructor(window, onChange) {
    this.window = window;
    this.onChange = onChange;
    this.states = {};
    this.revisions = {};
    this.subscriptions = new Map();
    this.closed = false;
    this.refresh = () => {
      if (window.document.hidden || this.closed) return;
      for (const name of ['microphone', 'accelerometer', 'gyroscope']) this.query(name);
    };
    for (const type of ['focus', 'pageshow']) window.addEventListener(type, this.refresh);
    window.document.addEventListener('visibilitychange', this.refresh);
    this.refresh();
  }

  set(name, state) {
    if (this.closed || this.states[name] === state) return;
    this.revisions[name] = (this.revisions[name] ?? 0) + 1;
    this.states[name] = state;
    this.onChange();
  }

  async query(name) {
    const revision = this.revisions[name] = (this.revisions[name] ?? 0) + 1;
    this.subscriptions.get(name)?.();
    this.subscriptions.delete(name);
    this.states[name] = 'unknown';
    this.onChange();
    try {
      const status = await this.window.navigator.permissions?.query({ name });
      if (this.closed || revision !== this.revisions[name] || !status) return;
      const remove = () => status.removeEventListener('change', update);
      const update = () => {
        if (this.closed || this.subscriptions.get(name) !== remove) return;
        this.states[name] = ['granted', 'denied', 'prompt'].includes(status.state) ? status.state : 'unknown';
        this.onChange();
      };
      status.addEventListener('change', update);
      this.subscriptions.set(name, remove);
      update();
    } catch { /* Safari and other browsers may reject sensor permission queries. */ }
  }

  close() {
    this.closed = true;
    for (const remove of this.subscriptions.values()) remove();
    this.subscriptions.clear();
    for (const type of ['focus', 'pageshow']) this.window.removeEventListener(type, this.refresh);
    this.window.document.removeEventListener('visibilitychange', this.refresh);
  }
}

// Optional sensor permission must begin in the Start listening click stack.
// Closing also invalidates pending permission promises before Rust drops callbacks.
export class PhysicsInput {
  constructor(layer, onPointer, onTilt, onShake, onStatus = () => {}, onPermission = () => {}) {
    this.window = layer.ownerDocument.defaultView;
    this.closed = false;
    this.listeners = [];
    this.motion = null;
    this.onStatus = onStatus;
    this.onPermission = onPermission;
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
        if (this.state !== 'active') this.onPermission();
        this.setStatus('active');
        this.gravity = null;
        onShake(...linear.map(value => Number.isFinite(value) ? value : 0), angle());
        return;
      }
      // Some devices expose only gravity-inclusive readings. Estimate the slow
      // baseline, then remove it; a stationary phone must not become a shake.
      const raw = axes.map(axis => event.accelerationIncludingGravity?.[axis]);
      if (!raw.every(Number.isFinite)) return;
      if (this.state !== 'active') this.onPermission();
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
        if (type === 'devicemotion' && granted && typeof Interface.requestPermission === 'function') this.onPermission();
        if (granted) this.listen(type, handler, session);
        this.setStatus(type === 'devicemotion' ? (granted ? 'waiting' : Interface ? 'denied' : 'unavailable') : this.state);
      });
    }
  }

  // The listener list is authoritative: tilt may work even when shaking does not.
  get enabled() { return Boolean(this.motion?.length); }

  setStatus(state) {
    const enabled = this.enabled;
    if (this.state === state && this.statusEnabled === enabled) return;
    this.state = state;
    this.statusEnabled = enabled;
    this.onStatus(state, enabled);
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
    this.microphoneStatus = document.createElement('p');
    this.microphoneStatus.className = 'microphone-permission';
    this.microphoneStatus.setAttribute('role', 'status');
    card.querySelector('.display-note').before(this.microphoneStatus);
    this.permissionHelp = document.createElement('details');
    this.permissionHelp.className = 'permission-help';
    const summary = document.createElement('summary');
    summary.textContent = 'About microphone and motion access';
    const help = document.createElement('p');
    help.textContent = 'Access is controlled by your browser. To reduce repeated microphone prompts, choose Allow in this site’s browser permissions, if available. A bookmark uses the browser’s permissions; a Home Screen app or another browser may have separate permissions. Motion access may be requested again after reopening. Nothing starts until you tap Start listening or Enable motion.';
    this.permissionHelp.append(summary, help);
    this.motionControls.after(this.permissionHelp);
    this.renderPermissions = () => {
      // Avoid repeating identical live-region announcements for independent queries.
      const show = (element, text) => { if (element.textContent !== text) element.textContent = text; };
      const states = this.permissions?.states ?? {};
      const microphone = !window.isSecureContext ? 'insecure'
        : !navigator.mediaDevices?.getUserMedia ? 'unavailable' : states.microphone ?? 'unknown';
      this.microphoneStatus.dataset.state = microphone;
      show(this.microphoneStatus, {
        unknown: 'Microphone permission cannot be checked here. Tap Start listening to check access.',
        prompt: 'Microphone off · your browser will ask for access when needed.',
        granted: 'Microphone access allowed.',
        denied: 'Microphone access blocked. Allow it in this site’s browser settings, then try again.',
        requesting: 'Opening microphone · respond to your browser if it asks for access.',
        'not-allowed': 'Microphone access was not granted. Check this site’s browser permissions, then try again.',
        unavailable: 'Microphone capture is unavailable in this browser.',
        insecure: 'Microphone access requires a secure HTTPS page.',
      }[microphone]);
      const sensors = [states.accelerometer, states.gyroscope];
      const state = this.input?.state ?? 'off';
      if (state !== 'off') {
        show(this.motionStatus, sensors.includes('denied') && ['waiting', 'active'].includes(state)
          ? 'Motion access blocked. Check this site’s browser permissions, then disable and enable motion.'
          : this.input.enabled && ['requesting', 'denied', 'unavailable'].includes(state)
            ? `Tilt on · ${state === 'requesting' ? 'waiting for shaking permission.' : state === 'denied' ? 'shaking access denied.' : 'shaking unavailable.'}`
            : {
              requesting: 'Allow Motion & Orientation to shake the balls.',
              waiting: 'Motion enabled · waiting for sensor readings…',
              active: matchMedia('(prefers-reduced-motion: reduce)').matches
                ? 'Motion on · Reduced Motion limits shaking.'
                : 'Motion on · shake your phone to move the balls.',
              denied: 'Motion access denied. Allow Motion & Orientation for this site, then tap Enable motion.',
              unavailable: 'This browser is not providing phone motion.',
            }[state]);
        return;
      }
      const motion = !window.isSecureContext ? 'insecure'
        : !window.DeviceMotionEvent && !window.DeviceOrientationEvent ? 'unavailable'
        : sensors.includes('denied') ? 'denied'
        : sensors.every(state => state === 'granted') ? 'granted'
        : sensors.includes('prompt') ? 'prompt' : 'unknown';
      this.motionStatus.dataset.permission = motion;
      show(this.motionStatus, {
        unknown: 'Motion off · tap Enable motion to check access.',
        prompt: 'Motion off · your browser may ask for access when enabled.',
        granted: 'Motion access allowed · motion off.',
        denied: 'Motion access blocked. Check this site’s browser permissions, then tap Enable motion.',
        unavailable: 'Phone motion is unavailable in this browser.',
        insecure: 'Motion access requires a secure HTTPS page.',
      }[motion]);
    };
    this.input = new PhysicsInput(layer,
      (...args) => this.view?.pointer(...args),
      (...args) => this.view?.orientation(...args),
      (...args) => this.view?.deviceAcceleration(...args),
      (state, on) => {
        this.motionButton.textContent = on ? 'Disable motion' : 'Enable motion';
        this.motionButton.disabled = state === 'requesting' && !on;
        this.motionButton.setAttribute('aria-pressed', String(on));
        this.motionStatus.dataset.state = state;
        this.renderPermissions();
      }, () => {
        this.permissions.set('accelerometer', 'granted');
        this.permissions.set('gyroscope', 'granted');
      });
    this.permissions = new PermissionStatus(window, this.renderPermissions);
    this.renderPermissions();
    this.microphoneAccess = event => this.permissions.set('microphone', event.detail);
    card.addEventListener('microphone-access', this.microphoneAccess);
    this.card = card;
    // A dedicated gesture allows shaking without microphone access and makes
    // permission retry explicit. Display rotation lock is never consulted.
    this.motionButton.onclick = () => {
      if (this.input.enabled) {
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
  close() {
    this.closed = true; this.permissions.close();
    this.card.removeEventListener('microphone-access', this.microphoneAccess);
    this.input.close(); this.view?.close(); this.view = null;
    this.motionControls.remove(); this.microphoneStatus.remove(); this.permissionHelp.remove();
  }
}
