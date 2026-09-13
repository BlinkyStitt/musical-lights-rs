// Measure served release artifacts through real AudioWorklet transfer/ACK and DOM paths.
// Usage: node measure-spectrum.mjs ROOT LABEL OUTPUT.json
import { chromium, webkit, devices } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, extname, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus, platform, arch, release } from 'node:os';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const [rootArgument, label, outputArgument] = process.argv.slice(2);
if (!rootArgument || !label || !outputArgument) throw new Error('Expected ROOT LABEL OUTPUT.json');
const root = resolve(rootArgument), output = resolve(outputArgument);
const dist = resolve(root, 'musical-leptos/dist');
const bytes = await readFile(resolve(dist, 'loudness/loudness.wasm'));
const processorSource = await readFile(resolve(dist, 'loudness/processor.js'), 'utf8');
const summary = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) };
};

function hostWorkletCost() {
  // This separate host benchmark includes snapshot creation and actual buffer
  // detachment. Browser measurements below supply the real asynchronous ACK path.
  const scope = { currentFrame: 0, sampleRate: 48000, WebAssembly, Float32Array, Float64Array,
    AudioWorkletProcessor: class { port = { postMessage(data, transfer) { structuredClone(data, { transfer }); } }; },
    registerProcessor(_, value) { scope.Processor = value; },
  };
  vm.runInNewContext(processorSource, scope);
  const p = new scope.Processor({ processorOptions: { module: new WebAssembly.Module(bytes), channel: 0, reducedMotion: false } });
  const memory = p.wasm.memory.buffer.byteLength;
  const blocks = Array.from({ length: 375 }, (_, block) => Float32Array.from({ length: 128 }, (_, i) =>
    .02 * Math.sin(2 * Math.PI * (block * 128 + i) * 1000 / 48000)));
  const run = seconds => {
    for (let second = 0; second < seconds; second++) for (const block of blocks) {
      assert.equal(p.process([[block]]), true);
      p.port.onmessage({ data: { type: 'ack' } });
      scope.currentFrame += 128;
    }
  };
  run(5);
  const start = performance.now(); run(30); const elapsed = performance.now() - start;
  assert.equal(p.failed, false);
  assert.equal(p.wasm.memory.buffer.byteLength, memory);
  return { audioSeconds: 30, elapsedMs: elapsed, percentOfOneHostCore: elapsed / 300, memoryBytes: memory,
    snapshotBytes: p.snapshot.byteLength, boundary: 'Mac Node WASM process + snapshot + transferable structuredClone; synchronous ACK after every quantum' };
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let file = resolve(dist, `.${pathname}`);
    if (!file.startsWith(dist + sep) && file !== dist) { response.writeHead(403).end(); return; }
    try { if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html'); }
    catch { if (!extname(file)) file = resolve(dist, 'index.html'); }
    response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const result = { label, at: new Date().toISOString(), host: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0].model },
  workletSha256: createHash('sha256').update(bytes).digest('hex'), indexSha256: createHash('sha256').update(await readFile(resolve(dist, 'index.html'))).digest('hex'),
  hostWorklet: hostWorkletCost(), profiles: [] };
await mkdir(dirname(output), { recursive: true });
try {
  for (const [name, engine, profile] of [
    ['desktop-chromium', chromium, { viewport: { width: 1440, height: 1000 } }],
    ['iphone-profile-webkit-on-mac', webkit, devices['iPhone 13']],
  ]) {
    console.log(`${label}: ${name}, 5 s warmup + 30 s release-page measurement`);
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ ...profile, colorScheme: 'dark' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        const makeStats = () => ({ frames: [], frameCosts: [], flushCosts: [], messages: [], decodeCosts: [], acks: 0 });
        window.measureStats = makeStats();
        window.resetMeasureStats = () => { window.measureStats = makeStats(); };
        const request = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = callback => request(now => {
          const stats = window.measureStats;
          if (stats.frames.at(-1) !== now) stats.frames.push(now);
          const start = performance.now();
          callback(now);
          stats.frameCosts.push(performance.now() - start);
          // Leptos queues its effects during the callback. This boundary includes
          // that microtask work, but does not claim GPU presentation or paint time.
          queueMicrotask(() => stats.flushCosts.push(performance.now() - start));
        });
        const Context = window.AudioContext;
        window.AudioContext = class extends Context {
          constructor(...args) { super(...args); window.measuredContext = this; }
        };
        const Node = window.AudioWorkletNode;
        window.AudioWorkletNode = class extends Node {
          constructor(...args) {
            super(...args);
            const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
            Object.defineProperty(this.port, 'onmessage', {
              get() { return descriptor.get.call(this); },
              set(callback) {
                descriptor.set.call(this, callback && function(event) {
                  const start = performance.now(), stats = window.measureStats;
                  const frame = event.data.type === 'frame';
                  if (frame) stats.messages.push({ received: start, audio: event.data.state[0], bytes: event.data.state.byteLength,
                    ageMs: (window.measuredContext.currentTime - event.data.state[0]) * 1000 });
                  callback.call(this, event);
                  if (frame) stats.decodeCosts.push(performance.now() - start);
                });
              },
            });
            const post = this.port.postMessage.bind(this.port);
            this.port.postMessage = (...args) => { if (args[0].type === 'ack') window.measureStats.acks++; return post(...args); };
          }
        };
        MediaDevices.prototype.getUserMedia = async () => {
          const context = new Context({ sampleRate: 48000 });
          const destination = context.createMediaStreamDestination();
          const buffer = context.createBuffer(1, 48000 * 8, 48000);
          const samples = buffer.getChannelData(0);
          let seed = 1;
          for (let i = 0; i < samples.length; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const t = i / 48000;
            samples[i] = (.02 + .015 * Math.sin(t * Math.PI / 2)) *
              (Math.sin(2 * Math.PI * 220 * t) + .6 * Math.sin(2 * Math.PI * 1800 * t)) + .005 * (seed / 2 ** 32 - .5);
          }
          const source = context.createBufferSource(); source.buffer = buffer; source.loop = true;
          const gain = context.createGain(); source.connect(gain); gain.connect(destination);
          source.start(); await context.resume();
          window.measureInput = { context, gain };
          return destination.stream;
        };
      });
      await page.goto(url);
      await page.getByRole('button', { name: 'Start listening' }).click();
      await page.getByRole('button', { name: 'Stop listening' }).waitFor();
      await page.waitForTimeout(5000);
      await page.evaluate(() => window.resetMeasureStats());
      await page.waitForTimeout(30000);
      const stats = await page.evaluate(() => window.measureStats);
      assert(stats.messages.length > 100, 'Measure the actual worklet, not idle RAF');
      assert.equal(stats.messages.length, stats.acks);
      assert(stats.decodeCosts.length === stats.messages.length);
      const intervals = stats.frames.slice(1).map((v, i) => v - stats.frames[i]);
      const seconds = (stats.frames.at(-1) - stats.frames[0]) / 1000;
      // Delay the actual UI thread. One old packet may be pending; after ACK the
      // producer must send current state, without replaying all missed frames.
      const blockedAt = await page.evaluate(() => {
        window.resetMeasureStats();
        const at = window.measuredContext.currentTime;
        const end = performance.now() + 300;
        while (performance.now() < end) { /* Deliberate UI stall for backpressure. */ }
        return at;
      });
      await page.waitForTimeout(200);
      const recovery = await page.evaluate(() => window.measureStats.messages);
      const stale = recovery.filter(m => m.audio < blockedAt + .25).length;
      assert(stale <= 1, `Replayed ${stale} old packets after a blocked UI`);
      assert(recovery.some(m => m.audio >= blockedAt + .25), 'No fresh post-stall snapshot');
      const meters = await page.getByRole('meter').count();
      const heights = await page.getByRole('meter').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('aria-valuenow'))));
      await page.screenshot({ path: output.replace(/\.json$/, `-${name}.png`), fullPage: true });
      await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await page.screenshot({ path: output.replace(/\.json$/, `-${name}-fullscreen.png`) });
      await page.keyboard.press('Escape');
      if (name.includes('webkit')) {
        for (const viewport of [{ width: 320, height: 740 }, { width: 375, height: 812 }, { width: 844, height: 390 }]) {
          await page.setViewportSize(viewport);
          await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
          await page.screenshot({ path: output.replace(/\.json$/, `-${viewport.width}-fullscreen.png`) });
          await page.keyboard.press('Escape');
        }
      }
      await page.getByRole('button', { name: 'Stop listening' }).click();
      await page.evaluate(() => window.measureInput.context.close());
      assert.deepEqual(errors, []);
      result.profiles.push({ name, browser: browser.version(), measuredSeconds: seconds, meters,
        fps: (stats.frames.length - 1) / seconds, frameIntervalMs: summary(intervals),
        appRafCallbackMs: summary(stats.frameCosts), appRafThroughMicrotaskMs: summary(stats.flushCosts),
        messageDecodeAndAckMs: summary(stats.decodeCosts), messages: stats.messages.length, acknowledgements: stats.acks,
        messagesPerSecond: stats.messages.length / seconds,
        payloadBytesPerSecond: stats.messages.reduce((sum, m) => sum + m.bytes, 0) / seconds,
        snapshotBytes: [...new Set(stats.messages.map(m => m.bytes))], snapshotAgeMs: summary(stats.messages.map(m => m.ageMs)),
        stall: { blockedMs: 300, oldPackets: stale, firstAudioTimes: recovery.slice(0, 5).map(m => m.audio), blockedAt },
        heights: { max: Math.max(...heights), min: Math.min(...heights), distinct: new Set(heights).size }, errors });
    } finally { await browser.close(); }
  }
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await new Promise(resolve => server.close(resolve)); }
