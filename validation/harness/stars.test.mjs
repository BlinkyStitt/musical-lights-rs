import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../musical-lights-physics/pkg/three.module.js';
import { Starfield, STAR_COUNT, skyDirection } from '../../musical-lights-physics/pkg/stars.js';
import { CATALOG } from '../../musical-lights-physics/pkg/stars-catalog.js';

test('starfield has a stable bounded sky and releases its scene resources', () => {
  const a = new Starfield(new THREE.Scene(), { value: .75 });
  const b = new Starfield(new THREE.Scene(), { value: 1 });
  const positions = a.points.geometry.attributes.position;
  assert.equal(positions.count, 8920);
  assert.equal(STAR_COUNT, CATALOG.length);
  assert.deepEqual(positions.array, b.points.geometry.attributes.position.array);
  for (let i = 0; i < positions.count; i++) {
    assert(Math.abs(Math.hypot(positions.getX(i), positions.getY(i), positions.getZ(i)) - 1) < 1e-6);
  }
  const quiet = new Float32Array(24);
  a.update(2500, false, 2, 120, 1, false, quiet); assert.equal(a.uniforms.time.value, 2.5);
  a.update(3500, true, 2, 120, 1, false, quiet); assert.equal(a.uniforms.time.value, 0);
  a.update(4500, true, 2, 120, 1, false, quiet); assert.equal(a.uniforms.time.value, 0);
  const disposed = [];
  a.points.geometry.addEventListener('dispose', () => disposed.push('geometry'));
  a.points.material.addEventListener('dispose', () => disposed.push('material'));
  a.dispose(); b.dispose();
  assert.deepEqual(disposed, ['geometry', 'material']);
  assert.equal(a.scene.children.length, 0); assert.equal(a.scene.background, null);
});

test('catalog coordinates, magnitude limit and Orion landmarks retain their real identities', () => {
  assert.equal(new Set(CATALOG.map(row => row[0])).size, CATALOG.length);
  assert(!CATALOG.some(row => row[0] === 0));
  assert(CATALOG.every(([, ra, dec, magnitude]) => ra >= 0 && ra < 24 && dec >= -90 && dec <= 90 && magnitude <= 6.5));
  assert.deepEqual(CATALOG.find(row => row[0] === 32263), [32263, 6.752481, -16.716116, -1.44, .009]);
  assert.deepEqual(CATALOG.find(row => row[0] === 27919), [27919, 5.919529, 7.407063, .45, 1.5]);
  assert.deepEqual(CATALOG.find(row => row[0] === 24378), [24378, 5.242298, -8.20164, .18, -.03]);
  assert.deepEqual(skyDirection(5.6, 0), [0, 0, 1]);
  const east = skyDirection(11.6, 0), north = skyDirection(5.6, 90);
  assert(Math.abs(east[0] + 1) < 1e-12 && Math.abs(east[2]) < 1e-12);
  assert(Math.abs(north[1] - 1) < 1e-12);
});

test('tempo shimmer follows BPM without phase jumps and ignores inactive or uncertain tempo', () => {
  const a = new Starfield(new THREE.Scene(), { value: 1 }), b = new Starfield(new THREE.Scene(), { value: 1 });
  const quiet = new Float32Array(24);
  const update = (sky, now, bpm, confidence = 1, playing = true) => sky.update(now, false, 1, bpm, confidence, playing, quiet);
  update(a, 0, 120); update(a, 125, 120); assert.equal(a.uniforms.beat.value, .25);
  update(a, 125, 60); assert.equal(a.uniforms.beat.value, .25);
  update(a, 375, 60); assert.equal(a.uniforms.beat.value, .5);
  update(b, 0, 120); for (const now of [25, 50, 75, 100, 125]) update(b, now, 120);
  assert(Math.abs(b.uniforms.beat.value - .25) < 1e-12);
  update(a, 1000, 120, 0); assert.equal(a.uniforms.musical.value, 0); assert.equal(a.uniforms.beat.value, .5);
  update(a, 2000, 120, 1, false); update(a, 3000, 120); assert.equal(a.uniforms.beat.value, .5);
  update(a, 4000, NaN); assert.equal(a.uniforms.musical.value, 0);
  a.dispose(); b.dispose();
});

test('qualified band envelopes affect their stars and reduced motion or Stop clears modulation', () => {
  const sky = new Starfield(new THREE.Scene(), { value: 1 }), attacks = new Float32Array(24);
  attacks[3] = .75; attacks[5] = NaN;
  sky.update(0, false, 1, 120, 1, true, attacks);
  assert.equal(sky.uniforms.attacks.value[3], .75); assert.equal(sky.uniforms.attacks.value[5], 0);
  assert.equal(sky.uniforms.attacks.value.filter(v => v > 0).length, 1);
  sky.update(100, true, 1, 120, 1, true, attacks);
  assert.equal(sky.uniforms.time.value, 0); assert.equal(sky.uniforms.musical.value, 0);
  assert(sky.uniforms.attacks.value.every(v => v === 0));
  sky.update(200, false, 1, 120, 1, false, attacks);
  assert(sky.uniforms.attacks.value.every(v => v === 0)); sky.dispose();
});
