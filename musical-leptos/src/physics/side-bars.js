import * as THREE from './three.module.js';
import { barProjection, BOX_OFFSETS } from './mirrors.js';

// Four full-size background boxes beside the physical center box. Copy its
// vertical bars, including the scrolling seam, without adding any physics.
export class SideBars {
  constructor(scene, bars, count) {
    this.scene = scene; this.bars = bars;
    this.capacity = (count + 1) * 2 * (BOX_OFFSETS.length - 1);
    bars.geometry.computeBoundingBox();
    this.geometry = bars.geometry.clone();
    this.halfWidth = this.geometry.boundingBox.max.x;
    this.edges = new Float32Array(this.capacity);
    this.offsets = new Float32Array(this.capacity);
    this.sourceBands = new Uint8Array(this.capacity);
    this.geometry.setAttribute('edge', new THREE.InstancedBufferAttribute(this.edges, 1));
    this.geometry.setAttribute('backgroundOffset', new THREE.InstancedBufferAttribute(this.offsets, 1));
    this.material = bars.material.clone();
    this.material.onBeforeCompile = shader => {
      bars.material.onBeforeCompile(shader);
      shader.vertexShader = 'attribute float backgroundOffset;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(barProjection, barProjection + '\nworld.x -= backgroundOffset;');
    };
    this.material.customProgramCacheKey = () => 'background-box-bars';
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, this.capacity);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.mesh.frustumCulled = false; this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }
  update(layout) {
    const [count, , width] = layout;
    const source = this.bars.instanceMatrix.array, target = this.mesh.instanceMatrix.array;
    let n = 0;
    for (const box of BOX_OFFSETS) {
      if (box === 0) continue;
      const offset = box * width;
      for (let i = 0; i < this.bars.count; i++) {
        const x = source[i * 16 + 12];
        if (x < -this.halfWidth || x > width + this.halfWidth) continue;
        if (n >= this.capacity) throw Error('Background bars exceed the bounded seam capacity');
        target.set(source.subarray(i * 16, i * 16 + 16), n * 16);
        target[n * 16 + 12] += offset;
        this.mesh.instanceColor.array.set(this.bars.instanceColor.array.subarray(i * 3, i * 3 + 3), n * 3);
        this.edges[n] = this.bars.geometry.attributes.edge.array[i];
        this.offsets[n] = offset; this.sourceBands[n] = i % count;
        n++;
      }
    }
    this.mesh.count = n;
    this.geometry.attributes.edge.needsUpdate = true;
    this.geometry.attributes.backgroundOffset.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true;
  }
  dispose() { this.scene.remove(this.mesh); this.geometry.dispose(); this.material.dispose(); this.mesh.dispose(); }
}
