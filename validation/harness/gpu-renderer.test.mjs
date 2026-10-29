import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireHardwareRenderer } from '../gpu-renderer.mjs';

test('GPU validation rejects missing or software renderers', () => {
  for (const renderer of [null, '', 'ANGLE (SwiftShader)', 'llvmpipe', 'softpipe', 'Software Rasterizer']) {
    assert.throws(() => requireHardwareRenderer(renderer), /requires/);
  }
  const hardware = 'ANGLE (Mesa, virgl (Mesa Intel(R) UHD Graphics), OpenGL 4.3)';
  assert.equal(requireHardwareRenderer(hardware), hardware);
});
