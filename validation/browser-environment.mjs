import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertBrowserEnvironment(platform = process.platform, env = process.env) {
  if (platform === 'darwin' && env.CODEX_SANDBOX === 'seatbelt') {
    throw new Error('Native browsers cannot launch in the restricted Codex macOS sandbox. Run from the repository root with host access (sandbox_permissions: "require_escalated"): PATH="$PWD/.tools/bin:$PATH" python3 validation/validate.py browser. For focused checks use .tools/bin/node validation/node_modules/@playwright/test/cli.js test --config validation/playwright.config.mjs. Zero browsers were launched.');
  }
}

export async function crashReports() {
  if (process.platform !== 'darwin') return [];
  const directory = path.join(homedir(), 'Library/Logs/DiagnosticReports');
  return (await readdir(directory)).filter(name => /chrom|webkit|playwright|headless/i.test(name)).sort();
}

export async function monitorBrowserCrashes(directory = fileURLToPath(new URL('./test-results/browser-processes/', import.meta.url))) {
  const before = await crashReports();
  return async () => {
    // ReportCrash can write its .ips after the browser process has exited.
    if (process.platform === 'darwin') await new Promise(resolve => setTimeout(resolve, 3000));
    const after = await crashReports();
    const added = after.filter(name => !before.includes(name));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'crash-reports.json'), JSON.stringify({ before, after, added }, null, 2));
    if (added.length) throw new Error(`New macOS browser crash reports: ${added.join(', ')}`);
  };
}
