import * as THREE from './three.module.js';
import { mergeVertices } from './BufferGeometryUtils.js';

// Evenly divided faces smooth the silhouette without concentrating vertices
// at the poles. Pigment uses 3D positions, so UV seams need no extra vertices.
export function sphereGeometry(detail) {
  const source = new THREE.IcosahedronGeometry(1, detail);
  source.deleteAttribute('uv');
  const geometry = mergeVertices(source, 1e-6);
  source.dispose();
  return geometry;
}
