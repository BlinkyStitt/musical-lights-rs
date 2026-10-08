// Browser presentation only. Acoustic decisions and flight math live in core.
export const SETTINGS_KEY = 'musical-lights-display-v1';
export const DEFAULT_SETTINGS = Object.freeze({ version: 1, directionOdds: Object.freeze([60, 200, .05, .5, 1]), flight: 30,
  cameraMotion: true, cameraAngle: 0, mirrorCount: 3, scrolling: true, youtubeLink: '' });
export function readSettings(storage) {
  const defaults = { ...DEFAULT_SETTINGS, directionOdds: [...DEFAULT_SETTINGS.directionOdds] };
  try {
    const saved = JSON.parse(storage.getItem(SETTINGS_KEY));
    if (saved?.version !== 1) return defaults;
    for (const [key, min, max] of [['flight', 0, 50], ['cameraAngle', -40, 40]]) {
      if (Number.isFinite(saved[key]) && saved[key] >= min && saved[key] <= max) defaults[key] = saved[key];
    }
    if (validDirectionOdds(saved.directionOdds)) defaults.directionOdds = [...saved.directionOdds];
    if (Number.isInteger(saved.mirrorCount) && saved.mirrorCount >= 0 && saved.mirrorCount <= 17) defaults.mirrorCount = saved.mirrorCount;
    for (const key of ['cameraMotion', 'scrolling']) if (typeof saved[key] === 'boolean') defaults[key] = saved[key];
    if (typeof saved.youtubeLink === 'string' && saved.youtubeLink.length <= 2048) defaults.youtubeLink = saved.youtubeLink;
    if (Array.isArray(saved.physics) && saved.physics.length === 8 && saved.physics.every((v, i) => Number.isFinite(v) && v >= [[.4, 20], [0, 30], [1, 20000], [0, 1], [0, 2], [.2, 2], [.04, 2], [.32, 4]][i][0] && v <= [[.4, 20], [0, 30], [1, 20000], [0, 1], [0, 2], [.2, 2], [.04, 2], [.32, 4]][i][1])) defaults.physics = saved.physics;
  } catch { /* Private browsing still has session settings. */ }
  return defaults;
}
export function validDirectionOdds(v) {
  return Array.isArray(v) && v.length === 5 && v.every(Number.isFinite)
    && v[0] >= 60 && v[1] <= 200 && v[0] < v[1]
    && v[2] >= 0 && v[3] <= 1 && v[2] <= v[3] && v[4] >= .25 && v[4] <= 4;
}
export function parseYouTube(value) {
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a YouTube video link.');
  const host = url.hostname.toLowerCase(), parts = url.pathname.split('/').filter(Boolean);
  let id;
  if (host === 'youtu.be') id = parts[0];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(host)) {
    id = parts[0] === 'watch' ? url.searchParams.get('v') : ['shorts', 'embed', 'live'].includes(parts[0]) ? parts[1] : null;
  }
  if (!/^[\w-]{11}$/.test(id ?? '')) throw new Error('Use a link to one YouTube video.');
  const time = url.searchParams.get('t') ?? url.searchParams.get('start') ?? '0';
  let start = /^\d+$/.test(time) ? Number(time) : 0;
  if (/^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/.test(time)) {
    const match = time.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    start = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  }
  return { id, start: Math.min(86400, start) };
}
let playerAPI;
function youtubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (playerAPI) return playerAPI;
  playerAPI = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    const timer = setTimeout(() => { playerAPI = null; reject(new Error('YouTube did not load. Try again.')); }, 10000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); previous?.(); resolve(window.YT); };
    const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => { clearTimeout(timer); playerAPI = null; script.remove(); reject(new Error('Cannot load YouTube. Check your connection.')); };
    document.head.append(script);
  });
  return playerAPI;
}
const explanations = {
  'listening-toggle': 'Listening uses your microphone to drive the lights. It does not play the microphone through your speakers.',
  'identify-song': 'While enabled, Identify song uploads a 10-second microphone recording at most once per minute. Turn it off to cancel. Recognition is separate from YouTube playback.',
  'motion-button': 'Phone motion lets measured tilt and shaking move the balls. It needs a separate sensor permission and works independently of Listening.',
  'scroll-lights': 'Scroll lights moves the bands at two columns per beat. Only a new attack above the recent loudness peak can change direction. The default chance rises from 5% at 60 BPM to 50% at 200 BPM; Advanced Display settings control the thresholds, odds and curve. Reduced Motion disables automatic movement.',
};
export class Presentation {
  constructor(card) {
    this.card = card; this.closed = false; this.generation = 0; this.removers = [];
    try { this.storage = localStorage; } catch { /* Session-only settings. */ }
    this.settings = card.preferences = readSettings(this.storage);
    this.originalAudioType = navigator.audioSession?.type;
    this.microphoneActive = false; this.videoPlaying = false;
    this.row = card.querySelector('.button-row'); this.panel = card.querySelector('.video-panel');
    this.panel.innerHTML = `<form class="video-form"><label>YouTube link<input class="youtube-link" type="url" placeholder="https://youtu.be/…" maxlength="2048" /></label><button type="submit">Load video</button><button type="button" class="remove-video">Remove video</button></form><div class="youtube-frame"></div><p class="youtube-status" role="status"></p>`;
    this.videoButton = document.createElement('button'); this.videoButton.type = 'button'; this.videoButton.className = 'video-button'; this.videoButton.textContent = 'Video';
    this.videoButton.setAttribute('aria-expanded', 'false'); this.row.insertBefore(this.videoButton, this.row.querySelector('.fullscreen-button'));
    this.listen(this.videoButton, 'click', () => { this.panel.hidden = false; this.card.classList.add('video-active', 'video-editing'); this.videoButton.setAttribute('aria-expanded', 'true'); this.panel.querySelector('input').focus(); });
    this.listen(this.panel.querySelector('form'), 'submit', event => { event.preventDefault(); this.loadVideo(this.panel.querySelector('input').value); });
    this.listen(this.panel.querySelector('.remove-video'), 'click', () => { this.generation++; this.player?.destroy(); this.player = null; this.videoPlaying = false; this.updateAudioType(); this.panel.hidden = true; this.card.classList.remove('video-active', 'video-editing'); this.videoButton.setAttribute('aria-expanded', 'false'); this.settings.youtubeLink = ''; this.panel.querySelector('input').value = ''; this.save(); });
    this.panel.querySelector('input').value = this.settings.youtubeLink;
    this.popup = document.createElement('div'); this.popup.id = 'control-help'; this.popup.className = 'control-help'; this.popup.hidden = true; this.popup.setAttribute('role', 'tooltip'); card.append(this.popup);
    this.enhanceControls();
    this.observer = new MutationObserver(() => this.enhanceControls()); this.observer.observe(this.row, { childList: true, subtree: true });
    this.listen(document, 'pointerdown', event => { if (!this.popup.contains(event.target) && !this.anchor?.contains(event.target)) this.hideHelp(); });
    this.listen(document, 'keydown', event => { if (event.key === 'Escape' && !this.popup.hidden) { event.preventDefault(); event.stopImmediatePropagation(); this.hideHelp(); } }, true);
    this.listen(window, 'scroll', () => this.positionHelp(), { passive: true });
    this.listen(window, 'resize', () => this.positionHelp());
    this.listen(card, 'audio-session', ({ detail }) => { this.microphoneActive = detail.source === 'microphone' && !['stopped', 'ended'].includes(detail.state); this.updateAudioType(); if (this.anchor?.dataset.help === 'listening-toggle') this.showHelp(this.anchor, 'listening-toggle'); });
    this.listen(card, 'microphone-access', ({ detail }) => { this.permission = detail; });
    for (const [selector, key, checkbox] of [['.flight-height', 'flight'], ['.mirror-count', 'mirrorCount'], ['.camera-motion', 'cameraMotion', true], ['.scroll-lights', 'scrolling', true]]) {
      const node = card.querySelector(selector); if (!node) continue;
      if (checkbox) node.checked = this.settings[key]; else node.value = this.settings[key];
      if (key === 'scrolling') node.dispatchEvent(new Event('change', { bubbles: true }));
      this.listen(node, 'change', () => { const value = checkbox ? node.checked : Number(node.value); if (!checkbox && (!node.validity.valid || !Number.isFinite(value))) return; this.settings[key] = value; this.save(); });
    }
    this.oddsInputs = ['.direction-slow-bpm', '.direction-fast-bpm', '.direction-low-chance', '.direction-high-chance', '.direction-curve'].map(s => card.querySelector(s));
    const writeOdds = () => this.oddsInputs.forEach((node, i) => { node.value = this.settings.directionOdds[i] * (i === 2 || i === 3 ? 100 : 1); });
    writeOdds();
    for (const node of this.oddsInputs) this.listen(node, 'change', () => {
      const odds = this.oddsInputs.map((n, i) => Number(n.value) / (i === 2 || i === 3 ? 100 : 1));
      const valid = this.oddsInputs.every(n => n.validity.valid && n.value !== '') && validDirectionOdds(odds);
      card.querySelector('.direction-error').textContent = valid ? '' : 'Use increasing BPM thresholds from 60 to 200, increasing odds from 0 to 100%, and a curve from 0.25 to 4.';
      if (valid) { this.settings.directionOdds = odds; this.save(); }
    });
    card.querySelector('.camera-rotation').value = this.settings.cameraAngle;
    this.listen(card.querySelector('.display-reset'), 'click', () => { Object.assign(this.settings, { directionOdds: [...DEFAULT_SETTINGS.directionOdds], flight: 30, cameraMotion: true, cameraAngle: 0, mirrorCount: DEFAULT_SETTINGS.mirrorCount, scrolling: true }); for (const [sel, key] of [['.flight-height', 'flight'], ['.camera-rotation', 'cameraAngle'], ['.mirror-count', 'mirrorCount']]) card.querySelector(sel).value = this.settings[key]; card.querySelector('.camera-motion').checked = true; writeOdds(); card.querySelector('.direction-error').textContent = ''; this.save(); card.dispatchEvent(new CustomEvent('camera-reset')); });
    this.save(false);
    if (this.settings.youtubeLink) this.loadVideo(this.settings.youtubeLink);
    card.presentation = this;
  }
  listen(target, type, callback, options) { target.addEventListener(type, callback, options); this.removers.push(() => target.removeEventListener(type, callback, options)); }
  save(persist = true) { if (persist) { try { this.storage?.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* Session settings remain usable. */ } } this.card.dispatchEvent(new CustomEvent('display-settings', { detail: this.settings })); }
  updateAudioType() {
    if (!navigator.audioSession) return;
    try { navigator.audioSession.type = this.microphoneActive ? 'play-and-record' : this.videoPlaying ? 'playback' : this.originalAudioType ?? 'auto'; } catch { /* Physical mobile acceptance is still required. */ }
  }
  enhanceControls() {
    for (const [className, text] of Object.entries(explanations)) {
      const input = this.row.querySelector('.' + className); const span = input?.closest('.setting-switch')?.querySelector('span');
      if (!span || span.dataset.help) continue;
      span.dataset.help = className; span.setAttribute('role', 'button'); span.tabIndex = 0; span.setAttribute('aria-expanded', 'false');
      this.listen(span, 'pointerenter', event => { if (event.pointerType === 'mouse') this.showHelp(span, className); });
      this.listen(span, 'pointerleave', event => { if (event.pointerType === 'mouse' && !this.popup.matches(':hover') && document.activeElement !== span) this.hideHelp(); });
      this.listen(span, 'focus', () => this.showHelp(span, className));
      this.listen(span, 'blur', () => this.hideHelp());
      this.listen(span, 'click', event => { event.preventDefault(); event.stopPropagation(); this.showHelp(span, className); });
      this.listen(span, 'keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); this.showHelp(span, className); } });
      span.dataset.explanation = text;
    }
    for (const button of [this.videoButton, this.row.querySelector('.fullscreen-button')]) {
      if (button.dataset.help) continue;
      button.dataset.help = 'action';
      this.listen(button, 'pointerenter', event => { if (event.pointerType === 'mouse') this.showHelp(button, button === this.videoButton ? 'video' : 'fullscreen'); });
      this.listen(button, 'focus', () => this.showHelp(button, button === this.videoButton ? 'video' : 'fullscreen'));
      this.listen(button, 'blur', () => this.hideHelp());
      this.listen(button, 'pointerleave', () => this.hideHelp());
      this.listen(button, 'click', () => this.hideHelp());
    }
  }
  showHelp(anchor, key) {
    this.hideHelp(); this.anchor = anchor; anchor.setAttribute('aria-describedby', this.popup.id); anchor.setAttribute('aria-expanded', 'true');
    const state = this.card.dataset.audioState ?? 'off';
    this.popup.textContent = key === 'listening-toggle' ? `${explanations[key]} Microphone: ${this.microphoneActive ? state : 'off'}. Permission: ${this.permission ?? this.card.querySelector('.microphone-permission')?.dataset.state ?? 'not requested'}. ${this.card.querySelector('.mic-session-status')?.textContent ?? ''}` : (explanations[key] ? explanations[key] + (key === 'identify-song' ? ' ' + this.card.querySelector('.recognition-status').textContent : '') : null) ?? (key === 'video' ? 'Paste a YouTube link to play a video. Listening must hear the speakers for the lights to follow its audio.' : 'Show video, lights, and controls together. Use Exit fullscreen or Escape to return.');
    this.popup.hidden = false; this.positionHelp();
  }
  positionHelp() {
    if (this.popup.hidden || !this.anchor) return;
    const rect = this.anchor.getBoundingClientRect(); const width = Math.min(300, innerWidth - 24);
    this.popup.style.width = width + 'px'; this.popup.style.left = Math.max(12, Math.min(innerWidth - width - 12, rect.left)) + 'px';
    const height = this.popup.getBoundingClientRect().height;
    this.popup.style.top = Math.max(12, Math.min(innerHeight - height - 12, rect.top > height + 20 ? rect.top - height - 8 : rect.bottom + 8)) + 'px';
  }
  hideHelp() { this.popup.hidden = true; this.anchor?.removeAttribute('aria-describedby'); this.anchor?.setAttribute('aria-expanded', 'false'); this.anchor = null; }
  async loadVideo(link) {
    const status = this.panel.querySelector('.youtube-status');
    let video; try { video = parseYouTube(link); } catch (error) { status.textContent = error.message; return; }
    const generation = ++this.generation;
    this.panel.hidden = false; this.card.classList.add('video-active'); this.videoButton.setAttribute('aria-expanded', 'true'); status.textContent = 'Loading YouTube…';
    try {
      const YT = await youtubeAPI(); if (this.closed || generation !== this.generation) return;
      this.player?.destroy(); this.videoPlaying = false; this.updateAudioType();
      const host = document.createElement('iframe'); host.title = 'YouTube video player';
      host.setAttribute('credentialless', ''); host.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen'); host.setAttribute('allowfullscreen', '');
      host.referrerPolicy = 'strict-origin-when-cross-origin';
      const embed = new URL('https://www.youtube-nocookie.com/embed/' + video.id);
      for (const [key, value] of Object.entries({ enablejsapi: 1, origin: location.origin, playsinline: 1, controls: 1, autoplay: 0, start: video.start })) embed.searchParams.set(key, value);
      host.src = embed.href; this.panel.querySelector('.youtube-frame').replaceChildren(host);
      this.card.classList.remove('video-editing');
      this.player = new YT.Player(host, { host: 'https://www.youtube-nocookie.com', videoId: video.id,
        playerVars: { origin: location.origin, playsinline: 1, controls: 1, autoplay: 0, start: video.start }, events: {
          onReady: ({ target }) => { if (this.closed || generation !== this.generation) { target.destroy(); return; } status.textContent = ''; this.panel.querySelector('iframe')?.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin'); },
          onStateChange: ({ data }) => { if (this.closed || generation !== this.generation) return; this.videoPlaying = data === 1; if (data === 1 && this.card.dataset.audioSource && this.card.dataset.audioSource !== 'microphone') { const source = this.card.querySelector('.input-source'); if (source) source.value = 'microphone'; this.card.dispatchEvent(new CustomEvent('review-input', { detail: { source: 'microphone', play: false } })); } this.updateAudioType(); },
          onError: ({ data }) => { if (this.closed || generation !== this.generation) return; status.textContent = ({ 100: 'This video is unavailable.', 101: 'This video does not allow embedding.', 150: 'This video does not allow embedding.', 153: 'YouTube could not identify this page. Reload and try again.' })[data] ?? 'YouTube playback failed. Try another video.'; this.videoPlaying = false; this.updateAudioType(); },
        } });
      this.settings.youtubeLink = link; this.save();
    } catch (error) { if (!this.closed && generation === this.generation) status.textContent = error.message; }
  }
  close() { this.closed = true; this.generation++; this.observer.disconnect(); for (const remove of this.removers) remove(); this.player?.destroy(); this.hideHelp(); this.microphoneActive = this.videoPlaying = false; this.updateAudioType(); this.popup.remove(); delete this.card.presentation; }
}
