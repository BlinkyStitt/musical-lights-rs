import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertBrowserEnvironment(platform = process.platform, env = process.env) {
  if (platform === 'darwin' && env.CODEX_SANDBOX === 'seatbelt') {
    throw new Error('Native browsers cannot launch in the restricted Codex macOS sandbox. Run from the repository root with host access (sandbox_permissions: "require_escalated"): PATH="$PWD/.tools/bin:$PATH" python3 validation/validate.py browser. For focused checks use .tools/bin/node validation/node_modules/@playwright/test/cli.js test --config validation/playwright.config.mjs. Zero browsers were launched.');
  }
}

// Apple marks nonfatal diagnostic snapshots as simulated in both IPS documents.
// https://developer.apple.com/documentation/xcode/examining-the-fields-in-a-crash-report
export function classifyBrowserReport(text) {
  try {
    const end = text.indexOf('\n');
    const header = JSON.parse(text.slice(0, end));
    const report = JSON.parse(text.slice(end + 1));
    if (!header || !report || typeof header !== 'object' || typeof report !== 'object'
      || !report.exception || !report.procName) return 'unreadable';
    return header.is_simulated === 1 && report.isSimulated === 1 ? 'simulated-fault' : 'crash';
  } catch { return 'unreadable'; }
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
    const reports = await Promise.all(added.map(async name => {
      let kind = 'unreadable';
      try { kind = classifyBrowserReport(await readFile(path.join(homedir(), 'Library/Logs/DiagnosticReports', name), 'utf8')); } catch { /* Missing reports must fail the guard. */ }
      return { name, kind };
    }));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'crash-reports.json'), JSON.stringify({ before, after, added, reports }, null, 2));
    const failures = reports.filter(report => report.kind !== 'simulated-fault');
    if (failures.length) throw new Error(`New macOS browser crash or unreadable reports: ${failures.map(report => report.name).join(', ')}`);
    if (reports.length) process.stderr.write(`macOS recorded simulated browser faults; retained in crash-reports.json: ${reports.map(report => report.name).join(', ')}\n`);
  };
}
