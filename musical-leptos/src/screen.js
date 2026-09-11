// Browser-owned screen resources follow the visualizer view, including requests
// that finish after the view closes or the tab changes visibility.
export class VisualizerScreen {
  constructor(element, onChange, onBand) {
    this.element = element;
    this.document = element.ownerDocument;
    this.window = this.document.defaultView;
    this.navigator = this.window.navigator;
    this.orientation = this.window.screen?.orientation;
    this.onChange = onChange;
    this.onBand = onBand;
    this.closed = false;
    this.lock = null;
    this.lockRelease = null;
    this.requestingLock = false;
    this.changingFullscreen = false;
    this.pendingFullscreenToggle = false;
    this.expanded = false;
    this.pageScrollY = 0;
    this.swipe = null;
    this.topTapHeight = 64;
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
    this.onFullscreen = () => this.setExpanded(this.document.fullscreenElement === this.element);
    this.onViewportChange = () => this.clearGesture();
    this.onKey = event => {
      if (event.key === 'Escape' && this.expanded) {
        event.preventDefault();
        this.toggleFullscreen();
      }
    };
    this.onPointerDown = event => {
      this.clearGesture();
      const touch = event.pointerType !== 'mouse';
      if (this.expanded && event.isPrimary && event.button === 0
          && event.target?.closest?.('.fullscreen-button')) {
        // Close before iOS finishes the tap. Otherwise Safari can re-hit-test
        // the same tap against the page revealed below the fullscreen view.
        event.preventDefault();
        this.toggleFullscreen();
        return;
      }
      if (this.expanded && event.isPrimary && event.button === 0
          && event.clientY <= this.topTapHeight) {
        // iOS may not deliver a complete captured drag after a viewport
        // gesture. Keep a direct, reliable touch target for leaving the view.
        event.preventDefault();
        this.toggleFullscreen(true);
        return;
      }
      if ((this.expanded || touch) && event.isPrimary && event.button === 0
          && this.element.contains(event.target)
          && !event.target.closest('button, input, summary')) {
        const band = event.target.closest('[role="meter"]');
        if (!this.expanded && !band) return;
        const index = band ? [...this.element.querySelectorAll('[role="meter"]')].indexOf(band) : -1;
        this.swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, touch, band: index, moved: false };
        if (touch) this.onBand(null);
        // Retain the gesture when the finger crosses a band or its animated fill.
        this.element.setPointerCapture(event.pointerId);
      }
    };
    this.onPointerMove = event => {
      const swipe = this.swipe;
      if (!swipe || event.pointerId !== swipe.id) return;
      const down = event.clientY - swipe.y;
      const across = Math.abs(event.clientX - swipe.x);
      if (Math.hypot(across, down) > 10) swipe.moved = true;
      if (this.expanded && down >= 80 && down > across * 1.5) {
        this.clearGesture();
        this.toggleFullscreen();
      }
    };
    this.onPointerUp = event => {
      this.onPointerMove(event);
      const swipe = this.swipe;
      if (!swipe || event.pointerId !== swipe.id) return;
      this.clearGesture();
      if (swipe.touch && !swipe.moved && swipe.band >= 0) this.onBand(swipe.band);
    };
    this.onPointerCancel = () => this.clearGesture();
    this.onTouchStart = event => {
      if (!this.expanded || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (touch.clientY <= this.topTapHeight) {
        // Safari can omit the matching pointer stream during viewport changes.
        // Capture the native touch before closing, so it cannot activate the
        // page underneath the fullscreen view.
        event.preventDefault();
        event.stopPropagation();
        this.toggleFullscreen(true);
      }
    };
    this.onTouchEnd = event => {
      if (!this.expanded || !event.changedTouches.length) return;
      const target = event.target;
      if (!target?.closest?.('.fullscreen-button')) return;
      event.preventDefault();
      event.stopPropagation();
      if (!this.changingFullscreen) this.toggleFullscreen();
    };
    this.document.addEventListener('visibilitychange', this.onVisibility);
    this.document.addEventListener('fullscreenchange', this.onFullscreen);
    this.document.addEventListener('keydown', this.onKey);
    this.document.addEventListener('pointerdown', this.onPointerDown, true);
    this.document.addEventListener('pointermove', this.onPointerMove);
    this.document.addEventListener('pointerup', this.onPointerUp, true);
    this.document.addEventListener('pointercancel', this.onPointerCancel);
    this.document.addEventListener('touchstart', this.onTouchStart, { capture: true, passive: false });
    this.document.addEventListener('touchend', this.onTouchEnd, { capture: true, passive: false });
    this.element.addEventListener('lostpointercapture', this.onPointerCancel);
    this.window.addEventListener?.('resize', this.onViewportChange);
    this.window.addEventListener?.('orientationchange', this.onViewportChange);
    this.window.visualViewport?.addEventListener?.('resize', this.onViewportChange);
    this.orientation?.addEventListener?.('change', this.onViewportChange);
    this.acquireLock();
  }

  clearGesture() {
    const swipe = this.swipe;
    this.swipe = null;
    if (swipe && this.element.hasPointerCapture(swipe.id)) this.element.releasePointerCapture(swipe.id);
  }

  emit() {
    if (this.closed) return;
    this.onChange(
      this.awake,
      this.expanded,
      this.error,
    );
  }

  setExpanded(expanded) {
    const wasExpanded = this.expanded;
    this.expanded = expanded;
    this.clearGesture();
    this.element.toggleAttribute('data-expanded', expanded);
    this.emit();
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

  async toggleFullscreen(deferExit = false) {
    if (this.closed) return;
    if (this.changingFullscreen) {
      this.pendingFullscreenToggle = true;
      return;
    }
    this.changingFullscreen = true;
    this.error = '';
    try {
      if (this.expanded) {
        // Let iOS finish the button activation while this element still owns
        // the touch. Otherwise Safari can dispatch the same tap to revealed
        // content after the fullscreen DOM changes.
        if (deferExit && typeof this.window.setTimeout === 'function') {
          await new Promise(resolve => this.window.setTimeout(resolve, 300));
        }
        const nativeExit = this.document.fullscreenElement === this.element
          ? this.document.exitFullscreen()
          : null;
        // Publish the page state before waiting for Safari's native fullscreen
        // promise. This keeps the restored controls usable immediately.
        this.setExpanded(false);
        this.window.scrollTo?.(0, this.pageScrollY);
        this.changingFullscreen = false;
        if (nativeExit) await nativeExit;
      } else {
        // The lights-only view is the action on every browser. Native
        // fullscreen additionally hides browser chrome where supported.
        this.pageScrollY = this.window.scrollY;
        this.setExpanded(true);
        if (this.document.fullscreenEnabled && typeof this.element.requestFullscreen === 'function') {
          // Keep the request within the button's user gesture.
          await this.element.requestFullscreen().catch(() => {});
        }
      }
      if (this.closed && this.document.fullscreenElement === this.element) {
        await this.document.exitFullscreen();
      }
    } catch {
      this.error = 'Could not exit fullscreen. Use the browser’s fullscreen control.';
    } finally {
      this.changingFullscreen = false;
      this.emit();
      if (!this.closed && this.pendingFullscreenToggle) {
        this.pendingFullscreenToggle = false;
        this.toggleFullscreen();
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.document.removeEventListener('visibilitychange', this.onVisibility);
    this.document.removeEventListener('fullscreenchange', this.onFullscreen);
    this.document.removeEventListener('keydown', this.onKey);
    this.document.removeEventListener('pointerdown', this.onPointerDown, true);
    this.document.removeEventListener('pointermove', this.onPointerMove);
    this.document.removeEventListener('pointerup', this.onPointerUp, true);
    this.document.removeEventListener('pointercancel', this.onPointerCancel);
    this.document.removeEventListener('touchstart', this.onTouchStart, { capture: true, passive: false });
    this.document.removeEventListener('touchend', this.onTouchEnd, { capture: true, passive: false });
    this.element.removeEventListener('lostpointercapture', this.onPointerCancel);
    this.window.removeEventListener?.('resize', this.onViewportChange);
    this.window.removeEventListener?.('orientationchange', this.onViewportChange);
    this.window.visualViewport?.removeEventListener?.('resize', this.onViewportChange);
    this.orientation?.removeEventListener?.('change', this.onViewportChange);
    this.setExpanded(false);
    this.releaseLock();
    if (this.document.fullscreenElement === this.element) {
      this.document.exitFullscreen().catch(() => {});
    }
    this.onChange = null;
    this.onBand = null;
  }
}
