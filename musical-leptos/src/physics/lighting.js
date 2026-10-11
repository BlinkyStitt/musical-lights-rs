import * as THREE from './three.module.js';

export const LIGHT_FIELD = `
  uniform vec3 stripState[24]; uniform vec3 stripColor[24]; uniform float fogAttack[24];
  uniform vec3 glowBallPosition[8]; uniform vec3 glowBallColor[8];
  uniform vec3 lightExtent; uniform mat3 lightView;
  uniform vec4 lightStrength; uniform vec2 colorEmission; uniform float reflectionFade;
  vec3 sourceIllumination(vec3 delta, vec3 normal, vec3 color, float isotropic) {
    float squared = dot(delta, delta);
    float radius = lightStrength.z;
    if (squared >= radius * radius) return vec3(0.0);
    float inverseDistance = inversesqrt(max(squared, .0000000001));
    float falloff = 1.0 - squared * inverseDistance / radius;
    return color * falloff * falloff * max(isotropic, max(.08, dot(normal, delta) * inverseDistance));
  }
  vec3 lightField(vec3 point, vec3 normal, float isotropic) {
    vec3 illumination = vec3(0.0);
    for (int i = 0; i < 24; i++) {
      float dx = stripState[i].x - point.x;
      dx -= floor(dx / lightExtent.x + .5) * lightExtent.x;
      float lower = stripState[i].y - point.y;
      float upper = lightExtent.y - stripState[i].y - point.y;
      vec3 delta = vec3(dx, abs(lower) < abs(upper) ? lower : upper, 0.0);
      vec3 color = stripColor[i] * lightStrength.x;
      color += vec3(mix(stripState[i].z, fogAttack[i] * .18, isotropic) * lightStrength.y);
      illumination += sourceIllumination(delta, normal, color, isotropic);
    }
    for (int i = 0; i < 8; i++) {
      vec3 delta = glowBallPosition[i] - point;
      delta.x -= floor(delta.x / lightExtent.x + .5) * lightExtent.x;
      delta.z -= floor(delta.z / lightExtent.z + .5) * lightExtent.z;
      vec3 color = glowBallColor[i] * lightStrength.x * colorEmission.y;
      illumination += sourceIllumination(delta, normal, color, isotropic);
    }
    return illumination;
  }
  vec3 localIllumination(vec3 point, vec3 normal) {
    return lightField(point, normal * lightView, 0.0);
  }
  vec3 scatteredIllumination(vec3 point) {
    return lightField(point, vec3(0.0), 1.0);
  }
`;
// One bounded field: 24 paired full-depth strips and the eight physical balls.
// Translation copies reuse it; no light objects, shadow maps, or bloom passes.
export class SceneLighting {
  constructor(palette, settings) {
    this.mistColor = new THREE.Color(0xffffff);
    this.uniforms = {
      fogAttack: { value: new Float32Array(24) },
      mistBase: { value: this.mistColor },
      stripState: { value: Array.from({ length: 24 }, () => new THREE.Vector3()) },
      stripColor: { value: Array.from({ length: 24 }, (_, i) => new THREE.Color().fromArray(palette, i * 3)) },
      glowBallPosition: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
      glowBallColor: { value: Array.from({ length: 8 }, () => new THREE.Color(0, 0, 0)) },
      lightExtent: { value: new THREE.Vector3(1.2, .5, .4) },
      lightView: { value: new THREE.Matrix3() },
      lightStrength: { value: new THREE.Vector4() },
      colorEmission: { value: new THREE.Vector2() },
      reflectionFade: { value: settings.depthFade ?? .72 },
    };
    this.configure(settings);
  }
  configure(settings) {
    this.uniforms.lightStrength.value.set(settings.colorSpill ?? .18, settings.attackLight ?? .8, settings.lightRange ?? .22, 0);
    this.uniforms.colorEmission.value.set(settings.barGlow ?? .08, settings.ballGlow ?? .12);
    this.uniforms.reflectionFade.value = settings.depthFade ?? .72;
  }
  apply(shader) {
    Object.assign(shader.uniforms, this.uniforms);
    shader.vertexShader = LIGHT_FIELD + 'varying vec3 nearbyIrradiance;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nnearbyIrradiance = localIllumination((instanceMatrix * vec4(position, 1.0)).xyz, normalize(transformedNormal));');
    shader.fragmentShader = 'varying vec3 nearbyIrradiance; uniform vec2 colorEmission; uniform float reflectionFade;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nvec3 nearbyLight = diffuseColor.rgb * nearbyIrradiance;\nreflectedLight.indirectDiffuse += nearbyLight;');
  }
  update(view, heights, offset, phase, pitch, height, depth, now) {
    const dt = Math.max(0, Math.min(.1, (now - (this.fogAt ?? now)) / 1000));
    this.fogAt = now;
    const blend = -Math.expm1(-dt / .35);
    for (let i = 0; i < 24; i++) this.uniforms.fogAttack.value[i] += (view.meshEdges[i] - this.uniforms.fogAttack.value[i]) * blend;
    this.uniforms.lightExtent.value.set(view.width, height, depth);
    this.uniforms.lightView.value.setFromMatrix4(view.camera.matrixWorldInverse);
    for (let i = 0; i < 24; i++) this.uniforms.stripState.value[i].set(((i + phase) % 24 + .5) * pitch, heights[offset + i], view.meshEdges[i]);
    const matrices = view.balls.instanceMatrix.array, colors = view.balls.instanceColor.array;
    for (let i = 0; i < 8; i++) {
      this.uniforms.glowBallPosition.value[i].set(matrices[i * 16 + 12], matrices[i * 16 + 13], matrices[i * 16 + 14]);
      const color = this.uniforms.glowBallColor.value[i].fromArray(colors, i * 3);
      if (view.pigments) {
        color.setRGB((view.pigments[i * 9] + view.pigments[i * 9 + 3] + view.pigments[i * 9 + 6]) / 3,
          (view.pigments[i * 9 + 1] + view.pigments[i * 9 + 4] + view.pigments[i * 9 + 7]) / 3,
          (view.pigments[i * 9 + 2] + view.pigments[i * 9 + 5] + view.pigments[i * 9 + 8]) / 3);
      }
    }
  }
}
