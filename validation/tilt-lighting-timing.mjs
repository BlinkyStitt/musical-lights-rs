// Host comparison, independent of phone acceptance. Run on an idle host after
// building. Pixel probes belong in tilt-lighting.spec.mjs, never this timing loop.
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import startup from './browser-startup.mjs';
import { staticPreview } from './static-preview.mjs';
const output = process.argv[2];
if (!output) throw new Error('Usage: node validation/tilt-lighting-timing.mjs OUTPUT.json [--hardware]');
const hardware = process.argv.includes('--hardware');
const launchOptions = hardware ? { args: process.platform === 'darwin'
  ? ['--use-angle=metal', '--enable-gpu']
  : ['--use-gl=angle', '--use-angle=gl', '--enable-gpu'] } : {};
const finish = await startup({ filteredProjects: [{ name: 'chromium', use: { browserName: 'chromium', launchOptions } }] });
const build = JSON.parse(await readFile('musical-leptos/dist/build.json', 'utf8'));
const rows = [];
try {
  const browser = await chromium.launch(launchOptions);
  try {
    // Reverse the order on a second round to expose warmup/thermal ordering.
    for (const [round, modes] of [['forward', ['baseline', 'shading', 'shadows']], ['reverse', ['shadows', 'shading', 'baseline']]]) {
      for (const mode of modes) {
        const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1 });
        await context.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
        await staticPreview(context, 'https://musical-lights.test');
        await context.route('**/tilt-shadow-candidate.mjs', route => route.fulfill({ path: new URL('./tilt-shadow-candidate.mjs', import.meta.url).pathname, contentType: 'text/javascript' }));
        const page = await context.newPage(), errors = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        await page.goto('https://musical-lights.test/advanced/');
        await page.waitForFunction(() => document.querySelector('#dancinglights')?.physics?.current).catch(error => {
          throw new Error(`Scene startup failed (${hardware ? 'hardware requested' : 'software requested'}): ${JSON.stringify(errors)}; ${error.message}`, { cause: error });
        });
        await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.locator('.input-source').selectOption('generated');
        await page.locator('.review-start').click();
        await page.waitForFunction(() => document.querySelector('#dancinglights').physics.report.acceptanceWorkload());
        await page.getByRole('button', { name: 'Close settings', exact: true }).click();
        await page.evaluate(async mode => {
          const v = document.querySelector('#dancinglights').physics;
          const base = document.querySelector('meta[name="musical-lights-assets"]').content;
          const THREE = await import(new URL(`${base}physics/three.module.js`, document.baseURI));
          if (mode === 'shadows') (await import('/tilt-shadow-candidate.mjs')).installShadowCandidate(v, THREE);
          v.cameraPan.clear(); v.updateCamera = () => {}; v.setCamera(20);
          const onFrame = v.onFrame, start = performance.now();
          v.onFrame = (...args) => {
            if (mode !== 'baseline') {
              const phase = (performance.now() - start) / 8000;
              v.globalLighting.update(9.81 * Math.sin(phase), -9.81 * Math.cos(phase), 3 * Math.sin(phase * .5));
            }
            return onFrame(...args);
          };
        }, mode);
        await page.waitForTimeout(5000);
        const data = await page.evaluate(() => new Promise(resolve => {
          const v = document.querySelector('#dancinglights').physics, gl = v.renderer.getContext();
          const debug = gl.getExtension('WEBGL_debug_renderer_info'), gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
          const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
          const queries = [], gpuMs = [], frameMs = [], cpuMs = [], debtMs = [], snapshotMs = [];
          const render = v.renderer.render.bind(v.renderer), reportFrame = v.report.frame.bind(v.report);
          let previous, measuring = true;
          const before = { ...v.metrics }, start = performance.now();
          const summary = values => {
            if (!values.length) return null;
            const sorted = values.toSorted((a, b) => a - b);
            return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
          };
          v.renderer.render = (...args) => {
            if (timer) {
              if (gl.getParameter(timer.GPU_DISJOINT_EXT)) {
                queries.splice(0).forEach(q => gl.deleteQuery(q)); gpuMs.length = 0;
              }
              while (queries.length && gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)) {
                const query = queries.shift(); gpuMs.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(query);
              }
            }
            const query = timer && queries.length < 4 ? gl.createQuery() : null;
            if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
            try { return render(...args); }
            finally { if (query) { gl.endQuery(timer.TIME_ELAPSED_EXT); queries.push(query); } }
          };
          // frame() is called only after actual draw submission, after the queue
          // gate. Its CPU cost includes the animation callback through submission.
          v.report.frame = (timestamp, cost) => {
            const now = performance.now();
            if (previous != null) frameMs.push(timestamp - previous); previous = timestamp;
            cpuMs.push(cost); debtMs.push(v.metrics.debt); snapshotMs.push(v.metrics.snapshotAgeMs);
            reportFrame(timestamp, cost);
            if (measuring && now - start >= 20000) {
              measuring = false; v.renderer.render = render; v.report.frame = reportFrame;
              queries.forEach(q => gl.deleteQuery(q));
              resolve({ gpu, timerAvailable: !!timer, submittedFps: 1000 / summary(frameMs).mean, frameMs: summary(frameMs), cpuSubmissionMs: summary(cpuMs), gpuMs: summary(gpuMs), simulationDebtMs: summary(debtMs), snapshotAgeMs: summary(snapshotMs), discardedSimulationMs: v.metrics.discardedSimulationMs - before.discardedSimulationMs,
                canvas: [v.canvas.width, v.canvas.height], viewport: [innerWidth, innerHeight], depth: v.renderedDepth, depthCopies: 0, banks: 9, balls: v.balls.count, camera: v.rotation,
                workload: v.report.audioState, diagnostics: v.card.dataset.toneDiagnostics });
            }
          };
        }));
        assert.equal(data.workload.diagnostics, false);
        assert.equal(data.balls, 8);
        const software = /swiftshader|llvmpipe|softpipe|software/i.test(data.gpu);
        if (hardware) assert(!software, `Hardware comparison requires a hardware renderer; found ${data.gpu}`);
        else assert(software, `Software comparison requires a software renderer; found ${data.gpu}`);
        assert.deepEqual(errors, []);
        rows.push({ build, round, mode, rendererClass: software ? 'software' : 'hardware', measuredAt: new Date().toISOString(), ...data, errors });
        await writeFile(output, JSON.stringify(rows, null, 2) + '\n');
        console.log(JSON.stringify(rows.at(-1)));
        await context.close();
      }
    }
  } finally { await browser.close(); }
} finally { await finish(); }
