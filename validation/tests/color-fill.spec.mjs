import { readFileSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { physicsReady, normalView, syntheticAudio } from '../physics-state.mjs';
const referenceVectors = JSON.parse(readFileSync(new URL('../fixtures/hsluv-reference.json', import.meta.url))).vectors;

for (const route of ['/', '/advanced/']) for (const reducedMotion of ['reduce', 'no-preference']) {
test(`contact color fills gradually on ${route} with motion ${reducedMotion}`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion });
  await page.goto(`http://127.0.0.1:8101${route}`);
  await physicsReady(page); await normalView(page);
  const result = await page.evaluate(async () => {
    const v = document.querySelector('#dancinglights').physics;
    const base = document.querySelector('meta[name="musical-lights-assets"]').content;
    const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
    const { linearToHsluv } = await import(new URL(`${base}physics/pigment.js`, document.baseURI));
    const { default: init, PhysicsSimulation } = await import(new URL(`${base}physics/physics.js`, document.baseURI));
    const wasm = await init(), layout = PhysicsSimulation.layout(), config = PhysicsSimulation.defaults();
    // Ball 0 starts red over source 6, then rolls onto blue sources. Audio is off.
    const palette = Float32Array.from({ length: 72 }, (_, i) => Math.floor(i / 3) === 6 ? +(i % 3 === 0) : +(i % 3 === 2));
    // Leave room above the first contact so its light can finish filling in
    // free space. Repeated blue contacts must not hide a lost swirl target.
    config[0] = 5;
    const sim = new PhysicsSimulation(config, palette), input = new Float32Array(layout[22]);
    input[67] = config[11]; input[24] = 5; input[31] = v.reduced.matches ? 1 : 0; input[32] = config[0]; input[62] = config[5]; input[64] = 8; input[65] = .0264; input[66] = .192; sim.input(input);
    const surface = () => new Float32Array(wasm.memory.buffer, sim.pigments_ptr(), 72).slice(0, 9);
    const mean = () => new Float32Array(wasm.memory.buffer, sim.snapshot_ptr(), layout[12]).slice(18, 21);
    const frames = [{ tick: 0, surface: Array.from(surface()), mean: Array.from(mean()) }];
    let firstContact, maximumJump = 0, maximumPerceptualJump = 0, previous = surface();
    for (let tick = 1; tick <= 360; tick++) {
      sim.step(); const current = surface();
      maximumJump = Math.max(maximumJump, ...current.map((value, i) => Math.abs(value - previous[i])));
      for (let region=0;region<3;region++) {
        const a=linearToHsluv(previous.slice(region*3,region*3+3)), b=linearToHsluv(current.slice(region*3,region*3+3));
        const hue=Math.abs(((b[0]-a[0]+540)%360)-180)/180;
        maximumPerceptualJump=Math.max(maximumPerceptualJump,hue,Math.abs(b[1]-a[1])/100,Math.abs(b[2]-a[2])/100);
      }
      if (firstContact === undefined && current.some((value, i) => i % 3 === 2 && value > 1e-5)) {
        firstContact = tick;
        // Follow the retained contact light while the ball leaves the bars.
        input[24] = 0; input[35] = 2; input[37] = 1; sim.input(input);
      }
      if (firstContact !== undefined && [0, 24, 60, 120].includes(tick - firstContact)) {
        frames.push({ tick, surface: Array.from(current), mean: Array.from(mean()) });
      }
      previous = current;
    }
    cancelAnimationFrame(v.request); v.stopPreview(); v.draw(performance.now());
    const visible = v.scene.children.map(node => node.visible), count = v.balls.count;
    const matrices = v.balls.instanceMatrix.array.slice(), colors = v.balls.instanceColor.array.slice();
    const attributes = ['pigmentA', 'pigmentB', 'pigmentC'].map(name => v.balls.geometry.attributes[name]);
    const saved = attributes.map(attr => attr.array.slice());
    const target = new THREE.WebGLRenderTarget(256, 256); target.texture.colorSpace = THREE.SRGBColorSpace;
    const pixels = new Uint8Array(256 * 256 * 4), camera = new THREE.PerspectiveCamera(30, 1, .01, 20);
    camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    try {
      v.scene.children.forEach(node => { if (node !== v.balls && !node.isLight) node.visible = false; });
      v.balls.count = 1; v.balls.setMatrixAt(0, new THREE.Matrix4().makeScale(.8, .8, .8)); v.balls.instanceMatrix.needsUpdate = true;
      for (const frame of frames) {
        attributes.forEach((attr, region) => { attr.array.set(linearToHsluv(frame.surface.slice(region * 3, region * 3 + 3)), 0); attr.needsUpdate = true; });
        v.balls.instanceColor.array.set(frame.mean, 0); v.balls.instanceColor.needsUpdate = true;
        v.renderer.setRenderTarget(target); v.renderer.render(v.scene, camera);
        v.renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
        // Compare blue fraction, so surface illumination does not set the result.
        frame.blue = [90, 128, 166].map(y => {
          let red = 0, blue = 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const index = ((y + dy) * 256 + 128 + dx) * 4;
            red += pixels[index]; blue += pixels[index + 2];
          }
          return blue / (red + blue);
        });
      }
      return { version: layout[18], firstContact, maximumJump, maximumPerceptualJump, frames };
    } finally {
      sim.free(); v.renderer.setRenderTarget(null); target.dispose(); v.balls.count = count;
      v.scene.children.forEach((node, i) => { node.visible = visible[i]; });
      v.balls.instanceMatrix.array.set(matrices); v.balls.instanceMatrix.needsUpdate = true;
      v.balls.instanceColor.array.set(colors); v.balls.instanceColor.needsUpdate = true;
      attributes.forEach((attr, i) => { attr.array.set(saved[i]); attr.needsUpdate = true; });
      v.request = requestAnimationFrame(v.animate);
    }
  });
  await info.attach('contact-fill-pixels.json', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.version).toBe(22); expect(result.firstContact).toBeGreaterThan(0);
  expect(result.maximumJump).toBeGreaterThan(.001); expect(result.maximumPerceptualJump).toBeLessThan(.047);
  expect(result.frames).toHaveLength(5);
  const [initial, impact, early, middle, late] = result.frames;
  expect(initial.surface).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0]);
  // Screen encoding expands a small linear-blue pickup. The physical first
  // step stays below .02 linear blue and the shared perceptual step bound above.
  expect(Math.max(...impact.surface.filter((_,i)=>i%3===2))).toBeLessThan(.02);
  expect(Math.max(...impact.blue)).toBeLessThan(.15);
  // Contact-local light must preserve distinct soft swirl regions rather than
  // become the former monotone lower/middle/upper gradient.
  for (const frame of [early, middle, late]) {
    expect(Math.max(...frame.surface.filter((_, i) => i % 3 === 2))).toBeGreaterThan(0);
    expect(Math.max(...frame.blue) - Math.min(...frame.blue)).toBeGreaterThan(.01);
  }
  expect(Math.max(...late.blue)).toBeGreaterThan(Math.max(...early.blue));
  expect(late.mean[2]).toBeGreaterThan(early.mean[2]);
});

}

test('microphone and digital playback publish attack-only paint while Stop restores idle contacts', async ({ page }) => {
  await syntheticAudio(page);
  await page.goto('http://127.0.0.1:8101/advanced/');
  await physicsReady(page); await normalView(page);
  const policy = () => page.evaluate(() => document.querySelector('#dancinglights').physics.input[63]);
  await expect.poll(policy).toBe(0);
  await page.evaluate(() => { window.paintWorker = document.querySelector('#dancinglights').physics.worker; });
  const listening = page.getByRole('checkbox', { name: 'Listening', exact: true });
  await listening.check();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect.poll(policy).toBe(1);
  await listening.uncheck();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'stopped');
  await expect.poll(policy).toBe(0);
  await page.locator('.diagnostics-controls').evaluate(node => { node.open = true; });
  await page.locator('.input-source').selectOption('generated');
  await page.locator('.review-start').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'playing');
  await expect.poll(policy).toBe(1);
  await page.locator('.tone-pause').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'paused');
  await expect.poll(policy).toBe(0);
  await page.locator('.tone-pause').click();
  await expect.poll(policy).toBe(1);
  await page.locator('.review-stop').click();
  await expect(page.locator('.audio-card')).toHaveAttribute('data-audio-state', 'stopped');
  await expect.poll(policy).toBe(0);
  expect(await page.evaluate(() => window.paintWorker === document.querySelector('#dancinglights').physics.worker)).toBe(true);
});

for (const route of ['/', '/advanced/']) for (const reducedMotion of ['reduce', 'no-preference']) {
  test(`HSLuv swirl pixels retain saturation and continuous joins on ${route} with motion ${reducedMotion}`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto(`http://127.0.0.1:8101${route}`);
    await physicsReady(page); await normalView(page);
    const result = await page.evaluate(async references => {
      const v=document.querySelector('#dancinglights').physics;
      const base=document.querySelector('meta[name="musical-lights-assets"]').content;
      const THREE=await import(new URL(`${base}physics/three.module.js`,document.baseURI));
      const { blendHsluv, hsluvToLinear, linearToHsluv }=await import(new URL(`${base}physics/pigment.js`,document.baseURI));
      cancelAnimationFrame(v.request); v.stopPreview(); v.draw(performance.now());
      const visible=v.scene.children.map(n=>n.visible), count=v.balls.count, material=v.balls.material;
      const matrices=v.balls.instanceMatrix.array.slice(), colors=v.balls.instanceColor.array.slice();
      const attrs=['pigmentA','pigmentB','pigmentC'].map(n=>v.balls.geometry.attributes[n]), saved=attrs.map(a=>a.array.slice());
      const strength=v.lighting.uniforms.lightStrength.value.clone(), emission=v.lighting.uniforms.colorEmission.value.clone();
      const colorAttack=v.lighting.uniforms.colorAttack.value;
      const tone=v.renderer.toneMapping, neutral=new THREE.AmbientLight(0xffffff,Math.PI);
      const target=new THREE.WebGLRenderTarget(256,256); target.texture.colorSpace=THREE.SRGBColorSpace;
      const pixels=new Uint8Array(256*256*4), camera=new THREE.PerspectiveCamera(30,1,.01,20);
      camera.position.set(0,0,5); camera.lookAt(0,0,0); camera.updateMatrixWorld();
      const regions=[[350,100,58],[10,100,58],[190,100,58]], ray=new THREE.Raycaster();
      const encode=v=>v<=.0031308 ? 12.92*v : 1.055*v**(1/2.4)-.055;
      const decode=v=>v<=.04045 ? v/12.92 : ((v+.055)/1.055)**2.4;
      const smooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
      const render=()=>{v.renderer.setRenderTarget(target);v.renderer.render(v.scene,camera);v.renderer.readRenderTargetPixels(target,0,0,256,256,pixels);};
      const png=()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const ctx=canvas.getContext('2d'),img=ctx.createImageData(256,256);
        for(let y=0;y<256;y++)img.data.set(pixels.subarray(y*1024,(y+1)*1024),(255-y)*1024);ctx.putImageData(img,0,0);return canvas.toDataURL('image/png').split(',')[1];};
      try {
        v.scene.children.forEach(n=>{if(n!==v.balls)n.visible=false;});
        v.lighting.uniforms.colorAttack.value=0;v.lighting.uniforms.lightStrength.value.set(0,0,1,0);v.lighting.uniforms.colorEmission.value.set(0,0);v.scene.add(neutral);v.renderer.toneMapping=THREE.NoToneMapping;
        v.balls.count=1;v.balls.setMatrixAt(0,new THREE.Matrix4().makeScale(.8,.8,.8));v.balls.instanceMatrix.needsUpdate=true;v.balls.computeBoundingSphere();
        // An unrelated instance summary must not desaturate the material.
        v.balls.instanceColor.array.set([.5,.5,.5]);v.balls.instanceColor.needsUpdate=true;
        // Constant-color patches isolate conversion parity from rasterization
        // of the curved, rapidly changing swirl field.
        let referenceError=0;
        for(const reference of references) {
          attrs.forEach(a=>{a.array.set(reference.hsluv);a.needsUpdate=true;});render();
          const actual=Array.from(pixels.slice((128*256+128)*4,(128*256+128)*4+3));
          referenceError=Math.max(referenceError,...actual.map((c,i)=>Math.abs(c-Math.round(encode(reference.linear[i])*255))));
        }
        attrs.forEach((a,i)=>{a.array.set(regions[i]);a.needsUpdate=true;});
        render();const after=png();let maxError=0,minSaturation=100,maxHueStep=0,previous;
        const joinSamples=[0,0], samples=[];
        for(let x=70;x<=185;x++) {
          const y=128;ray.setFromCamera(new THREE.Vector2((x+.5)/128-1,(y+.5)/128-1),camera);
          const hit=ray.intersectObject(v.balls)[0];if(!hit)continue;
          const p=hit.point.clone().normalize(),shape=v.layout.slice(23,27),edges=v.layout.slice(27,30);
          const wave=Math.sin(shape[0]*p.y+shape[1]*Math.sin(shape[2]*p.x)+shape[3]*p.z);
          const a=smooth(edges[0],edges[1],wave),b=smooth(edges[1],edges[2],wave);
          if(a>.1&&a<.9)joinSamples[0]++;if(b>.1&&b<.9)joinSamples[1]++;
          const expected=hsluvToLinear(blendHsluv(blendHsluv(regions[0],regions[1],a),regions[2],b)).map(c=>Math.round(encode(c)*255));
          const actual=Array.from(pixels.slice((y*256+x)*4,(y*256+x)*4+3));
          maxError=Math.max(maxError,...actual.map((c,i)=>Math.abs(c-expected[i])));
          const hsl=linearToHsluv(actual.map(c=>decode(c/255)));minSaturation=Math.min(minSaturation,hsl[1]);
          if(previous)maxHueStep=Math.max(maxHueStep,Math.abs(((hsl[0]-previous[0]+540)%360)-180));previous=hsl;
          samples.push({x,hsl,actual,expected});
        }
        // Retain a reproducible spatial before/after under identical lighting.
        const old=material.clone(), compile=material.onBeforeCompile;
        old.onBeforeCompile=shader=>{compile(shader);shader.fragmentShader=shader.fragmentShader.replace(
          /vec3 pigment = hsluvToLinear\(blendHsluv\(blendHsluv\(paintA,[\s\S]*?diffuseColor.rgb = pigment;/,
          `vec3 pigment = mix(mix(hsluvToLinear(paintA),hsluvToLinear(paintB),smoothstep(swirlEdges.x,swirlEdges.y,wave)),hsluvToLinear(paintC),smoothstep(swirlEdges.y,swirlEdges.z,wave)); diffuseColor.rgb = mix(diffuseColor.rgb,pigment,.78);`);};
        old.customProgramCacheKey=()=> 'rgb-spatial-reference';v.balls.material=old;render();const before=png();old.dispose();
        return {referenceError,maxError,minSaturation,maxHueStep,joinSamples,samples,before,after};
      } finally {
        v.scene.remove(neutral);v.balls.material=material;v.balls.count=count;v.balls.instanceMatrix.array.set(matrices);v.balls.instanceMatrix.needsUpdate=true;
        v.balls.instanceColor.array.set(colors);v.balls.instanceColor.needsUpdate=true;
        attrs.forEach((a,i)=>{a.array.set(saved[i]);a.needsUpdate=true;});
        v.scene.children.forEach((n,i)=>{n.visible=visible[i];});v.lighting.uniforms.lightStrength.value.copy(strength);v.lighting.uniforms.colorEmission.value.copy(emission);
        v.lighting.uniforms.colorAttack.value=colorAttack;v.balls.computeBoundingSphere();
        v.renderer.toneMapping=tone;v.renderer.setRenderTarget(null);target.dispose();v.request=requestAnimationFrame(v.animate);
      }
    }, referenceVectors);
    for(const name of ['before','after']) {
      const path=info.outputPath(`${name}-spatial-blend.png`);writeFileSync(path,Buffer.from(result[name],'base64'));
      await info.attach(`${name}-spatial-blend.png`,{path,contentType:'image/png'});
    }
    delete result.before;delete result.after;
    const path=info.outputPath('spatial-pixels.json');writeFileSync(path,JSON.stringify(result));
    await info.attach('spatial-pixels.json',{path,contentType:'application/json'});
    expect(result.samples.length).toBeGreaterThan(80);
    expect(result.joinSamples.every(n=>n>5)).toBe(true);
    expect(result.referenceError).toBeLessThanOrEqual(2);
    // Ray intersections and GPU-interpolated material points differ at steep
    // curved joins. Allow eight framebuffer levels here and strict constant-patch
    // conversion parity above; saturation and circular continuity stay separate.
    expect(result.maxError).toBeLessThanOrEqual(8);
    expect(result.minSaturation).toBeGreaterThan(97);
    // At this fixed camera, the steepest 180-degree soft join spans several
    // pixels; reject any hard circular hue step while checking every pixel above.
    expect(result.maxHueStep).toBeLessThan(45);
  });
}
