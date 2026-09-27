import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright's pw:browser log includes pid, exit code and terminating signal.
export default class BrowserProcessReporter {
  constructor() { this.output = []; }
  onStdErr(chunk) { this.output.push(chunk.toString()); }
  async onEnd() {
    const directory = fileURLToPath(new URL('./test-results/browser-processes/', import.meta.url));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'process-exits.log'), this.output.join(''));
  }
}
