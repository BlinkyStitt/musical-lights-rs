import * as THREE from './three.module.js';

export const BOX_OFFSETS = Object.freeze([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
// Source posts have their actual box depth. Clip wholly discarded scrolling
// posts before rasterization, retaining conservative padding at window edges.
export const barProjection = 'vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0); world = mvPosition.xyz; mvPosition.y -= sign(instanceMatrix[1].y) * barExtension * (.5 - position.y); mvPosition = modelViewMatrix * mvPosition; gl_Position = projectionMatrix * mvPosition; world.x -= backgroundOffset; float padding = .000001 * (1.0 + abs(instanceMatrix[3].x) + abs(backgroundOffset)); if (instanceMatrix[3].x + halfWidth - backgroundOffset < -padding || instanceMatrix[3].x - halfWidth - backgroundOffset > 1.2 + padding) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);';

// One faint outer coating across the nine banks. No internal partitions,
// mirrored geometry, depth copies or opaque walls against the stars.
export class Enclosure {
  constructor(scene, lighting) {
    this.scene = scene; this.matrix = new THREE.Matrix4();
    const material = new THREE.MeshLambertMaterial({ color: 0xaab5c0, side: THREE.BackSide, transparent: true, opacity: .035, depthWrite: false });
    material.onBeforeCompile = shader => lighting.apply(shader);
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1, 120, 16, 1), material, 1);
    this.mesh.frustumCulled = false; scene.add(this.mesh);
  }
  update(width, height, depth) {
    this.matrix.makeScale(BOX_OFFSETS.length * width, height, depth).setPosition(width / 2, height / 2, 0);
    this.mesh.setMatrixAt(0, this.matrix); this.mesh.instanceMatrix.needsUpdate = true;
  }
  dispose() {
    this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.dispose();
  }
}
