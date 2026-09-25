// Instrumented latency run, separate from the diagnostics-off FPS benchmark.
import { chromium, webkit } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import checkBrowserStartup from '../browser-startup.mjs';
import { staticPreview } from '../static-preview.mjs';
const url=process.argv[2]??'http://127.0.0.1:8104';
await checkBrowserStartup({filteredProjects:['chromium','webkit'].map(browserName=>({name:browserName,use:{browserName}}))});
const results=[];
for(const [browserName,engine] of [['chromium',chromium],['webkit',webkit]]) {
  for(const baseline of [true,false]) {
    const browser=await engine.launch();
    try {
      const context=await browser.newContext({viewport:{width:390,height:844}});
      await staticPreview(context,url);
      if(baseline) for(const [pattern,path] of [
        ['**/loudness/loudness.wasm','.cache/iso-display-before-partial.wasm'],
        ['**/physics/physics_bg.wasm','.cache/physics80-wasm/physics_bg.wasm'],
        ['**/physics/physics.js','.cache/physics80-wasm/physics.js'],
      ]) await context.route(pattern,route=>route.fulfill({path,contentType:path.endsWith('.wasm')?'application/wasm':'text/javascript'}));
      const page=await context.newPage();
      await page.addInitScript(()=>{
        const Context=window.AudioContext,Node=window.AudioWorkletNode;
        window.AudioContext=class extends Context { constructor(...args){super(...args);window.latencyContext=this;} };
        window.latencyPackets=[];
        window.AudioWorkletNode=class extends Node { constructor(...args){super(...args);
          this.port.addEventListener('message',({data})=>{
            if(data.type==='frame'&&window.latencyPackets.length<10000) window.latencyPackets.push({
              audioTime:window.latencyContext.currentTime,hostMs:performance.now(),sourceTime:data.state[0],
              target:data.state[2+8*5],measured:data.state[6+8*5]});
          });
        }};
      });
      await page.goto(`${url}/phone/`);
      await page.waitForFunction(()=>document.querySelector('#dancinglights')?.physics?.current);
      await page.locator('.tone-kind').selectOption('bursts');
      await page.getByRole('button',{name:'Start listening',exact:true}).click();
      await page.getByRole('button',{name:'Stop listening',exact:true}).waitFor();
      const data=await page.evaluate(()=>new Promise(resolve=>{
        const view=document.querySelector('#dancinglights').physics,frames=[];
        const sample=now=>{
          const audioTime=window.latencyContext.currentTime;
          frames.push({audioTime,hostMs:now,target:view.input[8],colliderTop:view.current[view.layout[9]+8],
            renderedTop:view.bars.instanceMatrix.array[8*16+13]+view.layout[6]/2,tick:view.current[2],debt:view.metrics.debt});
          if(audioTime<6)requestAnimationFrame(sample);
          else resolve({frames,packets:window.latencyPackets,height:view.height,workload:view.report.audioState,config:view.config});
        };requestAnimationFrame(sample);
      }));
      const cycles=[];
      for(let second=1;second<6;second++) {
        const at=data.workload.audioStart+second;
        const packets=data.packets.filter(p=>p.sourceTime>=at&&p.sourceTime<at+.5);
        const maximum=Math.max(...packets.map(p=>p.measured));
        const measured=packets.find(p=>p.measured>=maximum*.1);
        const raised=frames=>frames.find(p=>p.audioTime>=at&&p.audioTime<at+.5);
        const threshold=.003+(data.height*.95-.003)*.01;
        const collider=raised(data.frames.filter(p=>p.colliderTop>=threshold));
        const rendered=raised(data.frames.filter(p=>p.renderedTop>=threshold));
        assert(measured&&collider&&rendered);
        cycles.push({second,measurement10PercentOfBurstPeakMs:(measured.sourceTime-at)*1000,
          receipt10PercentOfBurstPeakMs:(measured.audioTime-at)*1000,
          collider1PercentHeightObservedMs:(collider.audioTime-at)*1000,
          render1PercentHeightMs:(rendered.audioTime-at)*1000});
      }
      const ages=data.packets.map(p=>(p.audioTime-p.sourceTime)*1000).sort((a,b)=>a-b);
      const item={browserName,baseline,physicalPhone:false,instrumented:true,cycles,
        transportAgeMs:{min:ages[0],p95:ages[Math.ceil(ages.length*.95)-1],max:ages.at(-1)},...data};
      results.push(item); console.log(browserName,baseline,cycles,item.transportAgeMs);
    } finally {await browser.close();}
  }
}
await writeFile('docs/partial-loudness-results/latency-detail.json.gz',gzipSync(JSON.stringify(results)));
await writeFile('docs/partial-loudness-results/latency.json',JSON.stringify(results.map(({frames,packets,...rest})=>rest),null,2)+'\n');
