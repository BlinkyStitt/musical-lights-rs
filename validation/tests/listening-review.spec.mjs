import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const origin='http://127.0.0.1:8101';
test('audible review uses output time for flashes, buffered completion, fallback labels and export', async ({page}) => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/audio-audit/**', async route=>{
    const name=new URL(route.request().url()).pathname.split('/').at(-1)||'index.html';
    const type=name.endsWith('.js')?'text/javascript':name.endsWith('.html')?'text/html':name.endsWith('.json')?'application/json':'application/octet-stream';
    await route.fulfill({path:fileURLToPath(new URL(`../../docs/audio-audit-results/${name}`,import.meta.url)),contentType:type});
  });
  await page.addInitScript(()=>{
    window.processing=10;window.timestampEnabled=true;window.flashes=[];window.started=[];
    const raf=window.requestAnimationFrame;
    window.requestAnimationFrame=fn=>raf.call(window,now=>{window.frameNow=now;fn(now)});
    const fill=CanvasRenderingContext2D.prototype.fillRect,stroke=CanvasRenderingContext2D.prototype.strokeRect;
    CanvasRenderingContext2D.prototype.fillRect=function(...args){if(args[2]===900)window.flashes=[];return fill.apply(this,args)};
    CanvasRenderingContext2D.prototype.strokeRect=function(...args){window.flashes.push(args[0]);return stroke.apply(this,args)};
    window.AudioContext=class {
      constructor(){window.audio=this;this.state='running';this.baseLatency=.01;this.outputLatency=.19;}
      get currentTime(){return window.processing;}
      getOutputTimestamp(){return window.timestampEnabled?{contextTime:this.currentTime-.208,performanceTime:(window.frameNow??performance.now())-8}:{contextTime:0,performanceTime:0};}
      async resume(){this.state='running';}
      createBuffer(channels,length,rate){window.duration=length/rate;return{duration:length/rate,copyToChannel(){}};}
      createBufferSource(){return{connect(){},disconnect(){},start(at){window.started.push(at)},stop(){}};}
    };
  });
  await page.goto(`${origin}/audio-audit/`);
  await expect(page.locator('#play')).toBeEnabled();await page.locator('#fixture').selectOption('recovered-150');
  await page.locator('#play').click();await expect(page.locator('#stop')).toBeEnabled();
  expect(await page.evaluate(()=>started)).toEqual([10]);
  for(const [processing,visible] of [[.446,false],[.655,true],[.765,true],[.767,false]]){
    await page.evaluate(value=>window.processing=10+value,processing);
    await expect.poll(async()=>Number((await page.locator('#status').textContent()).match(/: ([\d.]+) \//)?.[1])).toBeCloseTo(processing-.2,1);
    await expect.poll(()=>page.evaluate(()=>window.flashes.some(x=>x>450))).toBe(visible);
    await expect(page.locator('#status')).toContainText('Output timing');
  }
  await page.evaluate(()=>{window.processing=10+window.duration;});
  await expect(page.locator('#status')).toContainText((await page.evaluate(()=>duration-.2)).toFixed(2));
  await expect(page.locator('#play')).toBeDisabled();
  await page.evaluate(()=>{window.processing=10+window.duration+.201;});
  await expect(page.locator('#play')).toBeEnabled();
  await page.evaluate(()=>{window.timestampEnabled=false;});
  await page.locator('#play').click();await expect(page.locator('#status')).toContainText('Approximate timing');
  await page.evaluate(()=>{delete audio.baseLatency;delete audio.outputLatency;});
  await expect(page.locator('#status')).toContainText('Timing unverified');
  await page.locator('#stop').click();
  await page.locator('#notes').fill('Clock regression, not a listening judgment.');
  const download=page.waitForEvent('download');await page.locator('#export').click();
  const report=JSON.parse(await readFile(await (await download).path(),'utf8'));
  expect(report.notes['recovered-150']).toBe('Clock regression, not a listening judgment.');
  expect(report.playbacks[0]).toMatchObject({fixture:'recovered-150',methods:['output-timestamp'],completed:true});
  expect(report.playbacks[1].methods).toEqual(['estimated-latency','unverified']);
  expect(errors).toEqual([]);
});
