const HISTORY_PREFIX = 'musical-lights-song:v1:';
const SAMPLE_MS = 10_000;
const MAX_BYTES = 512 * 1024;

export function validSong(song) {
  return song && ['artist', 'title'].every(key => typeof song[key] === 'string' && song[key].trim() && song[key].length <= 1000)
    && (song.album === undefined || typeof song.album === 'string' && song.album.length <= 1000);
}

export class SongHistory {
  constructor(storage) { this.storage = storage; this.records = new Map(); this.warning = ''; this.read(); }
  read() {
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (!key?.startsWith(HISTORY_PREFIX)) continue;
        try {
          const entry = JSON.parse(this.storage.getItem(key));
          if (!validSong(entry) || !['sampleStartedAt', 'sampleEndedAt', 'recognizedAt'].every(k => typeof entry[k] === 'string' && Number.isFinite(Date.parse(entry[k])))) throw Error();
          this.records.set(key, entry);
        } catch { this.warning = 'Some saved history could not be read. It has been left untouched.'; }
      }
    } catch { this.warning = 'History cannot be saved in this browser. Export it before closing the page.'; }
    return [...this.records.values()].sort((a, b) => a.sampleStartedAt.localeCompare(b.sampleStartedAt));
  }
  add(entry) {
    const key = HISTORY_PREFIX + entry.id;
    this.records.set(key, entry);
    try { this.storage.setItem(key, JSON.stringify(entry)); }
    catch { this.warning = 'History could not be saved. Export it before closing the page.'; }
  }
}

export function historyCSV(entries) {
  const fields = ['sampleStartedAt', 'sampleEndedAt', 'recognizedAt', 'artist', 'title', 'album', 'provider'];
  const cell = value => {
    let text = String(value ?? '');
    // Prevent provider metadata being interpreted as spreadsheet formulas.
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return [fields.join(','), ...entries.map(entry => fields.map(key => cell(entry[key])).join(','))].join('\r\n') + '\r\n';
}

export class SongRecognition {
  constructor(card) {
    this.card = card;
    this.closed = false;
    this.input = null;
    this.playing = false;
    this.job = null;
    let storage;
    try { storage = localStorage; } catch { /* Export still works from memory. */ }
    this.history = new SongHistory(storage);
    this.tools = document.createElement('section');
    this.tools.className = 'song-tools';
    this.tools.setAttribute('aria-label', 'Song recognition');
    this.tools.innerHTML = `<div class="song-actions"><button type="button" class="identify-song" aria-describedby="recognition-disclosure"><span aria-hidden="true">♫</span> Identify song</button><button type="button" class="cancel-recognition" hidden>Cancel identification</button></div>
      <p id="recognition-disclosure">Identify song sends a 10-second microphone recording to AudD through our server. Only recognized song details are saved on this device.</p>
      <p class="recognition-status" role="status"></p>
      <details class="song-history"><summary>Song history (0)</summary><p>Detection times, not exact song start times. History is local to this browser.</p><div class="song-actions"><button type="button" class="export-songs-csv">Export CSV</button><button type="button" class="export-songs-json">Export JSON</button></div><p class="song-storage-status" role="status"></p><ol></ol></details>`;
    card.querySelector('.display-note').after(this.tools);
    this.strip = document.createElement('div');
    this.strip.className = 'recognized-song';
    this.strip.hidden = true;
    this.strip.setAttribute('aria-label', 'Last recognized song');
    this.strip.innerHTML = '<span class="song-caption">Last recognized</span><div class="song-window"><span class="song-title"></span></div>';
    card.querySelector('.spectrum-panel').before(this.strip);
    const query = selector => this.tools.querySelector(selector);
    this.button = query('.identify-song'); this.cancelButton = query('.cancel-recognition');
    const row = card.querySelector('.button-row');
    const fullscreen = row.querySelector('.fullscreen-button');
    row.insertBefore(this.button, fullscreen);
    row.insertBefore(this.cancelButton, fullscreen);
    query('.song-actions').remove();
    this.status = query('.recognition-status');
    this.button.onclick = () => this.identify();
    this.cancelButton.onclick = () => this.cancel('Identification canceled.');
    query('.export-songs-csv').onclick = () => this.export('csv');
    query('.export-songs-json').onclick = () => this.export('json');
    this.onInput = ({ detail }) => { this.cancel(); this.input = detail; this.refresh(); };
    this.onSession = ({ detail }) => {
      this.playing = detail.state === 'playing' && detail.source === 'microphone';
      if (!this.playing) this.cancel();
      if (detail.state === 'stopped') this.input = null;
      if (['Ready to identify a song.', 'Start listening to identify a song.'].includes(this.status.textContent)) this.status.textContent = '';
      this.refresh();
    };
    this.onVisibility = () => { if (document.hidden) this.cancel('Identification canceled when the page was hidden.'); };
    this.onStorage = () => this.renderHistory();
    card.addEventListener('recognition-input', this.onInput);
    card.addEventListener('audio-session', this.onSession);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('storage', this.onStorage);
    this.resize = new ResizeObserver(() => this.measureTitle());
    this.resize.observe(this.strip);
    this.renderHistory(); this.refresh();
  }

  endpoint() {
    const value = document.querySelector('meta[name="musical-lights-recognition"]')?.content;
    if (!value) return null;
    try {
      const url = new URL(value, document.baseURI);
      return url.protocol === 'https:' || url.origin === location.origin ? url.href : null;
    } catch { return null; }
  }

  refresh() {
    const supported = typeof MediaRecorder !== 'undefined';
    this.button.disabled = !this.endpoint() || !supported || !this.input || !this.playing || Boolean(this.job);
    this.button.title = !this.playing ? 'Start listening, then identify the music.' : 'Identify the music playing now.';
    this.cancelButton.hidden = !this.job;
    if (!this.job && !this.status.textContent) this.status.textContent = !this.endpoint()
      ? 'Song recognition is not configured yet.' : !supported ? 'Song recognition is unavailable in this browser.'
        : !this.playing ? 'Start listening to identify a song.' : 'Ready to identify a song.';
  }

  cancel(message = '') {
    const job = this.job;
    this.job = null;
    if (job) {
      job.abort.abort();
      clearTimeout(job.captureTimer); clearTimeout(job.deadline);
      if (job.recorder?.state !== 'inactive') job.recorder?.stop();
      this.status.textContent = message || 'Identification canceled.';
    }
    this.refresh();
  }

  async identify() {
    if (this.button.disabled || this.closed) return;
    const endpoint = this.endpoint();
    const job = { abort: new AbortController(), sampleStartedAt: new Date().toISOString() };
    this.job = job;
    this.status.textContent = 'Listening for 10 seconds…'; this.refresh();
    try {
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      if (!type) throw new Error('This browser cannot record a supported audio format.');
      const recorder = job.recorder = new MediaRecorder(this.input.stream, { mimeType: type, audioBitsPerSecond: 128000 });
      const blob = await new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        recorder.ondataavailable = ({ data }) => {
          size += data.size;
          if (size > MAX_BYTES) { reject(new Error('Audio sample is too large.')); return; }
          if (data.size) chunks.push(data);
        };
        recorder.onerror = () => reject(new Error('Could not record the audio sample.'));
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
        job.abort.signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
        recorder.start(1000);
        job.captureTimer = setTimeout(() => { job.sampleEndedAt = new Date().toISOString(); recorder.stop(); }, SAMPLE_MS);
        job.deadline = setTimeout(() => { reject(new Error('Audio capture timed out. Try again.')); }, SAMPLE_MS + 5000);
      });
      clearTimeout(job.deadline);
      if (this.job !== job) return;
      if (!job.sampleEndedAt) throw new Error('Audio recording ended early. Try again.');
      if (!blob.size) throw new Error('No audio was recorded. Try again.');
      this.status.textContent = 'Identifying song…';
      job.deadline = setTimeout(() => job.abort.abort(), 25_000);
      const response = await fetch(endpoint, { method: 'POST', body: blob, signal: job.abort.signal, credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error(({ 429: 'Too many requests. Wait a minute and try again.', 503: 'Song recognition is not configured yet.', 413: 'Audio sample is too large.' })[response.status] ?? 'Recognition failed. Try again when ready.');
      const { result } = await response.json();
      if (this.job !== job || this.closed) return;
      if (result === null) { this.status.textContent = 'No song recognized. Try again during a clearer part of the song.'; return; }
      if (!validSong(result)) throw new Error('The recognition service returned an invalid song.');
      const entry = { id: crypto.randomUUID(), provider: 'AudD', artist: result.artist, title: result.title, album: result.album ?? '',
        sampleStartedAt: job.sampleStartedAt, sampleEndedAt: job.sampleEndedAt, recognizedAt: new Date().toISOString() };
      this.history.add(entry); this.renderHistory();
      this.showSong(entry);
      this.status.textContent = `Recognized ${entry.artist} — ${entry.title}.`;
    } catch (error) {
      if (this.job === job && !this.closed) this.status.textContent = error.name === 'AbortError' ? 'Recognition timed out. Try again when ready.' : error.message;
    } finally {
      clearTimeout(job.captureTimer); clearTimeout(job.deadline);
      if (job.recorder && job.recorder.state !== 'inactive') job.recorder.stop();
      if (this.job === job) { this.job = null; this.refresh(); }
    }
  }

  showSong(entry) {
    const text = `${entry.artist} — ${entry.title}`;
    const title = this.strip.querySelector('.song-title');
    if (title.textContent !== text) title.textContent = text;
    this.strip.hidden = false;
    this.strip.title = `${text} · ${new Date(entry.sampleStartedAt).toLocaleString()}`;
    this.measureTitle();
  }

  measureTitle() {
    const title = this.strip.querySelector('.song-title');
    const distance = Math.max(0, title.scrollWidth - title.parentElement.clientWidth);
    this.strip.style.setProperty('--song-travel', `-${distance}px`);
    this.strip.style.setProperty('--song-duration', `${Math.max(8, distance / 25 + 4)}s`);
    this.strip.classList.toggle('song-overflow', distance > 0);
  }

  renderHistory() {
    const entries = this.history.read();
    this.tools.querySelector('summary').textContent = `Song history (${entries.length})`;
    this.tools.querySelector('.song-storage-status').textContent = this.history.warning;
    this.tools.querySelectorAll('[class^="export-songs-"]').forEach(button => { button.disabled = !entries.length; });
    const list = this.tools.querySelector('ol'); list.replaceChildren();
    for (const entry of entries.slice(-50).reverse()) {
      const item = document.createElement('li');
      item.textContent = `${new Date(entry.sampleStartedAt).toLocaleString()} · ${entry.artist} — ${entry.title}`;
      list.append(item);
    }
    list.setAttribute('aria-label', 'Latest 50 recognitions; exports include all songs');
  }

  export(format) {
    const entries = this.history.read();
    const data = format === 'csv' ? historyCSV(entries) : JSON.stringify({ version: 1, detections: entries }, null, 2);
    const blob = new Blob([data], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `musical-lights-songs-${new Date().toISOString().slice(0, 10)}.${format}`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  close() {
    this.closed = true; this.cancel(); this.input = null;
    this.card.removeEventListener('recognition-input', this.onInput);
    this.card.removeEventListener('audio-session', this.onSession);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('storage', this.onStorage);
    this.resize.disconnect(); this.button.remove(); this.cancelButton.remove(); this.tools.remove(); this.strip.remove();
  }
}
