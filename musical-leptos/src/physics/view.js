import { SceneLighting } from './lighting.js';
import * as THREE from './three.module.js';
import { PhoneReport } from './report.js';
import { Enclosure, barProjection, BAR_PROFILE } from './enclosure.js';
import { SideBars } from './side-bars.js';
import { sphereGeometry } from './spheres.js';
import { Starfield } from './stars.js';
import { CameraPan, cameraEditing } from './camera-pan.js';
import { GpuFrames } from './gpu-frames.js';

const CAMERA_DISTANCE = 1.8;

// Separate a transient notice from cumulative diagnostic counters and stopped state.
export class PhysicsNotice {
  constructor(node) { this.node = node; this.overloads = 0; this.incident = false; }
  render() {
    const text = this.persistent ? (this.message || this.persistent) : (this.report || this.message || '');
    if (this.node.textContent !== text) this.node.textContent = text;
  }
  show(message, persistent = '') {
    clearTimeout(this.timer);
    this.message = message; this.persistent = persistent; this.render();
    this.timer = setTimeout(() => { this.message = ''; this.render(); }, 4000);
  }
  sample(metrics, now, stepMs) {
    const overloads = metrics.overloadTicks ?? 0;
    const overloaded = overloads > this.overloads;
    this.overloads = overloads;
    const message = overloaded ? 'Motion briefly reached its physics work limit.'
      : metrics.snapshotAgeMs > 100 ? 'Motion updates are delayed.'
      : metrics.debt > 2 * stepMs ? 'Motion is catching up.' : '';
    if (message) {
      this.healthySince = null;
      if (!this.incident && !this.persistent) { this.incident = true; this.show(message); }
    } else {
      this.healthySince ??= now;
      if (now - this.healthySince >= 1000) this.incident = false;
    }
  }
  clear() {
    clearTimeout(this.timer); this.message = ''; this.persistent = ''; this.incident = false;
    this.healthySince = null; this.render();
  }
  close() { clearTimeout(this.timer); }
}

export class PhysicsView {
  constructor(layer, palette, onFrame, motion, waveLight) {
    this.layer = layer;
    this.graph = layer.parentElement;
    this.card = this.graph.closest('.audio-card');
    this.onFrame = onFrame;
    this.waveLight = waveLight;
    this.palette = palette;
    this.closed = false;
    this.lost = false;
    this.ready = false;
    this.inflight = false;
    this.sequence = 0;
    this.input = new Float32Array(64);
    this.listening = this.card.dataset.audioSource === 'microphone' && this.card.dataset.audioState === 'playing';
    this.tempo = 120;
    this.accentSerial = 0; this.audioAccent = 0; this.idleAccent = 0;
    this.seed = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    this.settings = this.card.preferences ?? { directionOdds: [60, 200, .05, .5, 1], flight: 30, cameraMotion: true, cameraAngle: 0 };
    this.cameraPan = new CameraPan();
    this.cameraBase = this.settings.cameraAngle; this.cameraDrag = false; this.cameraTime = 0;
    this.edges = new Float32Array(24);
    this.meshEdges = new Float32Array(144);
    this.meshPulses = new Float32Array(144);
    this.timing = { snapshots: [], resizes: [] };
    this.meters = [...this.graph.querySelectorAll('[role="meter"]')];
    this.meterValues = new Uint8Array(24);
    this.groups = this.meters.map((meter, i) => {
      const group = meter.parentElement; group.dataset.sourceBand = i;
      Object.assign(group.style, { position: 'absolute', top: '0', bottom: '0' });
      return group;
    });
    this.copies = this.meters.map((meter, i) => {
      const copy = document.createElement('span'); copy.className = 'bark-copy';
      copy.setAttribute('aria-hidden', 'true'); copy.dataset.sourceBand = i;
      for (const type of ['pointerenter', 'pointerleave']) copy.addEventListener(type, event => meter.dispatchEvent(new PointerEvent(type, { pointerType: event.pointerType })));
      this.graph.append(copy); return copy;
    });
    this.acceleration = [0, 0, 0];
    this.accelerationAt = 0;
    this.metrics = { frames: 0, renderMs: 0, debt: 0, maxDebt: 0, physicsSteps: 0, physicsMs: 0, discardedSimulationMs: 0 };
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    this.status = this.card.querySelector('.physics-status');
    this.notice = new PhysicsNotice(this.status);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, .01, 200);
    // Draw the foreground and stars in one scene pass.
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    // Bound fragment work on large and high-density displays. CSS controls
    // and text keep their native resolution. Multisample antialiasing smooths
    // geometry edges at this bounded scale, including after fullscreen resizes.
    this.pixelRatio = { value: 1 };
    this.renderer.localClippingEnabled = true;
    this.gpuFrames = new GpuFrames(this.renderer.getContext());
    this.layer.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', '8 rigid balls, matching top and bottom audio bars, inside a box with eight side banks');
    this.canvas = this.renderer.domElement;
    this.canvas.addEventListener('webglcontextlost', this.contextLost = event => {
      event.preventDefault(); this.gpuFrames.clear(); this.lost = true; this.pause(); this.notice.show('Graphics paused. Waiting for the WebGL context.', 'Graphics paused. Waiting for recovery.');
      this.report?.invalidate('WebGL context lost');
    });
    this.canvas.addEventListener('webglcontextrestored', this.contextRestored = () => {
      this.gpuFrames.clear(); this.lost = false; this.notice.clear(); this.pause();
    });
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 1.2));
    this.lighting = new SceneLighting(palette, this.settings);
    const light = new THREE.DirectionalLight(0xffffff, 1.8); light.position.set(-1, 3, 4); this.scene.add(light);
    const fill = new THREE.DirectionalLight(0xffffff, .9); fill.position.set(2, 1, 1); this.scene.add(fill);
    this.pointerPoint = new THREE.Vector3(); this.pointerRay = new THREE.Raycaster(); this.pointerCoordinates = new THREE.Vector2(); this.pointerPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this.object = new THREE.Object3D(); this.color = new THREE.Color(); this.quaternion = new THREE.Quaternion();
    this.listeners = [];
    this.motion = motion;
    this.observer = new ResizeObserver(() => { this.resizePending = true; }); this.observer.observe(layer);
    this.sceneVisible = true;
    this.visibilityObserver = new IntersectionObserver(([entry]) => { this.sceneVisible = entry.isIntersecting; if (!this.sceneVisible) { this.cameraPan.clear(); } });
    this.visibilityObserver.observe(layer);
    this.controls = this.card.querySelector('.audio-controls'); this.observer.observe(this.controls);
    this.listen(this.card, 'display-rotation', () => {
      this.resizePending = true;
      this.input[27] = 0;
      if (this.lastGravity) this.deviceGravity(...this.lastGravity);
      if (this.lastAcceleration) {
        const at = this.accelerationAt;
        this.deviceAcceleration(...this.lastAcceleration);
        this.accelerationAt = at;
      }
    });
    this.listen(window, 'scroll', () => this.measurePointer(), { passive: true });
    this.listen(document, 'visibilitychange', () => { if (document.hidden) { this.cameraPan.clear(); this.report?.invalidate('Page hidden during test'); } this.pause(); });
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'rigid-body-physics' });
    this.worker.onmessage = event => this.receive(event.data);
    this.worker.onerror = event => this.fail(event.message);
    this.measure();
    this.worker.postMessage({ type: 'init', palette, height: this.height, paused: document.hidden, config: this.settings.physics, danceOptions: this.danceOptions() });
    this.graph.physics = this;
    this.animate = frameTime => {
      this.request = null;
      if (this.closed || document.hidden || this.lost) return;
      // Worker ticks, input receipts and output timestamps use this clock.
      // rAF names the rendering frame and can precede callback execution.
      const start = performance.now(), now = start;
      if (this.resizePending) { this.resizePending = false; this.measure(); }
      this.onFrame(now, false);
      if (this.idle && this.preview && !this.previewPending && now - (this.previewAt ?? -Infinity) >= 1000 / 60) {
        this.previewAt = now; this.previewPending = true;
        this.preview.postMessage({ type: 'pulse', time: now / 1000, reduced: this.reduced.matches, direction: this.horizontalDirection ?? 1 });
      }
      this.input[31] = this.reduced.matches ? 1 : 0;
      this.input[63] = this.card.dataset.audioState === 'playing' ? 1 : 0;
      for (let i = 0; i < 3; i++) this.input[24 + i] = now - this.accelerationAt < 150 ? this.acceleration[i] : 0;
      if (this.ready) {
        this.worker.postMessage({ type: 'pulse', timestamp: performance.timeOrigin + now,
          sequence: ++this.sequence, input: this.input, tempo: this.tempo, accent: this.accentSerial, listening: this.listening });
      }
      if (now - (this.tempoReadoutAt ?? -Infinity) >= 1000) {
        this.tempoReadoutAt = now;
        const readout = this.card.querySelector('.tempo-readout');
        if (readout) { const playing = this.card.dataset.audioState === 'playing'; readout.hidden = !playing; readout.textContent = playing ? `${Math.round(this.tempo)} BPM` : ''; readout.title = this.tempoConfidence > 0 ? 'Estimated musical tempo' : 'No reliable beat; easing toward 60 BPM'; }
      }
      this.updateCamera(now);
      let rendered = false;
      // Keep input and simulation active while the GPU completes earlier frames.
      // Only submitted frames contribute to FPS and diagnostic cadence.
      try {
        if (this.current && this.sceneVisible && this.gpuFrames.ready()) {
          this.draw(now); this.gpuFrames.submitted(); rendered = true;
        }
      } catch (error) { this.fail(error.message); return; }
      this.metrics.snapshotAgeMs = this.received == null ? 0 : now - this.received;
      const cost = performance.now() - start;
      if (rendered) { this.metrics.frames++; this.metrics.renderMs += cost; }
      if (now - this.fpsAt >= 1000) {
        this.frameRate = `${Math.round((this.metrics.frames - this.fpsFrames) * 1000 / (now - this.fpsAt))} FPS`;
        this.fpsAt = now; this.fpsFrames = this.metrics.frames;
        const readout = this.card.querySelector('.frame-rate');
        if (readout) readout.textContent = this.frameRate;
      }
      if (rendered) this.report?.frame(frameTime, cost);
      this.notice.sample(this.metrics, now, 1000 / (this.layout?.[1] ?? 120));
      if (!this.lastStatus || now - this.lastStatus > 1000) {
        this.notice.report = this.report?.active ? this.report.query('.phone-progress').textContent
          : this.report?.result ? this.report.query('.phone-progress').textContent + (this.card.hasAttribute('data-expanded') ? ' Exit fullscreen to review and export the report.' : '') : '';
        this.notice.render();
        this.lastStatus = now;
      }
      this.request = requestAnimationFrame(this.animate);
    };
    this.previewLevels = new Float32Array(24); this.previewEdges = new Float32Array(24);
    this.idle = !this.card.dataset.audioSession || this.card.dataset.audioState === 'stopped';
    const camera = this.card.querySelector('.camera-rotation');
    this.listen(camera, 'pointerdown', () => { this.cameraDrag = true; });
    this.cameraControl = camera;
    this.listen(window, 'pointerup', () => { this.cameraDrag = false; });
    this.listen(window, 'pointercancel', () => { this.cameraDrag = false; });
    this.listen(window, 'keydown', event => {
      if (!this.sceneVisible || document.hidden || this.closed || this.lost) return;
      if (this.cameraPan.press(event)) event.preventDefault();
    });
    this.listen(window, 'keyup', event => this.cameraPan.release(event));
    this.listen(window, 'blur', () => this.cameraPan.clear());
    this.listen(document, 'focusin', event => { if (cameraEditing(event.target)) this.cameraPan.clear(); });
    this.listen(camera, 'input', () => { this.cameraBase = Number(camera.value); this.settings.cameraAngle = this.cameraBase; this.setCamera(this.cameraBase); this.card.presentation?.save(); });
    this.listen(this.card, 'camera-reset', () => { this.cameraPan.reset(); this.cameraBase = 0; this.setCamera(0); });
    this.listen(this.card, 'display-settings', ({ detail }) => {
      this.settings = detail;
      this.lighting.configure(detail); this.resizePending = true;
      if (detail.physics) this.input[62] = detail.physics[5];
      if (!this.report?.active) this.worker.postMessage({ type: 'dance', options: this.danceOptions() });
    });
    this.listen(this.card, 'audio-tempo', ({ detail }) => {
      if (Number.isFinite(detail.bpm)) { this.tempo = detail.bpm; this.tempoConfidence = detail.confidence; }
      const difference = (detail.accentSequence ?? 0) - this.audioAccent;
      if (difference > 0) this.accentSerial += difference;
      this.audioAccent = detail.accentSequence ?? 0;
    });
    this.listen(this.card, 'audio-session', ({ detail }) => {
      this.listening = detail.source === 'microphone' && detail.state === 'playing';
      if (detail.state === 'starting') this.audioAccent = 0;
      this.idle = detail.state === 'stopped';
      this.card.dataset.preview = String(this.idle);
      this.tempoReadoutAt = -Infinity;
      const readout = this.card.querySelector('.tempo-readout');
      if (detail.state !== 'playing' && readout) { readout.hidden = true; readout.textContent = ''; }
      if (this.idle) { this.tempo = 120; this.tempoConfidence = 0; this.startPreview(); } else this.stopPreview();
    });
    if (this.idle) this.startPreview();
    this.pause();
  }
  startPreview() {
    if (this.preview || this.closed) return;
    this.card.dataset.preview = 'true';
    this.preview = new Worker(new URL('./demo-worker.js', import.meta.url), { type: 'module', name: 'silent-sine-preview' });
    this.previewPending = true; this.idleAccent = 0;
    this.preview.postMessage({ type: 'init' });
    this.preview.onmessage = ({ data }) => {
      this.previewPending = false;
      if (data.type === 'error') { this.stopPreview(); this.notice.show(`Silent preview unavailable: ${data.message}`); return; }
      if (!this.idle || this.closed || data.type !== 'frame') return;
      const difference = (data.accentSequence ?? 0) - this.idleAccent;
      if (difference > 0) this.accentSerial += difference;
      this.idleAccent = data.accentSequence ?? 0;
      for (let i = 0; i < 24; i++) {
        this.previewLevels[i] = data.state[4 + i * 4];
        const elapsed = data.state[0] - data.state[5 + i * 4];
        this.previewEdges[i] = data.state[5 + i * 4] >= 0 && elapsed >= 0 ? Math.max(0, 1 - elapsed / .18) * (this.reduced.matches ? .5 : 1) : 0;
      }
      this.push(this.previewLevels, this.previewEdges, this.card.querySelector('.scroll-lights').checked && !this.reduced.matches);
    };
    this.preview.onerror = event => { this.stopPreview(); this.notice.show(`Silent preview unavailable: ${event.message}`); };
  }
  stopPreview() { this.preview?.terminate(); this.preview = null; this.previewPending = false; }
  listen(target, name, callback, options) { target.addEventListener(name, callback, options); this.listeners.push(() => target.removeEventListener(name, callback, options)); }
  pointer(x, y, inside) {
    this.input[27] = inside ? 1 : 0;
    this.pointerCoordinates.set(x * 2 - 1, y * 2 - 1);
    this.pointerRay.setFromCamera(this.pointerCoordinates, this.camera);
    this.pointerRay.ray.intersectPlane(this.pointerPlane, this.pointerPoint);
    this.input[28] = this.pointerPoint.x; this.input[29] = this.pointerPoint.y; this.input[30] = 0;
  }
  deviceGravity(x, y, z, angle) {
    this.lastGravity = [x, y, z, angle];
    this.input.set(this.motion.rotate(x, y, angle), 34);
    this.input[36] = z;
    this.input[37] = 1;
  }
  // Device acceleration and gravity are both SI m/s². Inertia acts opposite
  // the phone's linear acceleration, with no visual gain or per-axis clipping.
  deviceAcceleration(x, y, z, angle) {
    this.lastAcceleration = [x, y, z, angle];
    this.acceleration = this.motion.rotate(-x, -y, angle);
    this.acceleration[2] = -z;
    this.accelerationAt = performance.now();
  }
  measurePointer() { this.motion.bounds = this.layer.getBoundingClientRect(); }
  measure() {
    this.measurePointer();
    const box = this.motion.measureBounds(this.layer);
    if (box.width <= 0 || box.height <= 0) return;
    this.card.style.setProperty('--fullscreen-control-bottom', `${Math.max(0, this.controls.getBoundingClientRect().bottom - this.graph.getBoundingClientRect().top) + 8}px`);
    this.width = this.layout?.[2] ?? 1.2;
    this.height = Math.max(this.layout?.[19] ?? .4, this.width * box.height / box.width);
    if (this.input[32] !== this.height && this.timing.resizes.length < 5000) this.timing.resizes.push({ at: performance.now(), from: this.input[32], to: this.height });
    this.input[32] = this.height;
    const resolution = this.settings.resolution ?? 1;
    if (box.width !== this.canvasWidth || box.height !== this.canvasHeight || resolution !== this.renderResolution) {
      const ratio = Math.min(devicePixelRatio, 2, Math.sqrt(200000 * resolution ** 2 / (box.width * box.height)));
      this.renderResolution = resolution;
      this.pixelRatio.value = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(box.width, box.height, false);
      this.canvasWidth = box.width; this.canvasHeight = box.height;
    }
    this.aspect = box.width / box.height;
    this.fitEnclosure();
  }
  fitEnclosure() {
    const geometry = this.layout?.[17];
    const ceiling = this.current?.[geometry] ?? this.height;
    const barMax = this.current?.[geometry + 1] ?? Math.max(.003, this.height - .246);
    const visibleHeight = Math.max(this.height, ceiling);
    const visibleWidth = visibleHeight * this.aspect;
    const key = `${visibleHeight}/${visibleWidth}/${barMax}/${this.config?.[5]}`;
    if (key === this.geometryKey) return;
    this.geometryKey = key; this.visibleHeight = visibleHeight;
    this.camera.aspect = this.aspect;
    this.camera.near = 0.01; this.camera.far = 200;
    this.camera.updateProjectionMatrix(); this.setCamera(this.rotation ?? 0);
    this.positionMeters(this.renderedPhase ?? 0);
  }
  fitCamera() {
    this.camera.updateMatrixWorld();
    const depth = this.config?.[5] ?? .48;
    let tangent = 0;
    // Keep a small gutter around the physical room for focus outlines.
    const horizontal = Math.max(.5, 1 - 24 / this.canvasWidth);
    const vertical = Math.max(.5, 1 - 24 / this.canvasHeight);
    // Fit all eight room corners, including the near faces and camera pitch.
    // A 2D field of view crops those faces under perspective projection.
    for (let i = 0; i < 8; i++) {
      const point = this.pointerPoint.set(i & 1 ? this.width : 0, i & 2 ? this.visibleHeight : 0,
        i & 4 ? depth / 2 : -depth / 2).applyMatrix4(this.camera.matrixWorldInverse);
      tangent = Math.max(tangent, Math.abs(point.y) / (-point.z * vertical), Math.abs(point.x) / (-point.z * this.aspect * horizontal));
    }
    const fov = 2 * Math.atan(tangent * 1.015) * 180 / Math.PI;
    if (this.camera.fov !== fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
  }
  setCamera(degrees, verticalOffset = 0) {
    if (degrees !== this.rotation && !this.automaticCamera) this.report?.invalidate('Camera changed during test');
    this.rotation = degrees;
    const angle = degrees * Math.PI / 180;
    if (!Number.isFinite(this.visibleHeight)) return;
    const x = this.width * this.cameraPan.x, y = this.visibleHeight * this.cameraPan.y;
    this.camera.position.set(x + Math.sin(angle) * CAMERA_DISTANCE, y + verticalOffset, Math.cos(angle) * CAMERA_DISTANCE);
    this.camera.lookAt(x, y, 0);
    this.fitCamera();
  }
  danceOptions() { return { scrollSpeed: this.settings.scrollSpeed ?? 2, odds: this.settings.directionOdds, flight: this.settings.flight / 100, seed: this.seed }; }
  updateCamera(now) {
    const moving = this.settings.cameraMotion && !this.reduced.matches && !this.cameraDrag && !this.cameraControl.closest('.slider-control')?.contains(document.activeElement);
    const elapsed = this.cameraAt == null ? 0 : Math.max(0, now - this.cameraAt);
    this.cameraAt = now;
    if (this.cameraPan.step(elapsed / 1000)) {
      this.report?.invalidate('Camera moved during test');
    }
    this.cameraTime = moving ? this.cameraTime + elapsed : 0;
    // Move the sweep center inward at the limits. Start at the selected angle
    // and ease through both turns without clipping or losing the sweep width.
    const amplitude = this.settings.sweepAngle ?? 10;
    const center = THREE.MathUtils.clamp(this.cameraBase, -40 + amplitude, 40 - amplitude);
    const phase = amplitude ? Math.asin(THREE.MathUtils.clamp((this.cameraBase - center) / amplitude, -1, 1)) : 0;
    const yaw = moving ? center + amplitude * Math.sin(this.cameraTime * 2 * Math.PI / ((this.settings.sweepSeconds ?? 48) * 1000) + phase) : this.cameraBase;
    this.automaticCamera = true;
    this.setCamera(yaw);
    this.automaticCamera = false;
    if (now - (this.sliderAt ?? -Infinity) >= 50) {
      this.sliderAt = now;
      if (!this.cameraDrag && !this.cameraControl.closest('.slider-control')?.contains(document.activeElement)) this.cameraControl.value = yaw;
      // Keep the text node under the pointer. Replacing it during a press
      // can cancel WebKit's native click before the value editor opens.
      this.card.querySelector('.camera-angle').firstChild.nodeValue = yaw.toFixed(1) + '°';
    }
  }
  receive(data) {
    if (this.closed) return;
    if (data.type === 'error') { this.fail(data.message); return; }
    if (data.type === 'ready') {
      if (data.layout.length !== 30 || data.layout[18] !== 19 || data.layout[21] !== 8 || data.layout[22] !== this.input.length || !Number.isInteger(data.layout[20])) { this.fail('Physics assets have mismatched protocol versions. Reload to update.'); return; }
      this.layout = data.layout; this.config = data.config; this.defaults = data.defaults;
      this.buffers = Array.from({ length: 3 }, () => new ArrayBuffer(this.layout[12] * 4));
      this.input[62] = this.settings.physics?.[5] ?? this.config[5];
      this.makeMeshes(); this.ready = true;
      this.settings.physics ??= Array.from(this.config); this.card.presentation?.save(false);
      this.measure();
      if (this.card.dataset.mode === 'advanced') this.report = new PhoneReport(this);
      this.requestSnapshot();
    } else if (data.type === 'snapshot') {
      this.horizontalDirection = data.horizontalDirection; this.card.dataset.barBase = 'both';
      this.pigments = data.pigments;
      if (this.previous) this.buffers.push(this.previous.buffer);
      this.previous = this.current;
      this.current = new Float32Array(data.buffer);
      this.received = performance.now(); this.inflight = false;
      this.config[5] = this.current[this.layout[17] + 4];
      this.metrics.debt = data.debt; this.metrics.maxDebt = data.maxDebt;
      this.metrics.substepTotal = data.substepTotal; this.metrics.maxSubsteps = data.maxSubsteps; this.metrics.overloadTicks = data.overloadTicks;
      this.metrics.physicsSteps = data.steps; this.metrics.physicsMs = data.totalCost;
      // Geometry and accessible surfaces must describe the newly published room,
      // even when a worker message arrives between animation frames.
      this.fitEnclosure();
      this.metrics.maxSchedulingGap = data.maxSchedulingGap; this.metrics.maxStepMs = data.maxStepMs;
      if ((this.report?.active || this.card.dataset.toneDiagnostics === 'true' || this.recordTiming) && this.timing.snapshots.length < 50000) this.timing.snapshots.push({ at: performance.now(), debt: data.debt, schedulingGap: data.schedulingGap, batchMs: data.batchMs, ticks: data.batchTicks, substeps: data.batchSubsteps, maxSubsteps: data.batchMaxSubsteps, height: this.current[1] });
      this.requestSnapshot();
    } else if (data.type === 'reset' || data.type === 'recording') {
      this.config = data.config; this.input[62] = this.config[5];
      if (data.type === 'reset' && this.card.presentation) { this.card.preferences.physics = Array.from(data.config); this.card.presentation.save(); }
      for (const snapshot of [this.previous, this.current]) if (snapshot) this.buffers.push(snapshot.buffer);
      // The layout and GPU resources stay fixed across a physics reset.
      // Only snapshot interpolation and local event history belong to the old world.
      this.previous = this.current = null; this.starfield.reset();
      this.report?.receive(data);
    } else this.report?.receive(data);
  }
  requestSnapshot() {
    if (this.closed || !this.ready || this.inflight) return;
    const buffer = this.buffers.pop();
    if (!buffer) { this.fail('Snapshot buffer ownership was lost'); return; }
    this.inflight = true;
    this.worker.postMessage({ type: 'snapshot', buffer }, [buffer]);
  }
  makeMeshes() {
    this.disposeMeshes();
    const [count, , , pitch, joinWidth] = this.layout;
    const ballGeometry = sphereGeometry(7);
    for (const name of ['pigmentA', 'pigmentB', 'pigmentC']) ballGeometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(this.layout[21] * 3), 3));
    const ballMaterial = new THREE.MeshLambertMaterial({ transparent: false, opacity: 1, depthWrite: true });
    ballMaterial.onBeforeCompile = shader => {
      this.lighting.apply(shader);
      shader.uniforms.swirlShape = { value: new THREE.Vector4(...this.layout.slice(23, 27)) };
      shader.uniforms.swirlEdges = { value: new THREE.Vector3(...this.layout.slice(27, 30)) };
      shader.vertexShader = 'attribute vec3 pigmentA; attribute vec3 pigmentB; attribute vec3 pigmentC; varying vec3 objectPoint; varying vec3 paintA; varying vec3 paintB; varying vec3 paintC;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nobjectPoint = position; paintA = pigmentA; paintB = pigmentB; paintC = pigmentC;');
      shader.fragmentShader = 'uniform vec4 swirlShape; uniform vec3 swirlEdges; varying vec3 objectPoint; varying vec3 paintA; varying vec3 paintB; varying vec3 paintC;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        // The core supplies the contact-local swirl profile and eased colors.
        // Material coordinates keep its soft curves attached while the ball rolls.
        vec3 surfacePoint = normalize(objectPoint);
        float wave = sin(swirlShape.x * surfacePoint.y + swirlShape.y * sin(swirlShape.z * surfacePoint.x) + swirlShape.w * surfacePoint.z);
        vec3 pigment = mix(mix(paintA, paintB, smoothstep(swirlEdges.x, swirlEdges.y, wave)), paintC, smoothstep(swirlEdges.y, swirlEdges.z, wave));
        diffuseColor.rgb = mix(diffuseColor.rgb, pigment, .78);`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += pigment * colorEmission.y;');
    };
    this.balls = new THREE.InstancedMesh(ballGeometry, ballMaterial, this.layout[21]);
    this.renderedTops = new Float32Array(count);
    // The visible post spans the same depth as its physical support surface.
    // Extend the outer ends in the vertex shader, using the physical support span.
    const geometry = new THREE.BoxGeometry(pitch, 1, 1, 3);
    const positions = geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      if (Math.abs(x) > 0 && Math.abs(x) < pitch / 2) positions.setX(i, Math.sign(x) * (pitch - joinWidth) / 2);
    }
    geometry.computeBoundingBox();
    // Joined bands have a single outer coating. Omit their internal side caps.
    geometry.setIndex(Array.from(geometry.index.array).slice(geometry.groups[2].start));
    geometry.clearGroups();
    geometry.setAttribute('rampHeights', new THREE.InstancedBufferAttribute(new Float32Array(count * 6 * 3), 3));
    geometry.setAttribute('backgroundOffset', new THREE.InstancedBufferAttribute(new Float32Array(count * 6), 1));
    geometry.setAttribute('edge', new THREE.InstancedBufferAttribute(this.meshEdges, 1));
    geometry.setAttribute('pulse', new THREE.InstancedBufferAttribute(this.meshPulses, 1));
    this.barRoof = { value: this.height };
    const material = new THREE.MeshLambertMaterial({ toneMapped: false });
    material.onBeforeCompile = shader => {
      this.lighting.apply(shader);
      Object.assign(shader.uniforms, { pixelRatio: this.pixelRatio, enclosureHeight: this.barRoof, barExtension: { value: this.layout[6] } });
      shader.vertexShader = `attribute vec3 rampHeights; attribute float backgroundOffset;
        ${BAR_PROFILE}
        uniform float enclosureHeight; uniform float barExtension; attribute float edge; attribute float pulse; varying float coloredPulse; varying float faceIsFront; varying float barHeight; varying vec3 local; varying vec3 world; varying float glow;\n` + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        float normalHeight, normalSlope; rampAt(position.x, rampHeights, normalHeight, normalSlope);
        if (normal.y > 0.5) objectNormal = vec3(-normalSlope, rampHeights.y, 0.0);`);
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nlocal = position; faceIsFront = abs(normal.z); barHeight = length(instanceMatrix[1].xyz) + barExtension; glow = edge; coloredPulse = pulse; world = (instanceMatrix * vec4(position, 1.0)).xyz;');
      shader.vertexShader = shader.vertexShader.replace('local = position;', 'float surfaceHeight, surfaceSlope; rampAt(position.x, rampHeights, surfaceHeight, surfaceSlope); transformed.y = (position.y + 0.5) * surfaceHeight / rampHeights.y - 0.5; local = position;');
      shader.vertexShader = shader.vertexShader.replace('localIllumination((instanceMatrix * vec4(position, 1.0)).xyz', 'localIllumination((instanceMatrix * vec4(transformed, 1.0)).xyz');
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', barProjection);
      // Repeated banks use the source bar's lighting position. Translation
      // changes drawing, but must not create a different light in each bank.
      shader.vertexShader = shader.vertexShader.replace('vViewPosition = - mvPosition.xyz;', 'vViewPosition = -(modelViewMatrix * vec4(world, 1.0)).xyz;');
      shader.fragmentShader = 'uniform float attackGlow; uniform float colorAttack; varying float coloredPulse; uniform float pixelRatio; uniform float enclosureHeight; uniform float halfWidth; varying float faceIsFront; varying float barHeight; varying vec3 local; varying vec3 world; varying float glow;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
          if (world.y < 0.0 || world.y > enclosureHeight || world.x < 0.0 || world.x > 1.2) discard;
          float distance = min(halfWidth - abs(local.x), barHeight * (.5 - abs(local.y)));
          float pixel = max(0.000001, min(pixelRatio * fwidth(distance), min(halfWidth, barHeight * .5) / 3.0));
          float front = faceIsFront;
          float inner = (1.0 - smoothstep(1.25 * pixel, 2.5 * pixel, distance)) * front;
          vec3 barColor = diffuseColor.rgb;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), inner * glow);`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * colorEmission.x + barColor * coloredPulse * colorAttack + vec3(glow * inner * attackGlow);');
    };
    this.bars = new THREE.InstancedMesh(geometry, material, count * 6);
    for (let i = 0; i < count * 6; i++) { this.color.fromArray(this.palette, (i % count) * 3); this.bars.setColorAt(i, this.color); }
    for (const mesh of [this.bars, this.balls]) { mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.scene.add(mesh); }
    this.sideBars = new SideBars(this.scene, this.bars, count);
    this.coating = new Enclosure(this.scene, this.lighting); this.enclosure = this.coating.mesh;
    this.starfield = new Starfield(this.scene, this.pixelRatio);
    this.renderer.compile(this.scene, this.camera);
  }
  draw(now) {
    this.updateScene(now);
    this.render();
  }
  // Prepare geometry and lighting separately from submitting a GPU frame.
  // Synthetic-clock fixtures can inspect this state without bypassing the
  // animation loop's bounded GPU queue with hundreds of immediate draws.
  updateScene(now) {
    const [count, , , pitch, joinWidth, , , , stride, barOffset] = this.layout;
    const current = this.current, previous = this.previous ?? current;
    this.fitEnclosure();
    const step = 1000 / this.layout[1];
    const span = Math.max(step, (current[0] - previous[0]) * 1000);
    // Keep one physics step of interpolation, even when receipts span several
    // steps. A slow renderer must not add its entire snapshot gap to attacks.
    const alpha = Math.min(1, Math.max(0, 1 - (step - (now - this.received)) / span));
    const geometry = this.layout[17];
    const height = previous[geometry] + (current[geometry] - previous[geometry]) * alpha, depth = previous[geometry + 4] + (current[geometry + 4] - previous[geometry + 4]) * alpha;
    this.renderedDepth = depth; this.barRoof.value = height;
    for (const [k, name] of ['pigmentA', 'pigmentB', 'pigmentC'].entries()) {
      const attr = this.balls.geometry.attributes[name];
      for (let i = 0; i < this.layout[21]; i++) {
        if (this.pigments) attr.array.set(this.pigments.subarray(i * 9 + k * 3, i * 9 + k * 3 + 3), i * 3);
        else attr.array.set(current.subarray(3 + i * stride + 15, 3 + i * stride + 18), i * 3);
      }
      attr.needsUpdate = true;
    }
    const phaseOffset = this.layout[20];
    const phaseDelta = ((current[phaseOffset] - previous[phaseOffset] + count * 1.5) % count) - count / 2;
    const phase = (previous[phaseOffset] + phaseDelta * alpha + count) % count;
    this.renderedPhase = phase;
    this.positionMeters(phase);
    for (let i = 0; i < this.layout[21]; i++) {
      const offset = 3 + i * stride;
      this.object.position.set(
        previous[offset] + (current[offset] - previous[offset]) * alpha,
        previous[offset + 1] + (current[offset + 1] - previous[offset + 1]) * alpha,
        previous[offset + 2] + (current[offset + 2] - previous[offset + 2]) * alpha);
      this.object.quaternion.fromArray(previous, offset + 3);
      this.quaternion.fromArray(current, offset + 3); this.object.quaternion.slerp(this.quaternion, alpha);
      this.object.scale.setScalar(current[offset + 7]); this.object.updateMatrix(); this.balls.setMatrixAt(i, this.object.matrix);
      this.color.fromArray(current, offset + 15); this.balls.setColorAt(i, this.color);
    }
    for (let i = 0; i < count; i++) {
      const top = this.renderedTops[i] = previous[barOffset + i] + (current[barOffset + i] - previous[barOffset + i]) * alpha;
      const maximum = previous[geometry + 1] + (current[geometry + 1] - previous[geometry + 1]) * alpha;
      const wave = this.waveLight(i, top, maximum, now / 1000, !this.listening);
      const edge = this.listening ? this.edges[i] : wave * (this.reduced.matches ? .5 : 1);
      // Shared display levels contain audio loudness; physical travel also
      // includes the decorative listening floor and must not set brightness.
      const pulse = (this.idle ? edge : this.edges[i]) * this.input[i];
      for (let copy = 0; copy < 6; copy++) {
        this.meshEdges[i + copy * count] = edge;
        this.meshPulses[i + copy * count] = pulse;
      }
      const column = (i + phase) % count;
      const heights = this.bars.geometry.attributes.rampHeights.array;
      for (let neighbour = -1; neighbour <= 1; neighbour++) {
        const offset = barOffset + (i + count + neighbour) % count;
        const value = previous[offset] + (current[offset] - previous[offset]) * alpha;
        for (let copy = 0; copy < 6; copy++) heights[(i + copy * count) * 3 + neighbour + 1] = value;
      }
      this.object.scale.set(1, top, depth);
      for (let end = 0; end < 2; end++) {
        this.object.quaternion.set(end, 0, 0, 1 - end);
        for (let copy = 0; copy < 3; copy++) {
          this.object.position.set((column + .5 + (copy === 1 ? -count : copy === 2 ? count : 0)) * pitch,
            end ? height - top / 2 : top / 2, 0);
          this.object.updateMatrix(); this.bars.setMatrixAt(i + copy * count + end * count * 3, this.object.matrix);
        }
      }
    }
    this.sideBars.update(this.layout, this.camera, depth);
    this.lighting.update(this, this.renderedTops, 0, phase, pitch, height, depth, joinWidth);
    this.balls.instanceMatrix.needsUpdate = true; this.balls.instanceColor.needsUpdate = true;
    this.bars.instanceMatrix.needsUpdate = true; this.bars.geometry.attributes.edge.needsUpdate = true;
    this.bars.geometry.attributes.pulse.needsUpdate = true;
    this.bars.geometry.attributes.rampHeights.needsUpdate = true;
    this.renderedEnclosureHeight = height;
    this.coating.update(this.width, height, depth);
    this.renderedAt = performance.timeOrigin + now;
    this.renderAlpha = alpha;
    this.starfield.update(now, this.reduced.matches, this.camera, phase, pitch, height, depth, this.meshEdges);
  }
  render(camera = this.camera) { this.renderer.render(this.scene, camera); }
  renderedHeight(band, end = 0) {
    const offset = (band + end * this.layout[0] * 3) * 16;
    // The matrix scale reports the source knot height, at its band centre.
    return Math.abs(this.bars.instanceMatrix.array[offset + 5]);
  }

  positionMeters(phase) {
    const count = this.meters.length;
    const frontDepth = (this.config?.[5] ?? .48) / 2;
    const pitch = this.layout?.[3] ?? this.width / count;
    this.graph.classList.add('paired-bars');
    this.camera.updateMatrixWorld();
    const height = this.current?.[this.layout?.[17]] ?? this.height;
    const maximum = this.current?.[this.layout?.[17] + 1] ?? this.height / 4;
    for (const [property, y] of [['--balloon-headroom', maximum], ['--plot-baseline', .003]]) {
      this.pointerPoint.set(0, y, frontDepth).project(this.camera);
      const top = (1 - this.pointerPoint.y) * 50;
      this.graph.style.setProperty(property, `${property === '--plot-baseline' ? 100 - top : top}%`);
    }
    this.pointerPoint.set(0, height / 2, frontDepth).project(this.camera);
    const inset = (this.pointerPoint.x + 1) * 50;
    this.graph.style.setProperty('--plot-side-inset', `${inset}%`);
    const projection = this.camera.projectionMatrix.elements[0], eyeHeight = this.camera.position.y;
    if (this.meterPhase === phase && this.meterInset === inset && this.meterRotation === this.rotation
      && this.meterProjection === projection && this.meterEyeHeight === eyeHeight && this.meterHeight === height) return;
    this.meterPhase = phase; this.meterInset = inset; this.meterRotation = this.rotation;
    this.meterProjection = projection; this.meterEyeHeight = eyeHeight; this.meterHeight = height;
    const wrapped = phase > .00001;
    if (wrapped !== this.wrappedLabels) {
      this.wrappedLabels = wrapped;
      const labels = this.card.querySelectorAll('.spectrum-labels span');
      ['BASS', 'MIDRANGE', 'TREBLE'].forEach((text, i) => { labels[i].textContent = wrapped ? '' : text; });
    }
    // One accessible node per source; only the pointer surface is copied at
    // the seam. Stationary frames do not repeat layout/style writes.
    for (let i = 0; i < count; i++) {
      const column = (i + phase) % count, group = this.groups[i], copy = this.copies[i];
      const projected = x => { this.pointerPoint.set(x * pitch, height / 2, frontDepth).project(this.camera); return (this.pointerPoint.x + 1) * 50; };
      const left = projected(column), right = projected(Math.min(count, column + 1));
      group.style.left = `${left}%`; group.style.width = `${Math.max(0, right - left)}%`;
      const seamLeft = projected(0), seamRight = projected(Math.max(0, column + 1 - count));
      copy.style.left = `${seamLeft}%`; copy.style.width = `${Math.max(0, seamRight - seamLeft)}%`;
    }
  }
  push(levels, edges, scrolling = false) {
    // One owner updates accessible values for both live audio and idle PCM.
    // Mixing JS preview writes with cached Rust attributes left stale values.
    for (let i = 0; i < 24; i++) {
      const value = Math.round(levels[i] * 100);
      if (value !== this.meterValues[i]) {
        this.meterValues[i] = value;
        this.meters[i].setAttribute('aria-valuenow', String(value));
      }
    }
    this.input.set(levels, 0); this.edges.set(edges);
    // Record real audio edges separately from decorative bar glow.
    this.input.set(edges, 38);
    this.input[33] = scrolling ? 1 : 0;
  }
  clearMotion() {
    this.lastGravity = this.lastAcceleration = null;
    this.acceleration = [0, 0, 0]; this.input.fill(0, 24, 27); this.input.fill(0, 34, 38);
  }
  clearAudio() { this.push(new Float32Array(24), new Float32Array(24), false); }
  pause() {
    if (this.request != null) cancelAnimationFrame(this.request);
    this.request = null;
    const paused = document.hidden || this.lost;
    if (paused) this.cameraPan.clear();
    this.cameraAt = null;
    this.starfield?.reset();
    this.fpsAt = performance.now(); this.fpsFrames = this.metrics.frames; this.frameRate = '— FPS';
    const readout = this.card.querySelector('.frame-rate');
    if (readout) readout.textContent = this.frameRate;
    this.onFrame(performance.now(), true);
    this.worker?.postMessage({ type: 'pause', paused });
    if (!paused && !this.closed) this.request = requestAnimationFrame(this.animate);
  }
  fail(message) { this.notice.show(`Physics stopped: ${message}`, 'Motion stopped. Reload to restart.'); this.report?.invalidate(message); this.lost = true; this.pause(); }
  disposeMeshes() {
    this.sideBars?.dispose(); this.sideBars = null;
    this.coating?.dispose(); this.coating = null;
    this.starfield?.dispose(); this.starfield = null;
    for (const mesh of [this.balls, this.bars]) if (mesh) { this.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose?.(); mesh.dispose?.(); } }
  close() {
    this.closed = true; this.cameraPan.clear(); this.stopPreview(); cancelAnimationFrame(this.request); this.notice.close();
    this.worker.terminate(); this.worker.onmessage = null; this.worker.onerror = null;
    this.observer.disconnect(); this.visibilityObserver.disconnect(); this.motion.close(); this.report?.close();
    for (const remove of this.listeners) remove();
    for (const copy of this.copies) copy.remove();
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.contextRestored);
    this.gpuFrames.clear(); this.disposeMeshes(); this.renderer.dispose(); this.renderer.forceContextLoss(); this.canvas.remove();
    delete this.graph.physics; this.current = this.previous = null; this.buffers = [];
  }
}
