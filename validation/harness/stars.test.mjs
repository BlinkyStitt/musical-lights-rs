import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../musical-lights-physics/pkg/three.module.js';
import { Starfield } from '../../musical-lights-physics/pkg/stars.js';

test('starfield has a stable bounded sky and releases its scene resources', () => {
  const a = new Starfield(new THREE.Scene(), { value: .75 });
  const b = new Starfield(new THREE.Scene(), { value: 1 });
  const positions = a.points.geometry.attributes.position;
  assert.equal(positions.count, 512);
  assert.deepEqual(positions.array, b.points.geometry.attributes.position.array);
  for (let i = 0; i < positions.count; i++) {
    assert(Math.abs(positions.getX(i)) <= 1 && Math.abs(positions.getY(i)) <= 1);
  }
  a.update(2500, false); assert.equal(a.uniforms.time.value, 2.5);
  a.update(3500, true); assert.equal(a.uniforms.time.value, 0);
  a.update(4500, true); assert.equal(a.uniforms.time.value, 0);
  const disposed = [];
  a.points.geometry.addEventListener('dispose', () => disposed.push('geometry'));
  a.points.material.addEventListener('dispose', () => disposed.push('material'));
  a.dispose(); b.dispose();
  assert.deepEqual(disposed, ['geometry', 'material']);
  assert.equal(a.scene.children.length, 0); assert.equal(a.scene.background, null);
});
