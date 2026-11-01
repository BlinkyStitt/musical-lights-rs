import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireHardwareRenderer, renderingEvidence } from '../gpu-renderer.mjs';

test('GPU validation rejects missing or software renderers', () => {
  for (const renderer of [null, '', 'ANGLE (SwiftShader)', 'llvmpipe', 'softpipe', 'Software Rasterizer']) {
    assert.throws(() => requireHardwareRenderer(renderer), /requires/);
  }
  const hardware = 'ANGLE (Mesa, virgl (Mesa Intel(R) UHD Graphics), OpenGL 4.3)';
  assert.equal(requireHardwareRenderer(hardware), hardware);
});

test('native software evidence overrides a masked WebKit renderer without relabelling hardware', () => {
  const native = [{ pid: 7, tasks: [{ tid: 8, name: 'llvmpipe-0' }] }];
  const result = renderingEvidence('webkit', 'Apple GPU', native, 'linux');
  assert.equal(result.kind, 'software');
  assert.deepEqual(result.softwareThreads, [{ pid: 7, tid: 8, name: 'llvmpipe-0' }]);
  assert.equal(renderingEvidence('webkit', 'Apple GPU', [], 'linux').kind, 'unverified');
  assert.equal(renderingEvidence('webkit', 'Apple GPU', [], 'darwin').kind, 'hardware');
  assert.equal(renderingEvidence('chromium', 'ANGLE (SwiftShader)', [], 'linux').kind, 'software');
  assert.equal(renderingEvidence('chromium', 'ANGLE (Mesa, virgl (Mesa Intel UHD Graphics))', [], 'linux').kind, 'hardware');
  for (const renderer of [null, '']) assert.equal(renderingEvidence('webkit', renderer, [], 'linux').kind, 'unverified');
});
