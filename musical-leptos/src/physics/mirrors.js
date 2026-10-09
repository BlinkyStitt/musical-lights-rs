import * as THREE from './three.module.js';

export const barProjection = 'vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0); world = mvPosition.xyz; mvPosition.z = barFront + (mvPosition.z - barFront) * barDepth; depthDistance = (barFront - mvPosition.z) / physicalDepth; mvPosition = modelViewMatrix * mvPosition; gl_Position = projectionMatrix * mvPosition;';
// This exceeds the camera’s visible depth even at the minimum enclosure depth
// and maximum yaw. Higher settings add storage and uploads without visible depth.
export const MAX_DEPTH_IMAGES = 2048;
export const BOX_OFFSETS = Object.freeze([-2, -1, 0, 1, 2]);

// Ball images reuse the physical transforms. Bars use continuous extrusions
// instead of repeated boxes, so their depth surfaces have no internal seams.
export function mirrorCells(count) {
  if (!Number.isInteger(count) || count < 0 || count > MAX_DEPTH_IMAGES) throw new RangeError(`Use 0 to ${MAX_DEPTH_IMAGES} mirror images`);
  return Array.from({ length: count }, (_, i) => [0, 0, -i - 1]);
}

function imageGeometry(staged, count) {
  const { capacity, attributes } = staged;
  const cells = mirrorCells(count);
  const geometry = new THREE.SphereGeometry(1, 12, 8);
  for (const { name, attr } of attributes) geometry.setAttribute(name,
    new THREE.InstancedBufferAttribute(new Float32Array(capacity * attr.itemSize * count), attr.itemSize));
  const offsets = new Float32Array(count * capacity), gains = new Float32Array(offsets.length);
  for (let c = 0; c < count; c++) {
    offsets.fill(cells[c][2], c * capacity, (c + 1) * capacity);
    gains.fill(.72 ** (c + 1), c * capacity, (c + 1) * capacity);
  }
  geometry.setAttribute('copyDepth', new THREE.InstancedBufferAttribute(offsets, 1));
  geometry.setAttribute('copyGain', new THREE.InstancedBufferAttribute(gains, 1));
  return geometry;
}

export class MirrorRoom {
  constructor(scene, balls, count) {
    mirrorCells(count);
    this.poolCount = Math.min(MAX_DEPTH_IMAGES, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
    this.scene = scene;
    this.depth = { value: 1 };
    this.frustum = new THREE.Frustum(); this.clipMatrix = new THREE.Matrix4();
    this.sourceMatrix = new THREE.Matrix4(); this.sourceSphere = new THREE.Sphere();
    this.meshes = []; this.sources = [];
    for (const [kind, source] of [['balls', balls]]) {
      source.geometry.computeBoundingBox();
      source.geometry.computeBoundingSphere();
      const capacity = source.count;
      const staged = { source, capacity, kind,
        matrices: new Float32Array(capacity * 16), colors: new Float32Array(capacity * 3), attributes: [] };
      for (const [name, attr] of Object.entries(source.geometry.attributes)) if (attr.isInstancedBufferAttribute)
        staged.attributes.push({ name, attr, values: new Float32Array(capacity * attr.itemSize) });
      this.sources.push(staged);
      const geometry = imageGeometry(staged, this.poolCount);
      const material = source.material.clone();
      material.defines = { ...source.material.defines };
      material.customProgramCacheKey = () => `depth-copy-${kind}`;
      material.onBeforeCompile = shader => {
        source.material.onBeforeCompile(shader);
        shader.uniforms.mirrorDepth = this.depth;
        shader.vertexShader = 'attribute float copyDepth; attribute float copyGain; uniform float mirrorDepth; varying float imageGain;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
          vec4 sourcePoint = instanceMatrix * vec4(transformed, 1.0);
          vec4 mvPosition = modelViewMatrix * vec4(sourcePoint.xyz + vec3(0.0, 0.0, copyDepth * mirrorDepth), 1.0);
          imageGain = copyGain;
          gl_Position = projectionMatrix * mvPosition;`);
        // Keep the source ball lighting while translating its depth image.
        shader.vertexShader = shader.vertexShader.replace('vViewPosition = - mvPosition.xyz;', 'vViewPosition = -(modelViewMatrix * sourcePoint).xyz;');
        shader.fragmentShader = 'varying float imageGain;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight *= imageGain;\n#include <opaque_fragment>');
      };
      const mesh = new THREE.InstancedMesh(geometry, material, capacity * this.poolCount);
      mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * this.poolCount * 3), 3);
      this.meshes.push({ mesh, staged }); scene.add(mesh);
    }
    // One continuous outer coating has no partitions between repeated banks.
    // Transparent outside faces and faint inside coatings, without box outlines.
    // Only the center box participates in physics.
    this.walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xaab5c0, side: THREE.BackSide, transparent: true, opacity: .035, depthWrite: false }), 1);
    this.walls.frustumCulled = false; this.wallMatrix = new THREE.Matrix4();
    scene.add(this.walls);
    this.setCount(count);
  }
  setCount(count) {
    mirrorCells(count); // Validate before mutating the active pool.
    if (count > this.poolCount) {
      const poolCount = Math.min(MAX_DEPTH_IMAGES, 2 ** Math.ceil(Math.log2(count)));
      for (const { mesh, staged } of this.meshes) {
        // Release old GPU buffers before replacing them. Keep the scene object
        // and material, and reuse the expanded pool on later count reductions.
        mesh.dispose(); mesh.geometry.dispose();
        mesh.geometry = imageGeometry(staged, poolCount);
        mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(staged.capacity * poolCount * 16), 16).setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(staged.capacity * poolCount * 3), 3);
      }
      this.poolCount = poolCount;
    }
    this.count = count;
    for (const { mesh, staged } of this.meshes) { mesh.count = count * staged.capacity; mesh.visible = count > 0; }
  }
  visibleCount(staged, depth) {
    const { source } = staged;
    const padding = 1e-5 * (1 + this.count * depth);
    let visible = 0;
    for (let i = 0; i < source.count; i++) {
      this.sourceMatrix.fromArray(source.instanceMatrix.array, i * 16);
      this.sourceSphere.copy(source.geometry.boundingSphere).applyMatrix4(this.sourceMatrix);
      let first = 1, last = this.count;
      for (const plane of this.frustum.planes) {
        // Include float shader rounding at the far end of a long depth bank.
        const distance = plane.distanceToPoint(this.sourceSphere.center) + this.sourceSphere.radius + padding;
        const step = depth * plane.normal.z;
        // Cell n translates the sphere by -n * depth along world Z. Keep a
        // conservative prefix through the last cell that intersects all six
        // planes. This also retains cells that enter the view farther back.
        if (step > 0) last = Math.min(last, Math.floor(distance / step));
        else if (step < 0) first = Math.max(first, Math.ceil(distance / step));
        else if (distance < 0) { last = 0; break; }
      }
      if (last >= first) visible = Math.max(visible, last);
    }
    return visible;
  }
  update(width, height, depth, camera) {
    this.depth.value = depth;
    this.wallMatrix.makeScale(BOX_OFFSETS.length * width, height, depth * (this.count + 1)).setPosition(width / 2, height / 2, -depth * this.count / 2);
    this.walls.setMatrixAt(0, this.wallMatrix);
    this.walls.instanceMatrix.needsUpdate = true;
    if (this.count === 0) return;
    this.clipMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.clipMatrix);
    for (const staged of this.sources) {
      const { source, capacity, matrices, colors, attributes } = staged;
      let n = 0;
      for (let i = 0; i < source.count; i++) {
        if (n >= capacity) throw Error('Depth-copy source exceeds visible geometry capacity');
        matrices.set(source.instanceMatrix.array.subarray(i * 16, i * 16 + 16), n * 16);
        colors.set(source.instanceColor.array.subarray(i * 3, i * 3 + 3), n * 3);
        for (const { attr, values } of attributes) values.set(attr.array.subarray(i * attr.itemSize, (i + 1) * attr.itemSize), n * attr.itemSize);
        n++;
      }
      matrices.fill(0, n * 16);
    }
    for (const { mesh, staged } of this.meshes) {
      const { capacity, matrices, colors, attributes } = staged;
      const count = this.visibleCount(staged, depth);
      mesh.count = count * capacity; mesh.visible = count > 0;
      if (count === 0) continue;
      for (let c = 0; c < count; c++) {
        mesh.instanceMatrix.array.set(matrices, c * capacity * 16);
        mesh.instanceColor.array.set(colors, c * capacity * 3);
      }
      for (const { name, values } of attributes) {
        const out = mesh.geometry.attributes[name];
        for (let c = 0; c < count; c++) out.array.set(values, c * values.length);
        out.clearUpdateRanges(); out.addUpdateRange(0, count * values.length);
        out.needsUpdate = true;
      }
      // Grow pools only on settings changes; transfer the active image prefix.
      // Clear old ranges when drawing was paused or the count changed.
      for (const attr of [mesh.instanceMatrix, mesh.instanceColor]) {
        attr.clearUpdateRanges(); attr.addUpdateRange(0, mesh.count * attr.itemSize);
      }
      mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
    }
  }
  dispose() {
    for (const { mesh } of this.meshes) { this.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose(); }
    this.scene.remove(this.walls); this.walls.geometry.dispose(); this.walls.material.dispose(); this.walls.dispose();
  }
}
