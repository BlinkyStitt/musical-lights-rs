import {test,expect} from '@playwright/test';
import {physicsReady,normalView} from '../physics-state.mjs';
const origin='http://127.0.0.1:8101';

test('box depth updates physical boundaries and all nine banks without resetting balls',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto(origin+'/advanced/');await physicsReady(page);await normalView(page);
  const before=await page.evaluate(()=>{const v=document.querySelector('#dancinglights').physics;return{tick:v.current[2],pigments:Array.from(v.pigments)};});
  for(const cm of [20,200,48]) {
    await page.getByRole('slider',{name:'Box depth (cm)',exact:true}).fill(String(cm));
    await expect.poll(()=>page.evaluate(()=>{const v=document.querySelector('#dancinglights').physics;return Math.round(v.current[v.layout[17]+4]*100);})).toBe(cm);
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
    expect(state.pigments).toHaveLength(8*9);
    // Continuous fill mixes validated palette colors; each linear channel stays bounded.
    for (const channel of state.pigments) { expect(channel).toBeGreaterThanOrEqual(0); expect(channel).toBeLessThanOrEqual(1); }
    expect(state.balls).toBe(8);expect(state.copied).toBe(false);expect(state.transparent).toBe(false);expect(state.opacity).toBe(1);expect(state.depthWrite).toBe(true);
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
  await page.reload();await physicsReady(page);await expect(range).toHaveValue('200');
  expect(await page.evaluate(()=>!!document.querySelector('.audio-card').activeAudioContext)).toBe(false);
});

test('opaque physical balls occlude the background and depth changes retain bounded geometry',async({page},info)=>{
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto(origin+'/advanced/');await physicsReady(page);await normalView(page);
  const evidence=await page.evaluate(async()=>{
    const v=document.querySelector('#dancinglights').physics,base=document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE=await import(new URL(base+'physics/three.module.js',document.baseURI));v.draw(performance.now());
    const saved=v.scene.children.map(mesh=>mesh.visible),background=v.scene.background;
    const target=new THREE.WebGLRenderTarget(320,240),pixels=new Uint8Array(320*240*4),samples=[];
    const center=new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(v.balls.instanceMatrix.array,6*16));
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
  expect(evidence.samples[0].corner).not.toEqual(evidence.samples[1].corner);expect(evidence.balls).toBe(8);expect(evidence.geometries).toBeLessThanOrEqual(6);
  await info.attach('opaque-balls.json',{body:JSON.stringify(evidence),contentType:'application/json'});
});

test('browser WASM starts balls uniformly in the source band at their spawn X',async({page})=>{
  await page.goto(origin+'/advanced/');await physicsReady(page);
  const colors=await page.evaluate(async()=>{
    const v=document.querySelector('#dancinglights').physics,base=document.querySelector('meta[name="musical-lights-assets"]').content;
    const {default:init,PhysicsSimulation}=await import(new URL(base+'physics/physics.js',document.baseURI));const wasm=await init();
    const sim=new PhysicsSimulation(PhysicsSimulation.defaults(),new Float32Array(v.palette));
    try {
      const layout=PhysicsSimulation.layout(),state=new Float32Array(wasm.memory.buffer,sim.snapshot_ptr(),layout[12]);
      const pigments=new Float32Array(wasm.memory.buffer,sim.pigments_ptr(),layout[21]*9);
      return {version:layout[18],palette:Array.from(new Float32Array(v.palette)),balls:Array.from({length:8},(_,i)=>({x:state[3+i*layout[8]],color:Array.from(state.slice(3+i*layout[8]+15,3+i*layout[8]+18)),pigments:Array.from(pigments.slice(i*9,i*9+9))}))};
    } finally {sim.free();}
  });
  expect(colors.version).toBe(17);
  for(const [i,band] of [6,18,10,2,6,22,2,14].entries()) {
    const ball=colors.balls[i],expected=colors.palette.slice(band*3,band*3+3);
    expect(ball.x).toBeGreaterThanOrEqual(band*.05-1e-6);expect(ball.x).toBeLessThan((band+1)*.05+1e-6);expect(ball.color).toEqual(expected);
    for(let slot=0;slot<3;slot++)expect(ball.pigments.slice(slot*3,slot*3+3)).toEqual(expected);
  }
});
