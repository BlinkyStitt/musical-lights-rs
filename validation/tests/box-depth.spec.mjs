import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {physicsReady,normalView} from '../physics-state.mjs';
const origin='http://127.0.0.1:8101';

test('box depth updates physical boundaries and all nine banks without resetting balls',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto(origin+'/advanced/');await physicsReady(page);await normalView(page);
  const before=await page.evaluate(()=>{const v=document.querySelector('#dancinglights').physics;return{tick:v.current[2],pigments:Array.from(v.pigments)};});
  for(const cm of [20,200,48]) {
    await page.getByRole('slider',{name:'Box depth (cm)',exact:true}).fill(String(cm));
    await expect.poll(()=>page.evaluate(()=>{const v=document.querySelector('#dancinglights').physics;return Math.round(v.current[v.layout[17]+4]*100);})).toBe(cm);
    // The expanded camera controls can put Depth below the viewport. Resume
    // visible drawing before checking rendered geometry, not just worker state.
    await page.locator('#dancinglights').scrollIntoViewIfNeeded();
    await expect.poll(()=>page.evaluate(cm=>Math.abs(document.querySelector('#dancinglights').physics.renderedDepth-cm/100)<1e-5,cm)).toBe(true);
    const state=await page.evaluate(()=>{
      const v=document.querySelector('#dancinglights').physics;v.draw(performance.now());v.sideBars.update(v.layout);
      const z=v.bars.instanceMatrix.array,side=v.sideBars.mesh.instanceMatrix.array;
      return {tick:v.current[2],depth:v.renderedDepth,coating:v.enclosure.instanceMatrix.array[10],width:v.enclosure.instanceMatrix.array[0],
        sourceDepth:Array.from({length:v.bars.count},(_,i)=>Math.abs(z[i*16+10])),sideDepth:Array.from({length:v.sideBars.mesh.count},(_,i)=>Math.abs(side[i*16+10])),
        shifts:[...new Set(v.sideBars.offsets.slice(0,v.sideBars.mesh.count))],balls:v.balls.count,pigments:Array.from(v.pigments),palette:Array.from(v.palette),
        copied:v.scene.children.some(mesh=>mesh.geometry?.attributes.copyDepth),transparent:v.balls.material.transparent,opacity:v.balls.material.opacity,depthWrite:v.balls.material.depthWrite};
    });
    expect(state.tick).toBeGreaterThan(before.tick);
    // Physics keeps running, so real contacts may paint during these UI actions.
    // The native depth test checks exact pigment preservation at the resize.
    expect(state.pigments).toHaveLength(2*9);
    // Continuous fill mixes validated palette colors; each linear channel stays bounded.
    for (const channel of state.pigments) { expect(channel).toBeGreaterThanOrEqual(0); expect(channel).toBeLessThanOrEqual(1); }
    expect(state.balls).toBe(2);expect(state.copied).toBe(false);expect(state.transparent).toBe(false);expect(state.opacity).toBe(1);expect(state.depthWrite).toBe(true);
    expect(state.depth).toBeCloseTo(cm/100,5);expect(state.coating).toBeCloseTo(cm/100,5);expect(state.width).toBeCloseTo(10.8,5);
    for(const depth of [...state.sourceDepth,...state.sideDepth])expect(depth).toBeCloseTo(cm/100,5);
    expect(state.shifts).toHaveLength(8);
  }
  await expect(page.getByRole('button',{name:'Auto',exact:true})).toHaveCount(0);
  await expect(page.getByRole('spinbutton',{name:'Mirror images',exact:true})).toHaveCount(0);
});

test('box depth editor steps in centimeters, validates limits and restores without audio',async({page})=>{
  await page.goto(origin+'/advanced/');await physicsReady(page);await normalView(page);
  const range=page.getByRole('slider',{name:'Box depth (cm)',exact:true});
  await expect(range).toHaveValue('48');await page.getByRole('button',{name:'Increase Box depth (cm)',exact:true}).click();await expect(range).toHaveValue('49');
  await page.getByRole('button',{name:'Edit Box depth (cm)',exact:true}).click();
  const editor=page.getByRole('spinbutton',{name:'Box depth (cm) value',exact:true});
  await editor.fill('200');await editor.press('Enter');await expect(range).toHaveValue('200');
  await page.getByRole('button',{name:'Increase Box depth (cm)',exact:true}).click();await expect(range).toHaveValue('200');
  await page.getByRole('button',{name:'Edit Box depth (cm)',exact:true}).click();await editor.fill('201');await editor.press('Enter');await expect(editor).toBeVisible();await expect(range).toHaveValue('200');await editor.press('Escape');
  await page.reload();await physicsReady(page);await normalView(page);await expect(range).toHaveValue('200');
  expect(await page.evaluate(()=>!!document.querySelector('.audio-card').activeAudioContext)).toBe(false);
});

test('opaque physical balls occlude the background and depth changes retain bounded geometry',async({page},info)=>{
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto(origin+'/advanced/');await physicsReady(page);await normalView(page);
  const evidence=await page.evaluate(async()=>{
    const v=document.querySelector('#dancinglights').physics,base=document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE=await import(new URL(base+'physics/three.module.js',document.baseURI));v.draw(performance.now());
    const saved=v.scene.children.map(mesh=>mesh.visible),background=v.scene.background;
    const target=new THREE.WebGLRenderTarget(320,240),pixels=new Uint8Array(320*240*4),samples=[];
    const center=new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(v.balls.instanceMatrix.array,(v.balls.count-1)*16));
    const camera=new THREE.PerspectiveCamera(30,320/240,.01,20);camera.position.copy(center).add(new THREE.Vector3(0,0,1));camera.lookAt(center);camera.updateMatrixWorld();
    try {
      v.scene.children.forEach(mesh=>{if(mesh!==v.balls&&!mesh.isLight)mesh.visible=false;});
      for(const color of [0xff0000,0x0000ff]) {
        v.scene.background=new THREE.Color(color);v.renderer.setRenderTarget(target);v.renderer.render(v.scene,camera);v.renderer.readRenderTargetPixels(target,0,0,320,240,pixels);
        samples.push({center:Array.from(pixels.slice((120*320+160)*4,(120*320+160)*4+4)),corner:Array.from(pixels.slice(0,4))});
      }
      return {samples,balls:v.balls.count,geometries:v.renderer.info.memory.geometries};
    } finally {v.scene.background=background;v.scene.children.forEach((mesh,i)=>{mesh.visible=saved[i];});v.renderer.setRenderTarget(null);target.dispose();}
  });
  expect(evidence.samples[0].center).toEqual(evidence.samples[1].center);expect(evidence.samples[0].center[3]).toBe(255);
  expect(evidence.samples[0].corner).not.toEqual(evidence.samples[1].corner);expect(evidence.balls).toBe(2);expect(evidence.geometries).toBeLessThanOrEqual(6);
  await info.attach('opaque-balls.json',{body:JSON.stringify(evidence),contentType:'application/json'});
});

test('browser WASM starts balls uniformly in the source band at their spawn X',async({page})=>{
  await page.goto(origin+'/advanced/');await physicsReady(page);
  const colors=await page.evaluate(async()=>{
    const v=document.querySelector('#dancinglights').physics,base=document.querySelector('meta[name="musical-lights-assets"]').content;
    const {default:init,PhysicsSimulation}=await import(new URL(base+'physics/physics.js',document.baseURI));const wasm=await init();
    const config=PhysicsSimulation.defaults();config[8]=8; // Retain the complete original spawn profile.
    const sim=new PhysicsSimulation(config,new Float32Array(v.palette));
    try {
      const layout=PhysicsSimulation.layout(),state=new Float32Array(wasm.memory.buffer,sim.snapshot_ptr(),layout[12]);
      const pigments=new Float32Array(wasm.memory.buffer,sim.pigments_ptr(),layout[21]*9);
      return {version:layout[18],palette:Array.from(new Float32Array(v.palette)),balls:Array.from({length:8},(_,i)=>({x:state[3+i*layout[8]],color:Array.from(state.slice(3+i*layout[8]+15,3+i*layout[8]+18)),pigments:Array.from(pigments.slice(i*9,i*9+9))}))};
    } finally {sim.free();}
  });
  expect(colors.version).toBe(24);
  for(const [i,band] of [6,18,10,2,6,22,2,14].entries()) {
    const ball=colors.balls[i],expected=colors.palette.slice(band*3,band*3+3);
    expect(ball.x).toBeGreaterThanOrEqual(band*.05-1e-6);expect(ball.x).toBeLessThan((band+1)*.05+1e-6);expect(ball.color).toEqual(expected);
    for(let slot=0;slot<3;slot++)expect(ball.pigments.slice(slot*3,slot*3+3)).toEqual(expected);
  }
});

test('report config uses the selected depth before its physics receipt', async ({ page }) => {
  await page.goto(origin + '/advanced/'); await physicsReady(page); await normalView(page);
  const state = await page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics, slider = v.card.querySelector('.depth-slider');
    const previous = v.config[5]; slider.value = '36'; slider.dispatchEvent(new Event('input', { bubbles: true }));
    return { previous, actual: v.config[5], requested: v.input[62], report: v.report.readConfig()[5], audio: !!v.card.activeAudioContext };
  });
  expect(state.previous).toBeCloseTo(.48, 5); expect(state.actual).toBeCloseTo(.48, 5);
  expect(state.requested).toBeCloseTo(.36, 5); expect(state.report).toBeCloseTo(.36, 5); expect(state.audio).toBe(false);
});

test('live balls reach the visible side edges after viewport changes without a center-box wall', async ({page}, info) => {
  test.setTimeout(60000);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(origin+'/advanced/'); await physicsReady(page); await normalView(page);
  await page.locator('.display-controls').evaluate(n=>{n.open=true;});
  await page.locator('.camera-motion').uncheck();
  await page.locator('.camera-rotation').fill('0');
  const observations=[];
  for (const viewport of [{width:1440,height:1000},{width:390,height:844},{width:844,height:390}]) {
    await page.setViewportSize(viewport);
    await page.locator('#dancinglights').scrollIntoViewIfNeeded();
    for (const direction of [1,-1]) {
      await page.evaluate(direction=>{
        const v=document.querySelector('#dancinglights').physics;
        v.stopPreview(); v.idle=false; v.clearAudio();
        v.deviceGravity(direction*9.81,0,0,0);
      },direction);
      await page.waitForFunction(direction=>{
        const v=document.querySelector('#dancinglights').physics;
        const offset=68+(direction>0?4:0), p=v.input.slice(offset,offset+4);
        return Array.from({length:v.balls.count},(_,i)=>{
          const b=3+i*v.layout[8];
          const gap=p[0]*v.current[b]+p[1]*v.current[b+1]+p[2]*v.current[b+2]+p[3]-v.current[b+7];
          return Math.abs(gap)<.003;
        }).some(Boolean);
      },direction,{timeout:10000});
      const state=await page.evaluate(()=>{
        const v=document.querySelector('#dancinglights').physics;
        const balls=Array.from({length:v.balls.count},(_,i)=>{
          const b=3+i*v.layout[8], position=Array.from(v.current.slice(b,b+3)), radius=v.current[b+7];
          return {position,radius,clearance:[0,1].map(side=>{
            const p=v.input.slice(68+side*4,72+side*4);
            return p[0]*position[0]+p[1]*position[1]+p[2]*position[2]+p[3]-radius;
          })};
        });
        return {width:v.width,balls,tick:v.current[2],planes:Array.from(v.input.slice(68)),frames:v.metrics.frames,
          discarded:v.metrics.discardedSimulationMs,notice:v.notice.persistent,audio:!!v.card.activeAudioContext};
      });
      for(const ball of state.balls) for(const clearance of ball.clearance) expect(clearance).toBeGreaterThan(-.004);
      expect(state.discarded).toBe(0); expect(state.notice).toBeFalsy(); expect(state.audio).toBe(false); expect(state.frames).toBeGreaterThan(0);
      if(direction>0) expect(Math.max(...state.balls.map(b=>b.position[0]))).toBeGreaterThan(state.width+.02);
      else expect(Math.min(...state.balls.map(b=>b.position[0]))).toBeLessThan(-.02);
      observations.push({viewport,direction,...state});
    }
  }
  const evidence=info.outputPath('viewport-edge-contacts.json'), image=info.outputPath('wide-opening.png');
  await writeFile(evidence,JSON.stringify(observations,null,2));
  await page.screenshot({path:image});
  await info.attach('viewport-edge-contacts.json',{path:evidence,contentType:'application/json'});
  await info.attach('wide-opening.png',{path:image,contentType:'image/png'});
});


test('screen planes follow camera rotation, zoom and position in the actual renderer', async ({page}, info) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(origin+'/advanced/'); await physicsReady(page); await normalView(page);
  await page.locator('.display-controls').evaluate(n=>{n.open=true;});
  await page.locator('.camera-motion').uncheck();
  const samples=[];
  for(const c of [{width:390,height:844,angle:-30,zoom:75,x:20,y:70},{width:844,height:390,angle:30,zoom:125,x:80,y:30},{width:1440,height:1000,angle:0,zoom:25,x:50,y:50}]) {
    await page.setViewportSize({width:c.width,height:c.height});
    for(const [selector,value] of [['.camera-rotation',c.angle],['.camera-zoom',c.zoom],['.camera-x',c.x],['.camera-y',c.y]]) await page.locator(selector).fill(String(value));
    await page.locator('#dancinglights').scrollIntoViewIfNeeded();
    await page.waitForFunction(c=>{
      const v=document.querySelector('#dancinglights').physics;
      return v.rotation===c.angle && v.cameraParameters.get('cameraZoom')===c.zoom && v.aspect===v.canvasWidth/v.canvasHeight;
    },c);
    const state=await page.evaluate(async()=>{
      const v=document.querySelector('#dancinglights').physics,base=document.querySelector('meta[name="musical-lights-assets"]').content;
      const THREE=await import(new URL(base+'physics/three.module.js',document.baseURI));
      const planes=Array.from(v.input.slice(68)), checks=[];
      for(const [side,x] of [[0,-1],[1,1]]) for(const delta of [-.01,0,.01]) {
        const point=new THREE.Vector3(x*(1+delta),0,.5).unproject(v.camera), p=planes.slice(side*4,side*4+4);
        checks.push({side,delta,distance:p[0]*point.x+p[1]*point.y+p[2]*point.z+p[3]});
      }
      return {planes,checks,tick:v.current[2],frame:v.metrics.frames,audio:!!v.card.activeAudioContext};
    });
    for(const row of state.checks) {
      if(row.delta===0) expect(Math.abs(row.distance)).toBeLessThan(1e-5);
      else if(row.delta<0) expect(row.distance).toBeGreaterThan(0);
      else expect(row.distance).toBeLessThan(0);
    }
    expect(state.audio).toBe(false);expect(state.frame).toBeGreaterThan(0);samples.push({configuration:c,...state});
  }
  const path=info.outputPath('camera-side-planes.json');await writeFile(path,JSON.stringify(samples,null,2));
  await info.attach('camera-side-planes.json',{path,contentType:'application/json'});
});
