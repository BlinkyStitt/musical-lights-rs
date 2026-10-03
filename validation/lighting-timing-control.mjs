// Diagnose native headless fullscreen pacing separately from acceptance.
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import startup from './browser-startup.mjs';
import { staticPreview } from './static-preview.mjs';
const origin = 'https://musical-lights.test', viewport = { width: 844, height: 390 };
const finish = await startup({ filteredProjects: [{ name: 'chromium', use: { browserName: 'chromium' } }] });
const rows = [];
const build = JSON.parse(await readFile('musical-leptos/dist/build.json', 'utf8'));
try {
 const browser = await chromium.launch();
 try {
  for (const mode of ['native-blank', 'native-no-render', 'expanded-lit']) {
   const context = await browser.newContext({ viewport });
   if (mode === 'expanded-lit') await context.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
   await staticPreview(context, origin);
   const page = await context.newPage(); await page.setViewportSize(viewport);
   if (mode === 'native-blank') {
    await page.goto(`${origin}/about/`);
    await page.setContent('<button onclick="document.documentElement.requestFullscreen()">Fullscreen</button>');
    await page.locator('button').click();
   } else {
    await page.goto(`${origin}/advanced/`);
    await page.waitForFunction(() => document.querySelector('#dancinglights')?.physics?.current);
    await page.locator('.input-source').selectOption('generated');
    await page.locator('.review-start').click();
    await page.waitForFunction(() => document.querySelector('#dancinglights').physics.report.acceptanceWorkload());
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    if (mode === 'native-no-render') await page.evaluate(() => { document.querySelector('#dancinglights').physics.renderer.render = () => {}; });
   }
   await page.waitForTimeout(5000);
   const data = await page.evaluate(() => new Promise(resolve => {
    const start = performance.now(), intervals = []; let previous;
    const sample = now => {
     if (previous != null) intervals.push(now - previous); previous = now;
     if (now - start < 30000) requestAnimationFrame(sample);
     else {
      const v = document.querySelector('#dancinglights')?.physics;
      const gl = v?.renderer.getContext(), extension = gl?.getExtension('WEBGL_debug_renderer_info');
      const sorted = intervals.toSorted((a, b) => a - b);
      resolve({ measuredAt: new Date().toISOString(), viewport: { width: innerWidth, height: innerHeight }, nativeFullscreen: !!document.fullscreenElement,
       enclosureHeight: v?.current[1], material: v?.bars.material.type, gpu: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null,
       fps: intervals.length * 1000 / intervals.reduce((a, b) => a + b, 0), p95FrameMs: sorted[Math.ceil(sorted.length * .95) - 1],
       maxFrameMs: sorted.at(-1), over25Fraction: intervals.filter(x => x > 25).length / intervals.length });
     }
    }; requestAnimationFrame(sample);
   }));
   rows.push({ build, mode, ...data }); console.log(rows.at(-1));
   await context.close();
   await writeFile('docs/musical-motion-results/fullscreen-pacing-control.json', JSON.stringify(rows, null, 2) + '\n');
  }
 } finally { await browser.close(); }
} finally { await finish(); }
