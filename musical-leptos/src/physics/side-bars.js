import * as THREE from './three.module.js';

// Display copies of the same source bands, not additional colliders or balls.
// Half of the bands run along each side, ordered continuously around the room.
export class SideBars {
  constructor(scene, bars, count, palette) {
    this.scene = scene; this.count = count; this.bars = bars;
    bars.geometry.computeBoundingBox();
    const size = bars.geometry.boundingBox.getSize(new THREE.Vector3());
    this.geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    this.edges = new Float32Array(count * 2);
    this.geometry.setAttribute('edge', new THREE.InstancedBufferAttribute(this.edges, 1));
    this.material = bars.material.clone();
    this.material.onBeforeCompile = shader => {
      bars.material.onBeforeCompile(shader);
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
        '#include <color_fragment>\nif (abs(world.z) > halfDepth) discard;');
      shader.fragmentShader = shader.fragmentShader.replace('float pixel =', 'if (distance < 0.0) discard; float pixel =');
    };
    this.material.customProgramCacheKey = () => 'side-bars-1';
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, count * 2);
    this.mesh.frustumCulled = false; this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.object = new THREE.Object3D(); this.color = new THREE.Color();
    for (let i = 0; i < count * 2; i++) { this.color.fromArray(palette, (i % count) * 3); this.mesh.setColorAt(i, this.color); }
    scene.add(this.mesh);
  }
  update(layout, height, depth, phase, edges) {
    const [count, , width, pitch, , , postHeight] = layout, half = count / 2;
    for (let band = 0; band < count; band++) {
      const column = (band + phase) % count, side = column < half ? 0 : 1;
      const along = column % half;
      const tip = this.bars.instanceMatrix.array[band * 16 + 13] + postHeight / 2;
      for (let end = 0; end < 2; end++) {
        const i = band + end * count;
        // Keep copies inside the one-way face. Their outer face covers the
        // broad side of the source posts at oblique views, in one instanced draw.
        this.object.position.set(side ? width - .001 : .001,
          end ? height - tip + postHeight / 2 : tip - postHeight / 2,
          (side ? .5 - (along + .5) / half : (along + .5) / half - .5) * depth);
        this.object.rotation.set(end ? Math.PI : 0, side ? -Math.PI / 2 : Math.PI / 2, 0);
        this.object.scale.set(depth / (half * pitch), 1, .002 / depth);
        this.object.updateMatrix(); this.mesh.setMatrixAt(i, this.object.matrix);
        this.edges[i] = edges[band];
      }
    }
    this.geometry.attributes.edge.needsUpdate = true; this.mesh.instanceMatrix.needsUpdate = true;
  }
  dispose() { this.scene.remove(this.mesh); this.geometry.dispose(); this.material.dispose(); this.mesh.dispose(); }
}
