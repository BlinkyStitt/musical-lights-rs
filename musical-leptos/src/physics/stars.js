import * as THREE from './three.module.js';
import { CATALOG } from './stars-catalog.js';

const BACKGROUND = 0x050814;
export const STAR_COUNT = CATALOG.length;
const BALL_COUNT = 8;
const bounded = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const smooth = value => { const t = bounded(value); return t * t * (3 - 2 * t); };

// A fixed equatorial view centred on Orion (RA 5.6 h, declination 0 degrees).
// East is left and celestial north is up. These are directions, not distances.
export function skyDirection(ra, dec) {
  const longitude = (5.6 - ra) * Math.PI / 12, latitude = dec * Math.PI / 180;
  return [Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude), Math.cos(latitude) * Math.cos(longitude)];
}

function starColor(index) {
  if (index == null) return [1, 1, 1];
  // Display tints from the catalog's measured B-V index, not spectral RGB data.
  const t = Math.max(0, Math.min(1, (index + .3) / 1.8));
  return t < .5 ? [.68 + .64 * t, .8 + .3 * t, 1 - .3 * t]
    : [1, .95 - .6 * (t - .5), .85 - .9 * (t - .5)];
}

// A fixed sky behind the room: one point batch, no textures or render targets.
// Its own projection preserves constellation shapes as the viewport changes.
export class Starfield {
  constructor(scene, pixelRatio) {
    this.scene = scene;
    this.background = new THREE.Color(BACKGROUND);
    scene.background = this.background;
    const positions = new Float32Array(STAR_COUNT * 3), properties = new Float32Array(STAR_COUNT * 4);
    const colors = new Float32Array(STAR_COUNT * 3), twinkles = new Float32Array(STAR_COUNT);
    for (let i = 0; i < STAR_COUNT; i++) {
      const [id, ra, dec, magnitude, color] = CATALOG[i];
      const hash = Math.imul(id, 2654435761) >>> 0;
      const prominence = Math.max(0, Math.min(1, (6.5 - magnitude) / 8));
      positions.set(skyDirection(ra, dec), i * 3);
      // Hashes choose only shimmer phase and rate; positions are catalog data.
      properties.set([1 + 2.2 * prominence ** 2, hash / 4294967296 * Math.PI * 2,
        1.2 + .6 * ((hash >>> 16) / 65536), .12 + .65 * 10 ** (-.16 * (magnitude + 1.5))], i * 4);
      colors.set(starColor(color), i * 3);
      // A stable half of the catalog twinkles; the other stars stay steady.
      twinkles[i] = (hash >>> 8) & 1;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('star', new THREE.BufferAttribute(properties, 4));
    geometry.setAttribute('tint', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('twinkle', new THREE.BufferAttribute(twinkles, 1));
    // Eight fixed influence records: screen position in scene-height units,
    // radius and modulation. No per-frame allocations or extra drawing passes.
    this.influences = Array.from({ length: BALL_COUNT }, () => new THREE.Vector4(0, 0, .35, 0));
    this.uniforms = { time: { value: 0 }, pixelRatio, background: { value: this.background },
      aspect: { value: 1 }, motion: { value: 1 }, balls: { value: this.influences } };
    this.rolling = new Float32Array(BALL_COUNT);
    this.speeds = new Float32Array(BALL_COUNT);
    this.targets = new Float32Array(BALL_COUNT);
    this.contacts = new Uint8Array(BALL_COUNT);
    this.bands = new Uint32Array(BALL_COUNT);
    this.bounces = new Float32Array(BALL_COUNT);
    this.bounceAt = new Float64Array(BALL_COUNT);
    this.projection = new THREE.Vector3();
    this.reset();
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, depthTest: false, depthWrite: false, toneMapped: false,
      vertexShader: `attribute vec4 star; attribute vec3 tint; attribute float twinkle;
        uniform float time; uniform float pixelRatio; uniform float aspect;
        uniform float motion; uniform vec4 balls[8];
        varying float brightness; varying vec3 starTint;
        void main() {
          vec2 screen = vec2(position.x, position.y) / (1.4004150764 * max(position.z, .000001));
          // Motion increases each selected star's own smooth variation. A
          // rotating ball can shimmer even when its screen centre is still.
          float variation = sin(time * star.z * 4.0 + star.y);
          float local = 0.0;
          for (int i = 0; i < 8; i++) {
            float distance = length(screen - balls[i].xy) / balls[i].z;
            local += (1.0 - smoothstep(.15, 1.0, distance)) * balls[i].w;
          }
          // Each star retains its catalog brightness, tint and fixed point size.
          // Ambient variation is at most +/-2%; the combined effect is bounded.
          float ambient = .02 * sin(time * star.z + star.y);
          // Bound overlaps before variation so crowded balls still twinkle.
          float modulation = clamp(ambient + min(local, .60) * (.5 + .5 * variation), -.02, .60);
          brightness = star.w * (1.0 + .75 * twinkle * motion * modulation);
          starTint = tint;
          gl_PointSize = star.x * max(1.0, pixelRatio);
          // Gnomonic projection, 70-degree vertical field. Reject the rear hemisphere.
          if (position.z <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          else gl_Position = vec4(position.x / (.7002075382 * aspect), position.y / .7002075382, position.z, position.z);
        }`,
      fragmentShader: `uniform vec3 background; varying float brightness; varying vec3 starTint;
        void main() {
          float radius = length(gl_PointCoord - .5) * 2.0;
          if (radius >= 1.0) discard;
          float glow = 1.0 - smoothstep(.1, 1.0, radius);
          gl_FragColor = vec4(mix(background, starTint * brightness, glow), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = -1000;
    scene.add(this.points);
  }
  reset() {
    this.tick = null; this.received = null; this.lastTime = null;
    this.phase = 0; this.wasTempo = false;
    for (const values of [this.rolling, this.speeds, this.targets, this.contacts, this.bands, this.bounces]) values.fill(0);
    this.bounceAt.fill(-Infinity);
    for (const influence of this.influences) influence.w = 0;
  }
  snapshot(values, layout, now) {
    const tick = values[2];
    // Repeated receipts must not refresh stale data or retrigger contact events.
    if (tick === this.tick) return;
    if (this.tick != null && tick < this.tick) this.reset();
    const first = this.tick == null;
    this.tick = tick; this.received = now;
    for (let i = 0; i < BALL_COUNT; i++) {
      const offset = 3 + i * layout[8], radius = values[offset + 7], mass = values[offset + 8];
      const speed = Math.max(Math.hypot(values[offset + 9], values[offset + 10], values[offset + 11]),
        radius * Math.hypot(values[offset + 12], values[offset + 13], values[offset + 14]));
      const impulse = values[layout[11] + i];
      const touching = Number.isFinite(impulse) && impulse > 0;
      if (!first && touching && !this.contacts[i] && this.speeds[i] > .04 && mass > 0 && impulse / mass > .15) {
        this.bounces[i] = bounded((impulse / mass - .15) / .6);
        this.bounceAt[i] = now;
      }
      this.speeds[i] = Number.isFinite(speed) ? speed : 0;
      this.targets[i] = bounded((speed - .015) / (.6 - .015));
      this.contacts[i] = touching ? 1 : 0;
      let bands = 0;
      for (let band = 0; band < layout[0]; band++) {
        if (values[layout[10] + i * layout[0] + band] > 0) bands |= 1 << band;
      }
      this.bands[i] = bands;
    }
  }
  place(index, position, radius, camera) {
    // Use the mesh's interpolated position, independently of event history.
    this.projection.copy(position).applyMatrix4(camera.matrixWorldInverse);
    const influence = this.influences[index];
    influence.z = Math.max(.35, Math.min(.75,
      12 * radius * camera.projectionMatrix.elements[5] / (2 * Math.max(.001, -this.projection.z))));
    this.projection.copy(position).project(camera);
    influence.x = this.projection.x * camera.aspect / 2;
    influence.y = this.projection.y / 2;
  }
  update(now, reducedMotion, aspect, bpm, confidence, playing, attacks) {
    const elapsed = this.lastTime == null ? 0 : Math.max(0, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const musical = playing && !reducedMotion;
    const tempo = musical && Number.isFinite(bpm) && bpm > 0 && Number.isFinite(confidence) && confidence > 0;
    if (tempo && this.wasTempo) this.phase = (this.phase + elapsed * bpm / 60) % 1;
    this.wasTempo = tempo;
    this.uniforms.time.value = reducedMotion ? 0 : (now / 1000) % 86400;
    this.uniforms.motion.value = reducedMotion ? 0 : 1;
    if (Number.isFinite(aspect) && aspect > 0) this.uniforms.aspect.value = aspect;
    const fresh = this.received == null ? 0 : 1 - smooth((now - this.received - 250) / 300);
    const beat = tempo ? .5 + .5 * Math.cos(2 * Math.PI * this.phase) : 0;
    for (let i = 0; i < BALL_COUNT; i++) {
      const target = this.targets[i];
      const duration = target > this.rolling[i] ? .08 : .3;
      this.rolling[i] += (target - this.rolling[i]) * (1 - Math.exp(-elapsed / duration));
      const age = now - this.bounceAt[i];
      const bounce = this.bounces[i] * smooth(age / 25) * (1 - smooth((age - 25) / 450));
      let attack = 0;
      if (musical) for (let band = 0; band < 24; band++) {
        if (this.bands[i] & (1 << band)) attack = Math.max(attack, bounded(attacks[band]));
      }
      const response = Math.max(this.rolling[i], bounce, attack);
      this.influences[i].w = reducedMotion ? 0 : fresh *
        (.30 * this.rolling[i] + .20 * bounce + .10 * attack + .05 * beat * response);
    }
  }
  dispose() {
    this.scene.remove(this.points);
    if (this.scene.background === this.background) this.scene.background = null;
    this.points.geometry.dispose(); this.points.material.dispose();
  }
}
