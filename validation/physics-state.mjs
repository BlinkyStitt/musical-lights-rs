import { expect } from '@playwright/test';

export async function physicsReady(page) {
  await expect.poll(() => page.evaluate(() => Boolean(document.querySelector('#dancinglights')?.physics?.current))).toBe(true);
  const tick = await page.evaluate(() => document.querySelector('#dancinglights').physics.current[2]);
  await expect.poll(() => page.evaluate(() => {
    const view = document.querySelector('#dancinglights').physics;
    return view.ready && !view.closed && !view.lost && !view.notice.persistent ? view.current?.[2] : -1;
  })).toBeGreaterThan(tick);
}
export async function physicsState(page) {
  return page.evaluate(() => {
    const view = document.querySelector('#dancinglights').physics;
    const state = view.current, layout = view.layout;
    return { tick: state[2], height: state[1], ceiling: state[layout[17]], barMax: state[layout[17] + 1], metrics: { ...view.metrics }, config: view.config,
      bars: Array.from(state.slice(layout[9], layout[10])), edges: Array.from(view.edges),
      balls: Array.from({ length: layout[21] }, (_, i) => {
        const o = 3 + i * layout[8];
        return { position: Array.from(state.slice(o, o + 3)), rotation: Array.from(state.slice(o + 3, o + 7)),
          radius: state[o + 7], mass: state[o + 8], velocity: Array.from(state.slice(o + 9, o + 12)),
          color: Array.from(state.slice(o + 15, o + 18)), impulse: state[layout[11] + i] };
      }) };
  });
}
export async function syntheticAudio(page, permission = 'granted') {
  await page.addInitScript(({ permission }) => {
    const Context = window.AudioContext;
    window.AudioContext = class extends Context {
      constructor(...args) { super(...args); window.testContext = this; this.addEventListener('statechange', event => { if (window.freezeClock) event.stopImmediatePropagation(); }); }
      get currentTime() { return window.audioNow ?? super.currentTime; }
    };
    const Node = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Node {
      constructor(...args) {
        super(...args); window.testNode = this;
        this.port.addEventListener('message', event => {
          const { data } = event;
          // Once the fixture clock is frozen, delayed native snapshots must
          // not replace its explicit synthetic input. Errors still propagate.
          if (window.freezeClock && event.isTrusted && data.type === 'frame') {
            event.stopImmediatePropagation(); return;
          }
          if (data.type === 'frame') window.lastAnalysisTime = data.state[0];
        });
      }
    };
    window.resolveMotion = [];
    for (const name of ['DeviceMotionEvent', 'DeviceOrientationEvent']) {
      if (!window[name]) window[name] = class {};
      Object.defineProperty(window[name], 'requestPermission', { configurable: true,
        value: () => {
          // Model the initial Safari prompt's gesture requirement. Synthetic
          // sensor dispatch below still does not exercise the browser's gate.
          if (!navigator.userActivation.isActive) return Promise.reject(new DOMException('A gesture is required', 'NotAllowedError'));
          return permission === 'pending' ? new Promise(resolve => window.resolveMotion.push(resolve)) : Promise.resolve(permission);
        } });
    }
    MediaDevices.prototype.getUserMedia = async () => window.testContext.createMediaStreamDestination().stream;
    window.sendBars = (levels, edge = 0) => {
      // Partial frames use an end-exclusive clock, potentially one quantum
      // ahead of currentTime. Always supersede the last real/fake packet.
      const at = window.audioNow = Math.max(window.audioNow, window.lastAnalysisTime ?? 0) + .01;
      const state = new Float64Array(99); state[0] = at; state[1] = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0; state[2] = 4;
      for (let i = 0; i < 24; i++) state.set([levels[i], levels[i], edge ? at : -1, 0], 3 + i * 4);
      window.testNode.port.dispatchEvent(new MessageEvent('message', { data: { type: 'frame', sessionId: Number(document.querySelector('.audio-card').dataset.audioSession), state, clipped: 0 } }));
    };
  }, { permission });
}
export async function startFrozen(page) {
  await physicsReady(page);
  // Most physics fixtures measure fixed source columns. Scrolling has its own
  // end-to-end checks and can be re-enabled explicitly after this helper.
  await page.locator('.scroll-lights').uncheck();
  await page.getByRole('checkbox', { name: 'Phone motion', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Listening', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Listening', exact: true })).toBeChecked();
  await expect(page.locator('.listening-toggle')).toBeEnabled();
  await expect(page.locator('.mic-status')).toHaveText('Listening · Mic on');
  await page.evaluate(async () => {
    // Controlled clock fixture suppresses the real interruption event.
    window.freezeClock = true;
    await window.testContext.suspend();
    await new Promise(resolve => setTimeout(resolve, 50));
    window.audioNow = window.testContext.currentTime;
  });
  // Idle audio can move bodies and scroll columns before capture starts. These
  // controlled fixtures require the original initial room and source phase.
  await page.evaluate(() => new Promise(resolve => {
    const view = document.querySelector('#dancinglights').physics;
    const reset = ({ data }) => {
      if (data.type !== 'reset') return;
      view.worker.removeEventListener('message', reset); resolve();
    };
    view.worker.addEventListener('message', reset);
    view.worker.postMessage({ type: 'reset', config: Array.from(view.config) });
  }));
  await physicsReady(page);
  await expect.poll(() => page.evaluate(() => {
    const v = document.querySelector('#dancinglights').physics;
    return Math.max(...v.current.slice(v.layout[9], v.layout[10]));
  })).toBeLessThan(.0031);
}
