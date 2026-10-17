import * as THREE from './three.module.js';

export const BOX_OFFSETS = Object.freeze([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
// The bar mesh and the glass cutouts use one surface profile. Dimensions
// come from the shared core layout, and heights use the rendered snapshots.
export const BAR_PROFILE = `
  uniform float halfWidth; uniform float capHalfWidth;
  void rampAt(float x, vec3 heights, out float height, out float slope) {
    float halfJoin = halfWidth - capHalfWidth;
    float fraction = clamp((abs(x) - capHalfWidth) / (2.0 * halfJoin), 0.0, 0.5);
    float neighbour = x < 0.0 ? heights.x : heights.z;
    height = mix(heights.y, neighbour, fraction);
    slope = abs(x) > capHalfWidth ? sign(x) * (neighbour - heights.y) / (2.0 * halfJoin) : 0.0;
  }
`;

// Source posts have their actual box depth. Clip wholly discarded scrolling
// posts before rasterization, retaining conservative padding at window edges.
export const barProjection = 'vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0); world = mvPosition.xyz; mvPosition.y -= sign(instanceMatrix[1].y) * barExtension * (.5 - position.y); mvPosition = modelViewMatrix * mvPosition; gl_Position = projectionMatrix * mvPosition; world.x -= backgroundOffset; float padding = .000001 * (1.0 + abs(instanceMatrix[3].x) + abs(backgroundOffset)); if (instanceMatrix[3].x + halfWidth - backgroundOffset < -padding || instanceMatrix[3].x - halfWidth - backgroundOffset > 1.2 + padding) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);';

// One faint outer coating across the nine banks. No internal partitions,
// mirrored geometry, depth copies or opaque walls against the stars.
export class Enclosure {
  constructor(scene, lighting) {
    this.scene = scene; this.matrix = new THREE.Matrix4();
    // Opaque bars own shared depth boundaries; the coating must not blend
    // over a source surface at the same depth.
    const material = new THREE.MeshLambertMaterial({ color: 0xaab5c0, side: THREE.BackSide, transparent: true, opacity: .035, depthWrite: false, depthFunc: THREE.LessDepth });
    material.onBeforeCompile = shader => {
      lighting.apply(shader);
      shader.vertexShader = 'varying vec3 coatingPoint;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ncoatingPoint = (instanceMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = BAR_PROFILE + `
        varying vec3 coatingPoint;
        uniform vec3 stripState[24]; uniform vec3 lightExtent;
      ` + shader.fragmentShader;
      // Bars pass through the floor and roof and meet the front/back walls.
      // Glass inside those opaque volumes has no exposed surface. Exclude it
      // geometrically, rather than relying on coplanar depth rounding.
      shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        float pitch = 2.0 * halfWidth;
        float cell = mod(coatingPoint.x - stripState[0].x + halfWidth, lightExtent.x) / pitch;
        int band = int(mod(floor(cell), 24.0));
        int leftBand = int(mod(float(band) + 23.0, 24.0));
        int rightBand = int(mod(float(band) + 1.0, 24.0));
        float surfaceHeight, surfaceSlope;
        rampAt((fract(cell) - 0.5) * pitch,
          vec3(stripState[leftBand].y, stripState[band].y, stripState[rightBand].y), surfaceHeight, surfaceSlope);
        if (coatingPoint.y <= surfaceHeight || coatingPoint.y >= lightExtent.y - surfaceHeight) discard;
      `);
    };
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
