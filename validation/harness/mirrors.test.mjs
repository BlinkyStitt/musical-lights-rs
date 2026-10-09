import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../../musical-lights-physics/pkg/three.module.js';
import { MirrorRoom, mirrorCells } from '../../musical-lights-physics/pkg/mirrors.js';

test('ball depth images keep bounded pools, source transforms and non-indexed geometry', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshLambertMaterial(); material.defines = { PIXEL_RATIO: '2.0' };
  const geometry = new THREE.SphereGeometry().toNonIndexed();
  assert.equal(geometry.index, null);
  const balls = new THREE.InstancedMesh(geometry, material, 2);
  for (let i = 0; i < 2; i++) {
    balls.setMatrixAt(i, new THREE.Matrix4().makeScale(.12, .12, .12).setPosition(.3 + i * .6, .1, .02));
    balls.setColorAt(i, new THREE.Color(.4, .2 + i * .1, .1));
  }
  const room = new MirrorRoom(scene, balls, 3);
  room.update(1.2, .6, .24);
  assert.equal(room.walls.geometry.groups.length, 6); assert.equal(room.walls.count, 1);
  assert.equal(room.meshes.length, 1);
  assert.equal(scene.children.some(node => node.isLineSegments), false);
  assert.equal(room.walls.instanceMatrix.array[0], 6);
  assert.equal(room.walls.instanceMatrix.array[12], Math.fround(.6));
  assert.equal(mirrorCells(3).length, 3);
  assert.equal(mirrorCells(0).length, 0); assert.equal(mirrorCells(17).length, 17);
  for (const value of [-1, 18, 1.5, NaN]) assert.throws(() => mirrorCells(value), RangeError);
  assert.deepEqual(mirrorCells(3).slice(0, 2), [[0, 0, -1], [0, 0, -2]]);
  assert.equal(new Set(mirrorCells(17).map(c => c.join(','))).size, 17);
  assert.equal(room.sources[0].capacity, balls.count);
  assert.deepEqual(room.sources[0].matrices, balls.instanceMatrix.array);
  assert.deepEqual(room.sources[0].colors, balls.instanceColor.array);
  assert.equal(room.walls.instanceMatrix.array[10], Math.fround(.96));
  assert.equal(room.walls.instanceMatrix.array[14], Math.fround(-.36));
  assert.equal(room.meshes[0].mesh.geometry.parameters.widthSegments, 12);
  for (const { mesh, staged } of room.meshes) {
    assert.equal(mesh.material.defines.PIXEL_RATIO, '2.0');
    assert.equal(mesh.material.isMeshLambertMaterial, true);
    assert(mesh.instanceMatrix.array.every(Number.isFinite));
    assert.deepEqual(Array.from(mesh.geometry.attributes.copyDepth.array.slice(0, mesh.count)),
      Array.from({ length: 3 }, (_, c) => Array(staged.capacity).fill(-c - 1)).flat());
  }
  const meshes = room.meshes.map(({mesh}) => mesh);
  room.setCount(0); assert(room.meshes.every(({mesh}) => mesh.count === 0 && !mesh.visible));
  room.setCount(17); assert.deepEqual(room.meshes.map(({mesh}) => mesh), meshes);
  assert.equal(room.meshes.filter(s=>s.staged.kind==='balls').reduce((n,s)=>n+s.mesh.count,0), balls.count * 17);
  room.setCount(8); assert.equal(room.meshes.filter(s=>s.staged.kind==='balls').reduce((n,s)=>n+s.mesh.count,0), balls.count * 8);
  room.dispose(); assert.equal(scene.children.length, 0);
  geometry.dispose(); material.dispose();
});
