import * as THREE from './three.module.js';
import { LIGHT_FIELD } from './lighting.js';
import { FXAAShader } from './FXAAShader.js';

// Use the pinned Three.js edge search to find a subpixel sample. Compose fog
// at its contributing pixel centers before interpolation, retaining each
// surface's depth instead of interpolating across a depth discontinuity.
const EDGE_UV = FXAAShader.fragmentShader.slice(0, FXAAShader.fragmentShader.lastIndexOf('void main()'))
  .replace('uniform sampler2D tDiffuse;', '').replace('uniform vec2 resolution;', '').replace('varying vec2 vUv;', '')
  .replace('vec4 ApplyFXAA(', 'vec2 edgeUv(').replaceAll('return Sample( tex2D, uv );', 'return uv;');

// The density rises quadratically outside the clear room on all three axes.
// Integrate each positive part exactly along the view ray. This avoids a
// fixed step size, temporal noise and missed thin banks at shallow depths.
const DENSITY = `
  uniform vec3 volumeMin; uniform vec3 volumeMax; uniform vec3 volumeSpan;
  uniform vec3 volumeDensity;
  float positiveSquareIntegral(float a, float b) {
    float delta = b - a;
    if (a >= 0.0 && b >= 0.0) return (a * a + a * b + b * b) / 3.0;
    if (a <= 0.0 && b <= 0.0) return 0.0;
    a = max(a, 0.0); b = max(b, 0.0);
    return (b * b * b - a * a * a) / (3.0 * delta);
  }
  float axisIntegral(float a, float b, float lo, float hi, float coefficient) {
    return coefficient * (positiveSquareIntegral(a - hi, b - hi)
      + positiveSquareIntegral(lo - a, lo - b));
  }
  float opticalDepth(vec3 a, vec3 b) {
    return length(b - a) * (axisIntegral(a.x, b.x, volumeMin.x, volumeMax.x, volumeDensity.x)
      + axisIntegral(a.y, b.y, volumeMin.y, volumeMax.y, volumeDensity.y)
      + axisIntegral(a.z, b.z, volumeMin.z, volumeMax.z, volumeDensity.z));
  }
  float density(vec3 p) {
    vec3 outside = max(max(volumeMin - p, p - volumeMax), 0.0);
    return dot(outside * outside, volumeDensity);
  }
`;
const RAYS = `
  uniform mat4 volumeProjectionInverse; uniform mat4 volumeWorld;
  vec4 worldPoint(vec2 uv, float depth) {
    vec4 point = volumeProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return vec4((volumeWorld * vec4(point.xyz / point.w, 1.0)).xyz, point.w);
  }
`;

export class FogVolume {
  constructor(lighting) {
    this.size = new THREE.Vector2();
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    // Store color in sRGB to preserve dark pigment detail with byte textures.
    // WebGL decodes samples to linear light before the volume composition.
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    this.uniforms = {
      ...lighting.uniforms,
      volumeColor: { value: this.target.texture },
      volumeDepth: { value: this.target.depthTexture },
      volumeMin: { value: new THREE.Vector3() },
      volumeMax: { value: new THREE.Vector3() },
      volumeSpan: { value: new THREE.Vector3() },
      volumeDensity: { value: new THREE.Vector3() },
      volumePixel: { value: new THREE.Vector2() },
      volumeProjectionInverse: { value: new THREE.Matrix4() },
      volumeWorld: { value: new THREE.Matrix4() },
    };
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 24, 12), new THREE.ShaderMaterial({
      uniforms: this.uniforms, depthTest: false, depthWrite: false, toneMapped: false,
      vertexShader: LIGHT_FIELD + DENSITY + RAYS + `
        varying vec2 fogUv; varying vec3 fogLight; varying vec3 fogProbe;
        varying vec3 fogOrigin; varying vec3 fogRay;
        varying vec2 fogClipW;
        void main() {
          fogUv = uv;
          vec4 nearPoint = worldPoint(uv, 0.0), farPoint = worldPoint(uv, 1.0);
          vec3 origin = nearPoint.xyz, end = farPoint.xyz;
          fogClipW = vec2(nearPoint.w, farPoint.w);
          vec3 ray = end - origin;
          fogOrigin = origin; fogRay = ray;
          float distance = length(ray); vec3 direction = ray / distance;
          vec3 exit = (mix(volumeMin, volumeMax, step(vec3(0.0), direction)) - origin)
            / (max(abs(direction), .0000001) * mix(vec3(-1.0), vec3(1.0), step(vec3(0.0), direction)));
          vec3 upper = max(exit, 0.0) + volumeSpan * pow(.75 / max(direction * direction, .0000001), vec3(1.0 / 3.0));
          float farDistance = min(distance, min(upper.x, min(upper.y, upper.z)));
          float low = 0.0, high = farDistance;
          for (int i = 0; i < 6; i++) {
            float mid = (low + high) * .5;
            if (opticalDepth(origin, origin + direction * mid) < 6.0) low = mid; else high = mid;
          }
          float start = min(exit.x, min(exit.y, exit.z));
          if (any(lessThan(origin, volumeMin)) || any(greaterThan(origin, volumeMax))) start = 0.0;
          start = clamp(start, 0.0, high);
          fogLight = vec3(0.0); fogProbe = vec3(0.0); float weight = 0.0;
          // Fixed spatial quadrature. The density/transmittance integral in
          // the fragment shader remains exact; only incident light is sampled.
          for (int i = 0; i < 3; i++) {
            vec3 point = origin + direction * mix(start, high, (float(i) + .5) / 3.0);
            float scatter = density(point) * exp(-min(16.0, opticalDepth(origin, point)));
            fogLight += scatteredIllumination(point) * scatter;
            fogProbe += point * scatter; weight += scatter;
          }
          fogLight /= max(weight, .0000001);
          fogProbe /= max(weight, .0000001);
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: DENSITY + EDGE_UV + `
        uniform sampler2D volumeColor; uniform sampler2D volumeDepth; uniform vec3 mistBase;
        uniform vec2 volumePixel;
        varying vec2 fogUv; varying vec3 fogLight; varying vec3 fogProbe;
        varying vec3 fogOrigin; varying vec3 fogRay;
        varying vec2 fogClipW;
        vec3 shadeVolume(vec2 uv, vec3 origin, vec3 ray) {
          float depth = texture2D(volumeDepth, uv).x;
          float distance = depth * fogClipW.y / mix(fogClipW.x, fogClipW.y, depth);
          vec3 end = origin + ray * distance;
          float transmission = depth >= .9999999 ? 0.0 : exp(-min(16.0, opticalDepth(origin, end)));
          vec3 p = fogProbe * vec3(2.8, 4.0, 2.1);
          float cloud = sin(p.x + sin(p.z)) * sin(p.y - sin(p.x * .8));
          // A shared exposure rolloff retains saturated source hues as their
          // halos overlap. The neutral base and smoothed white attacks stay soft.
          float peak = max(fogLight.r, max(fogLight.g, fogLight.b));
          vec3 mist = mistBase + vec3(.0185 + .0025 * cloud) + .28 * fogLight / (1.0 + peak);
          return mix(mist, texture2D(volumeColor, uv).rgb, transmission);
        }
        void main() {
          // Reconstruct high-contrast edges after volume composition. Each
          // contributing pixel uses its own ray and depth, so foreground
          // pigment cannot bleed through an opaque bank. Smooth regions keep
          // their original color. No multisampled depth resolve is needed.
          vec3 originX = dFdx(fogOrigin), originY = dFdy(fogOrigin);
          vec3 rayX = dFdx(fogRay), rayY = dFdy(fogRay);
          vec3 color = shadeVolume(fogUv, fogOrigin, fogRay);
          vec2 offset = (edgeUv(volumeColor, volumePixel, fogUv) - fogUv) / volumePixel;
          float blend = max(abs(offset.x), abs(offset.y));
          if (blend > 0.0) {
            vec2 step = sign(offset);
            vec2 uv = clamp(fogUv + step * volumePixel, volumePixel * .5, vec2(1.0) - volumePixel * .5);
            step = (uv - fogUv) / volumePixel;
            vec3 neighbor = shadeVolume(uv, fogOrigin + originX * step.x + originY * step.y,
              fogRay + rayX * step.x + rayY * step.y);
            color = mix(color, neighbor, blend);
          }
          gl_FragColor = vec4(color, 1.0);
          #include <colorspace_fragment>
        }`,
    }));
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  update(width, height, depth, count, far) {
    const span = far * .8 * -Math.expm1(-depth * count / (far * .8));
    this.uniforms.volumeMin.value.set(0, 0, -depth / 2);
    this.uniforms.volumeMax.value.set(width, height, 2.1);
    // Even zero images need space for light to disappear into the medium.
    // Image count still controls geometry; it does not collapse the fog bank.
    this.uniforms.volumeSpan.value.set(width * 4, Math.max(width, height) * 2, Math.max(depth * 3, span));
  }
  render(renderer, scene, camera) {
    const output = renderer.getRenderTarget(), autoReset = renderer.info.autoReset;
    if (output) this.size.set(output.width, output.height); else renderer.getDrawingBufferSize(this.size);
    if (this.target.width !== this.size.x || this.target.height !== this.size.y) this.target.setSize(this.size.x, this.size.y);
    camera.updateMatrixWorld();
    this.uniforms.volumeProjectionInverse.value.copy(camera.projectionMatrixInverse);
    this.uniforms.volumeWorld.value.copy(camera.matrixWorld);
    const span = this.uniforms.volumeSpan.value;
    this.uniforms.volumePixel.value.set(1 / this.size.x, 1 / this.size.y);
    this.uniforms.volumeDensity.value.set(24 / span.x ** 3, 24 / span.y ** 3, 24 / span.z ** 3);
    renderer.info.autoReset = false; renderer.info.reset();
    try {
      renderer.setRenderTarget(this.target); renderer.render(scene, camera);
      renderer.setRenderTarget(output); renderer.render(this.scene, this.camera);
    } finally { renderer.setRenderTarget(output); renderer.info.autoReset = autoReset; }
  }
  dispose() {
    this.target.dispose();
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
  }
}
