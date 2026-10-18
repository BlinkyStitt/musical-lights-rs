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
  const quiet = new Float32Array(24), camera = new THREE.PerspectiveCamera(30, 2, .01, 200);
  a.update(2500, false, camera, 0, .05, .5, .48, quiet); assert.equal(a.uniforms.time.value, 2.5);
  a.update(3500, true, camera, 0, .05, .5, .48, quiet); assert.equal(a.uniforms.time.value, 0);
  a.update(4500, true, camera, 0, .05, .5, .48, quiet); assert.equal(a.uniforms.time.value, 0);
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

const sky = () => new Starfield(new THREE.Scene(), { value: 1 });
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('columns use the displayed flash strength without another envelope or clock', () => {
  const s = sky(), camera = new THREE.PerspectiveCamera(30, 2, .01, 200);
  const flashes = new Float32Array(144); flashes[3] = .8; flashes[8] = .25;
  // Repeated mesh instances must not multiply the source strength.
  flashes.fill(1, 24);
  for (const now of [0, 25, 450, 10000]) {
    s.update(now, false, camera, 4.25, .05, .5, .48, flashes);
    close(s.flashes[3], .8); close(s.flashes[8], .25);
    assert.equal(s.flashes.length, 24); assert.equal(s.flashes[4], 0);
  }
  flashes.fill(0); s.update(10000, false, camera, 4.25, .05, .5, .48, flashes);
  assert(s.flashes.every(value => value === 0)); s.dispose();
});

test('column projection follows the actual front face under camera, aspect and depth changes', () => {
  const s = sky(), camera = new THREE.PerspectiveCamera(40, 2, .01, 200), flashes = new Float32Array(24);
  for (const yaw of [-40, 0, 40]) for (const aspect of [.5, 2]) for (const depth of [.2, 2]) {
    camera.aspect = aspect; camera.updateProjectionMatrix();
    const angle = yaw * Math.PI / 180;
    camera.position.set(.6 + Math.sin(angle) * 4, .4, Math.cos(angle) * 4); camera.lookAt(.6, .25, 0);
    s.update(0, false, camera, 23.75, .05, .5, depth, flashes);
    for (const x of [-4.75, -.025, .6, 1.225, 5.75]) {
      const point = new THREE.Vector3(x, .21, depth / 2).project(camera);
      const room = new THREE.Vector3(point.x, point.y, 1).applyMatrix3(s.uniforms.starToRoom.value);
      close(room.x / room.z, x); close(room.y / room.z, .21);
    }
    close(s.uniforms.extent.value.z, -4.8); close(s.uniforms.extent.value.w, 6);
  }
  s.dispose();
});

test('Reduced Motion and reset clear column light without event history', () => {
  const s = sky(), camera = new THREE.PerspectiveCamera(30, 1, .01, 200), flashes = new Float32Array(24).fill(1);
  s.update(100, false, camera, 0, .05, .5, .48, flashes); assert(s.flashes.every(v => v === 1));
  s.update(200, true, camera, 0, .05, .5, .48, flashes);
  assert(s.flashes.every(v => v === 0)); assert.equal(s.uniforms.motion.value, 0); assert.equal(s.uniforms.time.value, 0);
  s.reset(); assert(s.flashes.every(v => v === 0)); assert.equal(s.uniforms.extent.value.y, 0);
  s.update(300, false, camera, 24, .05, .5, .48, flashes); assert(s.flashes.every(v => v === 1)); s.dispose();
});

test('invalid display strengths cannot create non-finite or negative star light', () => {
  const s = sky(), camera = new THREE.PerspectiveCamera(30, 1, .01, 200), flashes = new Float32Array(24);
  flashes.set([NaN, Infinity, -1, 2]);
  s.update(0, false, camera, 0, .05, .5, .48, flashes);
  assert.deepEqual(Array.from(s.flashes.slice(0, 4)), [0, 0, 0, 1]); s.dispose();
});
