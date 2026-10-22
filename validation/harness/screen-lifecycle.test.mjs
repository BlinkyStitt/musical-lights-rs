import { test } from 'node:test';
import { expect } from '@playwright/test';
import { VisualizerScreen } from '../../musical-leptos/src/screen.js';

function sentinel() {
  const lock = new EventTarget();
  lock.released = false;
  lock.releases = 0;
  lock.release = async () => {
    lock.releases++;
    lock.released = true;
    lock.dispatchEvent(new Event('release'));
  };
  return lock;
}

function environment(t, request = async () => sentinel()) {
  const document = new EventTarget();
  const changes = [];
  const requests = [];
  const orientation = new EventTarget();
  const window = Object.assign(new EventTarget(), {
    navigator: { wakeLock: { request: type => {
      requests.push(type);
      return request();
    } } },
    screen: { orientation },
  });
  document.hidden = false;
  document.fullscreenEnabled = true;
  document.fullscreenElement = null;
  document.defaultView = window;
  document.exitFullscreen = async () => {
    document.fullscreenElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  };
  const attributes = new Set();
  const element = Object.assign(new EventTarget(), { ownerDocument: document, hasPointerCapture: () => false, toggleAttribute: (name, enabled) => enabled ? attributes.add(name) : attributes.delete(name), requestFullscreen: async () => {
    document.fullscreenElement = element;
    document.dispatchEvent(new Event('fullscreenchange'));
  } });
  const screen = new VisualizerScreen(element, (awake, full, error) => changes.push({ awake, full, error }), () => {});
  t.after(() => screen.close());
  const visible = value => {
    document.hidden = !value;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  return { document, element, screen, changes, requests, visible, attributes, window, orientation };
}

test('screen lock follows visibility and closes without later callbacks', async t => {
  const locks = [];
  const env = environment(t, async () => { const lock = sentinel(); locks.push(lock); return lock; });
  await expect.poll(() => env.changes.at(-1).awake).toBe('Screen stays awake');
  expect(env.requests).toEqual(['screen']);
  env.visible(false);
  expect(locks[0].released).toBe(true);
  expect(env.changes.at(-1).awake).toBe('Screen may sleep');
  env.visible(true);
  await expect.poll(() => env.changes.at(-1).awake).toBe('Screen stays awake');
  expect(env.requests).toEqual(['screen', 'screen']);
  await locks[1].release(); // A system release must report the loss, not retry forever.
  expect(env.changes.at(-1).awake).toBe('Screen may sleep');
  expect(env.requests).toHaveLength(2);
  env.visible(false); env.visible(true);
  await expect.poll(() => locks.length).toBe(3);
  env.screen.close();
  expect(locks[2].released).toBe(true);
  const count = env.changes.length;
  env.visible(false); env.visible(true);
  env.document.dispatchEvent(new Event('fullscreenchange'));
  await Promise.resolve();
  expect(env.changes).toHaveLength(count);
  expect(env.requests).toHaveLength(3);
});

test('a rejected wake request leaves fullscreen available without retry loops', async t => {
  const env = environment(t, async () => { throw new DOMException('Power saving', 'NotAllowedError'); });
  await expect.poll(() => env.changes.at(-1).awake).toBe('Screen may sleep');
  expect(env.changes.at(-1).error).toBe('');
  await env.screen.toggleFullscreen();
  expect(env.changes.at(-1).full).toBe(true);
  expect(env.requests).toEqual(['screen']);
  env.screen.close();
});

test('late wake grants close immediately after the view closes', async t => {
  let resolve;
  const env = environment(t, () => new Promise(done => { resolve = done; }));
  env.screen.close();
  const count = env.changes.length;
  const lock = sentinel(); resolve(lock);
  await expect.poll(() => lock.releases).toBe(1);
  expect(env.changes).toHaveLength(count);
  expect(env.requests).toEqual(['screen']);
});

test('visibility changes during a pending wake request release the stale lock', async t => {
  const pending = [];
  const env = environment(t, () => new Promise(resolve => pending.push(resolve)));
  env.visible(false); env.visible(true);
  expect(env.requests).toHaveLength(1);
  const stale = sentinel(); pending[0](stale);
  await expect.poll(() => env.requests.length).toBe(2);
  expect(stale.releases).toBe(1);
  const current = sentinel(); pending[1](current);
  await expect.poll(() => env.changes.at(-1).awake).toBe('Screen stays awake');
  expect(current.released).toBe(false);
  env.screen.close();
  expect(current.releases).toBe(1);
});

test('viewport and orientation changes cancel gestures and close removes listeners', t => {
  const env = environment(t);
  const gesture = { id: 1 };

  env.screen.swipe = gesture;
  env.window.dispatchEvent(new Event('resize'));
  expect(env.screen.swipe).toBe(null);

  env.screen.swipe = gesture;
  env.orientation.dispatchEvent(new Event('change'));
  expect(env.screen.swipe).toBe(null);

  env.screen.close();
  env.screen.swipe = gesture;
  env.window.dispatchEvent(new Event('resize'));
  env.orientation.dispatchEvent(new Event('change'));
  expect(env.screen.swipe).toBe(gesture);
});

test('fullscreen follows external exits, keeps expansion after rejection, and closes late entries', async t => {
  const env = environment(t);
  await env.screen.toggleFullscreen();
  expect(env.changes.at(-1).full).toBe(true);
  await env.document.exitFullscreen();
  expect(env.changes.at(-1).full).toBe(false);
  env.element.requestFullscreen = async () => { throw new TypeError('Denied'); };
  await env.screen.toggleFullscreen();
  expect(env.changes.at(-1).error).toBe('');
  expect(env.changes.at(-1).full).toBe(true);
  expect(env.attributes.has('data-expanded')).toBe(true);
  await env.screen.toggleFullscreen();
  expect(env.changes.at(-1).full).toBe(false);
  let resolve;
  env.element.requestFullscreen = () => new Promise(done => { resolve = done; });
  const entry = env.screen.toggleFullscreen();
  env.screen.close();
  expect(env.attributes.has('data-expanded')).toBe(false);
  const count = env.changes.length;
  env.document.fullscreenElement = env.element;
  resolve(); await entry;
  expect(env.document.fullscreenElement).toBe(null);
  expect(env.changes).toHaveLength(count);
});

test('Escape cancels a queued fullscreen entry while the native exit is pending', async t => {
  const env = environment(t);
  await env.screen.toggleFullscreen();
  let finishExit;
  env.document.exitFullscreen = () => new Promise(resolve => {
    finishExit = () => {
      env.document.fullscreenElement = null;
      env.document.dispatchEvent(new Event('fullscreenchange'));
      resolve();
    };
  });
  const exit = env.screen.toggleFullscreen();
  // Controls return before the native transition completes. A second entry
  // followed by Escape must keep the page open after that transition finishes.
  expect(env.attributes.has('data-expanded')).toBe(false);
  await env.screen.toggleFullscreen();
  const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
  env.document.dispatchEvent(escape);
  finishExit();
  await exit;
  expect(env.attributes.has('data-expanded')).toBe(false);
  expect(env.document.fullscreenElement).toBe(null);
  expect(escape.defaultPrevented).toBe(true);
  expect(env.changes.at(-1).full).toBe(false);
});

test('a late native exit event cannot hide an entry from Escape', async t => {
  const env = environment(t);
  await env.screen.toggleFullscreen();
  await env.screen.toggleFullscreen();
  let finishEntry;
  env.element.requestFullscreen = () => new Promise(resolve => {
    finishEntry = () => {
      env.document.fullscreenElement = env.element;
      resolve();
    };
  });
  const entry = env.screen.toggleFullscreen();
  // Chromium can deliver the previous exit event after starting the next entry.
  env.document.dispatchEvent(new Event('fullscreenchange'));
  const visibleDuringEntry = env.attributes.has('data-expanded');
  const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
  env.document.dispatchEvent(escape);
  finishEntry();
  await entry;
  env.document.dispatchEvent(new Event('fullscreenchange'));
  expect(visibleDuringEntry).toBe(true);
  expect(escape.defaultPrevented).toBe(true);
  expect(env.document.fullscreenElement).toBe(null);
  expect(env.attributes.has('data-expanded')).toBe(false);
});


test('a delayed fullscreen entry event preserves scrolling to the bottom controls', async t => {
  const env = environment(t);
  await env.screen.toggleFullscreen();
  expect(env.element.scrollTop).toBe(0);
  // The user can scroll before the browser delivers its native event after
  // requestFullscreen resolves. Confirming entry must not jump back to top.
  env.element.scrollTop = 240;
  env.document.dispatchEvent(new Event('fullscreenchange'));
  expect(env.element.scrollTop).toBe(240);
  expect(env.attributes.has('data-expanded')).toBe(true);
  await env.screen.toggleFullscreen();
  await env.screen.toggleFullscreen();
  expect(env.element.scrollTop).toBe(0);
});


test('a focused control can consume Escape without exiting fullscreen', async t => {
  const env = environment(t, async () => sentinel());
  await env.screen.toggleFullscreen();
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperty(event, 'key', { value: 'Escape' });
  event.preventDefault();
  env.document.dispatchEvent(event);
  expect(env.attributes.has('data-expanded')).toBe(true);
});


test('history navigation closes expanded state before route cleanup', async t => {
  const env = environment(t);
  env.document.fullscreenEnabled = false;
  await env.screen.toggleFullscreen();
  expect(env.attributes.has('data-expanded')).toBe(true);
  const routeStates = [];
  env.window.addEventListener('popstate', () => routeStates.push(env.attributes.has('data-expanded')));
  env.window.dispatchEvent(new Event('popstate'));
  expect(routeStates).toEqual([false]);
  expect(env.screen.expanded).toBe(false);
});

test('history navigation cancels fullscreen entry that finishes after Back', async t => {
  const env = environment(t);
  let finish;
  env.element.requestFullscreen = async () => {
    await new Promise(resolve => { finish = resolve; });
    env.document.fullscreenElement = env.element;
    env.document.dispatchEvent(new Event('fullscreenchange'));
  };
  const entering = env.screen.toggleFullscreen();
  env.window.dispatchEvent(new Event('popstate'));
  finish(); await entering;
  await expect.poll(() => env.screen.expanded).toBe(false);
  expect(env.document.fullscreenElement).toBe(null);
  expect(env.attributes.has('data-expanded')).toBe(false);
});

test('native fullscreen uses a separate view surface so its UA transform rule cannot pin the card upright', async t => {
  const env = environment(t);
  // The outer surface is installed after the fixture constructor. Production
  // captures its per-view wrapper at mount time, distinct from the card.
  const root = { requestFullscreen: async () => { env.document.fullscreenElement = root; } };
  env.screen.fullscreenTarget = root;
  await env.screen.toggleFullscreen();
  expect(env.document.fullscreenElement).toBe(root);
  expect(env.screen.expanded).toBe(true);
  await env.screen.toggleFullscreen();
  expect(env.document.fullscreenElement).toBe(null);
  expect(env.screen.expanded).toBe(false);
});

test('a late fullscreen request cannot exit a replacement view surface', async t => {
  const env = environment(t);
  let grant;
  const oldSurface = { requestFullscreen: () => new Promise(resolve => { grant = resolve; }) };
  env.screen.fullscreenTarget = oldSurface;
  const entering = env.screen.toggleFullscreen();
  env.screen.close();
  const replacement = {};
  env.document.fullscreenElement = replacement;
  grant();
  await entering;
  expect(env.document.fullscreenElement).toBe(replacement);
});

test('duplicate native fullscreen notices do not reset the display or keyboard layout', t => {
  const env = environment(t);
  let changes = 0;
  env.element.addEventListener('display-rotation', () => changes++);
  env.screen.setExpanded(true);
  env.document.fullscreenElement = env.screen.fullscreenTarget;
  env.document.dispatchEvent(new Event('fullscreenchange'));
  env.screen.setExpanded(true);
  expect(changes).toBe(1);
  env.document.fullscreenElement = null;
  env.document.dispatchEvent(new Event('fullscreenchange'));
  env.screen.setExpanded(false);
  expect(changes).toBe(2);
  env.screen.close();
  expect(changes).toBe(2);
});
