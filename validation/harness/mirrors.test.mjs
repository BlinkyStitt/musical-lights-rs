import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../../musical-lights-physics/pkg/three.module.js';
import { SceneLighting } from '../../musical-lights-physics/pkg/lighting.js';
import { MirrorRoom, mirrorCells, MAX_DEPTH_IMAGES } from '../../musical-lights-physics/pkg/mirrors.js';
import { sphereGeometry } from '../../musical-lights-physics/pkg/spheres.js';
import { curveMaximum } from '../../musical-lights-physics/pkg/side-bars.js';

test('culling bounds include the interior peak of time-interpolated spline tips', () => {
  // Both blended endpoints are .5, but reversing tangents leave a .505 peak.
  const coefficients = [.5, .02, -.02, 0];
  const bound = curveMaximum(coefficients);
  assert(bound > .505);
  for (let i = 0; i <= 1000; i++) {
    const t = i / 1000, [a, b, c, d] = coefficients;
    assert(a + t * (b + t * (c + t * d)) <= bound);
  }
  assert.equal(curveMaximum([.1, 0, 0, 0]), .1);
});

test('sphere meshes have a closed outward surface, unit normals and shared vertices', () => {
  for (const detail of [2, 7]) {
    const geometry = sphereGeometry(detail), points = geometry.attributes.position, normals = geometry.attributes.normal;
    const index = geometry.index.array, edges = new Map(), seen = new Set();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3();
    for (let i = 0; i < points.count; i++) {
      a.fromBufferAttribute(points, i); normal.fromBufferAttribute(normals, i);
      assert(Math.abs(a.length() - 1) < 1e-6); assert(Math.abs(normal.length() - 1) < 1e-6);
      assert(a.dot(normal) > .999999);
      const key = a.toArray().map(n => Math.round(n * 1e6)).join(',');
      assert(!seen.has(key)); seen.add(key);
    }
    for (let i = 0; i < index.length; i += 3) {
      const triangle = Array.from(index.slice(i, i + 3));
      a.fromBufferAttribute(points, triangle[0]); b.fromBufferAttribute(points, triangle[1]); c.fromBufferAttribute(points, triangle[2]);
      assert(b.sub(a).cross(c.sub(a)).dot(a) > 0);
      for (let j = 0; j < 3; j++) {
        const key = [triangle[j], triangle[(j + 1) % 3]].sort((x, y) => x - y).join(',');
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    assert([...edges.values()].every(n => n === 2));
    assert.equal(points.count - edges.size + index.length / 3, 2);
    geometry.dispose();
  }
});

test('ball depth images keep bounded pools, source transforms and non-indexed geometry', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshLambertMaterial(); material.defines = { PIXEL_RATIO: '2.0' };
  const geometry = new THREE.SphereGeometry().toNonIndexed();
  assert.equal(geometry.index, null);
  geometry.setAttribute('pigmentA', new THREE.InstancedBufferAttribute(new Float32Array([.2,.3,.4,.5,.6,.7]), 3));
  const balls = new THREE.InstancedMesh(geometry, material, 2);
  for (let i = 0; i < 2; i++) {
    balls.setMatrixAt(i, new THREE.Matrix4().makeScale(.12, .12, .12).setPosition(.3 + i * .6, .1, .02));
    balls.setColorAt(i, new THREE.Color(.4, .2 + i * .1, .1));
  }
  const room = new MirrorRoom(scene, balls, 3, new SceneLighting(new Float32Array(72), {}));
  const camera = new THREE.PerspectiveCamera(150, 1, .01, 10000);
  camera.position.set(0, 0, 4); camera.updateMatrixWorld();
  room.update(1.2, .6, .24, camera);
  assert.equal(room.poolCount, 4);
  assert.equal(room.meshes[0].mesh.instanceMatrix.array.length, 2 * 4 * 16);
  assert.equal(room.walls.geometry.groups.length, 6); assert.equal(room.walls.count, 1);
  assert.equal(room.meshes.length, 1);
  assert.equal(scene.children.some(node => node.isLineSegments), false);
  assert.equal(room.walls.instanceMatrix.array[0], Math.fround(10.8));
  assert.equal(room.walls.instanceMatrix.array[12], Math.fround(.6));
  assert.equal(mirrorCells(3).length, 3);
  assert.equal(mirrorCells(0).length, 0); assert.equal(mirrorCells(17).length, 17);
  for (const value of [-1, MAX_DEPTH_IMAGES + 1, 1.5, NaN]) assert.throws(() => mirrorCells(value), RangeError);
  assert.deepEqual(mirrorCells(3).slice(0, 2), [[0, 0, -1], [0, 0, -2]]);
  assert.equal(new Set(mirrorCells(17).map(c => c.join(','))).size, 17);
  assert.equal(room.sources[0].capacity, balls.count);
  assert.deepEqual(room.sources[0].matrices, balls.instanceMatrix.array);
  assert.deepEqual(room.sources[0].colors, balls.instanceColor.array);
  assert.equal(room.walls.instanceMatrix.array[10], Math.fround(.96));
  assert.equal(room.walls.instanceMatrix.array[14], Math.fround(-.36));
  assert(room.meshes[0].mesh.geometry.index.count / 3 > 168);
  assert(room.meshes[0].mesh.geometry.attributes.position.count < 117);
  for (const { mesh, staged } of room.meshes) {
    assert.equal(mesh.material.defines.PIXEL_RATIO, '2.0');
    assert.equal(mesh.material.isMeshLambertMaterial, true);
    assert(mesh.instanceMatrix.array.every(Number.isFinite));
    assert.deepEqual(Array.from(mesh.geometry.attributes.copyDepth.array.slice(0, mesh.count)),
      Array.from({ length: 3 }, (_, c) => Array(staged.capacity).fill(-c - 1)).flat());
  }
  const meshes = room.meshes.map(({mesh}) => mesh);
  room.setCount(0); assert(room.meshes.every(({mesh}) => mesh.count === 0 && !mesh.visible));
  const oldGeometry = room.meshes[0].mesh.geometry; let geometryReleases = 0, bufferReleases = 0;
  oldGeometry.addEventListener('dispose', () => geometryReleases++);
  meshes[0].addEventListener('dispose', () => bufferReleases++);
  room.setCount(17); assert.equal(room.poolCount, 32);
  assert.equal(geometryReleases, 1); assert.equal(bufferReleases, 1);
  assert.deepEqual(room.meshes.map(({mesh}) => mesh), meshes);
  assert.equal(room.meshes.filter(s=>s.staged.kind==='balls').reduce((n,s)=>n+s.mesh.count,0), balls.count * 17);
  room.setCount(MAX_DEPTH_IMAGES); room.update(1.2, .6, .24, camera);
  assert.equal(room.meshes[0].mesh.count, balls.count * MAX_DEPTH_IMAGES);
  assert.equal(room.meshes[0].mesh.instanceMatrix.array.length, balls.count * MAX_DEPTH_IMAGES * 16);
  assert(room.meshes[0].mesh.instanceMatrix.array.every(Number.isFinite));
  for (let c = 0; c < MAX_DEPTH_IMAGES; c++) assert.deepEqual(room.meshes[0].mesh.geometry.attributes.pigmentA.array.slice(c*6,c*6+6), geometry.attributes.pigmentA.array);
  const expandedGeometry = meshes[0].geometry, expandedMatrices = meshes[0].instanceMatrix;
  room.setCount(8); assert.equal(meshes[0].geometry, expandedGeometry); assert.equal(meshes[0].instanceMatrix, expandedMatrices);
  assert.equal(room.meshes.filter(s=>s.staged.kind==='balls').reduce((n,s)=>n+s.mesh.count,0), balls.count * 8);
  room.setCount(44); room.update(1.2, .6, .24, camera);
  assert.equal(room.walls.instanceMatrix.array[0], room.walls.instanceMatrix.array[10],
    '44 depth images match the nine-box width at the default physical depth');
  room.dispose(); assert.equal(scene.children.length, 0);
  geometry.dispose(); material.dispose();
});

test('depth culling keeps images that enter the view later and removes the invisible tail', () => {
  const scene = new THREE.Scene(), geometry = new THREE.SphereGeometry(), material = new THREE.MeshLambertMaterial();
  const balls = new THREE.InstancedMesh(geometry, material, 1);
  balls.setMatrixAt(0, new THREE.Matrix4().makeScale(.1, .1, .1).setPosition(3, 0, 0));
  balls.setColorAt(0, new THREE.Color(1, 0, 0));
  const camera = new THREE.PerspectiveCamera(30, 1, .01, 12);
  camera.position.set(0, 0, 4); camera.updateMatrixWorld();
  const room = new MirrorRoom(scene, balls, 17, new SceneLighting(new Float32Array(72), {}));
  room.update(1.2, .6, .24, camera);
  assert.equal(room.meshes[0].mesh.count, 0);
  assert.equal(room.meshes[0].mesh.visible, false);
  room.setCount(MAX_DEPTH_IMAGES); room.update(1.2, .6, .24, camera);
  const visible = room.meshes[0].mesh.count;
  assert(visible > 17 && visible < 64);
  assert.equal(room.count, MAX_DEPTH_IMAGES);
  const source = geometry.boundingSphere.clone().applyMatrix4(new THREE.Matrix4().fromArray(balls.instanceMatrix.array));
  for (let n = visible + 1; n <= MAX_DEPTH_IMAGES; n++)
    assert.equal(room.frustum.intersectsSphere(source.clone().translate(new THREE.Vector3(0, 0, -n * .24))), false);
  for (const attr of [room.meshes[0].mesh.instanceMatrix, room.meshes[0].mesh.instanceColor])
    assert.deepEqual(attr.updateRanges, [{ start: 0, count: visible * attr.itemSize }]);
  room.dispose(); geometry.dispose(); material.dispose();
});
