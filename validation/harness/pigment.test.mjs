import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { blendHsluv, hsluvToLinear, linearToHsluv } from '../../musical-leptos/src/physics/pigment.js';
const fixture = JSON.parse(await readFile(new URL('../fixtures/hsluv-reference.json', import.meta.url)));
const convert = linear => linearToHsluv(linear, 0, new Float64Array(3), 0);
const near = (a,b,tolerance) => a.forEach((v,i) => assert(Math.abs(v-b[i]) < tolerance, `${a} != ${b}`));

test('renderer conversion mirrors core against official HSLuv snapshot rev4', () => {
  for (const { linear, hsluv } of fixture.vectors) {
    near(convert(linear), hsluv, .0001);
    near(hsluvToLinear(hsluv), linear, .000003);
    near(hsluvToLinear(convert(linear)), linear, .000003);
  }
});

test('renderer hue policy mirrors core wrap, increasing opposite ties and achromatic borrowing', () => {
  for (const [a,b,h] of [[350,10,0],[10,350,0],[0,180,90],[180,0,270]])
    near(blendHsluv([a,100,58],[b,100,58],.5),[h,100,58],.0001);
  for (const grey of [[90,0,50],[0,0,0],[0,0,100]]) {
    assert.equal(blendHsluv(grey,[280,100,58],.5)[0],280);
    assert.equal(blendHsluv([280,100,58],grey,.5)[0],280);
  }
  near(blendHsluv([90,0,20],[270,0,80],.5),[0,0,50],.0001);
});


test('packed pigment uploads preserve region offsets, neighboring attributes and invalid-input boundaries', () => {
  const source = Float64Array.from([.25, ...fixture.vectors.flatMap(v => v.linear), .75]);
  const before = source.slice(), target = new Float32Array(3 * fixture.vectors.length + 4).fill(-1);
  for (let i = 0; i < fixture.vectors.length; i++) {
    assert.equal(linearToHsluv(source, 1 + 3 * i, target, 2 + 3 * i), target);
    near(target.slice(2 + 3 * i, 5 + 3 * i), fixture.vectors[i].hsluv, .0001);
  }
  assert.deepEqual(source, before);
  assert.deepEqual(Array.from(target.slice(0, 2)), [-1, -1]);
  assert.deepEqual(Array.from(target.slice(-2)), [-1, -1]);
  const valid = target.slice();
  for (const invalid of [NaN, Infinity, -.01, 1.01]) for (let component = 0; component < 3; component++) {
    const rgb = [.1, .2, .3]; rgb[component] = invalid;
    assert.throws(() => linearToHsluv(rgb, 0, target, 2), /Invalid linear pigment/);
    assert.deepEqual(target, valid);
  }
});
