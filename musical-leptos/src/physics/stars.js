import * as THREE from './three.module.js';
import { CATALOG } from './stars-catalog.js';
import { BOX_OFFSETS } from './enclosure.js';

const BACKGROUND = 0x050814;
export const STAR_COUNT = CATALOG.length;
const BAND_COUNT = 24;
const bounded = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

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
    // A screen-to-room homography aligns the fixed sky to the bars' front face.
    // The periodic band lookup visits only two neighbours, including all banks.
    this.viewProjection = new THREE.Matrix4();
    this.flashes = new Float32Array(BAND_COUNT);
    this.uniforms = { time: { value: 0 }, pixelRatio, background: { value: this.background },
      aspect: { value: 1 }, motion: { value: 1 }, flashes: { value: this.flashes },
      starToRoom: { value: new THREE.Matrix3() }, extent: { value: new THREE.Vector4() }, phase: { value: 0 } };
    this.reset();
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, depthTest: false, depthWrite: false, toneMapped: false,
      vertexShader: `attribute vec4 star; attribute vec3 tint; attribute float twinkle;
        uniform float time; uniform float pixelRatio; uniform float aspect;
        uniform float motion; uniform float flashes[24];
        uniform mat3 starToRoom; uniform vec4 extent; uniform float phase;
        varying float brightness; varying vec3 starTint;
        void main() {
          vec2 screen = vec2(position.x, position.y) / (1.4004150764 * max(position.z, .000001));
          vec3 room = starToRoom * vec3(2.0 * screen.x / aspect, 2.0 * screen.y, 1.0);
          float local = 0.0;
          if (extent.y > 0.0 && abs(room.z) > .000001) {
            vec2 point = room.xy / room.z;
            if (point.x >= extent.z && point.x <= extent.w && point.y >= 0.0 && point.y <= extent.y) {
              float column = point.x / extent.x - phase - .5;
              float left = floor(column), fraction = column - left;
              // A one-bar core and a half-bar soft edge on each side. Adjacent
              // flashes add; repeating a bank never adds another copy of a light.
              local = 4.0 * ((1.0 - smoothstep(.5, 1.0, fraction)) * flashes[int(mod(left, 24.0))]
                + (1.0 - smoothstep(.5, 1.0, 1.0 - fraction)) * flashes[int(mod(left + 1.0, 24.0))]);
            }
          }
          // Catalog brightness, tint and point size stay fixed. The local flash
          // uses the bars' displayed envelope directly; ambient shimmer is +/-2%.
          float ambient = .02 * sin(time * star.z + star.y);
          float modulation = ambient + local;
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
    this.flashes.fill(0);
    this.uniforms.extent.value.y = 0;
  }
  update(now, reducedMotion, camera, phase, pitch, height, depth, flashes) {
    this.uniforms.time.value = reducedMotion ? 0 : (now / 1000) % 86400;
    this.uniforms.motion.value = reducedMotion ? 0 : 1;
    this.uniforms.aspect.value = camera.aspect;
    this.uniforms.phase.value = phase;
    const width = BAND_COUNT * pitch;
    this.uniforms.extent.value.set(pitch, height, BOX_OFFSETS[0] * width, (BOX_OFFSETS[BOX_OFFSETS.length - 1] + 1) * width);
    camera.updateMatrixWorld();
    const m = this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const z = depth / 2;
    // Restrict the camera projection to the full-depth bars' front plane, then
    // invert it. This handles yaw, pitch, pan, aspect and depth without moving stars.
    this.uniforms.starToRoom.value.set(m[0], m[4], m[8] * z + m[12],
      m[1], m[5], m[9] * z + m[13], m[3], m[7], m[11] * z + m[15]).invert();
    for (let i = 0; i < BAND_COUNT; i++) this.flashes[i] = reducedMotion ? 0 : bounded(flashes[i]);
  }
  dispose() {
    this.scene.remove(this.points);
    if (this.scene.background === this.background) this.scene.background = null;
    this.points.geometry.dispose(); this.points.material.dispose();
  }
}
