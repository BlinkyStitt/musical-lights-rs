// Browser-owned screen resources follow the visualizer view, including requests
// that finish after the view closes or the tab changes visibility.
export class VisualizerScreen {
  constructor(element, onChange) {
    this.element = element;
    this.document = element.ownerDocument;
    this.navigator = this.document.defaultView.navigator;
    this.onChange = onChange;
    this.closed = false;
    this.lock = null;
    this.lockRelease = null;
    this.requestingLock = false;
    this.changingFullscreen = false;
    this.visibility = 0;
    this.awake = 'Keeping screen awake…';
    this.error = '';
    this.onVisibility = () => {
      this.visibility++;
      if (this.document.hidden) {
        this.releaseLock();
        this.awake = 'Screen may sleep';
        this.emit();
      } else {
        this.acquireLock();
      }
    };
    this.onFullscreen = () => this.emit();
    this.document.addEventListener('visibilitychange', this.onVisibility);
    this.document.addEventListener('fullscreenchange', this.onFullscreen);
    this.acquireLock();
  }

  emit() {
    if (this.closed) return;
    this.onChange(
      this.awake,
      this.document.fullscreenElement === this.element,
      !!this.document.fullscreenEnabled && typeof this.element.requestFullscreen === 'function',
      this.error,
    );
  }

  async acquireLock() {
    if (this.closed || this.requestingLock || this.lock) return;
    if (typeof this.navigator.wakeLock?.request !== 'function') {
      this.awake = 'Screen wake lock unavailable';
      this.emit();
      return;
    }
    if (this.document.hidden) {
      this.awake = 'Screen may sleep';
      this.emit();
      return;
    }
    this.requestingLock = true;
    const visibility = this.visibility;
    this.awake = 'Keeping screen awake…';
    this.emit();
    try {
      const lock = await this.navigator.wakeLock.request('screen');
      if (this.closed || this.document.hidden || visibility !== this.visibility) {
        await lock.release();
        return;
      }
      if (lock.released) {
        this.awake = 'Screen may sleep';
        return;
      }
      this.lock = lock;
      this.lockRelease = () => {
        this.detachLock();
        this.awake = 'Screen may sleep';
        this.emit();
      };
      lock.addEventListener('release', this.lockRelease);
      this.awake = 'Screen stays awake';
    } catch {
      this.awake = 'Screen may sleep';
    } finally {
      this.requestingLock = false;
      this.emit();
      // A visibility change can invalidate an in-flight request. Try once for
      // the new visible state; a system rejection alone must not cause a loop.
      if (!this.closed && !this.document.hidden && visibility !== this.visibility) {
        this.acquireLock();
      }
    }
  }

  detachLock() {
    const lock = this.lock;
    if (lock) lock.removeEventListener('release', this.lockRelease);
    this.lock = null;
    this.lockRelease = null;
    return lock;
  }

  releaseLock() {
    const lock = this.detachLock();
    if (lock) lock.release().catch(() => {});
  }

  async toggleFullscreen() {
    if (this.closed || this.changingFullscreen) return;
    this.changingFullscreen = true;
    this.error = '';
    try {
      // Call before any await: entering fullscreen needs the button gesture.
      if (this.document.fullscreenElement === this.element) {
        await this.document.exitFullscreen();
      } else {
        await this.element.requestFullscreen();
      }
      if (this.closed && this.document.fullscreenElement === this.element) {
        await this.document.exitFullscreen();
      }
    } catch {
      this.error = 'Fullscreen is unavailable. You can keep using the visualizer here.';
    } finally {
      this.changingFullscreen = false;
      this.emit();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.document.removeEventListener('visibilitychange', this.onVisibility);
    this.document.removeEventListener('fullscreenchange', this.onFullscreen);
    this.releaseLock();
    if (this.document.fullscreenElement === this.element) {
      this.document.exitFullscreen().catch(() => {});
    }
    this.onChange = null;
  }
}
