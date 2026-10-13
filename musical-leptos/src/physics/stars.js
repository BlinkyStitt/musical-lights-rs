import * as THREE from './three.module.js';

const BACKGROUND = 0x050814;
const STAR_COUNT = 512;

// A fixed sky behind the room: one point batch, no textures or render targets.
// Clip-space positions keep camera sweeps from moving the background.
export class Starfield {
  constructor(scene, pixelRatio) {
    this.scene = scene;
    this.background = new THREE.Color(BACKGROUND);
    scene.background = this.background;
    let seed = 0x73a9f12d;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const positions = new Float32Array(STAR_COUNT * 3), properties = new Float32Array(STAR_COUNT * 4);
    for (let i = 0; i < STAR_COUNT; i++) {
      positions.set([random() * 2 - 1, random() * 2 - 1, 0], i * 3);
      properties.set([.9 + random() ** 3 * 2, random() * Math.PI * 2, .45 + random() * .7, .28 + random() * .52], i * 4);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('star', new THREE.BufferAttribute(properties, 4));
    this.uniforms = { time: { value: 0 }, pixelRatio, background: { value: this.background } };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, depthTest: false, depthWrite: false, toneMapped: false,
      vertexShader: `attribute vec4 star; uniform float time; uniform float pixelRatio;
        varying float brightness;
        void main() {
          brightness = star.w * (.78 + .22 * sin(time * star.z + star.y));
          gl_PointSize = max(1.0, star.x * pixelRatio);
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }`,
      fragmentShader: `uniform vec3 background; varying float brightness;
        void main() {
          float radius = length(gl_PointCoord - .5) * 2.0;
          if (radius >= 1.0) discard;
          float glow = 1.0 - smoothstep(.1, 1.0, radius);
          gl_FragColor = vec4(mix(background, vec3(.72, .81, 1.0) * brightness, glow), 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = -1000;
    scene.add(this.points);
  }
  update(now, reducedMotion) {
    this.uniforms.time.value = reducedMotion ? 0 : (now / 1000) % 86400;
  }
  dispose() {
    this.scene.remove(this.points);
    if (this.scene.background === this.background) this.scene.background = null;
    this.points.geometry.dispose(); this.points.material.dispose();
  }
}
