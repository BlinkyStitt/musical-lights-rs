import * as THREE from './three.module.js';

export const barProjection = 'vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0); world = mvPosition.xyz; mvPosition = modelViewMatrix * mvPosition; gl_Position = projectionMatrix * mvPosition;';
export const BOX_OFFSETS = Object.freeze([-2, -1, 0, 1, 2]);

// A finite stack of fading scene copies creates depth without reflection
// cameras, ray/box tests in every fragment, or additional simulated balls.
export function mirrorCells(count = 3) {
  if (!Number.isInteger(count) || count < 0 || count > 17) throw new RangeError('Use 0 to 17 mirror images');
  return Array.from({ length: count }, (_, i) => [0, 0, -i - 1]);
}

export class MirrorRoom {
  constructor(scene, balls, bars, sideBars, width, count = 3) {
    this.scene = scene;
    this.depth = { value: 1 };
    this.meshes = []; this.sources = [];
    const cells = mirrorCells(17);
    for (const [kind, source] of [['balls', balls], ['bars', bars], ['sides', sideBars]]) {
      source.geometry.computeBoundingBox();
      const halfWidth = (source.geometry.boundingBox.max.x - source.geometry.boundingBox.min.x) / 2;
      const capacity = kind === 'bars' ? (source.count / 6 + 1) * 2 : source.count;
      const staged = { source, capacity, kind, halfWidth,
        matrices: new Float32Array(capacity * 16), colors: new Float32Array(capacity * 3), attributes: [] };
      for (const [name, attr] of Object.entries(source.geometry.attributes)) if (attr.isInstancedBufferAttribute)
        staged.attributes.push({ name, attr, values: new Float32Array(capacity * attr.itemSize) });
      this.sources.push(staged);
      const size = source.geometry.boundingBox.getSize(new THREE.Vector3());
      const geometry = kind === 'balls' ? new THREE.SphereGeometry(1, 12, 8) : new THREE.BoxGeometry(size.x, size.y, size.z);
      for (const { name, attr } of staged.attributes) geometry.setAttribute(name,
        new THREE.InstancedBufferAttribute(new Float32Array(capacity * attr.itemSize * cells.length), attr.itemSize));
      const offsets = new Float32Array(cells.length * capacity), gains = new Float32Array(offsets.length);
      for (let c = 0; c < cells.length; c++) {
        offsets.fill(cells[c][2], c * capacity, (c + 1) * capacity);
        gains.fill(.72 ** (c + 1), c * capacity, (c + 1) * capacity);
      }
      geometry.setAttribute('copyDepth', new THREE.InstancedBufferAttribute(offsets, 1));
      geometry.setAttribute('copyGain', new THREE.InstancedBufferAttribute(gains, 1));
      const material = source.material.clone();
      material.defines = { ...source.material.defines };
      material.customProgramCacheKey = () => `depth-copy-${kind}`;
      material.onBeforeCompile = shader => {
        source.material.onBeforeCompile(shader);
        shader.uniforms.mirrorDepth = this.depth;
        shader.vertexShader = 'attribute float copyDepth; attribute float copyGain; uniform float mirrorDepth; varying float imageGain;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(kind === 'balls' ? '#include <project_vertex>' : barProjection, `
          vec4 sourcePoint = instanceMatrix * vec4(transformed, 1.0);
          ${kind === 'balls' ? '' : 'world = sourcePoint.xyz;'}
          vec4 mvPosition = modelViewMatrix * vec4(sourcePoint.xyz + vec3(0.0, 0.0, copyDepth * mirrorDepth), 1.0);
          imageGain = copyGain;
          gl_Position = projectionMatrix * mvPosition;`);
        // Preserve the source lighting while translating the drawing. Bars
        // already shade at their bank-local world position; balls use theirs.
        if (kind === 'balls') shader.vertexShader = shader.vertexShader.replace('vViewPosition = - mvPosition.xyz;', 'vViewPosition = -(modelViewMatrix * sourcePoint).xyz;');
        shader.fragmentShader = 'varying float imageGain;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight *= imageGain;\n#include <opaque_fragment>');
      };
      const mesh = new THREE.InstancedMesh(geometry, material, capacity * cells.length);
      mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * cells.length * 3), 3);
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
    this.count = count;
    for (const { mesh, staged } of this.meshes) { mesh.count = count * staged.capacity; mesh.visible = count > 0; }
  }
  update(width, height, depth) {
    this.depth.value = depth;
    this.wallMatrix.makeScale(BOX_OFFSETS.length * width, height, depth).setPosition(width / 2, height / 2, 0);
    this.walls.setMatrixAt(0, this.wallMatrix);
    this.walls.instanceMatrix.needsUpdate = true;
    if (this.count === 0) return;
    for (const staged of this.sources) {
      const { source, kind, capacity, halfWidth, matrices, colors, attributes } = staged;
      let n = 0;
      for (let i = 0; i < source.count; i++) {
        const x = source.instanceMatrix.array[i * 16 + 12];
        if (kind === 'bars' && (x < -halfWidth || x > width + halfWidth)) continue;
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
      for (let c = 0; c < this.count; c++) {
        mesh.instanceMatrix.array.set(matrices, c * capacity * 16);
        mesh.instanceColor.array.set(colors, c * capacity * 3);
      }
      for (const { name, values } of attributes) {
        const out = mesh.geometry.attributes[name];
        for (let c = 0; c < this.count; c++) out.array.set(values, c * values.length);
        out.clearUpdateRanges(); out.addUpdateRange(0, this.count * values.length);
        out.needsUpdate = true;
      }
      // Pools reserve 17 images, but transfer only the active image prefix.
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
