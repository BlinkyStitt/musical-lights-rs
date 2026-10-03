import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SongHistory, historyCSV, validSong, recognitionEndpoint, RecognitionCooldown } from '../../musical-leptos/src/recognition.js';

test('development and previews cannot inherit the live recognition endpoint', () => {
  const live = 'https://musical-lights-recognition.satoshiandkin.workers.dev/recognize';
  for (const page of ['http://127.0.0.1:8101/', 'http://localhost:8080/', 'https://preview.example/']) {
    assert.equal(recognitionEndpoint(live, page), null);
    assert.equal(recognitionEndpoint('/recognize', page), new URL('/recognize', page).href);
  }
  assert.equal(recognitionEndpoint(live, 'https://blink.stitthappens.com/advanced/'), live);
  assert.equal(recognitionEndpoint('/recognize', 'https://preview.example/', 'https://blink.stitthappens.com/'), null);
  assert.equal(recognitionEndpoint('recognize', 'https://blink.stitthappens.com/advanced/', 'https://blink.stitthappens.com/'), 'https://blink.stitthappens.com/recognize');
  for (const value of ['', 'javascript:alert(1)', 'http://remote.example/recognize'])
    assert.equal(recognitionEndpoint(value, 'https://blink.stitthappens.com/'), null);
});

test('lookup cooldown lasts one minute and survives reload and other tabs', () => {
  const disk = storage(); let now = 1000;
  const first = new RecognitionCooldown(disk, () => now), second = new RecognitionCooldown(disk, () => now);
  assert.equal(first.remaining(), 0); first.start();
  now += 59_999;
  assert.equal(first.remaining(), 1); assert.equal(second.remaining(), 1);
  assert.equal(new RecognitionCooldown(disk, () => now).remaining(), 1);
  now++;
  assert.equal(first.remaining(), 0); assert.equal(second.remaining(), 0);
});

test('lookup cooldown survives unavailable storage for the current session', () => {
  const disk = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  let now = 1000; const cooldown = new RecognitionCooldown(disk, () => now);
  assert.equal(cooldown.remaining(), 0); cooldown.start();
  assert.equal(cooldown.remaining(), 60_000); now += 60_000;
  assert.equal(cooldown.remaining(), 0);
});

function storage() {
  const map = new Map();
  return { get length() { return map.size; }, key: i => [...map.keys()][i], getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) };
}
const entry = (id, title = 'Song') => ({ id, artist: 'Artist', title, album: '', provider: 'AudD',
  sampleStartedAt: '2026-10-01T20:00:00.000Z', sampleEndedAt: '2026-10-01T20:00:10.000Z', recognizedAt: '2026-10-01T20:00:11.000Z' });

test('each explicit recognition survives reload and concurrent tabs, including repeated songs', () => {
  const disk = storage(), first = new SongHistory(disk), second = new SongHistory(disk);
  first.add(entry('1')); second.add(entry('2')); first.add(entry('3', 'Another song'));
  assert.equal(new SongHistory(disk).read().length, 3);
  assert.equal(second.read().length, 3);
});
test('storage failure preserves matches for export and reports unsaved history', () => {
  const disk = storage(); disk.setItem = () => { throw Error('quota'); };
  const history = new SongHistory(disk); history.add(entry('1'));
  assert.deepEqual(history.read(), [entry('1')]);
  assert.match(history.warning, /Export/);
});
test('corrupt history stays untouched without hiding valid entries', () => {
  const disk = storage(); disk.setItem('musical-lights-song:v1:bad', '{');
  disk.setItem('musical-lights-song:v1:bad-time', JSON.stringify({ ...entry('bad-time'), sampleStartedAt: 123 }));
  const history = new SongHistory(disk); history.add(entry('1'));
  assert.equal(history.read().length, 1); assert.match(history.warning, /could not be read/);
  assert.equal(disk.getItem('musical-lights-song:v1:bad'), '{');
});
test('CSV includes timestamps and safely quotes commas, newlines and formulas', () => {
  const song = entry('1', '=HYPERLINK("bad")'); song.artist = 'A, B\nC';
  const csv = historyCSV([song]);
  assert.ok(csv.includes('"A, B\nC"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes(song.sampleStartedAt)); assert.ok(csv.includes(song.recognizedAt));
});
test('provider metadata must contain bounded artist and title strings', () => {
  assert.ok(validSong({ artist: 'Artist', title: 'Title' }));
  for (const song of [null, {}, { artist: 'A', title: ' ' }, { artist: 'A', title: 'x'.repeat(1001) }, { artist: 'A', title: 1 }]) assert.ok(!validSong(song));
});
