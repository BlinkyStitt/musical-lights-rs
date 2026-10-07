import { runtimeRoot } from './runtime-assets.mjs';
// Optional in-process static origin for timing when host TCP ports are exhausted.
// Browser execution, workers, AudioWorklet, and WASM remain the actual build.
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
export async function staticPreview(context, url) {
  if (new URL(url).hostname !== 'musical-lights.test') return;
  const root=resolve('musical-leptos/dist');
  // AudioWorklet module fetches bypass Playwright routing. Supply the exact
  // built script through a Blob URL; its actual processor and WASM still run.
  const runtime = await runtimeRoot(root);
  const sources = Object.fromEntries(await Promise.all(['processor.js', 'pcm-playback.js'].map(async name => [name, await readFile(resolve(runtime, 'loudness', name), 'utf8')])));
  await context.addInitScript(sources => {
    const prototype=AudioWorklet.prototype, add=prototype.addModule;
    prototype.addModule=async function(url,options) {
      const path = new URL(url,document.baseURI).pathname, name = path.split('/').at(-1);
      if(!path.endsWith('/loudness/' + name) || !sources[name]) return add.call(this,url,options);
      const local=URL.createObjectURL(new Blob([sources[name]],{type:'text/javascript'}));
      try {return await add.call(this,local,options);} finally {URL.revokeObjectURL(local);}
    };
  }, sources);
  const types={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.png':'image/png','.ico':'image/x-icon'};
  await context.route('https://musical-lights.test/**',async route=>{
    let path=resolve(root,`.${decodeURIComponent(new URL(route.request().url()).pathname)}`);
    if(path!==root&&!path.startsWith(root+sep)) return route.fulfill({status:403,body:'Forbidden'});
    try {
      if((await stat(path)).isDirectory())path=resolve(path,'index.html');
      await route.fulfill({body:await readFile(path),contentType:types[extname(path)]??'application/octet-stream'});
    } catch {await route.fulfill({status:404,body:'Not found'});}
  });
}
