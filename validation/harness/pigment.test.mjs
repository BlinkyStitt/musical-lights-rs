import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { blendHsluv, hsluvToLinear, linearToHsluv } from '../../musical-leptos/src/physics/pigment.js';
const fixture = JSON.parse(await readFile(new URL('../fixtures/hsluv-reference.json', import.meta.url)));
const near = (a,b,tolerance) => a.forEach((v,i) => assert(Math.abs(v-b[i]) < tolerance, `${a} != ${b}`));

test('renderer conversion mirrors core against official HSLuv snapshot rev4', () => {
  for (const { linear, hsluv } of fixture.vectors) {
    near(linearToHsluv(linear), hsluv, .0001);
    near(hsluvToLinear(hsluv), linear, .000003);
    near(hsluvToLinear(linearToHsluv(linear)), linear, .000003);
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
