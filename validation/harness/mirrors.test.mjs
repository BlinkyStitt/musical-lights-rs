import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../../musical-lights-physics/pkg/three.module.js';
import { RoundedBoxGeometry } from '../../musical-lights-physics/pkg/RoundedBoxGeometry.js';
import { MirrorRoom, mirrorCells } from '../../musical-lights-physics/pkg/mirrors.js';

test('depth copies accept triangle soup and keep bounded pools without extra physics or reversed winding', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshLambertMaterial(); material.defines = { PIXEL_RATIO: '2.0' };
  const geometry = new RoundedBoxGeometry(.05, 20, .2, 1, .003);
  assert.equal(geometry.index, null);
  const bars = new THREE.InstancedMesh(geometry, material, 6);
  for (let i = 0; i < 6; i++) bars.setMatrixAt(i, new THREE.Matrix4().makeTranslation([-1.2, .6, 2.4][i % 3], 0, 0));
  const balls = new THREE.InstancedMesh(new THREE.SphereGeometry(), material, 2);
  bars.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(18), 3);
  balls.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(6), 3);
  const sides = new THREE.InstancedMesh(geometry.clone(), material, 2);
  sides.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(6), 3);
  const room = new MirrorRoom(scene, balls, bars, sides, 1.2);
  room.update(1.2, .6, .24);
  assert.equal(room.walls.geometry.groups.length, 6); assert.equal(room.walls.count, 1);
  assert.equal(room.meshes.length, 3);
  assert.equal(scene.children.some(node => node.isLineSegments), false);
  assert.equal(room.walls.instanceMatrix.array[0], 6);
  assert.equal(room.walls.instanceMatrix.array[12], Math.fround(.6));
  assert.equal(mirrorCells().length, 3);
  assert.equal(mirrorCells(0).length, 0); assert.equal(mirrorCells(17).length, 17);
  for (const value of [-1, 18, 1.5, NaN]) assert.throws(() => mirrorCells(value), RangeError);
  assert.deepEqual(mirrorCells().slice(0, 2), [[0, 0, -1], [0, 0, -2]]);
  assert.equal(new Set(mirrorCells(17).map(c => c.join(','))).size, 17);
  const staged = room.sources.find(s => s.kind === 'bars');
  assert.equal(staged.capacity, 4);
  assert.equal(staged.matrices[12], Math.fround(.6));
  assert.equal(staged.matrices[28], Math.fround(.6));
  assert(staged.matrices.slice(32).every(v => v === 0));
  assert.deepEqual(Array.from(room.meshes[1].mesh.geometry.index.array.slice(0, 3)), [0, 2, 1]);
  assert.equal(room.meshes[1].mesh.geometry.index.count, 36);
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
  geometry.dispose(); sides.geometry.dispose(); balls.geometry.dispose(); material.dispose();
});
