// Instrumented packet-to-render comparison. Separate from diagnostics-off FPS
// acceptance; captures real worklet packets and produced-WASM surface endpoints.
import { chromium, webkit, devices } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { hardwareBrowserOptions, requireHardwareRenderer } from './gpu-renderer.mjs';
import startup from './browser-startup.mjs';
import { openFullscreenSettings } from './physics-state.mjs';
import { staticPreview } from './static-preview.mjs';
import { packetRenderCrossings, packetRenderSummary } from './packet-render.mjs';
const [origin, output, reanalyzedOutput] = process.argv.slice(2);
if (origin === '--reanalyze') {
  if (!output || !reanalyzedOutput) throw new Error('Usage: node validation/active-gap-latency.mjs --reanalyze CAPTURE_JSON OUTPUT_JSON');
  const captures = JSON.parse(await readFile(output, 'utf8'));
  for (const capture of captures) {
    capture.crossings = packetRenderCrossings(capture.packets, capture.renders);
    capture.summary = { ...capture.summary, ...packetRenderSummary(capture.crossings), responseWindow: 'before next same-band threshold crossing' };
    console.log(JSON.stringify(capture.summary));
  }
  await writeFile(reanalyzedOutput, JSON.stringify(captures, null, 2) + '\n');
} else {
if (!origin || !output) throw new Error('Usage: node validation/active-gap-latency.mjs ORIGIN OUTPUT_JSON');
const hardware = process.argv.includes('--hardware');
const finish = await startup({ filteredProjects: ['chromium', 'webkit'].map(browserName => ({ name: browserName, use: { browserName, launchOptions: hardware ? hardwareBrowserOptions(browserName) : {} } })) });
const results = [];
try {
  for (const [name, engine, profile] of [['chromium', chromium, {}], ['webkit', webkit, devices['iPhone 13']]]) {
    for (const cap of [60, 2000]) {
      const browser = await engine.launch(hardware ? hardwareBrowserOptions(name) : {});
      try {
        const context = await browser.newContext({ ...profile, hasTouch: true, viewport: { width: 390, height: 844 } });
        await staticPreview(context, origin);
        await context.addInitScript(cap => {
          localStorage.setItem('musical-lights-display-v1', JSON.stringify({ version: 1, activeGapCap: cap }));
          const random = crypto.getRandomValues.bind(crypto);
          crypto.getRandomValues = values => {
            if (values instanceof Uint32Array && values.length === 1) { values[0] = 1; return values; }
            return random(values);
          };
          window.packets = [];
          const Native = window.AudioWorkletNode;
          window.AudioWorkletNode = class extends Native {
            constructor(...args) {
              super(...args);
              this.port.addEventListener('message', ({ data }) => {
                // Physics receives the filtered presentation value, not the
                // unfiltered target at the preceding transport offset.
                if (data.type === 'frame' && packets.length < 10000) packets.push({ at: performance.timeOrigin + performance.now(), levels: Array.from({ length: 24 }, (_, i) => data.state[4 + i * 4]) });
              });
            }
          };
        }, cap);
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/advanced/');
        await page.waitForFunction(() => document.querySelector('#dancinglights')?.physics?.current);
        const gpu = await page.evaluate(() => {
          const gl = document.querySelector('#dancinglights').physics.renderer.getContext();
          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
        });
        if (hardware) requireHardwareRenderer(gpu);
        await page.evaluate(() => {
          const v = document.querySelector('#dancinglights').physics;
          window.renders = [];
          const draw = v.draw;
          v.draw = function (...args) {
            draw.apply(this, args);
            if (renders.length < 10000) {
              const g = this.layout[17], previous = this.previous ?? this.current, baseline = previous[g+5] + (this.current[g+5]-previous[g+5])*this.renderAlpha;
              const travel = previous[g+6] + (this.current[g+6]-previous[g+6])*this.renderAlpha;
              renders.push({ at: this.renderedAt, baseline, travel, tops: Array.from(this.renderedTops), levels: Array.from(this.renderedTops, top => (top-baseline)/travel) });
            }
          };
          document.querySelector('.diagnostics-controls').open = true;
        });
        await openFullscreenSettings(page);
        await page.locator('.tone-kind').selectOption('bursts');
        await page.locator('.tone-trace').check();
        await page.locator('.input-source').selectOption('generated');
        await page.locator('.review-start').click();
        await page.waitForTimeout(8500);
        const data = await page.evaluate(() => {
          const v = document.querySelector('#dancinglights').physics;
          return { seed: v.seed, packets, renders, chunks: v.report.toneChunks.map(({ values, ...chunk }) => ({ ...chunk, values: Array.from(values) })), layout: v.layout, metrics: v.metrics, audio: v.report.audioState };
        });
        if (data.seed !== 1) throw new Error('Comparison seed must be identical');
        const crossings = packetRenderCrossings(data.packets, data.renders);
        const summary = { browser: name, capCm: cap, physicalPhone: false, diagnostics: true, threshold: .1, crossings: crossings.length,
          responseWindow: 'before next same-band threshold crossing', ...packetRenderSummary(crossings) };
        if (!data.chunks.length || !data.packets.length || !summary.matched) throw new Error('No complete packet/trace/render evidence: ' + JSON.stringify(summary));
        if (errors.length) throw new Error('Latency page errors: ' + JSON.stringify(errors));
        results.push({ summary, crossings, gpu, hardwareRequested: hardware, errors, ...data }); console.log(JSON.stringify(summary));
        await context.close();
      } finally { await browser.close(); }
    }
  }
  await writeFile(output, JSON.stringify(results, null, 2) + '\n');
} finally { await finish(); }
}
