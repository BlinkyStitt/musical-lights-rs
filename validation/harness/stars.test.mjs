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

// The unchanged packed physics layout: 8 bodies, 24 bars, impulses and contacts.
const layout = [24]; layout[8] = 18; layout[10] = 171; layout[11] = 363;
function state(tick, { speed = 0, angular = 0, impulse = 0, band = -1, mass = 2, x = .5 } = {}) {
  const values = new Float32Array(400); values[2] = tick;
  for (let i = 0; i < 8; i++) { values[3 + i * 18 + 7] = .1; values[3 + i * 18 + 8] = mass; }
  values[3] = x; values[12] = speed; values[15] = angular;
  values[363] = impulse;
  if (band >= 0) values[171 + band] = impulse;
  return values;
}
const quiet = new Float32Array(24);
const sky = () => new Starfield(new THREE.Scene(), { value: 1 });
const update = (s, now, { bpm = 0, confidence = 1, playing = false, attacks = quiet, reduced = false } = {}) =>
  s.update(now, reduced, 1, bpm, confidence, playing, attacks);
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('rolling normalizes linear and rim speed with 80 ms rise and 300 ms release', () => {
  const s = sky(); s.snapshot(state(1, { speed: .015 }), layout, 0); update(s, 0); update(s, 80);
  close(s.rolling[0], 0);
  s.snapshot(state(2, { speed: .6 }), layout, 80); update(s, 160);
  close(s.rolling[0], 1 - Math.exp(-1));
  s.snapshot(state(3), layout, 160); update(s, 460);
  close(s.rolling[0], (1 - Math.exp(-1)) * Math.exp(-1));
  const angular = sky(); angular.snapshot(state(1, { angular: 6 }), layout, 0); update(angular, 0); update(angular, 80);
  close(angular.rolling[0], 1 - Math.exp(-1));
  assert(s.influences.slice(1).every(v => v.w === 0)); s.dispose(); angular.dispose();
});

test('new bounces need prior motion and impulse per mass, then rise and fade', () => {
  for (const [speed, impulse, mass, qualifies] of [[.1, 1.5, 2, true], [.03, 1.5, 2, false], [.1, .2, 2, false], [.1, 1.5, 0, false]]) {
    const s = sky(); s.snapshot(state(1, { speed }), layout, 0); update(s, 0);
    s.snapshot(state(2, { impulse, mass }), layout, 10); update(s, 10);
    close(s.influences[0].w, .3 * s.rolling[0]);
    update(s, 35);
    close(s.influences[0].w, .3 * s.rolling[0] + (qualifies ? .2 : 0));
    // Fresh supporting ticks retain the envelope without extending its end.
    for (const t of [100, 200, 300, 400, 485]) s.snapshot(state(t, { impulse, mass }), layout, t);
    update(s, 485); close(s.influences[0].w, .3 * s.rolling[0]);
    assert.equal(s.bounceAt[0], qualifies ? 10 : -Infinity); s.dispose();
  }
});

test('duplicate ticks, support, wrapping, camera and resize do not generate impacts', () => {
  const s = sky(); s.snapshot(state(1, { speed: .6 }), layout, 0);
  s.snapshot(state(1, { impulse: 2 }), layout, 100); assert.equal(s.received, 0); assert.equal(s.bounceAt[0], -Infinity);
  s.snapshot(state(2, { speed: .6, x: 100 }), layout, 101); assert.equal(s.bounceAt[0], -Infinity);
  s.snapshot(state(3, { impulse: 2 }), layout, 102); assert.equal(s.bounceAt[0], 102);
  s.snapshot(state(4, { impulse: 2 }), layout, 200); assert.equal(s.bounceAt[0], 102);
  const camera = new THREE.PerspectiveCamera(30, 2, .01, 200); camera.position.z = 2; camera.updateMatrixWorld();
  s.place(0, new THREE.Vector3(0, 0, 0), .001, camera); close(s.influences[0].z, .70);
  camera.position.x = .5; camera.aspect = 1; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  s.place(0, new THREE.Vector3(0, 0, 0), 1, camera); close(s.influences[0].z, 1.50);
  assert(s.influences[0].x < 0); assert.equal(s.bounceAt[0], 102);
  s.place(0, new THREE.Vector3(0, 0, 0), .05, camera);
  close(s.influences[0].z, 24 * .05 * camera.projectionMatrix.elements[5] / 4); s.dispose();
});

test('stale physics fades local responses after 250 ms and clears them at 550 ms', () => {
  const s = sky(); s.snapshot(state(1, { speed: .6 }), layout, 0); update(s, 0);
  s.rolling[0] = 1; update(s, 250); close(s.influences[0].w, .3);
  update(s, 400); close(s.influences[0].w, .15);
  s.snapshot(state(1), layout, 500); update(s, 550); assert.equal(s.influences[0].w, 0);
  s.snapshot(state(2, { speed: .6 }), layout, 551); update(s, 551); assert(s.influences[0].w > 0);
  s.dispose();
});

test('reset and recreated or rewound physics suppress initial contacts', () => {
  const s = sky(); s.snapshot(state(10, { speed: .6 }), layout, 0); update(s, 0);
  s.snapshot(state(11, { impulse: 2 }), layout, 10); assert.equal(s.bounceAt[0], 10);
  s.reset(); assert(s.influences.every(v => v.w === 0));
  s.snapshot(state(11, { impulse: 2 }), layout, 20); assert.equal(s.bounceAt[0], -Infinity);
  s.snapshot(state(12, { speed: .6 }), layout, 30);
  s.snapshot(state(1, { impulse: 2 }), layout, 40); assert.equal(s.bounceAt[0], -Infinity); s.dispose();
});

test('only contacting source attacks add local music, with BPM on existing responses', () => {
  const s = sky(), attacks = quiet.slice(); attacks[3] = 1; attacks[5] = NaN;
  s.snapshot(state(1, { impulse: .2, band: 3 }), layout, 0); update(s, 0, { playing: true, attacks });
  close(s.influences[0].w, .1); assert(s.influences.slice(1).every(v => v.w === 0));
  update(s, 0, { bpm: 120, playing: true, attacks }); close(s.influences[0].w, .15);
  update(s, 125, { bpm: 120, playing: true, attacks }); close(s.phase, .25); close(s.influences[0].w, .125);
  update(s, 125, { bpm: 60, playing: true, attacks }); close(s.phase, .25);
  update(s, 375, { bpm: 60, playing: true, attacks }); close(s.phase, .5);
  s.snapshot(state(2, { impulse: .2, band: 4 }), layout, 375);
  update(s, 375, { bpm: 120, playing: true, attacks }); close(s.influences[0].w, 0);
  update(s, 400, { bpm: 120, confidence: 0, playing: true, attacks }); close(s.phase, .5);
  update(s, 1000, { bpm: NaN, playing: true, attacks }); close(s.phase, .5); assert.equal(s.wasTempo, false);
  update(s, 2000, { bpm: 120, playing: false, attacks });
  update(s, 3000, { bpm: 120, playing: true, attacks }); close(s.phase, .5);
  const split = sky(); update(split, 0, { bpm: 120, playing: true });
  for (const t of [25, 50, 75, 100, 125]) update(split, t, { bpm: 120, playing: true });
  close(split.phase, .25); split.dispose(); s.dispose();
});

test('audio off removes only music, Reduced Motion holds base brightness', () => {
  const s = sky(), attacks = quiet.slice(); attacks[3] = 1;
  s.snapshot(state(1, { speed: .6, impulse: .2, band: 3 }), layout, 0); update(s, 0);
  update(s, 80, { bpm: 120, playing: true, attacks }); const musical = s.influences[0].w;
  update(s, 80, { bpm: 120, playing: false, attacks }); assert(s.influences[0].w > 0 && s.influences[0].w < musical);
  update(s, 100, { bpm: 120, playing: true, attacks, reduced: true });
  assert(s.influences.every(v => v.w === 0)); assert.equal(s.uniforms.motion.value, 0); assert.equal(s.uniforms.time.value, 0);
  s.dispose();
});
