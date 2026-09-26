import { traceLayout } from '../trace-layout.mjs';
// Compare unchanged measurements and browser balance against a captured production WASM.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const load=async path=>(await WebAssembly.instantiate(await readFile(path))).instance.exports;
const before=await load(process.argv[2] ?? '.cache/before-treble.wasm'), after=await load('musical-lights-worklet/pkg/loudness.wasm');
function run(w,pcm) {
 const h=w.processor_create(0,2,0); w.processor_trace_enable(h,1);
 const stride=w.processor_trace_stride(h),rows=[];
 for(let at=0;at<pcm.length;at+=128){const block=pcm.subarray(at,at+128);new Float32Array(w.memory.buffer,w.processor_input(h),block.length).set(block);assert.equal(w.processor_process(h,block.length,BigInt(at)),1);
 const trace=new Float64Array(w.memory.buffer,w.processor_trace_ptr(h),w.processor_trace_count(h)*stride);
 for(let i=0;i<trace.length;i+=stride)rows.push(Array.from(trace.slice(i,i+stride)));w.processor_trace_clear(h);}
 w.processor_destroy(h); return {rows,schema:traceLayout(stride)};
}
let seed=42,low=0;const report=[];
for(const kind of ['1k-plus-8k','white','lowpass-noise','silence']){
 const pcm=Float32Array.from({length:4*48000},(_,i)=>{
 if(kind==='silence')return 0;
 if(kind==='1k-plus-8k')return .02*Math.sin(i*2*Math.PI*1000/48000)+.01*Math.sin(i*2*Math.PI*8000/48000);
 seed=(1664525*seed+1013904223)>>>0;const white=seed/2**32-.5;
 low=.97*low+.03*white;return kind==='white'?.06*white:.3*low;
 });
 const a=run(before,pcm),b=run(after,pcm);assert.equal(a.rows.length,b.rows.length);
 for(let i=0;i<a.rows.length;i++)assert.deepEqual(a.rows[i].slice(0,315),b.rows[i].slice(0,315),'ISO or partial measurement changed');
 const mean=r=>Array.from({length:24},(_,j)=>r.rows.slice(500).reduce((sum,row)=>sum+row[r.schema.display+(r.schema.header??2)+j*r.schema.step],0)/(r.rows.length-500));
 const old=mean(a),current=mean(b);
 report.push({kind,frames:a.rows.length,isoAndPartialBitIdentical:true,beforeMeanHeights:old,afterMeanHeights:current,beforeTrebleToMid:old[21]/old[8]||0,afterTrebleToMid:current[21]/current[8]||0});
}
await writeFile('docs/partial-loudness-results/responsive-display/treble.json',JSON.stringify(report,null,2)+'\n');
console.log(report.map(r=>({kind:r.kind,before:r.beforeTrebleToMid,after:r.afterTrebleToMid,identical:r.isoAndPartialBitIdentical})));
