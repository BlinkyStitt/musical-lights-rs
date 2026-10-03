import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VisualizerScreen } from '../../musical-leptos/src/screen.js';

function exitGesture(t) {
  const document = new EventTarget();
  document.defaultView = Object.assign(new EventTarget(), { navigator: {} });
  const element = Object.assign(new EventTarget(), {
    ownerDocument: document,
    toggleAttribute() {},
    contains: () => true,
  });
  const screen = new VisualizerScreen(element, () => {}, () => {});
  t.after(() => screen.close());
  const fullscreen = { closest: selector => selector.includes('.fullscreen-button') ? fullscreen : null };
  const listening = { closest: () => null };
  const dispatch = (type, target = fullscreen, fields = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, Object.fromEntries(Object.entries({ target, ...fields }).map(([key, value]) => [key, { value }])));
    document.dispatchEvent(event);
    return event;
  };
  screen.setExpanded(true);
  dispatch('pointerdown', fullscreen, { isPrimary: true, button: 0, pointerType: 'touch', pointerId: 7 });
  assert.equal(screen.expanded, false, 'Exit must close before the compatibility click');
  let activations = 0;
  document.addEventListener('click', () => activations++);
  const click = (target = fullscreen, fields = {}) => {
    const before = activations;
    const event = dispatch('click', target, { detail: 1, ...fields });
    return { prevented: event.defaultPrevented, activated: activations > before };
  };
  return { screen, element, fullscreen, listening, dispatch, click };
}

test('an Exit gesture without a compatibility click leaves Listening usable', t => {
  const env = exitGesture(t);
  // Safari can deliver this click without another pointerdown.
  assert.deepEqual(env.click(env.listening), { prevented: false, activated: true });
});

for (const cancellation of ['pointercancel', 'touchcancel']) {
  test(`${cancellation} clears Exit suppression even without another pointer stream`, t => {
    const env = exitGesture(t);
    env.dispatch(cancellation);
    assert.deepEqual(env.click(), { prevented: false, activated: true });
    assert.deepEqual(env.click(env.listening), { prevented: false, activated: true });
  });
}

test('Exit does not suppress a different pointer activation of Fullscreen', t => {
  const env = exitGesture(t);
  assert.deepEqual(env.click(env.fullscreen, { pointerId: 8 }), { prevented: false, activated: true });
});

test('Exit consumes its compatibility click once and prevents re-entry', t => {
  const env = exitGesture(t);
  assert.deepEqual(env.click(env.fullscreen, { pointerId: 7 }), { prevented: true, activated: false });
  assert.deepEqual(env.click(), { prevented: false, activated: true });
  assert.equal(env.screen.expanded, false);
});

test('a Safari compatibility MouseEvent is consumed after normal capture release', t => {
  const env = exitGesture(t);
  env.element.dispatchEvent(new Event('lostpointercapture'));
  assert.deepEqual(env.click(), { prevented: true, activated: false });
});

test('keyboard Fullscreen activation is not suppressed', t => {
  const env = exitGesture(t);
  assert.deepEqual(env.click(env.fullscreen, { detail: 0 }), { prevented: false, activated: true });
});

test('a fresh pointer gesture can activate Fullscreen', t => {
  const env = exitGesture(t);
  env.dispatch('pointerdown', env.fullscreen, { isPrimary: true, button: 0, pointerType: 'mouse', pointerId: 9 });
  assert.deepEqual(env.click(env.fullscreen, { pointerId: 9 }), { prevented: false, activated: true });
});
