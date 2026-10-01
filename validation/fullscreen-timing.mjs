import { assertBrowserEnvironment } from './browser-environment.mjs';
assertBrowserEnvironment();
// Measure the transition itself, not just the warmed-up fullscreen view.
// Host browser measurements are not physical-phone acceptance.
import { chromium, webkit, devices } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import startup from './browser-startup.mjs';
import { staticPreview } from './static-preview.mjs';
const [origin, output, clean] = process.argv.slice(2);
if (!origin || !output) throw new Error('Usage: node validation/fullscreen-timing.mjs ORIGIN OUTPUT [--expect-clean]');
const finishBrowserAudit = await startup({filteredProjects:['chromium','webkit'].map(browserName=>({name:browserName,use:{browserName}}))});
try {
const results=[];
for (const [name,engine,profile] of [['chromium',chromium,{}],['webkit',webkit,devices['iPhone 13']]]) {
  const browser=await engine.launch();
  try {
    const context=await browser.newContext({...profile,viewport:{width:390,height:844}});
    await staticPreview(context,origin);
    await context.addInitScript(()=>{Object.defineProperty(document,'fullscreenEnabled',{value:false});Element.prototype.requestFullscreen=undefined;});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`${origin}/phone/`);
    await page.locator('.generated-audio').check();
    await page.waitForFunction(()=>document.querySelector('#dancinglights')?.physics?.current);
    await page.getByRole('button',{name:'Start listening',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#dancinglights').physics.report.acceptanceWorkload());
    await page.waitForTimeout(2000);
    await page.evaluate(()=>{
      const v=document.querySelector('#dancinglights').physics;
      window.samples=[];window.marks=[];window.profiling=true;let previous=performance.now();
      const sample=t=>{samples.push({t,frame:t-previous,debt:v.metrics.debt,age:v.metrics.snapshotAgeMs,overload:v.metrics.overloadTicks,height:v.current[1],requested:v.input[32]});previous=t;if(profiling)requestAnimationFrame(sample)};
      requestAnimationFrame(sample);
    });
    await page.waitForTimeout(500);
    for (const event of ['enter','landscape','portrait','exit']) {
      await page.evaluate(event=>marks.push({event,t:performance.now()}),event);
      if(event==='enter')await page.getByRole('button',{name:'Fullscreen',exact:true}).click();
      if(event==='landscape')await page.setViewportSize({width:844,height:390});
      if(event==='portrait')await page.setViewportSize({width:390,height:844});
      if(event==='exit')await page.getByRole('button',{name:'Exit fullscreen',exact:true}).click();
      await page.waitForTimeout(2200);
    }
    const data=await page.evaluate(()=>{
      profiling=false;const v=document.querySelector('#dancinglights').physics;
      return{layout:v.layout,samples,marks,discardedSimulationMs:v.metrics.discardedSimulationMs,workload:v.report.audioState};
    });
    const windows=data.marks.map(({event,t})=>{
      const points=data.samples.filter(p=>p.t>=t&&p.t<t+2000),before=data.samples.findLast(p=>p.t<t);
      const frames=points.map(p=>p.frame).sort((a,b)=>a-b);
      return{event,fps:1000*frames.length/frames.reduce((a,b)=>a+b,0),p95:frames[Math.ceil(frames.length*.95)-1],maxFrame:frames.at(-1),
        over25Fraction:frames.filter(x=>x>25).length/frames.length,maxDebt:Math.max(...points.map(p=>p.debt)),maxSnapshotAge:Math.max(...points.map(p=>p.age)),
        overloadTicks:points.at(-1).overload-before.overload,fromHeight:before.height,toHeight:points.at(-1).height};
    });
    const build=await page.evaluate(()=>import(document.querySelector('meta[name="musical-lights-assets"]').content + 'physics/build.js').then(module=>module.build));
    const result={browser:name,version:browser.version(),physicalPhone:false,origin,build,errors,windows,...data};
    results.push(result);console.log(JSON.stringify({browser:name,windows,errors}));
    await context.close();
  } finally {await browser.close();}
}
await writeFile(output,JSON.stringify(results,null,2)+'\n');
if(clean==='--expect-clean')for(const result of results){
  assert.equal(result.errors.length,0);assert.equal(result.discardedSimulationMs,0);
  assert.equal(result.workload.state,'playing');assert.equal(result.workload.diagnostics,false);
  for(const window of result.windows){
    assert(window.fps>=59&&window.p95<=18.5&&window.over25Fraction<.01,`${result.browser} ${window.event} frame budget exceeded`);
    assert(window.maxSnapshotAge<100&&window.maxDebt<2*1000/120,`${result.browser} ${window.event} lost timely updates`);
  }
}
} finally { await finishBrowserAudit(); }
