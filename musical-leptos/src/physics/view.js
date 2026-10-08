import * as THREE from './three.module.js';
import { RoundedBoxGeometry } from './RoundedBoxGeometry.js';
import { PhoneReport } from './report.js';
import { MirrorRoom, visiblePostProjection } from './mirrors.js';
import { SideBars } from './side-bars.js';

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
  constructor(layer, palette, onFrame, motion) {
    this.layer = layer;
    this.graph = layer.parentElement;
    this.card = this.graph.closest('.audio-card');
    this.onFrame = onFrame;
    this.palette = palette;
    this.closed = false;
    this.lost = false;
    this.ready = false;
    this.inflight = false;
    this.sequence = 0;
    this.input = new Float32Array(38);
    this.tempo = 120;
    this.accentSerial = 0; this.audioAccent = 0; this.idleAccent = 0;
    this.seed = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    this.settings = this.card.preferences ?? { directionOdds: [60, 200, .05, .5, 1], flight: 30, cameraMotion: true, cameraAngle: 0 };
    this.cameraBase = this.settings.cameraAngle; this.cameraDrag = false; this.lastAccentAt = -Infinity;
    this.edges = new Float32Array(24);
    this.meshEdges = new Float32Array(144);
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
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    // Bound fragment work on large and high-density displays. CSS controls
    // and text keep their native resolution. Physical and reflected edges
    // share the actual render scale, including after fullscreen resizes.
    this.pixelRatio = { value: 1 };
    this.renderer.localClippingEnabled = true;
    this.layer.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', '8 rigid balls, matching top and bottom audio bars, and an infinity mirror box');
    this.canvas = this.renderer.domElement;
    this.canvas.addEventListener('webglcontextlost', this.contextLost = event => {
      event.preventDefault(); this.lost = true; this.pause(); this.notice.show('Graphics paused. Waiting for the WebGL context.', 'Graphics paused. Waiting for recovery.');
      this.report?.invalidate('WebGL context lost');
    });
    this.canvas.addEventListener('webglcontextrestored', this.contextRestored = () => {
      this.lost = false; this.notice.clear(); this.pause();
    });
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 1.2));
    this.attackLights = Array.from({ length: 4 }, () => { const light = new THREE.PointLight(0xffffff, 0, .45, 2); this.scene.add(light); return light; });
    const light = new THREE.DirectionalLight(0xffffff, 1.8); light.position.set(-1, 3, 4); this.scene.add(light);
    this.pointerPoint = new THREE.Vector3(); this.pointerRay = new THREE.Raycaster(); this.pointerCoordinates = new THREE.Vector2(); this.pointerPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this.object = new THREE.Object3D(); this.color = new THREE.Color(); this.quaternion = new THREE.Quaternion();
    this.listeners = [];
    this.motion = motion;
    this.observer = new ResizeObserver(() => { this.resizePending = true; }); this.observer.observe(layer);
    this.sceneVisible = true;
    this.visibilityObserver = new IntersectionObserver(([entry]) => { this.sceneVisible = entry.isIntersecting; });
    this.visibilityObserver.observe(layer);
    this.controls = this.card.querySelector('.audio-controls'); this.observer.observe(this.controls);
    this.listen(window, 'scroll', () => this.measurePointer(), { passive: true });
    this.listen(document, 'visibilitychange', () => { if (document.hidden) this.report?.invalidate('Page hidden during test'); this.pause(); });
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
      for (let i = 0; i < 3; i++) this.input[24 + i] = now - this.accelerationAt < 150 ? this.acceleration[i] : 0;
      if (this.ready) {
        this.worker.postMessage({ type: 'pulse', timestamp: performance.timeOrigin + now,
          sequence: ++this.sequence, input: this.input, tempo: this.tempo, accent: this.accentSerial });
      }
      if (now - (this.tempoReadoutAt ?? -Infinity) >= 1000) {
        this.tempoReadoutAt = now;
        const readout = this.card.querySelector('.tempo-readout');
        if (readout) { const playing = this.card.dataset.audioState === 'playing'; readout.hidden = !playing; readout.textContent = playing ? `${Math.round(this.tempo)} BPM` : ''; readout.title = this.tempoConfidence > 0 ? 'Estimated musical tempo' : 'No reliable beat; easing toward 60 BPM'; }
      }
      this.updateCamera(now);
      const rendered = this.current && this.sceneVisible;
      if (rendered) this.draw(now);
      this.metrics.snapshotAgeMs = this.received == null ? 0 : now - this.received;
      const cost = performance.now() - start;
      if (rendered) { this.metrics.frames++; this.metrics.renderMs += cost; }
      this.report?.frame(frameTime, cost);
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
    this.listen(window, 'pointerup', () => { this.cameraDrag = false; });
    this.listen(window, 'pointercancel', () => { this.cameraDrag = false; });
    this.listen(camera, 'input', () => { this.cameraBase = Number(camera.value); this.settings.cameraAngle = this.cameraBase; this.setCamera(this.cameraBase); this.card.presentation?.save(); });
    this.listen(this.card, 'camera-reset', () => { this.cameraBase = 0; this.setCamera(0); });
    this.listen(this.card, 'display-settings', ({ detail }) => {
      this.settings = detail;
      if (this.mirrors && this.mirrors.count !== detail.mirrorCount) {
        this.mirrors.setCount(detail.mirrorCount);
      }
      if (detail.cameraAngle !== this.cameraBase) this.cameraBase = detail.cameraAngle;
      if (!this.report?.active) this.worker.postMessage({ type: 'dance', options: this.danceOptions() });
    });
    this.listen(this.card, 'audio-tempo', ({ detail }) => {
      if (Number.isFinite(detail.bpm)) { this.tempo = detail.bpm; this.tempoConfidence = detail.confidence; }
      const difference = (detail.accentSequence ?? 0) - this.audioAccent;
      if (difference > 0) { this.accentSerial += difference; this.lastAccentAt = performance.now(); }
      this.audioAccent = detail.accentSequence ?? 0;
    });
    this.listen(this.card, 'audio-session', ({ detail }) => {
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
      if (difference > 0) { this.accentSerial += difference; this.lastAccentAt = performance.now(); }
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
    this.input.set(this.rotate(x, y, angle), 34);
    this.input[36] = z;
    this.input[37] = 1;
  }
  // Device acceleration and gravity are both SI m/s². Inertia acts opposite
  // the phone's linear acceleration, with no visual gain or per-axis clipping.
  deviceAcceleration(x, y, z, angle) {
    this.acceleration = this.rotate(-x, -y, angle);
    this.acceleration[2] = -z;
    this.accelerationAt = performance.now();
  }
  rotate(x, y, angle) { const a = angle * Math.PI / 180; return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), 0]; }
  measurePointer() { this.motion.bounds = this.layer.getBoundingClientRect(); }
  measure() {
    const box = this.layer.getBoundingClientRect(); this.motion.bounds = box;
    if (box.width <= 0 || box.height <= 0) return;
    this.card.style.setProperty('--fullscreen-control-bottom', `${Math.max(0, this.controls.getBoundingClientRect().bottom - this.graph.getBoundingClientRect().top) + 8}px`);
    this.width = this.layout?.[2] ?? 1.2;
    this.height = Math.max(this.layout?.[19] ?? .4, this.width * box.height / box.width);
    if (this.input[32] !== this.height && this.timing.resizes.length < 5000) this.timing.resizes.push({ at: performance.now(), from: this.input[32], to: this.height });
    this.input[32] = this.height;
    if (box.width !== this.canvasWidth || box.height !== this.canvasHeight) {
      const ratio = Math.min(devicePixelRatio, 2, Math.sqrt(200000 / (box.width * box.height)));
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
    const key = `${visibleHeight}/${visibleWidth}/${barMax}`;
    if (key === this.geometryKey) return;
    this.geometryKey = key; this.visibleHeight = visibleHeight;
    this.camera.aspect = this.aspect;
    this.camera.near = 0.01; this.camera.far = 200;
    this.camera.updateProjectionMatrix(); this.setCamera(this.rotation ?? 0);
    this.positionMeters(this.renderedPhase ?? 0);
  }
  fitCamera() {
    this.camera.updateMatrixWorld();
    const depth = this.config?.[5] ?? .24;
    let tangent = 0;
    // Reserve space for the projected Quiet/Loud labels around the room.
    // Fit the geometry inside those CSS gutters; keep labels on their true
    // projected coordinates instead of clamping them away from the bar bases.
    const horizontal = Math.max(.5, 1 - 84 / this.canvasWidth);
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
    this.camera.position.set(this.width / 2 + Math.sin(angle) * 4, this.visibleHeight / 2 + verticalOffset, Math.cos(angle) * 4);
    this.camera.lookAt(this.width / 2, this.visibleHeight / 2, 0);
    this.fitCamera();
  }
  danceOptions() { return { odds: this.settings.directionOdds, flight: this.settings.flight / 100, seed: this.seed }; }
  updateCamera(now) {
    const moving = this.settings.cameraMotion && !this.reduced.matches && !this.cameraDrag;
    const age = Number.isFinite(this.lastAccentAt) ? Math.max(0, now - this.lastAccentAt) : 0;
    const kick = moving ? 1.5 * Math.exp(-age / 250) * Math.sin(age / 35) : 0;
    const yaw = Math.max(-40, Math.min(40, this.cameraBase + (moving ? 4 * Math.sin(now / 3600) : 0) + kick));
    this.automaticCamera = true;
    this.setCamera(yaw, moving ? Math.sin(now / 4400) * Math.tan(2 * Math.PI / 180) * 4 : 0);
    this.automaticCamera = false;
    if (!this.cameraDrag && now - (this.sliderAt ?? -Infinity) >= 50) {
      this.sliderAt = now; this.card.querySelector('.camera-rotation').value = yaw;
      this.card.querySelector('.camera-angle').textContent = yaw.toFixed(1) + '°';
    }
  }
  receive(data) {
    if (this.closed) return;
    if (data.type === 'error') { this.fail(data.message); return; }
    if (data.type === 'ready') {
      if (data.layout[18] !== 9 || data.layout[21] !== 8 || !Number.isInteger(data.layout[20])) { this.fail('Physics assets have mismatched protocol versions. Reload to update.'); return; }
      this.layout = data.layout; this.config = data.config; this.defaults = data.defaults;
      this.buffers = Array.from({ length: 3 }, () => new ArrayBuffer(this.layout[12] * 4));
      this.makeMeshes(); this.ready = true;
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
      this.config = data.config;
      if (data.type === 'reset' && this.card.presentation) { this.card.preferences.physics = Array.from(data.config); this.card.presentation.save(); }
      for (const snapshot of [this.previous, this.current]) if (snapshot) this.buffers.push(snapshot.buffer);
      this.previous = this.current = null; this.makeMeshes();
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
    const [count, , , pitch, gap, radius, postHeight] = this.layout;
    const ballGeometry = new THREE.SphereGeometry(1, 20, 14);
    for (const name of ['pigmentA', 'pigmentB', 'pigmentC']) ballGeometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(this.layout[21] * 3), 3));
    const ballMaterial = new THREE.MeshLambertMaterial();
    this.patternTime = { value: 0 };
    ballMaterial.onBeforeCompile = shader => {
      shader.uniforms.patternTime = this.patternTime;
      shader.vertexShader = 'attribute vec3 pigmentA; attribute vec3 pigmentB; attribute vec3 pigmentC; varying vec3 objectPoint; varying vec3 paintA; varying vec3 paintB; varying vec3 paintC;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nobjectPoint = position; paintA = pigmentA; paintB = pigmentB; paintC = pigmentC;');
      shader.fragmentShader = 'uniform float patternTime; varying vec3 objectPoint; varying vec3 paintA; varying vec3 paintB; varying vec3 paintC;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        float wave = sin(7.0 * objectPoint.y + 3.0 * sin(3.0 * objectPoint.x + patternTime) + 4.0 * objectPoint.z);
        vec3 pigment = mix(mix(paintA, paintB, smoothstep(-0.85, 0.15, wave)), paintC, smoothstep(0.15, 0.9, wave));
        diffuseColor.rgb = mix(diffuseColor.rgb, pigment, .78);`);
    };
    this.balls = new THREE.InstancedMesh(ballGeometry, ballMaterial, this.layout[21]);
    // Two chords per quarter-circle keep the narrow caps smooth at screen size.
    // Avoid dense subdivisions across all six faces of each long bar.
    const geometry = new RoundedBoxGeometry(pitch - gap, postHeight, this.config[5], 1, radius);
    geometry.setAttribute('edge', new THREE.InstancedBufferAttribute(this.meshEdges, 1));
    this.barRoof = { value: this.height };
    const material = new THREE.MeshLambertMaterial({ toneMapped: false });
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, { pixelRatio: this.pixelRatio, enclosureHeight: this.barRoof, halfWidth: { value: (pitch - gap) / 2 }, halfDepth: { value: this.config[5] / 2 }, radius: { value: radius }, postHeight: { value: postHeight } });
      shader.vertexShader = 'uniform float enclosureHeight; attribute float edge; varying vec3 local; varying vec3 world; varying float glow;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nlocal = position; glow = edge; world = (instanceMatrix * vec4(position, 1.0)).xyz;');
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', visiblePostProjection);
      shader.fragmentShader = 'uniform float pixelRatio; uniform float enclosureHeight; uniform float halfWidth; uniform float halfDepth; uniform float radius; uniform float postHeight; varying vec3 local; varying vec3 world; varying float glow;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
          if (world.y < 0.0 || world.y > enclosureHeight || world.x < 0.0 || world.x > 1.2) discard;
          vec2 q = vec2(abs(local.x) - (halfWidth - radius), local.y - (postHeight * 0.5 - radius));
          float distance = min(radius - (length(max(q, 0.0)) + min(max(q.x, q.y), 0.0)), min(world.y, enclosureHeight - world.y));
          float pixel = pixelRatio * fwidth(distance);
          float front = step(halfDepth - radius - 0.00001, abs(local.z));
          float outline = (1.0 - smoothstep(0.5 * pixel, 1.5 * pixel, distance)) * front;
          float inner = (1.0 - smoothstep(1.5 * pixel, 2.5 * pixel, distance)) * front;
          diffuseColor.rgb = mix(mix(diffuseColor.rgb, vec3(1.0), inner * glow), vec3(0.0), outline);`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(glow * inner * (1.0 - outline) * .8);');
      // Keep the boundary dark after lighting.
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight *= 1.0 - outline;\n#include <opaque_fragment>');
    };
    this.bars = new THREE.InstancedMesh(geometry, material, count * 6);
    for (let i = 0; i < count * 6; i++) { this.color.fromArray(this.palette, (i % count) * 3); this.bars.setColorAt(i, this.color); }
    for (const mesh of [this.bars, this.balls]) { mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.scene.add(mesh); }
    this.sideBars = new SideBars(this.scene, this.bars, count, this.palette);
    this.ceiling = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, this.config[5] / 2), new THREE.Vector3(this.width, 0, this.config[5] / 2),
    ]), new THREE.LineBasicMaterial({ color: getComputedStyle(this.graph).getPropertyValue('--line').trim() }));
    this.scene.add(this.ceiling);
    this.mirrors = new MirrorRoom(this.scene, this.balls, this.bars, this.width, this.settings.mirrorCount);
    this.enclosure = this.mirrors.walls;
  }
  draw(now) {
    const [count, , , pitch, , , postHeight, , stride, barOffset] = this.layout;
    const current = this.current, previous = this.previous ?? current;
    this.fitEnclosure();
    this.ceiling.position.y = current[this.layout[17]];
    const height = current[this.layout[17]], depth = this.config[5];
    this.barRoof.value = height;
    if (!this.reduced.matches) this.patternTime.value = now / 10000;
    for (const [k, name] of ['pigmentA', 'pigmentB', 'pigmentC'].entries()) {
      const attr = this.balls.geometry.attributes[name];
      for (let i = 0; i < this.layout[21]; i++) {
        if (this.pigments) attr.array.set(this.pigments.subarray(i * 9 + k * 3, i * 9 + k * 3 + 3), i * 3);
        else attr.array.set(current.subarray(3 + i * stride + 15, 3 + i * stride + 18), i * 3);
      }
      attr.needsUpdate = true;
    }
    const span = Math.max(1000 / 120, (current[0] - previous[0]) * 1000);
    const alpha = Math.min(1, Math.max(0, (now - this.received) / span));
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
      const top = previous[barOffset + i] + (current[barOffset + i] - previous[barOffset + i]) * alpha;
      const column = (i + phase) % count;
      this.object.scale.setScalar(1);
      for (let end = 0; end < 2; end++) {
        this.object.quaternion.set(end, 0, 0, 1 - end);
        for (let copy = 0; copy < 3; copy++) {
          this.object.position.set((column + .5 + (copy === 1 ? -count : copy === 2 ? count : 0)) * pitch,
            end ? height - top + postHeight / 2 : top - postHeight / 2, 0);
          this.object.updateMatrix(); this.bars.setMatrixAt(i + copy * count + end * count * 3, this.object.matrix);
        }
      }
    }
    this.sideBars.update(this.layout, height, depth, phase, this.meshEdges);
    let used = 0;
    for (let i = 0; i < count && used < this.attackLights.length; i++) {
      const glow = this.meshEdges[i];
      if (glow < .05) continue;
      const light = this.attackLights[used++];
      light.position.set(((i + phase) % count + .5) * pitch, used % 2 ? current[barOffset + i] + .025 : height - current[barOffset + i] - .025, depth / 2 + .025);
      light.intensity = .035 * glow;
    }
    while (used < this.attackLights.length) this.attackLights[used++].intensity = 0;
    this.balls.instanceMatrix.needsUpdate = true; this.balls.instanceColor.needsUpdate = true;
    this.bars.instanceMatrix.needsUpdate = true; this.bars.geometry.attributes.edge.needsUpdate = true;
    this.renderedEnclosureHeight = height;
    this.mirrors.update(this.width, height, depth);
    this.renderedAt = performance.timeOrigin + now;
    this.renderAlpha = alpha;
    this.renderer.render(this.scene, this.camera);
  }
  renderedHeight(band, end = 0) {
    const center = this.bars.instanceMatrix.array[(band + end * this.layout[0] * 3) * 16 + 13];
    if (end) return this.renderedEnclosureHeight + this.layout[6] / 2 - center;
    return center + this.layout[6] / 2;
  }
  positionMeters(phase) {
    const count = this.meters.length;
    const pitch = this.layout?.[3] ?? this.width / count;
    this.graph.classList.add('paired-bars');
    this.camera.updateMatrixWorld();
    const height = this.current?.[this.layout?.[17]] ?? this.height;
    const maximum = this.current?.[this.layout?.[17] + 1] ?? this.height / 4;
    const guide = this.graph.querySelector('.meter-guide');
    for (const [i, y] of [height - .003, height - maximum, maximum, .003].entries()) {
      this.pointerPoint.set(0, y, 0).project(this.camera);
      const top = (1 - this.pointerPoint.y) * 50;
      if (guide?.children[i]) guide.children[i].style.top = `${top}%`;
      if (i === 2) this.graph.style.setProperty('--balloon-headroom', `${top}%`);
      if (i === 3) this.graph.style.setProperty('--plot-baseline', `${100 - top}%`);
    }
    this.pointerPoint.set(0, height / 2, 0).project(this.camera);
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
      ['BASS', 'MIDRANGE', 'TREBLE'].forEach((text, i) => { labels[i].textContent = wrapped ? (i === 1 ? 'SCROLLING ↔' : '') : text; });
    }
    // One accessible node per source; only the pointer surface is copied at
    // the seam. Stationary frames do not repeat layout/style writes.
    for (let i = 0; i < count; i++) {
      const column = (i + phase) % count, group = this.groups[i], copy = this.copies[i];
      const projected = x => { this.pointerPoint.set(x * pitch, height / 2, 0).project(this.camera); return (this.pointerPoint.x + 1) * 50; };
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
    for (let copy = 0; copy < 6; copy++) this.meshEdges.set(edges, copy * 24);
    this.input[33] = scrolling ? 1 : 0;
  }
  clearMotion() { this.acceleration = [0, 0, 0]; this.input.fill(0, 24, 27); this.input.fill(0, 34, 38); }
  clearAudio() { this.push(new Float32Array(24), new Float32Array(24), false); }
  pause() {
    if (this.request != null) cancelAnimationFrame(this.request);
    this.request = null;
    const paused = document.hidden || this.lost;
    this.onFrame(performance.now(), true);
    this.worker?.postMessage({ type: 'pause', paused });
    if (!paused && !this.closed) this.request = requestAnimationFrame(this.animate);
  }
  fail(message) { this.notice.show(`Physics stopped: ${message}`, 'Motion stopped. Reload to restart.'); this.report?.invalidate(message); this.lost = true; this.pause(); }
  disposeMeshes() {
    this.sideBars?.dispose(); this.sideBars = null;
    this.mirrors?.dispose(); this.mirrors = null;
    for (const mesh of [this.balls, this.bars, this.ceiling]) if (mesh) { this.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose?.(); mesh.dispose?.(); } }
  close() {
    this.closed = true; this.stopPreview(); cancelAnimationFrame(this.request); this.notice.close();
    this.worker.terminate(); this.worker.onmessage = null; this.worker.onerror = null;
    this.observer.disconnect(); this.visibilityObserver.disconnect(); this.motion.close(); this.report?.close();
    for (const remove of this.listeners) remove();
    for (const copy of this.copies) copy.remove();
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.contextRestored);
    this.disposeMeshes(); this.renderer.dispose(); this.renderer.forceContextLoss(); this.canvas.remove();
    delete this.graph.physics; this.current = this.previous = null; this.buffers = [];
  }
}
