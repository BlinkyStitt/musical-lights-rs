import * as THREE from './three.module.js';
import { RoundedBoxGeometry } from './RoundedBoxGeometry.js';
import { PhoneReport } from './report.js';

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
    this.input = new Float32Array(33);
    this.edges = new Float32Array(24);
    this.acceleration = [0, 0, 0];
    this.tilt = [0, 0, 0];
    this.accelerationAt = 0;
    this.metrics = { frames: 0, renderMs: 0, debt: 0, maxDebt: 0, physicsSteps: 0, physicsMs: 0, discardedSimulationMs: 0 };
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    this.status = this.card.querySelector('.physics-status');
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera();
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.layer.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', '24 rigid balls and audio bars');
    this.canvas = this.renderer.domElement;
    this.canvas.addEventListener('webglcontextlost', this.contextLost = event => {
      event.preventDefault(); this.lost = true; this.pause(); this.status.textContent = 'Graphics paused. Waiting for the WebGL context.';
      this.report?.invalidate('WebGL context lost');
    });
    this.canvas.addEventListener('webglcontextrestored', this.contextRestored = () => {
      this.lost = false; this.status.textContent = ''; this.pause();
    });
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 2));
    const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(-1, 3, 4); this.scene.add(light);
    this.pointerPoint = new THREE.Vector3(); this.pointerDirection = new THREE.Vector3();
    this.object = new THREE.Object3D(); this.color = new THREE.Color(); this.quaternion = new THREE.Quaternion();
    this.listeners = [];
    this.motion = motion;
    this.observer = new ResizeObserver(() => this.measure()); this.observer.observe(layer);
    this.listen(window, 'scroll', () => this.measurePointer(), { passive: true });
    this.listen(document, 'visibilitychange', () => { if (document.hidden) this.report?.invalidate('Page hidden during test'); this.pause(); });
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'rigid-body-physics' });
    this.worker.onmessage = event => this.receive(event.data);
    this.worker.onerror = event => this.fail(event.message);
    this.measure();
    this.worker.postMessage({ type: 'init', palette, height: this.height, paused: document.hidden });
    this.graph.physics = this;
    this.animate = now => {
      this.request = null;
      if (this.closed || document.hidden || this.lost) return;
      const start = performance.now();
      this.onFrame(now, false);
      this.input[31] = this.reduced.matches ? 1 : 0;
      for (let i = 0; i < 3; i++) this.input[24 + i] = Math.max(-100, Math.min(100,
        this.tilt[i] + (now - this.accelerationAt < 150 ? this.acceleration[i] : 0)));
      if (this.ready && !this.inflight) {
        const buffer = this.spare?.buffer ?? this.buffers.pop();
        this.spare = null;
        this.worker.postMessage({ type: 'pulse', timestamp: performance.timeOrigin + now,
          sequence: ++this.sequence, input: this.input, buffer }, buffer ? [buffer] : []);
        this.inflight = true;
      }
      if (this.current) this.draw(now);
      const cost = performance.now() - start;
      this.metrics.frames++; this.metrics.renderMs += cost;
      this.report?.frame(now, cost);
      if (!this.lastStatus || now - this.lastStatus > 1000) {
        this.status.textContent = this.report?.active ? this.report.query('.phone-progress').textContent
          : this.report?.result ? this.report.query('.phone-progress').textContent + (this.card.hasAttribute('data-expanded') ? ' Exit fullscreen to review and export the report.' : '')
          : this.metrics.debt > 2 * 1000 / (this.layout?.[1] ?? 120) ? `Physics delay: ${this.metrics.debt.toFixed(1)} ms` : '';
        this.lastStatus = now;
      }
      this.request = requestAnimationFrame(this.animate);
    };
    this.pause();
  }
  listen(target, name, callback, options) { target.addEventListener(name, callback, options); this.listeners.push(() => target.removeEventListener(name, callback, options)); }
  pointer(x, y, inside) {
    this.input[27] = inside ? 1 : 0;
    this.pointerPoint.set(x * 2 - 1, y * 2 - 1, 0).unproject(this.camera);
    this.camera.getWorldDirection(this.pointerDirection);
    this.pointerPoint.addScaledVector(this.pointerDirection, -this.pointerPoint.z / this.pointerDirection.z);
    this.input[28] = this.pointerPoint.x; this.input[29] = this.pointerPoint.y; this.input[30] = 0;
  }
  orientation(beta, gamma, angle) { this.tilt = this.rotate(Math.sin(gamma * Math.PI / 180) * 2, -Math.sin(beta * Math.PI / 180) * 2, angle); }
  deviceAcceleration(x, y, angle) { this.acceleration = this.rotate(-x, -y, angle); this.accelerationAt = performance.now(); }
  rotate(x, y, angle) { const a = angle * Math.PI / 180; return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), 0]; }
  measurePointer() { this.motion.bounds = this.layer.getBoundingClientRect(); }
  measure() {
    const box = this.layer.getBoundingClientRect(); this.motion.bounds = box;
    if (box.width <= 0 || box.height <= 0) return;
    this.width = this.layout?.[2] ?? 1.2;
    this.height = this.width * box.height / box.width;
    this.input[32] = this.height;
    this.renderer.setSize(box.width, box.height, false);
    this.camera.left = -this.width / 2; this.camera.right = this.width / 2;
    this.camera.top = this.height / 2; this.camera.bottom = -this.height / 2;
    this.camera.near = 0.01; this.camera.far = 200;
    this.camera.updateProjectionMatrix(); this.setCamera(this.rotation ?? 0);
  }
  setCamera(degrees) {
    if (degrees !== this.rotation) this.report?.invalidate('Camera changed during test');
    this.rotation = degrees;
    const angle = degrees * Math.PI / 180;
    this.camera.position.set(this.width / 2 + Math.sin(angle) * 4, this.height / 2, Math.cos(angle) * 4);
    this.camera.lookAt(this.width / 2, this.height / 2, 0);
  }
  receive(data) {
    if (this.closed) return;
    if (data.type === 'error') { this.fail(data.message); return; }
    if (data.type === 'ready') {
      this.layout = data.layout; this.config = data.config;
      this.buffers = Array.from({ length: 3 }, () => new ArrayBuffer(this.layout[12] * 4));
      this.makeMeshes(); this.ready = true;
      this.report = new PhoneReport(this);
    } else if (data.type === 'snapshot') {
      this.spare = this.previous;
      this.previous = this.current;
      this.current = new Float32Array(data.buffer);
      this.received = performance.now(); this.inflight = false;
      this.metrics.debt = data.debt; this.metrics.maxDebt = data.maxDebt;
      this.metrics.physicsSteps = data.steps; this.metrics.physicsMs = data.totalCost;
    } else if (data.type === 'reset' || data.type === 'recording') {
      this.config = data.config;
      if (this.previous) this.spare = this.previous;
      this.previous = null; this.makeMeshes();
      this.report?.receive(data);
    } else this.report?.receive(data);
  }
  makeMeshes() {
    this.disposeMeshes();
    const [count, , , pitch, gap, radius, postHeight] = this.layout;
    this.balls = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 }), count);
    const geometry = new RoundedBoxGeometry(pitch - gap, postHeight, this.config[5], 3, radius);
    geometry.setAttribute('edge', new THREE.InstancedBufferAttribute(this.edges, 1));
    const material = new THREE.ShaderMaterial({
      uniforms: { halfWidth: { value: (pitch - gap) / 2 }, radius: { value: radius }, postHeight: { value: postHeight } },
      vertexShader: `attribute float edge;
        varying vec3 tint; varying vec3 local; varying vec3 world; varying float glow;
        void main() { local = position; glow = edge; tint = instanceColor;
          vec4 p = instanceMatrix * vec4(position, 1.0); world = p.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * p; }`,
      fragmentShader: `uniform float halfWidth; uniform float radius; uniform float postHeight;
        varying vec3 tint; varying vec3 local; varying vec3 world; varying float glow;
        void main() {
          if (world.y < 0.0) discard;
          vec2 q = vec2(abs(local.x) - (halfWidth - radius), local.y - (postHeight * 0.5 - radius));
          float distance = radius - (length(max(q, 0.0)) + min(max(q.x, q.y), 0.0));
          distance = min(distance, world.y);
          // fwidth is one device pixel. Scale to one CSS pixel at the capped pixel ratio.
          float inner = 1.0 - smoothstep((PIXEL_RATIO - 0.5) * fwidth(distance), (PIXEL_RATIO + 0.5) * fwidth(distance), distance);
          vec3 fill = mix(tint, vec3(1.0), glow * 0.22);
          gl_FragColor = vec4(mix(fill, vec3(1.0), inner * glow), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      defines: { PIXEL_RATIO: Math.min(devicePixelRatio, 2).toFixed(1) },
    });
    this.bars = new THREE.InstancedMesh(geometry, material, count);
    for (let i = 0; i < count; i++) { this.color.fromArray(this.palette, i * 3); this.bars.setColorAt(i, this.color); }
    for (const mesh of [this.bars, this.balls]) { mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.scene.add(mesh); }
  }
  draw(now) {
    const [count, , , pitch, , , postHeight, , stride, barOffset] = this.layout;
    const current = this.current, previous = this.previous ?? current;
    const span = Math.max(1000 / 120, (current[0] - previous[0]) * 1000);
    const alpha = Math.min(1, Math.max(0, (now - this.received) / span));
    for (let i = 0; i < count; i++) {
      const offset = 3 + i * stride;
      this.object.position.set(
        previous[offset] + (current[offset] - previous[offset]) * alpha,
        previous[offset + 1] + (current[offset + 1] - previous[offset + 1]) * alpha,
        previous[offset + 2] + (current[offset + 2] - previous[offset + 2]) * alpha);
      this.object.quaternion.fromArray(previous, offset + 3);
      this.quaternion.fromArray(current, offset + 3); this.object.quaternion.slerp(this.quaternion, alpha);
      this.object.scale.setScalar(current[offset + 7]); this.object.updateMatrix(); this.balls.setMatrixAt(i, this.object.matrix);
      this.color.fromArray(current, offset + 15); this.balls.setColorAt(i, this.color);
      const top = previous[barOffset + i] + (current[barOffset + i] - previous[barOffset + i]) * alpha;
      this.object.position.set((i + 0.5) * pitch, top - postHeight / 2, 0);
      this.object.quaternion.identity(); this.object.scale.setScalar(1); this.object.updateMatrix(); this.bars.setMatrixAt(i, this.object.matrix);
    }
    this.balls.instanceMatrix.needsUpdate = true; this.balls.instanceColor.needsUpdate = true;
    this.bars.instanceMatrix.needsUpdate = true; this.bars.geometry.attributes.edge.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }
  push(levels, edges) { this.input.set(levels, 0); this.edges.set(edges); }
  stopMotion() { this.motion.stopMotion(); this.tilt = [0, 0, 0]; this.acceleration = [0, 0, 0]; this.input.fill(0, 0, 27); this.edges.fill(0); }
  pause() {
    if (this.request != null) cancelAnimationFrame(this.request);
    this.request = null;
    const paused = document.hidden || this.lost;
    this.onFrame(performance.now(), true);
    this.worker?.postMessage({ type: 'pause', paused });
    if (!paused && !this.closed) this.request = requestAnimationFrame(this.animate);
  }
  fail(message) { this.status.textContent = `Physics stopped: ${message}`; this.report?.invalidate(message); this.lost = true; this.pause(); }
  disposeMeshes() { for (const mesh of [this.balls, this.bars]) if (mesh) { this.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose(); } }
  close() {
    this.closed = true; cancelAnimationFrame(this.request);
    this.worker.terminate(); this.worker.onmessage = null; this.worker.onerror = null;
    this.observer.disconnect(); this.motion.close(); this.report?.close();
    for (const remove of this.listeners) remove();
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.contextRestored);
    this.disposeMeshes(); this.renderer.dispose(); this.renderer.forceContextLoss(); this.canvas.remove();
    delete this.graph.physics; this.current = this.previous = this.spare = null;
  }
}
