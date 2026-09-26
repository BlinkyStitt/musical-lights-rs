import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackClock } from '../../docs/audio-audit-results/playback-clock.js';
const context = () => ({ state: 'running', currentTime: 10, baseLatency: .01, outputLatency: .19 });
test('200 ms output delay preserves a 120 ms recovered bass flash, including timestamp age', () => {
  const audio = context(), clock = new PlaybackClock(audio, 10);
  audio.getOutputTimestamp = () => ({ contextTime: audio.currentTime - .208, performanceTime: 992 });
  for (const [processing, expected, lit] of [[.446,.246,false],[.647,.447,true],[.706,.506,true],[.765,.565,true],[.767,.567,false]]) {
    audio.currentTime = 10 + processing;
    const result = clock.read(1000);
    assert.ok(Math.abs(result.elapsed - expected) < 1e-12);
    assert.equal(result.method, 'output-timestamp');
    assert.equal(result.elapsed >= .446 && result.elapsed < .566, lit);
  }
});
test('fallback estimates, missing metadata, zero and invalid startup timestamps are explicit', () => {
  const audio = context(), clock = new PlaybackClock(audio, 10);
  for (const timestamp of [undefined, {contextTime:0,performanceTime:0}, {contextTime:NaN,performanceTime:10}]) {
    audio.getOutputTimestamp = () => timestamp;
    const result = clock.read(1000);
    assert.equal(result.method, 'estimated-latency');
    assert.ok(Math.abs(result.elapsed + .2) < 1e-12);
  }
  delete audio.baseLatency;delete audio.outputLatency;
  assert.equal(clock.read(1000).method, 'unverified');
  assert.equal(clock.read(1000).elapsed, 0);
});
test('suspension freezes, resumption obtains fresh timestamps, and completion waits for output', () => {
  const audio=context(),clock=new PlaybackClock(audio,10);
  audio.currentTime=11;
  assert.ok(clock.read(1000).elapsed < 1);
  audio.state='suspended';audio.currentTime=12;
  assert.ok(clock.read(5000).elapsed < 1);
  audio.state='running';audio.getOutputTimestamp=()=>({contextTime:11,performanceTime:5000});
  assert.equal(clock.read(5000).elapsed,1);
  assert.equal(new PlaybackClock(audio,12).read(5000).elapsed,-1);
});
