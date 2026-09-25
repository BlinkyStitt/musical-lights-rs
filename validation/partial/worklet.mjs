// Production WASM validation, including preserved ISO measurements and cost.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { tonePCM, frequencies } from '../../musical-leptos/src/tones.js';
const load = async path => (await WebAssembly.instantiate(await readFile(path))).instance.exports;
const current = await load('musical-lights-worklet/pkg/loudness.wasm');
const previous = await load('.cache/iso-display-before-partial.wasm');
function run(w, pcm, diagnostics, chunk=128) {
  const h=w.processor_create(0,2,0); w.processor_trace_enable(h,Number(diagnostics));
  const input=new Float32Array(w.memory.buffer,w.processor_input(h),w.processor_capacity(h));
  const stride=w.processor_trace_stride(h), rows=[];
  const start=performance.now();
  for(let i=0;i<pcm.length;i+=chunk) {
    const block=pcm.subarray(i,i+chunk);input.set(block);
    assert.equal(w.processor_process(h,block.length,BigInt(i)),1);
    if(diagnostics) {
      const view=new Float64Array(w.memory.buffer,w.processor_trace_ptr(h),w.processor_trace_count(h)*stride);
      for(let j=0;j<view.length;j+=stride) rows.push(view.slice(j,j+stride));
      w.processor_trace_clear(h);
    }
  }
  const elapsed=performance.now()-start;
  assert.equal(w.processor_trace_dropped(h),0);
  w.processor_destroy(h);
  return {elapsed,rows};
}
const cases=[];
for(const kind of ['stationary','two','bursts','silence','exercise']) {
  const pcm=tonePCM(kind).subarray(0,48000*4);
  const before=run(previous,pcm,true), after=run(current,pcm,true);
  assert.equal(after.rows.length,before.rows.length);
  let maximumRatioError=0;
  for(let j=0;j<after.rows.length;j++) {
    assert.deepEqual(after.rows[j].slice(0,266),before.rows[j].slice(0,266),'ISO measurement changed');
    const row=after.rows[j], partial=Array.from(row.slice(291,315)), peak=Math.max(...partial);
    const targets=partial.map((_,i)=>row[318+5*i]), top=Math.max(...targets);
    for(let i=0;i<24;i++) {
      assert(Number.isFinite(partial[i]) && partial[i]>=0);
      if(peak) maximumRatioError=Math.max(maximumRatioError,Math.abs(partial[i]/peak-targets[i]/top));
    }
  }
  assert(maximumRatioError<2e-7);
  const beforeCost=run(previous,pcm,false).elapsed, afterCost=run(current,pcm,false).elapsed;
  assert(afterCost<pcm.length/48*.5,'Analysis uses over half of realtime on this host');
  cases.push({kind,frames:after.rows.length,isoBitIdentical:true,maximumRatioError,audioMs:pcm.length/48,beforeCpuMs:beforeCost,afterCpuMs:afterCost});
  console.log(cases.at(-1));
}
const centers=[];
for(const [band,f] of frequencies.entries()) {
  const pcm=tonePCM('stationary',f,.02).subarray(0,48000);
  const {rows}=run(current,pcm,true), row=rows.at(-1);
  const targets=Array.from({length:24},(_,i)=>row[318+5*i]);
  const fraction=targets[band]/targets.reduce((a,b)=>a+b,0);
  assert(fraction>=.9);
  centers.push({hz:f,mappedFraction:fraction});
}
await writeFile('docs/partial-loudness-results/worklet.json',JSON.stringify({cases,centers},null,2)+'\n');
const edges=[100,200,300,400,510,630,770,920,1080,1270,1480,1720,2000,2320,2700,3150,3700,4400,5300,6400,7700,9500,12000];
const boundaries=[];
for(const [band,f] of edges.entries()) {
  const {rows}=run(current,tonePCM('stationary',f,.02).subarray(0,48000),true), row=rows.at(-1);
  const targets=Array.from({length:24},(_,i)=>row[318+5*i]), peak=Math.max(...targets);
  const ratio=Math.max(...targets.filter((_,i)=>i!==band&&i!==band+1))/peak;
  assert(ratio<.1);boundaries.push({hz:f,mappedMaxNonadjacentOverPeak:ratio});
}
const sweeps=[];
for(const direction of ['up','down']) {
  let phase=0;
  const pcm=Float32Array.from({length:24*48000},(_,i)=> {
    const f=50*(13700/50)**(direction==='up'?i/(24*48000):1-i/(24*48000));
    const sample=.02*Math.sin(phase);phase+=2*Math.PI*f/48000;return sample;
  });
  const {rows}=run(current,pcm,true);let worst=0;
  for(const row of rows.slice(250)) {
    const t=Math.max(0,row[266]-1024)/(24*48000), f=50*(13700/50)**(direction==='up'?t:1-t);
    const band=edges.filter(x=>x<=f).length;
    const targets=Array.from({length:24},(_,i)=>row[318+5*i]), peak=Math.max(...targets);
    worst=Math.max(worst,Math.max(...targets.filter((_,i)=>Math.abs(i-band)>1))/peak);
  }
  assert(worst<.1);sweeps.push({direction,mappedMaxNonadjacentOverPeak:worst});
}
await writeFile('docs/partial-loudness-results/worklet.json',JSON.stringify({cases,centers,boundaries,sweeps},null,2)+'\n');
