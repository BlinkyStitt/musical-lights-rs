import { expect } from '@playwright/test';

export async function physicsReady(page) {
  await expect.poll(() => page.evaluate(() => Boolean(document.querySelector('#dancinglights')?.physics?.current))).toBe(true);
  await expect(page.locator('.physics-status')).toBeEmpty();
}
export async function physicsState(page) {
  return page.evaluate(() => {
    const view = document.querySelector('#dancinglights').physics;
    const state = view.current, layout = view.layout;
    return { tick: state[2], height: state[1], metrics: { ...view.metrics }, config: view.config,
      bars: Array.from(state.slice(layout[9], layout[10])), edges: Array.from(view.edges),
      balls: Array.from({ length: layout[0] }, (_, i) => {
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
      constructor(...args) { super(...args); window.testContext = this; }
      get currentTime() { return window.audioNow ?? super.currentTime; }
    };
    const Node = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Node {
      constructor(...args) { super(...args); window.testNode = this; }
    };
    window.resolveMotion = [];
    for (const name of ['DeviceMotionEvent', 'DeviceOrientationEvent']) {
      if (!window[name]) window[name] = class {};
      Object.defineProperty(window[name], 'requestPermission', { configurable: true,
        value: () => permission === 'pending' ? new Promise(resolve => window.resolveMotion.push(resolve)) : Promise.resolve(permission) });
    }
    MediaDevices.prototype.getUserMedia = async () => window.testContext.createMediaStreamDestination().stream;
    window.sendBars = (levels, edge = 0) => {
      const at = window.audioNow;
      const state = new Float64Array(122); state[0] = at;
      for (let i = 0; i < 24; i++) state.set([levels[i], 0, at + .35, edge, 0], 2 + i * 5);
      window.testNode.port.dispatchEvent(new MessageEvent('message', { data: { type: 'frame', state, clipped: 0 } }));
    };
  }, { permission });
}
export async function startFrozen(page) {
  await physicsReady(page);
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await window.testContext.suspend();
    await new Promise(resolve => setTimeout(resolve, 50));
    window.audioNow = window.testContext.currentTime;
  });
}
