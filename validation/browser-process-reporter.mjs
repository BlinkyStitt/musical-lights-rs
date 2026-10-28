import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeProcessSnapshot } from './browser-stall.mjs';

const directory = fileURLToPath(new URL('./test-results/browser-processes/', import.meta.url));

// Playwright's pw:browser log includes pid, exit code and terminating signal.
export default class BrowserProcessReporter {
  constructor() { this.output = []; this.timers = new Map(); this.samples = []; }
  onStdErr(chunk) { this.output.push(chunk.toString()); }
  onStepBegin(test, result, step) {
    if (process.platform !== 'linux' || step.category !== 'pw:api'
      || !/^(Navigate|Create page)/.test(step.title)) return;
    this.timers.set(step, setTimeout(() => {
      const at = new Date().toISOString();
      this.samples.push((async () => {
        let processes;
        try { processes = await nativeProcessSnapshot(); }
        catch (error) { processes = { error: error.message }; }
        await mkdir(directory, { recursive: true });
        await appendFile(path.join(directory, 'stalled-steps.jsonl'), JSON.stringify({
          at, test: test.titlePath(), step: step.title, processes,
        }) + '\n');
      })());
    }, 5000));
  }
  onStepEnd(test, result, step) {
    clearTimeout(this.timers.get(step)); this.timers.delete(step);
  }
  async onEnd() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    await Promise.all(this.samples);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'process-exits.log'), this.output.join(''));
  }
}
