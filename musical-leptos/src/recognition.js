const HISTORY_PREFIX = 'musical-lights-song:v1:';
const SAMPLE_MS = 10_000;
const MAX_BYTES = 512 * 1024;
const COOLDOWN_MS = 60_000;
const COOLDOWN_KEY = 'musical-lights-recognition-next:v1';

export function recognitionEndpoint(value, pageURL, baseURL = pageURL) {
  if (!value) return null;
  try {
    const page = new URL(pageURL), endpoint = new URL(value, baseURL);
    if (!['http:', 'https:'].includes(endpoint.protocol)) return null;
    // Development and preview builds may use a same-origin mock, never the
    // production service accidentally inherited from index.html.
    if (endpoint.origin !== page.origin && (page.origin !== 'https://blink.stitthappens.com' || endpoint.protocol !== 'https:')) return null;
    return endpoint.href;
  } catch { return null; }
}

export class RecognitionCooldown {
  constructor(storage, now = () => Date.now()) { this.storage = storage; this.now = now; this.until = 0; }
  remaining() {
    try {
      const saved = Number(this.storage?.getItem(COOLDOWN_KEY));
      if (Number.isFinite(saved)) this.until = Math.max(this.until, saved);
    } catch { /* Keep the session limit when storage is unavailable. */ }
    return Math.max(0, this.until - this.now());
  }
  start() {
    this.until = this.now() + COOLDOWN_MS;
    try { this.storage?.setItem(COOLDOWN_KEY, String(this.until)); }
    catch { /* Keep the session limit when storage is unavailable. */ }
  }
}

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
    this.enabled = false;
    let storage;
    try { storage = localStorage; } catch { /* Export still works from memory. */ }
    this.history = new SongHistory(storage);
    this.cooldown = new RecognitionCooldown(storage);
    this.tools = document.createElement('section');
    this.tools.className = 'song-tools';
    this.tools.setAttribute('aria-label', 'Song recognition');
    this.tools.innerHTML = `<details class="song-history settings-section"><summary>Song history (0)</summary>
      <p id="recognition-disclosure">While enabled, Identify song sends a 10-second microphone recording to AudD through our server at most once per minute. Each lookup uses one request. Only recognized song details are saved on this device.</p>
      <p>Detection times, not exact song start times. History is local to this browser.</p><div class="song-actions"><button type="button" class="export-songs-csv">Export CSV</button><button type="button" class="export-songs-json">Export JSON</button></div><p class="song-storage-status" role="status"></p><ol></ol></details>`;
    (card.querySelector('.diagnostics-controls') ?? card.querySelector('.display-note')).after(this.tools);
    this.strip = document.createElement('div');
    this.strip.className = 'recognized-song';
    this.strip.hidden = true;
    this.strip.setAttribute('role', 'status');
    this.strip.setAttribute('aria-atomic', 'true');
    this.strip.innerHTML = '<div class="song-window"><span class="song-title"></span></div>';
    card.querySelector('.visual-content').after(this.strip);
    const query = selector => this.tools.querySelector(selector);
    this.control = document.createElement('div'); this.control.className = 'recognition-control';
    this.control.innerHTML = `<label class="setting-switch song-detection"><input type="checkbox" class="identify-song" aria-describedby="recognition-disclosure recognition-progress"><span>Identify song</span></label>
      <svg class="recognition-ring" viewBox="0 0 24 24" role="img" aria-label="Song identification off"><circle class="ring-track" cx="12" cy="12" r="9"/><circle class="ring-progress" cx="12" cy="12" r="9" pathLength="1"/></svg>
      <span id="recognition-progress" class="visually-hidden"></span><p class="recognition-status" role="status"></p>`;
    this.button = this.control.querySelector('.identify-song');
    const row = card.querySelector('.button-row'); row.insertBefore(this.control, row.querySelector('.listening-toggle').closest('.setting-switch').nextSibling);
    this.status = this.control.querySelector('.recognition-status');
    this.ring = this.control.querySelector('.recognition-ring');
    this.progress = this.control.querySelector('#recognition-progress');
    this.button.onchange = () => {
      this.enabled = this.button.checked;
      if (this.enabled) { this.status.textContent = ''; this.schedule(); }
      else this.cancel('');
    };
    query('.export-songs-csv').onclick = () => this.export('csv');
    query('.export-songs-json').onclick = () => this.export('json');
    this.onInput = ({ detail }) => { this.cancel(); this.input = detail; this.refresh(); };
    this.onSession = ({ detail }) => {
      this.playing = detail.state === 'playing' && detail.source === 'microphone';
      if (!this.playing) this.cancel();
      if (detail.state === 'stopped') this.input = null;
      if (['Ready to identify a song.', 'Turn on Listening to identify a song.'].includes(this.status.textContent)) this.status.textContent = '';
      this.refresh();
    };
    this.onVisibility = () => { if (document.hidden) this.cancel('Identification canceled when the page was hidden.'); };
    this.onStorage = () => { this.renderHistory(); this.refresh(); };
    card.addEventListener('recognition-input', this.onInput);
    card.addEventListener('audio-session', this.onSession);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('storage', this.onStorage);
    this.resize = new ResizeObserver(() => this.measureTitle());
    this.resize.observe(this.strip);
    this.resize.observe(this.strip.querySelector('.song-title'));
    this.cooldownTimer = setInterval(() => this.refresh(), 1000);
    this.renderHistory(); this.refresh();
  }

  endpoint() {
    const value = document.querySelector('meta[name="musical-lights-recognition"]')?.content;
    return recognitionEndpoint(value, location.href, document.baseURI);
  }

  refresh() {
    const supported = typeof MediaRecorder !== 'undefined';
    const remaining = this.cooldown.remaining();
    let phase = 'off', fraction = 0, description = 'Song identification off.';
    if (this.enabled) {
      phase = this.job?.phase ?? 'waiting';
      if (phase === 'capture') {
        fraction = Math.min(1, (performance.now() - this.job.captureAt) / SAMPLE_MS);
        description = 'Capturing ten seconds of microphone audio.';
      } else if (phase === 'upload') { fraction = 1; description = 'Identifying song.'; }
      else { fraction = 1 - Math.min(1, remaining / COOLDOWN_MS); description = remaining ? 'Waiting for the next song lookup.' : 'Ready for the next song lookup.'; }
    }
    // No live countdown announcements or spinning animation. Reduced Motion
    // receives the same discrete once-a-second progress updates.
    this.ring.dataset.phase = phase;
    this.ring.style.setProperty('--recognition-progress', fraction);
    this.ring.setAttribute('aria-label', description); this.progress.textContent = description;
    this.button.checked = this.enabled;
    this.button.disabled = !this.endpoint() || !supported || !this.input || !this.playing;
    this.button.title = !this.playing ? 'Turn on Listening, then identify the music.' : 'Identify microphone audio once per minute.';
    if (!this.job && !this.status.textContent) this.status.textContent = !this.endpoint()
      ? 'Song recognition is not configured yet.' : !supported ? 'Song recognition is unavailable in this browser.' : '';
    this.status.dataset.routine = String(['Song recognition is not configured yet.', 'Song recognition is unavailable in this browser.'].includes(this.status.textContent));

  }

  cancel(message = '') {
    this.enabled = false;
    clearTimeout(this.nextLookup);
    const job = this.job;
    this.job = null;
    if (job) {
      job.abort.abort();
      clearTimeout(job.captureTimer); clearTimeout(job.deadline);
      if (job.recorder?.state !== 'inactive') job.recorder?.stop();
      this.status.textContent = message;
    }
    this.refresh();
  }

  schedule() {
    clearTimeout(this.nextLookup);
    if (!this.enabled || this.closed || !this.playing || !this.input || this.job) return;
    // Start capture ten seconds before the next allowed upload so completed
    // lookups remain a minute apart. Recheck shared storage before dispatch.
    const delay = Math.max(0, this.cooldown.remaining() - SAMPLE_MS);
    this.nextLookup = setTimeout(() => this.identify(), delay);
    this.refresh();
  }

  async identify() {
    this.refresh();
    if (this.button.disabled || !this.enabled || this.job || this.closed) return;
    const endpoint = this.endpoint();
    const job = { abort: new AbortController(), sampleStartedAt: new Date().toISOString(), phase: 'capture', captureAt: performance.now() };
    this.job = job;
    this.status.textContent = ''; this.refresh();
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
      // Another tab may have uploaded while this recording was in progress.
      const remaining = this.cooldown.remaining();
      if (remaining > 0) {
        job.phase = 'waiting'; this.refresh();
        await new Promise((resolve, reject) => {
          job.captureTimer = setTimeout(resolve, remaining);
          job.abort.signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
        });
        if (this.job !== job) return;
        if (this.cooldown.remaining() > 0) return; // A newer tab lookup: reschedule, never overspend.
      }
      job.phase = 'upload'; this.refresh();
      job.deadline = setTimeout(() => job.abort.abort(), 25_000);
      // An upload may spend a lookup even if it fails or is canceled later.
      // Canceled recordings never reach this point and consume no cooldown.
      const upload = () => {
        if (this.job !== job || job.abort.signal.aborted || this.cooldown.remaining() > 0) return null;
        this.cooldown.start(); this.refresh();
        return fetch(endpoint, { method: 'POST', body: blob, signal: job.abort.signal, credentials: 'omit', cache: 'no-store' });
      };
      // Serialize cooldown reservation across tabs where Web Locks is available.
      // Shared storage is checked again inside the lock, immediately before spend.
      const locks = globalThis.navigator?.locks;
      const response = locks ? await locks.request('musical-lights-recognition-upload', { signal: job.abort.signal }, upload) : await upload();
      if (!response) return;
      if (!response.ok) throw new Error(({ 429: 'Too many requests. Wait a minute and try again.', 503: 'Song recognition is not configured yet.', 413: 'Audio sample is too large.' })[response.status] ?? 'Recognition failed. Try again when ready.');
      const { result } = await response.json();
      if (this.job !== job || this.closed) return;
      if (result === null) { this.status.textContent = 'No song recognized. Try again during a clearer part of the song.'; return; }
      if (!validSong(result)) throw new Error('The recognition service returned an invalid song.');
      const entry = { id: crypto.randomUUID(), provider: 'AudD', artist: result.artist, title: result.title, album: result.album ?? '',
        sampleStartedAt: job.sampleStartedAt, sampleEndedAt: job.sampleEndedAt, recognizedAt: new Date().toISOString() };
      this.history.add(entry); this.renderHistory();
      this.showSong(entry);
      this.status.textContent = '';
    } catch (error) {
      if (this.job === job && !this.closed) {
        this.enabled = false;
        this.status.textContent = `${error.name === 'AbortError' ? 'Recognition timed out.' : error.message} Song identification turned off.`;
      }
    } finally {
      clearTimeout(job.captureTimer); clearTimeout(job.deadline);
      if (job.recorder && job.recorder.state !== 'inactive') job.recorder.stop();
      if (this.job === job) { this.job = null; this.refresh(); this.schedule(); }
    }
  }

  showSong(entry) {
    const text = `${entry.artist} — ${entry.title}`;
    const title = this.strip.querySelector('.song-title');
    const changed = title.textContent !== text;
    if (changed) title.textContent = text;
    this.strip.hidden = false;
    this.strip.title = `${text} · ${new Date(entry.sampleStartedAt).toLocaleString()}`;
    this.measureTitle();
    // Each new song starts at the left edge, then travels continuously left.
    // Repeated recognition of the same song keeps its current scrolling phase.
    if (changed) title.getAnimations().forEach(animation => { animation.currentTime = 0; });
  }

  measureTitle() {
    const title = this.strip.querySelector('.song-title');
    const width = title.parentElement.clientWidth;
    const textWidth = title.scrollWidth;
    const pixelsPerSecond = 45;
    this.strip.style.setProperty('--song-entry', `${width}px`);
    this.strip.style.setProperty('--song-travel', `-${textWidth}px`);
    this.strip.style.setProperty('--song-duration', `${(width + textWidth) / pixelsPerSecond}s`);
    this.strip.style.setProperty('--song-delay', `-${width / pixelsPerSecond}s`);
    this.strip.classList.toggle('song-overflow', textWidth > width);
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
    clearInterval(this.cooldownTimer);
    this.card.removeEventListener('recognition-input', this.onInput);
    this.card.removeEventListener('audio-session', this.onSession);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('storage', this.onStorage);
    this.resize.disconnect(); this.control.remove(); this.tools.remove(); this.strip.remove();
  }
}
