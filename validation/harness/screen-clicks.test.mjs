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

test('Rotate cancels capture and stale Exit suppression, retains selection until cleanup', t => {
  const env = exitGesture(t);
  env.element.setAttribute = () => {};
  env.screen.setExpanded(true);
  const released = [];
  env.element.hasPointerCapture = () => true;
  env.element.releasePointerCapture = id => released.push(id);
  env.screen.swipe = { id: 99 };
  env.element.dispatchEvent(new Event('rotate-display'));
  assert.equal(env.screen.swipe, null);
  assert.deepEqual(released, [99]);
  assert.equal(env.element.displayQuarterTurn, 1);
  assert.deepEqual(env.click(), { prevented: false, activated: true });
  env.screen.setExpanded(false);
  env.element.dispatchEvent(new Event('rotate-display'));
  assert.equal(env.element.displayQuarterTurn, 1);
  env.screen.setExpanded(true);
  for (const expected of [2, 3, 0]) {
    env.element.dispatchEvent(new Event('rotate-display'));
    assert.equal(env.element.displayQuarterTurn, expected);
  }
  env.screen.close();
  assert.equal(env.element.displayQuarterTurn, undefined);
  env.element.dispatchEvent(new Event('rotate-display'));
  assert.equal(env.element.displayQuarterTurn, undefined);
});

for (let turn = 0; turn < 4; turn++) {
  test(`exit swipes follow logical down at display turn ${turn}`, t => {
    const env = exitGesture(t);
    env.screen.setExpanded(true);
    const width = turn % 2 ? 800 : 400, height = turn % 2 ? 400 : 800;
    Object.assign(env.element, { displayQuarterTurn: turn, clientWidth: width, clientHeight: height,
      hasAttribute: () => true, classList: { contains: () => false },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 800 }),
      setPointerCapture() {}, hasPointerCapture: () => false });
    const target = { closest: selector => selector === '#dancinglights' ? target : null };
    const physical = (x, y) => {
      const [clientX, clientY] = [[x, y], [height - y, x], [width - x, height - y], [y, width - x]][turn];
      return { clientX, clientY, pointerId: 42, pointerType: 'touch', isPrimary: true, button: 0 };
    };
    env.dispatch('pointerdown', target, physical(width / 2, 100));
    assert.ok(env.screen.swipe);
    env.dispatch('pointermove', target, physical(width / 2, 190));
    assert.equal(env.screen.expanded, false);
    assert.equal(env.screen.swipe, null);
  });
}

test('Exit consumes a matching touch click retargeted onto a revealed page link', t => {
  const env = exitGesture(t);
  const link = { closest: () => null };
  assert.deepEqual(env.click(link, { pointerId: 7 }), { prevented: true, activated: false });
  assert.deepEqual(env.click(link, { pointerId: 8 }), { prevented: false, activated: true });
});
