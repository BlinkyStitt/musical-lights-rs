// Measurement-only candidate. Eight real spheres cast approximate soft shadows
// onto opaque bars/balls at their rendered world positions. No map or extra pass.
// Keep this prototype out of the shipped runtime when shading-only wins timing.
export function installShadowCandidate(view, THREE) {
  const uniforms = {
    shadowBalls: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
    shadowCamera: { value: new THREE.Matrix4() },
    shadowSun: { value: new THREE.Vector3() },
  };
  const apply = view.lighting.apply.bind(view.lighting);
  view.lighting.apply = shader => {
    apply(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'varying vec3 shadowPoint; uniform mat4 shadowCamera;\n' + shader.vertexShader;
    // Recover actual world coordinates after ramp deformation and the outer
    // floor/roof extension. Source-light coordinate wrapping is separate.
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\nshadowPoint = (shadowCamera * mvPosition).xyz;');
    shader.fragmentShader = `
      varying vec3 shadowPoint;
      uniform vec4 shadowBalls[8]; uniform vec3 shadowSun;
      float sphereVisibility() {
        float visibility = 1.0;
        for (int i = 0; i < 8; i++) {
          vec3 delta = shadowBalls[i].xyz - shadowPoint;
          float along = dot(delta, shadowSun);
          float radius = shadowBalls[i].w;
          float perpendicular = length(delta - along * shadowSun);
          // Ignore a receiver's own surface and casters behind the receiver.
          float hit = smoothstep(radius - .002, radius + .002, perpendicular);
          if (along > .001 && dot(delta, delta) > radius * radius + .000001)
            visibility = min(visibility, mix(.3, 1.0, hit));
        }
        return visibility;
      }
    ` + shader.fragmentShader;
    // Occlude global diffuse only; source illumination, pigments, bar emission
    // and white attack edges retain their independent energy.
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>',
      '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= sphereVisibility();');
  };
  for (const material of [view.bars.material, view.balls.material, view.sideBars.material, view.enclosure.material]) {
    const key = material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey = () => key() + '/tilt-shadow-candidate';
    material.needsUpdate = true;
  }
  const render = view.render.bind(view);
  view.render = (...args) => {
    const camera = args[0] ?? view.camera; camera.updateMatrixWorld();
    uniforms.shadowCamera.value.copy(camera.matrixWorld);
    const matrices = view.balls.instanceMatrix.array;
    for (let i = 0; i < 8; i++) uniforms.shadowBalls.value[i].set(
      matrices[i * 16 + 12], matrices[i * 16 + 13], matrices[i * 16 + 14],
      Math.hypot(matrices[i * 16], matrices[i * 16 + 1], matrices[i * 16 + 2]));
    uniforms.shadowSun.value.copy(view.globalLighting.key.position).normalize();
    return render(...args);
  };
}
