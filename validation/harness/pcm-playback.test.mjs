import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playbackFixture } from '../pcm-playback-fixture.mjs';

test('PCM stays exact across startup clocks, chunk boundaries and loop seams', () => {
  const pcm = Float32Array.from([0, .013153076171875, -.03125, .25, -.5, 0, .125]);
  for (const frame of [0, 768, 3456, 100000000]) {
    const player = playbackFixture(pcm, true, frame);
    let sample = 0;
    for (const length of [128, 96, 511, 128]) {
      const actual = player.render(length);
      for (const value of actual) assert.equal(value, pcm[sample++ % pcm.length]);
    }
  }
});

test('pause holds the integer cursor, resume continues, replay rewinds and end stays silent', () => {
  const states = [], player = playbackFixture(Float32Array.of(.25, -.5, .125), false, 768, data => states.push(data));
  assert.deepEqual(player.render(1), Float32Array.of(.25));
  player.command({ type: 'pause', sequence: 1 });
  assert.deepEqual(player.render(128), new Float32Array(128));
  assert.deepEqual(states.at(-1), { type: 'transport', sequence: 1, frame: 769, positionFrame: 1, repeat: false, state: 'paused' });
  player.command({ type: 'resume', sequence: 2 });
  assert.deepEqual(player.render(4), Float32Array.of(-.5, .125, 0, 0));
  assert.equal(states.at(-1).frame, 899); assert.equal(states.at(-1).state, 'ended');
  assert.deepEqual(player.render(128), new Float32Array(128));
  player.command({ type: 'restart', sequence: 3 });
  assert.deepEqual(player.render(2), Float32Array.of(.25, -.5));
  player.command({ type: 'repeat', repeat: true, sequence: 4 });
  assert.deepEqual(player.render(4), Float32Array.of(.125, .25, -.5, .125));
});
