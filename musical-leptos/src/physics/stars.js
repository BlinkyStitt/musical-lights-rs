import * as THREE from './three.module.js';
import { CATALOG } from './stars-catalog.js';

const BACKGROUND = 0x050814;
export const STAR_COUNT = CATALOG.length;

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
    const colors = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const [id, ra, dec, magnitude, color] = CATALOG[i];
      const hash = Math.imul(id, 2654435761) >>> 0;
      const prominence = Math.max(0, Math.min(1, (6.5 - magnitude) / 8));
      positions.set(skyDirection(ra, dec), i * 3);
      // Hashes choose only twinkle phase and musical band; positions are catalog data.
      properties.set([1 + 2.2 * prominence ** 2, hash / 4294967296 * Math.PI * 2,
        hash % 24, .12 + .65 * 10 ** (-.16 * (magnitude + 1.5))], i * 4);
      colors.set(starColor(color), i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('star', new THREE.BufferAttribute(properties, 4));
    geometry.setAttribute('tint', new THREE.BufferAttribute(colors, 3));
    this.uniforms = { time: { value: 0 }, pixelRatio, background: { value: this.background },
      aspect: { value: 1 }, beat: { value: 0 }, musical: { value: 0 }, attacks: { value: new Float32Array(24) } };
    this.phase = 0; this.lastTime = null;
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, depthTest: false, depthWrite: false, toneMapped: false,
      vertexShader: `attribute vec4 star; attribute vec3 tint;
        uniform float time; uniform float pixelRatio; uniform float aspect;
        uniform float beat; uniform float musical; uniform float attacks[24];
        varying float brightness; varying vec3 starTint;
        void main() {
          // Independent glints continue with all audio stopped. Different
          // phases and rates keep the catalog sky from pulsing as one sheet.
          float cycle = .5 + .5 * sin(time * (1.2 + .6 * fract(star.y)) + star.y);
          float glint = pow(cycle, 10.0);
          float pulse = musical * pow(.5 + .5 * cos(6.28318530718 * beat + star.y), 8.0);
          float attack = attacks[int(star.z)];
          // Halfway between the earlier subtle shimmer and the stronger glints.
          brightness = min(1.0, star.w * (.575 + .425 * cycle)
            + (.1 + .175 * star.w) * glint + (.275 + .11 * star.w) * pulse
            + (.4 + .325 * star.w) * attack);
          starTint = tint;
          // Keep bright catalog stars visible when the room lowers its render resolution.
          gl_PointSize = (star.x + .4 * glint + .3 * pulse + .6 * attack) * max(1.0, pixelRatio);
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
  update(now, reducedMotion, aspect, bpm, confidence, playing, attacks) {
    const elapsed = this.lastTime == null ? 0 : Math.max(0, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const musical = playing && !reducedMotion;
    const tempo = musical && Number.isFinite(bpm) && bpm > 0 && Number.isFinite(confidence) && confidence > 0;
    if (tempo && this.wasTempo) this.phase = (this.phase + elapsed * bpm / 60) % 1;
    this.wasTempo = tempo;
    this.uniforms.time.value = reducedMotion ? 0 : (now / 1000) % 86400;
    if (Number.isFinite(aspect) && aspect > 0) this.uniforms.aspect.value = aspect;
    this.uniforms.beat.value = this.phase;
    this.uniforms.musical.value = tempo ? 1 : 0;
    for (let i = 0; i < 24; i++) this.uniforms.attacks.value[i] = musical && Number.isFinite(attacks[i])
      ? Math.max(0, Math.min(1, attacks[i])) : 0;
  }
  dispose() {
    this.scene.remove(this.points);
    if (this.scene.background === this.background) this.scene.background = null;
    this.points.geometry.dispose(); this.points.material.dispose();
  }
}
