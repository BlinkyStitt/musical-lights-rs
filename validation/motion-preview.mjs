// Export actual production-WASM trajectories, driven by identical PCM and held targets.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import startup from './browser-startup.mjs';
import { assertBrowserEnvironment } from './browser-environment.mjs';
import { staticPreview } from './static-preview.mjs';
import { flashPCM, flashTrace } from './partial/flash-fixtures.mjs';
assertBrowserEnvironment();
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node validation/motion-preview.mjs BASELINE_ROOT BASELINE_REVISION');
const baseline = resolve(process.argv[2]);
const baselineRevision = process.argv[3];
const engineHashes = {};
const output = 'docs/continuous-motion-results';
await mkdir(output, { recursive: true });
const finish = await startup({ filteredProjects: [{ name: 'chromium', use: { browserName: 'chromium' } }] });
let palette;
try {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await staticPreview(context, 'https://musical-lights.test');
    const page = await context.newPage(); await page.goto('https://musical-lights.test');
    await page.waitForFunction(() => document.querySelector('#dancinglights')?.physics?.current);
    palette = await page.evaluate(() => Array.from(document.querySelector('#dancinglights').physics.palette));
  } finally { await browser.close(); }
} finally { await finish(); }
const pcm = new Float32Array(8 * 48000);
for (const [i, kind, hz] of [[0,'repeated',150],[1,'tremolo',1000],[2,'swell',8600],[3,'repeated',8600]]) {
  pcm.set(flashPCM(kind,hz,.025), i * 96000);
}
// Quantize before analysis so the downloadable audio and analyzed samples agree.
for(let i=0;i<pcm.length;i++) pcm[i]=Math.round(pcm[i]*32767)/32768;
const wave = Buffer.alloc(44 + pcm.length * 2);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1,20); wave.writeUInt16LE(1,22);
wave.writeUInt32LE(48000,24);wave.writeUInt32LE(96000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);
wave.write('data',36);wave.writeUInt32LE(pcm.length*2,40);
for(let i=0;i<pcm.length;i++)wave.writeInt16LE(Math.round(pcm[i]*32768),44+i*2);
await writeFile(`${output}/identical-audio.wav`, wave);
const beforeBytes=await readFile(`${baseline}/musical-leptos/dist/loudness/loudness.wasm`);
const afterBytes=await readFile('musical-leptos/dist/loudness/loudness.wasm');
const before=flashTrace(new WebAssembly.Module(beforeBytes),pcm);
const after=flashTrace(new WebAssembly.Module(afterBytes),pcm);
assert.equal(before.length,after.length);
for(let i=0;i<before.length;i++)assert.deepEqual(before[i],after[i],`Acoustic/filtered trace differs at ${i}`);
const data={ palette, fps:60, seconds:8, cases:{} };
for(const [name,directory] of [['before',`${baseline}/musical-lights-physics/pkg`],['after',resolve('musical-lights-physics/pkg')]]) {
  const api=await import(pathToFileURL(`${directory}/physics.js`).href);
  const wasm=await api.default({module_or_path:await readFile(`${directory}/physics_bg.wasm`)});
  engineHashes[name] = createHash('sha256').update(await readFile(`${directory}/physics_bg.wasm`)).digest('hex');
  const layout=api.PhysicsSimulation.layout();
  assert.equal(layout[18], name === 'before' ? 3 : 4);
  for(const scrolling of [false,true]) {
    const config=api.PhysicsSimulation.defaults(),sim=new api.PhysicsSimulation(config,new Float32Array(palette));
    const input=new Float32Array(34);input[32]=config[0];
    const frames=[];let row=0,held,offset=0;
    for(let tick=0;tick<960;tick++) {
      const t=tick/120;
      if(tick%2===0){
        while(row+1<after.length&&after[row+1][364]<=t)row++;
        held=after[row];
        offset=scrolling?Math.floor(t*55.5/80)%24:0;
        for(let i=0;i<24;i++)input[i]=held[368+4*(name==='before'?(i+24-offset)%24:i)];
        input[33]=name==='before'?offset:Number(scrolling);sim.input(input);
      }
      sim.step();
      if(tick%2===1){
        const state=new Float32Array(wasm.memory.buffer,sim.snapshot_ptr(),layout[12]);
        const round=x=>Math.round(x*1e6)/1e6;
        frames.push({phase:name==='before'?offset:state[layout[20]],
          bars:Array.from(state.subarray(layout[9],layout[10]),round),
          edges:Array.from({length:24},(_,i)=>{const source=name==='before'?(i+24-offset)%24:i;const attack=held[369+4*source];return attack<0?0:Math.max(0,1-(t-attack)/.180)}),
          balls:Array.from({length:24},(_,i)=>{const at=3+i*layout[8];return [state[at],state[at+1],state[at+7],...state.subarray(at+15,at+18)].map(round)})});
      }
    }
    data.cases[`${name}-${scrolling}`]=frames;sim.free();
  }
}
await writeFile(`${output}/trajectories.js`,`window.motionPreview=${JSON.stringify(data)};\n`);
await writeFile(`${output}/evidence.json`,JSON.stringify({baseline:baselineRevision,engineHashes,physicalPhone:false,pcmSha256:createHash('sha256').update(wave).digest('hex'),traceRows:after.length,traceColumns:after[0].length,allAcousticAndFilteredValuesBitIdentical:true,workletBytesIdentical:beforeBytes.equals(afterBytes),physicsHz:120,previewHz:60},null,2)+'\n');
console.log(`Exported ${after.length} bit-identical audio trace rows and four production-physics previews.`);
