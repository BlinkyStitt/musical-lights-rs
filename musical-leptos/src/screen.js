// Browser-owned screen resources follow the visualizer view, including requests
// that finish after the view closes or the tab changes visibility.
export class VisualizerScreen {
  constructor(element, onChange, onBand) {
    this.element = element;
    this.document = element.ownerDocument;
    this.window = this.document.defaultView;
    // Fullscreen UA rules force its target upright. A per-view outer surface
    // leaves the card rotatable and keeps pending requests owned by this view.
    this.fullscreenTarget = element.closest?.('.visualizer-screen') ?? element;
    this.navigator = this.window.navigator;
    this.orientation = this.window.screen?.orientation;
    this.onChange = onChange;
    this.onBand = onBand;
    this.closed = false;
    this.lock = null;
    this.lockRelease = null;
    this.requestingLock = false;
    this.changingFullscreen = false;
    this.pendingFullscreenState = null;
    this.expanded = false;
    this.element.displayQuarterTurn = 0;
    this.pageScrollY = 0;
    this.swipe = null;
    this.suppressedFullscreenPointer = null;
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
    this.onFullscreen = () => {
      // Native events can arrive after their promise and during the next
      // transition. Only idle events represent an external browser change.
      if (!this.changingFullscreen) this.setExpanded(this.document.fullscreenElement === this.fullscreenTarget);
    };
    this.onViewportChange = () => this.clearGesture();
    // End the expanded view while it still belongs to the document, before
    // the router removes it during Back/Forward navigation.
    this.onNavigation = () => this.toggleFullscreen(false, false);
    this.onKey = event => {
      // The restored controls can queue an entry before a native exit finishes.
      // Escape cancels that request even while the page is already visible.
      if (event.key === 'Escape' && !event.defaultPrevented
          && !event.target?.closest?.('dialog[open]')
          && (this.expanded || this.pendingFullscreenState === true)) {
        event.preventDefault();
        this.toggleFullscreen(false, false);
      }
    };
    this.onPointerDown = event => {
      this.suppressedFullscreenPointer = null;
      this.clearGesture();
      const touch = event.pointerType !== 'mouse';
      const fullscreenButton = event.target?.closest?.('.fullscreen-button');
      if (this.expanded && event.isPrimary && event.button === 0
          && fullscreenButton) {
        // Close before iOS finishes the tap. Otherwise Safari can re-hit-test
        // the same tap against the page revealed below the fullscreen view.
        event.preventDefault();
        this.suppressedFullscreenPointer = { button: fullscreenButton, id: event.pointerId };
        this.toggleFullscreen();
        return;
      }
      if (this.expanded && event.isPrimary && event.button === 0
          && !this.element.classList.contains('video-active')
          && !this.element.classList.contains('video-editing')
          && this.point(event).y <= this.topTapHeight
          && event.target?.closest?.('#dancinglights')
          && !event.target?.closest?.('button, input, label, summary')) {
        // iOS may not deliver a complete captured drag after a viewport
        // gesture. Keep a direct, reliable touch target for leaving the view.
        event.preventDefault();
        this.toggleFullscreen(true);
        return;
      }
      if ((this.expanded || touch) && event.isPrimary && event.button === 0
          && this.element.contains(event.target)
          && (!this.expanded || event.target.closest('#dancinglights'))
          && !event.target.closest('button, input, label, summary, .video-panel, .control-help, [role=button]')) {
        const band = event.target.closest('[data-source-band], [role="meter"]');
        if (!this.expanded && !band) return;
        const index = band ? Number(band.dataset.sourceBand ?? [...this.element.querySelectorAll('[role="meter"]')].indexOf(band)) : -1;
        this.swipe = { id: event.pointerId, ...this.point(event), touch, band: index, moved: false };
        if (touch) this.onBand(null);
        // Retain the gesture when the finger crosses a band or its animated fill.
        this.element.setPointerCapture(event.pointerId);
      }
    };
    this.onClick = event => {
      const pointer = this.suppressedFullscreenPointer;
      this.suppressedFullscreenPointer = null;
      // A touch click can be retargeted onto the revealed page after Exit.
      // Consume that same pointer stream even when it now hits a link. Safari
      // MouseEvents without an ID can only be matched to the original button.
      const suppress = pointer && event.detail !== 0
        && (event.pointerId > 0 ? event.pointerId === pointer.id
          : event.target?.closest?.('.fullscreen-button') === pointer.button);
      if (suppress) {
        // Pointer-down already exited. The compact bar keeps the restored
        // entry button under the pointer; consuming this click prevents re-entry.
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    this.onPointerMove = event => {
      const swipe = this.swipe;
      if (!swipe || event.pointerId !== swipe.id) return;
      const point = this.point(event);
      const down = point.y - swipe.y;
      const across = Math.abs(point.x - swipe.x);
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
    this.onPointerCancel = () => {
      this.suppressedFullscreenPointer = null;
      this.clearGesture();
    };
    // Normal implicit capture release precedes the compatibility click; it
    // ends a band gesture but must still let Exit consume its own click.
    this.onLostPointerCapture = () => this.clearGesture();
    this.onTouchStart = event => {
      if (!this.expanded || event.touches.length !== 1) return;
      // Recognition controls share the top tap area with Exit fullscreen.
      // Preserve their native touch/click activation instead of closing it.
      if (event.target?.closest?.('button, input, label, summary')
          && !event.target.closest('.fullscreen-button')) return;
      const touch = event.touches[0];
      if (!this.element.classList.contains('video-active') && !this.element.classList.contains('video-editing') && this.point(touch).y <= this.topTapHeight && event.target?.closest?.('#dancinglights')) {
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
    this.onRotate = () => {
      if (!this.expanded || this.closed) return;
      this.clearGesture();
      this.suppressedFullscreenPointer = null;
      this.element.displayQuarterTurn = (this.element.displayQuarterTurn + 1) % 4;
      this.element.setAttribute('data-display-rotation', this.element.displayQuarterTurn);
      this.rotationChanged();
    };
    this.element.addEventListener('rotate-display', this.onRotate);
    this.document.addEventListener('visibilitychange', this.onVisibility);
    this.document.addEventListener('fullscreenchange', this.onFullscreen);
    this.document.addEventListener('keydown', this.onKey);
    this.document.addEventListener('pointerdown', this.onPointerDown, true);
    this.document.addEventListener('click', this.onClick, true);
    this.document.addEventListener('pointermove', this.onPointerMove);
    this.document.addEventListener('pointerup', this.onPointerUp, true);
    this.document.addEventListener('pointercancel', this.onPointerCancel);
    this.document.addEventListener('touchstart', this.onTouchStart, { capture: true, passive: false });
    this.document.addEventListener('touchend', this.onTouchEnd, { capture: true, passive: false });
    this.document.addEventListener('touchcancel', this.onPointerCancel, true);
    this.element.addEventListener('lostpointercapture', this.onLostPointerCapture);
    this.window.addEventListener?.('popstate', this.onNavigation, true);
    this.window.addEventListener?.('resize', this.onViewportChange);
    this.window.addEventListener?.('orientationchange', this.onViewportChange);
    this.window.visualViewport?.addEventListener?.('resize', this.onViewportChange);
    this.orientation?.addEventListener?.('change', this.onViewportChange);
    if (this.window.matchMedia?.('(pointer: coarse) and (max-width: 900px)').matches) this.setExpanded(true);
    this.acquireLock();
  }

  point(event) {
    return this.expanded && this.element.getBoundingClientRect
      ? localPoint(this.element, event.clientX, event.clientY) : { x: event.clientX, y: event.clientY };
  }

  rotationChanged() {
    this.element.dispatchEvent(new Event('display-rotation'));
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
    const changed = expanded !== this.expanded;
    const entering = expanded && !this.expanded;
    this.expanded = expanded;
    this.clearGesture();
    this.element.toggleAttribute('data-expanded', expanded);
    if (changed) this.rotationChanged();
    if (entering) this.element.scrollTop = 0;
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

  async toggleFullscreen(deferExit = false, expanded = !this.expanded) {
    if (this.closed) return;
    if (this.changingFullscreen) {
      this.pendingFullscreenState = expanded;
      return;
    }
    this.changingFullscreen = true;
    this.error = '';
    try {
      if (!expanded) {
        // Let iOS finish the button activation while this element still owns
        // the touch. Otherwise Safari can dispatch the same tap to revealed
        // content after the fullscreen DOM changes.
        if (deferExit && typeof this.window.setTimeout === 'function') {
          await new Promise(resolve => this.window.setTimeout(resolve, 300));
        }
        const nativeExit = this.document.fullscreenElement === this.fullscreenTarget
          ? this.document.exitFullscreen()
          : null;
        // Publish the page state before waiting for Safari's native fullscreen
        // promise. This keeps the restored controls usable immediately.
        this.setExpanded(false);
        this.window.scrollTo?.(0, this.pageScrollY);
        if (nativeExit) await nativeExit;
      } else {
        // The lights-only view is the action on every browser. Native
        // fullscreen additionally hides browser chrome where supported.
        this.pageScrollY = this.window.scrollY;
        this.setExpanded(true);
        if (this.document.fullscreenEnabled && typeof this.fullscreenTarget.requestFullscreen === 'function') {
          // Keep the request within the button's user gesture.
          await this.fullscreenTarget.requestFullscreen().catch(() => {});
        }
      }
      if (this.closed && this.document.fullscreenElement === this.fullscreenTarget) {
        await this.document.exitFullscreen();
      }
    } catch {
      this.error = 'Could not exit fullscreen. Use the browser’s fullscreen control.';
    } finally {
      this.changingFullscreen = false;
      this.emit();
      if (!this.closed && this.pendingFullscreenState !== null) {
        const requested = this.pendingFullscreenState;
        this.pendingFullscreenState = null;
        if (requested !== this.expanded || (!requested && this.document.fullscreenElement === this.fullscreenTarget)) {
          this.toggleFullscreen(false, requested);
        }
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.element.removeEventListener('rotate-display', this.onRotate);
    this.document.removeEventListener('visibilitychange', this.onVisibility);
    this.document.removeEventListener('fullscreenchange', this.onFullscreen);
    this.document.removeEventListener('keydown', this.onKey);
    this.document.removeEventListener('pointerdown', this.onPointerDown, true);
    this.document.removeEventListener('click', this.onClick, true);
    this.document.removeEventListener('pointermove', this.onPointerMove);
    this.document.removeEventListener('pointerup', this.onPointerUp, true);
    this.document.removeEventListener('pointercancel', this.onPointerCancel);
    this.document.removeEventListener('touchstart', this.onTouchStart, { capture: true, passive: false });
    this.document.removeEventListener('touchend', this.onTouchEnd, { capture: true, passive: false });
    this.document.removeEventListener('touchcancel', this.onPointerCancel, true);
    this.element.removeEventListener('lostpointercapture', this.onLostPointerCapture);
    this.suppressedFullscreenPointer = null;
    this.window.removeEventListener?.('popstate', this.onNavigation, true);
    this.window.removeEventListener?.('resize', this.onViewportChange);
    this.window.removeEventListener?.('orientationchange', this.onViewportChange);
    this.window.visualViewport?.removeEventListener?.('resize', this.onViewportChange);
    this.orientation?.removeEventListener?.('change', this.onViewportChange);
    this.setExpanded(false);
    this.releaseLock();
    delete this.element.displayQuarterTurn;
    this.element.removeAttribute?.('data-display-rotation');
    if (this.document.fullscreenElement === this.fullscreenTarget) {
      this.document.exitFullscreen().catch(() => {});
    }
    this.onChange = null;
    this.onBand = null;
  }
}

// Browser-only display coordinates. CSS turns clockwise; scene Y points up.
export function displayTurn(card) {
  return card?.hasAttribute?.('data-expanded') ? (card.displayQuarterTurn ?? 0) : 0;
}

// Invert a quarter-turned element's physical bounds into its logical layout.
// Never use the transformed width/height as the renderer's layout dimensions.
export function localPoint(element, x, y, turn = displayTurn(element.closest?.('.audio-card') ?? element)) {
  const box = element.getBoundingClientRect();
  const u = (x - box.left) / box.width, v = (y - box.top) / box.height;
  const [a, b] = [[u, v], [v, 1 - u], [1 - u, 1 - v], [1 - v, u]][turn];
  return { x: a * element.clientWidth, y: b * element.clientHeight };
}

export function viewportBounds(card, viewport) {
  const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? card.ownerDocument.defaultView.innerWidth;
  const height = viewport?.height ?? card.ownerDocument.defaultView.innerHeight;
  const points = [localPoint(card, x, y), localPoint(card, x + width, y + height)];
  return { left: Math.min(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)),
    right: Math.max(...points.map(p => p.x)), bottom: Math.max(...points.map(p => p.y)) };
}

// Top-layer dialogs need their own transform and physical origin.
export function placeDialog(card, dialog, bounds) {
  const turn = displayTurn(card), w = card.clientWidth, h = card.clientHeight;
  const rect = card.getBoundingClientRect();
  const { left: x, top: y, width, height } = bounds;
  const [px, py] = [[x, y], [h - y, x], [w - x, h - y], [y, w - x]][turn];
  Object.assign(dialog.style, { inset: 'auto', margin: '0', left: `${rect.left + px}px`, top: `${rect.top + py}px`,
    width: `${width}px`, height: `${height}px`, maxWidth: 'none', maxHeight: 'none',
    transformOrigin: '0 0', transform: turn ? `rotate(${turn * 90}deg)` : 'none' });
}
