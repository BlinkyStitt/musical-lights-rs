import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../../musical-lights-physics/pkg/three.module.js';
import { RoundedBoxGeometry } from '../../musical-lights-physics/pkg/RoundedBoxGeometry.js';
import { MirrorRoom, mirrorCells } from '../../musical-lights-physics/pkg/mirrors.js';

test('mirror geometry accepts triangle soup, keeps shader defines and reverses odd winding', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshLambertMaterial(); material.defines = { PIXEL_RATIO: '2.0' };
  const geometry = new RoundedBoxGeometry(.05, 20, .2, 1, .003);
  assert.equal(geometry.index, null);
  const bars = new THREE.InstancedMesh(geometry, material, 6);
  for (let i = 0; i < 6; i++) bars.setMatrixAt(i, new THREE.Matrix4().makeTranslation([-1.2, .6, 2.4][i % 3], 0, 0));
  const balls = new THREE.InstancedMesh(new THREE.SphereGeometry(), material, 2);
  bars.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(18), 3);
  balls.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(6), 3);
  const room = new MirrorRoom(scene, balls, bars, 1.2);
  room.update(1.2, .6, .24);
  assert.equal(room.walls.children.length, 6); assert.equal(room.meshes.length, 4);
  assert.equal(mirrorCells().length, 17);
  const depths = mirrorCells().map(cell => cell.reduce((sum, n) => sum + Math.abs(n), 0));
  assert.deepEqual(depths, depths.toSorted((a, b) => a - b));
  const staged = room.sources.find(s => s.kind === 'bars');
  assert.equal(staged.capacity, 4);
  assert.equal(staged.matrices[12], Math.fround(.6));
  assert.equal(staged.matrices[28], Math.fround(.6));
  assert(staged.matrices.slice(32).every(v => v === 0));
  assert.deepEqual(Array.from(room.meshes[2].mesh.geometry.index.array.slice(0, 3)), [0, 2, 1]);
  assert.deepEqual(Array.from(room.meshes[3].mesh.geometry.index.array.slice(0, 3)), [0, 1, 2]);
  assert.equal(room.meshes[2].mesh.geometry.index.count, 36);
  for (const { mesh } of room.meshes) {
    assert.equal(mesh.material.defines.PIXEL_RATIO, '2.0');
    assert(mesh.instanceMatrix.array.every(Number.isFinite));
  }
  room.dispose(); assert.equal(scene.children.length, 0);
  geometry.dispose(); balls.geometry.dispose(); material.dispose();
});
