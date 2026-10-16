import * as THREE from './three.module.js';
import { BOX_OFFSETS } from './enclosure.js';

// A coloured flat top includes the two half-joins at its edges.
// Straight segments cannot exceed their endpoints, including snapshot blends.
export function rampMaximum(values, offset = 0) {
  const left = values[offset], centre = values[offset + 1], right = values[offset + 2];
  return Math.max(centre, (left + centre) / 2, (centre + right) / 2);
}

// Eight full-size background boxes beside the physical center box. Copy its
// vertical bars, including the scrolling seam, without adding any physics.
export class SideBars {
  constructor(scene, bars, count) {
    this.scene = scene; this.bars = bars;
    this.frustum = new THREE.Frustum(); this.projection = new THREE.Matrix4(); this.bounds = new THREE.Box3();
    this.capacity = (count + 1) * 2 * (BOX_OFFSETS.length - 1);
    bars.geometry.computeBoundingBox();
    this.geometry = bars.geometry.clone();
    this.halfWidth = this.geometry.boundingBox.max.x;
    this.edges = new Float32Array(this.capacity);
    this.pulses = new Float32Array(this.capacity);
    this.offsets = new Float32Array(this.capacity);
    this.sourceBands = new Uint8Array(this.capacity);
    this.geometry.setAttribute('edge', new THREE.InstancedBufferAttribute(this.edges, 1));
    this.geometry.setAttribute('pulse', new THREE.InstancedBufferAttribute(this.pulses, 1));
    this.geometry.setAttribute('backgroundOffset', new THREE.InstancedBufferAttribute(this.offsets, 1));
    this.geometry.setAttribute('rampHeights', new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3));
    this.material = bars.material.clone();
    this.material.onBeforeCompile = shader => {
      bars.material.onBeforeCompile(shader);
    };
    this.material.customProgramCacheKey = () => 'background-box-bars';
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, this.capacity);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.mesh.frustumCulled = false; this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }
  update(layout, camera, depth) {
    const [count, , width] = layout;
    if (camera) {
      camera.updateMatrixWorld();
      this.frustum.setFromProjectionMatrix(this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    }
    const source = this.bars.instanceMatrix.array, target = this.mesh.instanceMatrix.array;
    const height = source[count * 3 * 16 + 13] + Math.abs(source[count * 3 * 16 + 5]) / 2;
    let n = 0;
    for (const box of BOX_OFFSETS) {
      if (box === 0) continue;
      const offset = box * width;
      // Reject whole banks before scanning their posts. Include the complete
      // depth extrusion: a bank outside the front view can enter farther back.
      if (camera) {
        this.bounds.min.set(offset, -layout[6], -depth / 2);
        this.bounds.max.set(offset + width, height + layout[6] + .00001, depth / 2);
        if (!this.frustum.intersectsBox(this.bounds)) continue;
      }
      for (let i = 0; i < this.bars.count; i++) {
        const x = source[i * 16 + 12];
        // Touching an edge contributes no surface inside this box. Compare
        // the submitted float32 bounds so a rounded JS sum cannot add a sliver.
        if (Math.fround(x + this.halfWidth) <= 0 || Math.fround(x - this.halfWidth) >= width) continue;
        if (camera) {
          // Bound both straight half-ramps, including snapshot interpolation.
          const top = rampMaximum(this.bars.geometry.attributes.rampHeights.array, i * 3);
          const roof = source[i * 16 + 5] < 0;
          this.bounds.min.set(x + offset - this.halfWidth, roof ? height - top : -layout[6], -depth / 2);
          this.bounds.max.set(x + offset + this.halfWidth, roof ? height + layout[6] : top, depth / 2);
          if (!this.frustum.intersectsBox(this.bounds)) continue;
        }
        if (n >= this.capacity) throw Error('Background bars exceed the bounded seam capacity');
        target.set(source.subarray(i * 16, i * 16 + 16), n * 16);
        target[n * 16 + 12] += offset;
        this.mesh.instanceColor.array.set(this.bars.instanceColor.array.subarray(i * 3, i * 3 + 3), n * 3);
        this.edges[n] = this.bars.geometry.attributes.edge.array[i];
        this.pulses[n] = this.bars.geometry.attributes.pulse.array[i];
        this.offsets[n] = offset; this.sourceBands[n] = i % count;
        this.geometry.attributes.rampHeights.array.set(
          this.bars.geometry.attributes.rampHeights.array.subarray(i * 3, i * 3 + 3), n * 3);
        n++;
      }
    }
    this.mesh.count = n;
    for (const attr of [this.geometry.attributes.edge, this.geometry.attributes.pulse, this.geometry.attributes.backgroundOffset, this.geometry.attributes.rampHeights, this.mesh.instanceMatrix, this.mesh.instanceColor]) {
      attr.clearUpdateRanges(); attr.addUpdateRange(0, n * attr.itemSize); attr.needsUpdate = true;
    }
  }
  dispose() { this.scene.remove(this.mesh); this.geometry.dispose(); this.material.dispose(); this.mesh.dispose(); }
}
