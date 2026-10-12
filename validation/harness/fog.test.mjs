import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FogVolume } from '../../musical-lights-physics/pkg/fog.js';
import { SceneLighting } from '../../musical-lights-physics/pkg/lighting.js';

test('fog keeps at least three rows of transition while requested image depth stays independent', () => {
  const fog = new FogVolume(new SceneLighting(new Float32Array(72), {}));
  try {
    for (const depth of [.2, .24, 2]) {
      for (const count of [0, 1, 2, 3]) {
        fog.update(1.2, .6, depth, count, 2000);
        assert.equal(fog.uniforms.volumeSpan.value.z, depth * 3);
      }
      fog.update(1.2, .6, depth, 32, 2000);
      const shallow = fog.uniforms.volumeSpan.value.z;
      fog.update(1.2, .6, depth, 2048, 2000);
      assert(fog.uniforms.volumeSpan.value.z > shallow * 5);
      assert(fog.uniforms.volumeSpan.value.z <= depth * 2048);
    }
  } finally { fog.dispose(); }
});
