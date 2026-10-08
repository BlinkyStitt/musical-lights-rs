import * as THREE from './three.module.js';

export const barProjection = 'vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0); world = mvPosition.xyz; mvPosition = modelViewMatrix * mvPosition; gl_Position = projectionMatrix * mvPosition;';
// A segment with both endpoints outside one face cannot intersect the room.
// This rejects whole cells before the exact fragment ray/box portal runs.
export const invisibleCellCull = `
  if ((mirrorCell.x < 0.0 && cameraPosition.x <= 0.0)
   || (mirrorCell.x > 0.0 && cameraPosition.x >= mirrorExtent.x)
   || (mirrorCell.y < 0.0 && cameraPosition.y <= 0.0)
   || (mirrorCell.y > 0.0 && cameraPosition.y >= mirrorExtent.y)
   || (mirrorCell.z < 0.0 && cameraPosition.z <= -mirrorExtent.z * .5)
   || (mirrorCell.z > 0.0 && cameraPosition.z >= mirrorExtent.z * .5))
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);`;

// Unfold a rectangular mirror room. A reflected point in cell n has alternating
// parity and an n*extent translation. Keep a finite, fading set of back, side
// and corner images. No render targets,
// recursive cameras, physics bodies, or negative instance scales.
export function mirrorCells(count = 6) {
  if (!Number.isInteger(count) || count < 0 || count > 17) throw new RangeError('Use 0 to 17 mirror images');
  // Include separated back-wall repeats before spending copies on corners.
  // Full-depth posts touched their reflected neighbours and hid the depth.
  const cells = [[0, 0, -1], [0, 0, -3], [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]];
  for (let z = -5; z >= -15; z -= 2) cells.push([0, 0, z]);
  cells.push([0, 0, 1], [-1, -1, 0], [1, -1, 0], [-1, 1, 0], [1, 1, 0]);
  return cells.slice(0, count);
}

export class MirrorRoom {
  constructor(scene, balls, bars, sideBars, width, count = 6) {
    this.count = count;
    this.scene = scene;
    this.extent = { value: new THREE.Vector3(width, 1, 1) };
    this.meshes = [];
    this.sources = [];
    this.corner = new THREE.Vector3(); this.viewport = new THREE.Vector4();
    this.savedScissor = new THREE.Vector4();
    // Keep one bounded pool. Changing the image count does not release shader
    // programs and force compilation while audio is already running.
    const cells = mirrorCells(17);
    for (const [kind, source] of [['balls', balls], ['bars', bars], ['sides', sideBars]]) {
      // Wrapped bar instances outside the real room are physics bookkeeping.
      // Upload only the two visible banks and at most one seam bar per bank.
      source.geometry.computeBoundingBox();
      const halfWidth = (source.geometry.boundingBox.max.x - source.geometry.boundingBox.min.x) / 2;
      const capacity = kind === 'bars' ? (source.count / 6 + 1) * 2 : source.count;
      const staged = { source, capacity, kind, halfWidth,
        matrices: new Float32Array(capacity * 16), colors: new Float32Array(capacity * 3), attributes: [] };
      for (const [name, attr] of Object.entries(source.geometry.attributes)) if (attr.isInstancedBufferAttribute)
        staged.attributes.push({ name, attr, values: new Float32Array(capacity * attr.itemSize) });
      this.sources.push(staged);
      for (const odd of [false, true]) {
        const group = cells.filter(cell => Math.abs(cell[0] + cell[1] + cell[2]) % 2 === Number(odd));
        // Virtual images are smaller and fading. Keep physical balls detailed,
        // but use a smaller sphere grid for their reflected copies.
        const size = source.geometry.boundingBox.getSize(new THREE.Vector3());
        // Physical and mirror strips use 12 triangles. Their distance shader
        // clips the rounded front silhouette.
        const geometry = kind === 'balls' ? new THREE.SphereGeometry(1, 12, 8) : new THREE.BoxGeometry(size.x, size.y, size.z);
        // A reflection reverses winding. Reverse indices once for odd cells;
        // all instance matrices remain the original proper rigid transforms.
        if (odd) {
          const index = geometry.index.array;
          for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
        }
        for (const [name, attribute] of Object.entries(source.geometry.attributes)) {
          if (attribute.isInstancedBufferAttribute) geometry.setAttribute(name,
            new THREE.InstancedBufferAttribute(new Float32Array(capacity * attribute.itemSize * group.length), attribute.itemSize));
        }
        const cellData = new Float32Array(group.length * capacity * 3);
        const signData = new Float32Array(cellData.length), gainData = new Float32Array(group.length * capacity);
        group.forEach((cell, c) => {
          const signs = cell.map(n => Math.abs(n) % 2 ? -1 : 1);
          const gain = .72 ** cell.reduce((total, n) => total + Math.abs(n), 0);
          for (let i = 0; i < capacity; i++) {
            cellData.set(cell, (c * capacity + i) * 3);
            signData.set(signs, (c * capacity + i) * 3);
            gainData[c * capacity + i] = gain;
          }
        });
        geometry.setAttribute('mirrorCell', new THREE.InstancedBufferAttribute(cellData, 3));
        geometry.setAttribute('mirrorSign', new THREE.InstancedBufferAttribute(signData, 3));
        geometry.setAttribute('mirrorGain', new THREE.InstancedBufferAttribute(gainData, 1));
        // Reflections reuse the source color, attack outline and pigments.
        // Avoid evaluating four local lights again for every virtual image.
        // The real geometry remains lit and illuminates the physical enclosure.
        const material = new THREE.MeshBasicMaterial({ toneMapped: source.material.toneMapped });
        material.defines = { ...source.material.defines };
        material.customProgramCacheKey = () => `mirror-room-${kind}-2`;
        material.onBeforeCompile = shader => {
          source.material.onBeforeCompile(shader);
          shader.uniforms.mirrorExtent = this.extent;
          shader.vertexShader = `attribute vec3 mirrorCell; attribute vec3 mirrorSign; attribute float mirrorGain;
            ${kind !== 'balls' ? 'uniform float halfWidth;' : ''}
            uniform vec3 mirrorExtent; varying vec3 reflectedPoint; varying float reflectionGain;\n` + shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace('#include <defaultnormal_vertex>',
            THREE.ShaderChunk.defaultnormal_vertex.replace('transformedNormal = normalMatrix * transformedNormal;',
              'transformedNormal = normalMatrix * (mirrorSign * transformedNormal);'));
          shader.vertexShader = shader.vertexShader.replace(kind !== 'balls' ? barProjection : '#include <project_vertex>', `
            vec4 sourcePoint = instanceMatrix * vec4(transformed, 1.0);
            ${kind !== 'balls' ? 'world = sourcePoint.xyz;' : ''}
            vec3 center = mirrorExtent * vec3(.5, .5, 0.0);
            vec3 unfolded = center + mirrorSign * (sourcePoint.xyz - center) + mirrorCell * mirrorExtent;
            reflectedPoint = (modelMatrix * vec4(unfolded, 1.0)).xyz;
            reflectionGain = mirrorGain;
            vec4 mvPosition = viewMatrix * vec4(reflectedPoint, 1.0);
            gl_Position = projectionMatrix * mvPosition;
            ${invisibleCellCull}
            ${kind === 'bars' ? 'if (instanceMatrix[3].x < -halfWidth || instanceMatrix[3].x > mirrorExtent.x + halfWidth) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);' : ''}`);
          shader.fragmentShader = `uniform vec3 mirrorExtent; varying vec3 reflectedPoint; varying float reflectionGain;\n` + shader.fragmentShader;
          // Only rays that traverse the real room and leave an interior mirror
          // can see a virtual copy. This is the mirror portal; it also prevents
          // images from covering the exterior when the camera sees through a side.
          shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `
            #include <clipping_planes_fragment>
            vec3 ray = reflectedPoint - cameraPosition;
            vec3 safeRay = mix(vec3(0.000001), ray, step(vec3(0.000001), abs(ray)));
            vec3 lo = (vec3(0.0, 0.0, -mirrorExtent.z * .5) - cameraPosition) / safeRay;
            vec3 hi = (vec3(mirrorExtent.xy, mirrorExtent.z * .5) - cameraPosition) / safeRay;
            vec3 entry = min(lo, hi), exit = max(lo, hi);
            float enterRoom = max(max(entry.x, entry.y), entry.z);
            float leaveRoom = min(min(exit.x, exit.y), exit.z);
            if (leaveRoom < max(enterRoom, 0.0) || leaveRoom > 1.00001) discard;`);
          shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
            'outgoingLight *= reflectionGain;\n#include <opaque_fragment>');
        };
        const mesh = new THREE.InstancedMesh(geometry, material, capacity * group.length);
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * group.length * 3), 3);
        mesh.onBeforeRender = (renderer, scene, camera) => {
          renderer.getScissor(this.savedScissor); this.savedScissorTest = renderer.getScissorTest();
          renderer.getCurrentViewport(this.viewport);
          let minX = 1, minY = 1, maxX = -1, maxY = -1;
          const extent = this.extent.value;
          for (let i = 0; i < 8; i++) {
            this.corner.set(i & 1 ? extent.x : 0, i & 2 ? extent.y : 0, (i & 4 ? .5 : -.5) * extent.z).project(camera);
            minX = Math.min(minX, this.corner.x); minY = Math.min(minY, this.corner.y);
            maxX = Math.max(maxX, this.corner.x); maxY = Math.max(maxY, this.corner.y);
          }
          // The ray portal can show images only inside the projected room.
          // Reject its exterior before fragment shading, with a pixel of extra
          // coverage for antialiasing. Respect offscreen render-target viewports.
          const v = this.viewport, ratio = renderer.getPixelRatio();
          const left = Math.max(v.x, Math.floor(v.x + (minX + 1) * v.z / 2) - 1);
          const bottom = Math.max(v.y, Math.floor(v.y + (minY + 1) * v.w / 2) - 1);
          const right = Math.min(v.x + v.z, Math.ceil(v.x + (maxX + 1) * v.z / 2) + 1);
          const top = Math.min(v.y + v.w, Math.ceil(v.y + (maxY + 1) * v.w / 2) + 1);
          renderer.setScissor(left / ratio, bottom / ratio, Math.max(0, right - left) / ratio, Math.max(0, top - bottom) / ratio);
          renderer.setScissorTest(true);
        };
        mesh.onAfterRender = renderer => { renderer.setScissor(this.savedScissor); renderer.setScissorTest(this.savedScissorTest); };
        this.meshes.push({ mesh, staged, cells: group, copies: group.length }); scene.add(mesh);
      }
    }
    // All six interior faces have a light silver coating; exterior faces are
    // culled. The reflected geometry supplies their moving mirror image.
    const coating = new THREE.MeshBasicMaterial({ color: 0xaab5c0, side: THREE.BackSide,
      transparent: true, opacity: .035, depthWrite: false });
    // One inward-facing box draws all six transparent mirror coatings.
    this.walls = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), coating);
    scene.add(this.walls);
    this.frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x718096, transparent: true, opacity: .45 }));
    scene.add(this.frame);
    this.setCount(count);
  }
  setCount(count) {
    const active = mirrorCells(count);
    this.count = count;
    for (const entry of this.meshes) {
      entry.copies = entry.cells.filter(cell => active.some(a => a.every((n, i) => n === cell[i]))).length;
      // Each parity group retains the same selected prefix as the source
      // cell list, so no instance attributes or materials need replacement.
      entry.mesh.count = entry.copies * entry.staged.capacity;
      entry.mesh.visible = entry.copies > 0;
    }
  }
  update(width, height, depth) {
    this.extent.value.set(width, height, depth);
    this.walls.position.set(width / 2, height / 2, 0);
    this.walls.scale.set(width, height, depth);
    this.frame.position.set(width / 2, height / 2, 0); this.frame.scale.set(width, height, depth);
    for (const staged of this.sources) {
      const { source, kind, capacity, halfWidth, matrices, colors, attributes } = staged;
      let n = 0;
      for (let i = 0; i < source.count; i++) {
        const x = source.instanceMatrix.array[i * 16 + 12];
        if (kind === 'bars' && (x < -halfWidth || x > width + halfWidth)) continue;
        if (n >= capacity) throw Error('Mirror source exceeds visible geometry capacity');
        for (let j = 0; j < 16; j++) matrices[n * 16 + j] = source.instanceMatrix.array[i * 16 + j];
        for (let j = 0; j < 3; j++) colors[n * 3 + j] = source.instanceColor.array[i * 3 + j];
        for (const { attr, values } of attributes) {
          for (let j = 0; j < attr.itemSize; j++) values[n * attr.itemSize + j] = attr.array[i * attr.itemSize + j];
        }
        n++;
      }
      // A seam may add a column. Zero unused slots so they form no triangles.
      matrices.fill(0, n * 16);
    }
    for (const { mesh, staged, copies } of this.meshes) {
      const { capacity, matrices, colors, attributes } = staged;
      for (let c = 0; c < copies; c++) {
        mesh.instanceMatrix.array.set(matrices, c * capacity * 16);
        mesh.instanceColor.array.set(colors, c * capacity * 3);
      }
      for (const { name, values } of attributes) {
        const out = mesh.geometry.attributes[name];
        for (let c = 0; c < copies; c++) out.array.set(values, c * values.length);
        out.needsUpdate = true;
      }
      mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
    }
  }
  dispose() {
    for (const { mesh } of this.meshes) { this.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose(); }
    this.scene.remove(this.walls); this.walls.geometry.dispose(); this.walls.material.dispose();
    this.scene.remove(this.frame); this.frame.geometry.dispose(); this.frame.material.dispose();
  }
}
