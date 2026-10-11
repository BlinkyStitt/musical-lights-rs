import * as THREE from './three.module.js';
// One bounded field: 24 paired full-depth strips and the eight physical balls.
// Translation copies reuse it; no light objects, shadow maps, or bloom passes.
export class SceneLighting {
  constructor(palette, settings) {
    this.fog = new THREE.Fog(0xffffff, .65, 1);
    this.uniforms = {
      fogRows: { value: new THREE.Vector2() },
      fogViewFar: { value: 200 },
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
    shader.vertexShader = 'uniform vec2 fogRows; uniform float fogViewFar;\n' + shader.vertexShader;
    // Use the final projected position, including bar extrusion and ball copies.
    // The view matrix's Z column recovers world Z without a matrix inverse.
    // Keep the fog aligned with the rows as the camera turns, and hide far clipping.
    shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `
      #ifdef USE_FOG
        float worldZ = dot(viewMatrix[2].xyz, mvPosition.xyz - viewMatrix[3].xyz);
        vFogDepth = max((fogRows.x - worldZ) * fogRows.y, -mvPosition.z / fogViewFar);
      #endif`);
    const field = `
      varying vec3 nearbyIrradiance; varying vec3 fogIrradiance;
      uniform vec3 stripState[24]; uniform vec3 stripColor[24];
      uniform vec3 glowBallPosition[8]; uniform vec3 glowBallColor[8];
      uniform vec3 lightExtent; uniform mat3 lightView;
      uniform vec4 lightStrength; uniform vec2 colorEmission; uniform float reflectionFade;
      vec3 sourceIllumination(vec3 delta, vec3 normal, vec3 color) {
        float squared = dot(delta, delta);
        float radius = lightStrength.z;
        if (squared >= radius * radius) return vec3(0.0);
        float inverseDistance = inversesqrt(max(squared, .0000000001));
        float falloff = 1.0 - squared * inverseDistance / radius;
        // Fog scatters source light without a surface-facing term. Reuse the
        // same bounded source samples and distance falloff as the scene lighting.
        fogIrradiance += color * falloff * falloff;
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
          illumination += sourceIllumination(delta, worldNormal, stripColor[i] * lightStrength.x + vec3(stripState[i].z * lightStrength.y));
        }
        for (int i = 0; i < 8; i++) {
          vec3 delta = glowBallPosition[i] - point;
          delta.x -= floor(delta.x / lightExtent.x + .5) * lightExtent.x;
          delta.z -= floor(delta.z / lightExtent.z + .5) * lightExtent.z;
          illumination += sourceIllumination(delta, worldNormal, glowBallColor[i] * lightStrength.x * colorEmission.y);
        }
        return illumination;
      }
    `;
    // Sample the bounded field at vertices and interpolate across each face.
    // The coating has fixed subdivisions; depth images add no field sources.
    shader.vertexShader = field + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nnearbyIrradiance = localIllumination((instanceMatrix * vec4(position, 1.0)).xyz, normalize(transformedNormal));');
    shader.fragmentShader = 'varying vec3 nearbyIrradiance; varying vec3 fogIrradiance; uniform vec2 colorEmission; uniform float reflectionFade;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nvec3 nearbyLight = diffuseColor.rgb * nearbyIrradiance;\nreflectedLight.indirectDiffuse += nearbyLight;');
    // Colored haze peaks within the fog, then disappears into the background
    // at full density. Bright attacks and the balls' current pigments share it.
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', `#include <fog_fragment>
      #ifdef USE_FOG
        gl_FragColor.rgb += linearToOutputTexel(vec4(fogIrradiance * (.8 * fogFactor * (1.0 - fogFactor)), 1.0)).rgb;
      #endif`);
  }
  update(view, heights, offset, phase, pitch, height, depth) {
    // The physical box stays clear. The final third of the copied depth fades
    // fully into the plot background at the back face of the last row.
    this.uniforms.fogRows.value.set(-depth / 2, 1 / (depth * Math.max(1, view.mirrors.count)));
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
