import * as THREE from './three.module.js';

const LIGHT_FIELD = `
  varying vec3 nearbyIrradiance; varying vec3 fogIrradiance;
  uniform vec3 stripState[24]; uniform vec3 stripColor[24]; uniform float fogAttack[24];
  uniform vec3 glowBallPosition[8]; uniform vec3 glowBallColor[8];
  uniform vec3 lightExtent; uniform mat3 lightView;
  uniform vec4 lightStrength; uniform vec2 colorEmission; uniform float reflectionFade;
  vec3 sourceIllumination(vec3 delta, vec3 normal, vec3 color, vec3 haze) {
    float squared = dot(delta, delta);
    float radius = lightStrength.z;
    if (squared >= radius * radius) return vec3(0.0);
    float inverseDistance = inversesqrt(max(squared, .0000000001));
    float falloff = 1.0 - squared * inverseDistance / radius;
    // Fog scatters source light without a surface-facing term. Reuse the
    // same bounded source samples and distance falloff as the scene lighting.
    fogIrradiance += haze * falloff * falloff;
    return color * falloff * falloff * max(.08, dot(normal, delta) * inverseDistance);
  }
  vec3 localIllumination(vec3 point, vec3 surfaceNormal) {
    vec3 illumination = vec3(0.0);
    fogIrradiance = vec3(0.0);
    // Convert the normal once. Distant sources need no square root or facing calculation.
    vec3 worldNormal = surfaceNormal * lightView;
    for (int i = 0; i < 24; i++) {
      float dx = stripState[i].x - point.x;
      dx -= floor(dx / lightExtent.x + .5) * lightExtent.x;
      float lower = stripState[i].y - point.y;
      float upper = lightExtent.y - stripState[i].y - point.y;
      vec3 delta = vec3(dx, abs(lower) < abs(upper) ? lower : upper, 0.0);
      vec3 color = stripColor[i] * lightStrength.x;
      illumination += sourceIllumination(delta, worldNormal, color + vec3(stripState[i].z * lightStrength.y), color + vec3(fogAttack[i] * lightStrength.y * .18));
    }
    for (int i = 0; i < 8; i++) {
      vec3 delta = glowBallPosition[i] - point;
      delta.x -= floor(delta.x / lightExtent.x + .5) * lightExtent.x;
      delta.z -= floor(delta.z / lightExtent.z + .5) * lightExtent.z;
      vec3 color = glowBallColor[i] * lightStrength.x * colorEmission.y;
      illumination += sourceIllumination(delta, worldNormal, color, color);
    }
    return illumination;
  }
`;

const MIST_COLOR = `
  varying vec3 fogPoint; varying vec3 fogIrradiance;
  uniform vec3 mistBase;
  float mistNoise(vec2 p) {
    return sin(p.x + sin(p.y * 1.7)) * sin(p.y - sin(p.x * .8));
  }
  vec3 mistColor() {
    vec2 p = fogPoint.xy * vec2(2.8, 4.0);
    float cloud = .5 + .3 * mistNoise(p) + .2 * mistNoise(p * 2.13 + 4.0);
    return mistBase + vec3(.016 + .005 * cloud) + .12 * fogIrradiance / (vec3(1.0) + fogIrradiance);
  }
`;
// One bounded field: 24 paired full-depth strips and the eight physical balls.
// Translation copies reuse it; no light objects, shadow maps, or bloom passes.
export class SceneLighting {
  constructor(palette, settings) {
    this.fog = new THREE.Fog(0xffffff, .15, 1);
    this.fogCorner = new THREE.Vector3();
    this.uniforms = {
      fogRows: { value: new THREE.Vector2() },
      fogViewFar: { value: 200 },
      fogAttack: { value: new Float32Array(24) },
      mistBase: { value: this.fog.color },
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
    shader.vertexShader = 'uniform vec2 fogRows; uniform float fogViewFar; varying vec3 fogPoint;\n' + shader.vertexShader;
    // Use the final projected position, including bar extrusion and ball copies.
    // The view matrix's Z column recovers world Z without a matrix inverse.
    // Keep the fog aligned with the rows as the camera turns, and hide far clipping.
    shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `
      #ifdef USE_FOG
        vec3 relative = mvPosition.xyz - viewMatrix[3].xyz;
        fogPoint = vec3(dot(viewMatrix[0].xyz, relative), dot(viewMatrix[1].xyz, relative), dot(viewMatrix[2].xyz, relative));
        vFogDepth = max((fogRows.x - fogPoint.z) * fogRows.y, -mvPosition.z / fogViewFar);
      #endif`);
    // Sample the bounded field at vertices and interpolate across each face.
    // The coating has fixed subdivisions; depth images add no field sources.
    shader.vertexShader = LIGHT_FIELD + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nnearbyIrradiance = localIllumination((instanceMatrix * vec4(position, 1.0)).xyz, normalize(transformedNormal));');
    shader.fragmentShader = MIST_COLOR + 'varying vec3 nearbyIrradiance; uniform vec2 colorEmission; uniform float reflectionFade;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nvec3 nearbyLight = diffuseColor.rgb * nearbyIrradiance;\nreflectedLight.indirectDiffuse += nearbyLight;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', `
      #ifdef USE_FOG
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, linearToOutputTexel(vec4(mistColor(), 1.0)).rgb, fogFactor);
      #endif`);
  }
  makeFogBank(scene) {
    // A single opaque bank also fills empty air. Its fixed grid samples the
    // same bounded light field as the bars, balls and coating.
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: LIGHT_FIELD + `
        varying vec3 fogPoint;
        void main() {
          fogPoint = (modelMatrix * vec4(position, 1.0)).xyz;
          // Keep fourteen lighting intervals around the physical sources.
          // The two outer rows cover empty air, where source light is zero.
          if (abs(position.y) < .5) fogPoint.y = mix(-lightStrength.z, lightExtent.y + lightStrength.z, (position.y + .4375) / .875);
          nearbyIrradiance = localIllumination(fogPoint, vec3(0.0, 0.0, 1.0));
          gl_Position = projectionMatrix * viewMatrix * vec4(fogPoint, 1.0);
          // Keep the opaque background across the far plane at oblique angles.
          gl_Position.z = min(gl_Position.z, gl_Position.w * .9999998);
        }`,
      fragmentShader: MIST_COLOR + `
        void main() {
          gl_FragColor = vec4(mistColor(), 1.0);
          #include <colorspace_fragment>
        }`,
      toneMapped: false,
    });
    const bank = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 128, 16), material);
    bank.frustumCulled = false;
    scene.add(bank);
    return bank;
  }
  update(view, heights, offset, phase, pitch, height, depth, now) {
    // Keep the physical room clear, then thicken the atmosphere to an opaque
    // bank. Scale its distance with the requested depth and camera range.
    const requestedSpan = depth * view.mirrors.count;
    const visibleSpan = view.camera.far * .8;
    // Follow the requested depth continuously. Ease toward the visible range
    // so even the largest settings retain a distinct fog distance.
    const span = visibleSpan * -Math.expm1(-requestedSpan / visibleSpan);
    this.uniforms.fogRows.value.set(-depth / 2, 1 / Math.max(.001, span));
    const dt = Math.max(0, Math.min(.1, (now - (this.fogAt ?? now)) / 1000));
    this.fogAt = now;
    const blend = -Math.expm1(-dt / .35);
    for (let i = 0; i < 24; i++) this.uniforms.fogAttack.value[i] += (view.meshEdges[i] - this.uniforms.fogAttack.value[i]) * blend;
    view.fogBank.position.set(view.width / 2, height / 2, -depth / 2 - span);
    // Intersect all four view rays with the bank's world-Z plane. Oblique
    // views need more height on the far side than a centered FOV estimate.
    let halfWidth = 2.5 * view.width, halfHeight = Math.max(height, height / 2 + this.uniforms.lightStrength.value.z);
    const eye = view.camera.position, bank = view.fogBank.position;
    for (let i = 0; i < 4; i++) {
      const ray = this.fogCorner.set(i & 1 ? 1 : -1, i & 2 ? 1 : -1, .5).unproject(view.camera).sub(eye);
      ray.multiplyScalar((bank.z - eye.z) / ray.z).add(eye);
      halfWidth = Math.max(halfWidth, Math.abs(ray.x - bank.x));
      halfHeight = Math.max(halfHeight, Math.abs(ray.y - bank.y));
    }
    view.fogBank.scale.set(halfWidth * 2.01, halfHeight * 2.01, 1);
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
