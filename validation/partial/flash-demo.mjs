import { assertBrowserEnvironment } from '../browser-environment.mjs';
assertBrowserEnvironment();
// Render the actual before/after Leptos builds from their production PCM traces.
// Usage: node validation/partial/flash-demo.mjs .cache/flash-before-site
import { readFile, mkdir, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium, expect } from '../node_modules/@playwright/test/index.mjs';
import checkBrowserStartup from '../browser-startup.mjs';
import { syntheticAudio, startFrozen } from '../physics-state.mjs';
import { flashPCM, flashTrace } from './flash-fixtures.mjs';

const finishBrowserAudit = await checkBrowserStartup({ filteredProjects: [{ name: 'chromium', use: { browserName: 'chromium' } }] });
try {
const browser = await chromium.launch();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
try {
  for (const [version, directory] of [['before', process.argv[2]], ['after', 'musical-leptos/dist']]) {
    const root = resolve(directory);
    const module = new WebAssembly.Module(await readFile(resolve(root, 'loudness/loudness.wasm')));
    for (const [name, frequency] of [['bass', 150], ['treble', 8600]]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme: 'dark' });
      await context.addInitScript(source => {
        const add = AudioWorklet.prototype.addModule;
        AudioWorklet.prototype.addModule = async function(url, options) {
          if (!String(url).endsWith('/loudness/processor.js')) return add.call(this, url, options);
          const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
          try { return await add.call(this, blob, options); } finally { URL.revokeObjectURL(blob); }
        };
      }, await readFile(resolve(root, 'loudness/processor.js'), 'utf8'));
      await context.route('https://musical-lights.test/**', async route => {
        let file = resolve(root, `.${new URL(route.request().url()).pathname}`);
        if (file !== root && !file.startsWith(root + sep)) return route.fulfill({ status: 403, body: '' });
        try {
          if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
          await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] ?? 'application/octet-stream' });
        } catch { await route.fulfill({ status: 404, body: '' }); }
      });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await syntheticAudio(page); await page.goto('https://musical-lights.test/'); await startFrozen(page);
      await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).hover();
      await expect(page.locator('.frequency-tooltip')).toBeHidden();
      const offset = await page.evaluate(() => window.audioNow + 1);
      const rows = flashTrace(module, flashPCM('repeated', frequency, .006));
      const output = `.cache/flash-demo/${name}-${version}`;
      await mkdir(output, { recursive: true });
      for (let frame = 0; frame < 60; frame++) {
        const at = frame / 30;
        const row = rows.findLast(row => row[364] <= at);
        const state = row ? Array.from(row.slice(364, 463)) : [at, 0, 4, ...Array.from({ length: 24 }, () => [0, 0, -1, 0]).flat()];
        state[0] += offset;
        for (let i = 0; i < 24; i++) if (state[5 + i * 4] >= 0) state[5 + i * 4] += offset;
        await page.evaluate(async ({ state, at }) => {
          window.audioNow = at;
          window.testNode.port.dispatchEvent(new MessageEvent('message', { data: {
            type: 'frame', sessionId: Number(document.querySelector('.audio-card').dataset.audioSession), state: new Float64Array(state), clipped: 0,
          } }));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, { state, at: offset + at });
        await page.screenshot({ path: `${output}/${String(frame).padStart(3, '0')}.png` });
      }
      expect(errors).toEqual([]);
      await context.close();
      console.log(`Rendered ${name} ${version}: 60 frames at 30 FPS`);
    }
  }
} finally { await browser.close(); }
} finally { await finishBrowserAudit(); }
