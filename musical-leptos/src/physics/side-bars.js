import * as THREE from './three.module.js';

// Display copies of the same source bands, not additional colliders or balls.
// Half of the bands run along each side, ordered continuously around the room.
export class SideBars {
  constructor(scene, bars, count, palette) {
    this.scene = scene; this.count = count; this.bars = bars;
    bars.geometry.computeBoundingBox();
    this.geometry = bars.geometry.clone();
    this.halfStrip = this.geometry.boundingBox.max.z;
    this.edges = new Float32Array(count * 2);
    this.depth = { value: 1 };
    this.geometry.setAttribute('edge', new THREE.InstancedBufferAttribute(this.edges, 1));
    this.material = bars.material.clone();
    this.material.onBeforeCompile = shader => {
      bars.material.onBeforeCompile(shader);
      shader.uniforms.sideDepth = this.depth;
      shader.fragmentShader = 'uniform float sideDepth;\n' + shader.fragmentShader;
      // The exterior face is visible through the one-way wall. Applying the
      // front-bank X clip here removed the entire face and left only edges.
      shader.fragmentShader = shader.fragmentShader.replace(' || world.x < 0.0 || world.x > 1.2', ' || abs(world.z) > sideDepth * .5');
    };
    this.material.customProgramCacheKey = () => 'side-bars-2';
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, count * 2);
    this.mesh.frustumCulled = false; this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.object = new THREE.Object3D(); this.color = new THREE.Color();
    for (let i = 0; i < count * 2; i++) { this.color.fromArray(palette, (i % count) * 3); this.mesh.setColorAt(i, this.color); }
    scene.add(this.mesh);
  }
  update(layout, height, depth, phase, edges) {
    this.depth.value = depth;
    const [count, , width, pitch] = layout, half = count / 2;
    for (let band = 0; band < count; band++) {
      const column = (band + phase) % count, side = column < half ? 0 : 1;
      const along = column % half;
      const tip = Math.abs(this.bars.instanceMatrix.array[band * 16 + 5]);
      for (let end = 0; end < 2; end++) {
        const i = band + end * count;
        // The same visible source heights wrap around the side walls.
        // Both faces stay visible through the one-way coating.
        this.object.position.set(side ? width - this.halfStrip - .0005 : this.halfStrip + .0005,
          end ? height - tip / 2 : tip / 2,
          (side ? .5 - (along + .5) / half : (along + .5) / half - .5) * depth);
        this.object.rotation.set(end ? Math.PI : 0, side ? -Math.PI / 2 : Math.PI / 2, 0);
        this.object.scale.set(depth / (half * pitch), tip, 1);
        this.object.updateMatrix(); this.mesh.setMatrixAt(i, this.object.matrix);
        this.edges[i] = edges[band];
      }
    }
    this.geometry.attributes.edge.needsUpdate = true; this.mesh.instanceMatrix.needsUpdate = true;
  }
  dispose() { this.scene.remove(this.mesh); this.geometry.dispose(); this.material.dispose(); this.mesh.dispose(); }
}
