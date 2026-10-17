import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../../musical-lights-physics/pkg/three.module.js';
import { SceneLighting } from '../../musical-lights-physics/pkg/lighting.js';
import { Enclosure, BOX_OFFSETS } from '../../musical-lights-physics/pkg/enclosure.js';
import { sphereGeometry } from '../../musical-lights-physics/pkg/spheres.js';
import { rampMaximum } from '../../musical-lights-physics/pkg/side-bars.js';

test('culling bounds contain the flat cap and both straight half-joins', () => {
  for (const heights of [[1, .01, .1], [.1, .8, 1], [.1, .1, .1]]) {
    const bound = rampMaximum(heights);
    for (let i = 0; i <= 1000; i++) {
      const x = i / 1000 - .5;
      const blend = Math.max(0, (Math.abs(x) - .48) / .04);
      const neighbour = x < 0 ? heights[0] : heights[2];
      assert(heights[1] * (1 - blend) + neighbour * blend <= bound + 1e-14);
    }
  }
  assert.equal(rampMaximum([1, .01, .1]), .505);
  assert.equal(rampMaximum([.1, .8, 1]), .9);
  assert.equal(rampMaximum([.1, .1, .1]), .1);
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

test('one outer coating spans nine banks at physical depth without copied balls or internal walls', () => {
  const scene = new THREE.Scene();
  const room = new Enclosure(scene, new SceneLighting(new Float32Array(72), {}));
  const mesh = room.mesh, geometry = mesh.geometry, matrices = mesh.instanceMatrix;
  assert.equal(mesh.count, 1); assert.equal(scene.children.length, 1);
  assert.equal(geometry.groups.length, 6); assert.equal(mesh.material.isMeshLambertMaterial, true);
  assert.equal(mesh.material.transparent, true); assert.equal(mesh.material.depthWrite, false);
  assert.equal(mesh.material.side, THREE.BackSide); assert(mesh.material.opacity < .05);
  assert.equal(scene.children.some(node => node.isLineSegments || node.geometry.attributes.copyDepth), false);
  assert.deepEqual(BOX_OFFSETS, [-4,-3,-2,-1,0,1,2,3,4]);
  for (const depth of [.2, .48, 2, .2]) {
    room.update(1.2, .6, depth);
    assert.equal(mesh.geometry, geometry); assert.equal(mesh.instanceMatrix, matrices);
    assert.equal(matrices.array.length, 16); assert(matrices.array.every(Number.isFinite));
    assert.equal(matrices.array[0], Math.fround(10.8)); assert.equal(matrices.array[5], Math.fround(.6));
    assert.equal(matrices.array[10], Math.fround(depth));
    assert.equal(matrices.array[12], Math.fround(.6)); assert.equal(matrices.array[13], Math.fround(.3));
    assert.equal(matrices.array[14], 0);
  }
  let geometryReleases=0, materialReleases=0, bufferReleases=0;
  geometry.addEventListener('dispose', () => geometryReleases++);
  mesh.material.addEventListener('dispose', () => materialReleases++);
  mesh.addEventListener('dispose', () => bufferReleases++);
  room.dispose(); assert.equal(scene.children.length, 0);
  assert.deepEqual([geometryReleases, materialReleases, bufferReleases], [1,1,1]);
});
