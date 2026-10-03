import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('idle wave spans every band, travels across the spectrum and emits no attack flashes', async () => {
  const messages = [], self = { postMessage: message => messages.push(message) };
  const path = new URL('../../musical-leptos/src/physics/demo-worker.js', import.meta.url);
  const bytes = await readFile(new URL('../../musical-lights-worklet/pkg/loudness.wasm', import.meta.url));
  runInNewContext((await readFile(path, 'utf8')).replaceAll('import.meta.url', JSON.stringify(path.href)),
    { self, URL, WebAssembly, fetch: async () => new Response(bytes) });
  const frame = async (time, reduced = false) => {
    await self.onmessage({ data: { type: 'pulse', time, reduced } });
    return Array.from(messages.at(-1).state);
  };
  await self.onmessage({ data: { type: 'init' } }); assert.equal(messages.pop().type, 'ready');
  const first = await frame(0), later = await frame(1.5), reduced = await frame(0, true);
  const levels = state => Array.from({ length: 24 }, (_, i) => state[4 + 4 * i]);
  const a = levels(first), b = levels(later), r = levels(reduced);
  assert.equal(a.filter(value => value >= .149 && value <= .751).length, 24);
  assert.equal(a.indexOf(Math.max(...a)), 6); assert.equal(b.indexOf(Math.max(...b)), 12);
  assert.ok(a.every((value, i) => Math.abs(value - a[(i + 1) % 24]) < .08));
  assert.ok(r.every(value => value >= .299 && value <= .601));
  assert.ok(Array.from({ length: 24 }, (_, i) => first[5 + 4 * i]).every(value => value === -1));
  assert.ok(levels(await frame(6)).every((value, i) => Math.abs(value - a[i]) < 1e-12));
});
