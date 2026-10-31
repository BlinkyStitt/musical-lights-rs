import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { nativeProcessSnapshot } from './browser-stall.mjs';

export function cgroupV2Directories(cgroup, mountinfo) {
  const group = cgroup.split('\n').find(line => line.startsWith('0::'))?.slice(3);
  const mount = mountinfo.split('\n').find(line => line.includes(' - cgroup2 '))?.split(' ');
  if (!group || !mount || group.split('/').includes('..')) throw new Error('Cannot map the process cgroup v2 mount');
  const unescape = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  const root = unescape(mount[3]), mountedAt = unescape(mount[4]);
  const relative = posix.relative(root, group);
  if (relative.startsWith('..')) throw new Error('Process cgroup is outside the visible mount');
  const directories = [];
  // Parent quotas can constrain a child even if its own cpu.max says "max".
  for (let directory = posix.join(mountedAt, relative); ; directory = posix.dirname(directory)) {
    directories.push(directory);
    if (directory === mountedAt) return directories;
  }
}

export async function performanceProcessSample() {
  if (process.platform !== 'linux') return { platform: process.platform, nativeCounters: 'Linux /proc unavailable' };
  const [cgroup, mountinfo] = await Promise.all(['/proc/self/cgroup', '/proc/self/mountinfo'].map(path => readFile(path, 'utf8')));
  let directories = [], cgroupMappingError;
  try { directories = cgroupV2Directories(cgroup, mountinfo); }
  catch (error) { cgroupMappingError = error.message; }
  const files = ['/proc/pressure/cpu', '/proc/pressure/memory', ...directories.flatMap(directory =>
    ['cpu.max', 'cpu.stat', 'cpu.pressure', 'memory.max', 'memory.events', 'cpuset.cpus.effective']
      .map(name => `${directory}/${name}`))];
  const limits = Object.fromEntries(await Promise.all(files.map(async path => {
    try { return [path, (await readFile(path, 'utf8')).trim()]; }
    catch (error) { return [path, { error: error.code }]; }
  })));
  return { platform: process.platform, cgroup, mountinfo, cgroupMappingError, limits, processes: await nativeProcessSnapshot() };
}

// Sample outside the browser every ten seconds. Persist each sample immediately
// so timeout/crash artifacts retain evidence from the failing operation. Never
// overlap samples or change controller limits to obtain a passing measurement.
export async function recordPerformanceProcesses(path, { sample = performanceProcessSample, intervalMs = 10000 } = {}) {
  await writeFile(path, '');
  const start = performance.now();
  let stopped = false, timer, pending = Promise.resolve(), failure;
  const capture = async () => {
    const at = new Date().toISOString(), elapsedMs = performance.now() - start;
    const data = await sample();
    await appendFile(path, JSON.stringify({ at, elapsedMs, sampleDurationMs: performance.now() - start - elapsedMs, ...data }) + '\n');
  };
  const poll = () => {
    pending = capture().then(() => { if (!stopped) timer = setTimeout(poll, intervalMs); })
      .catch(error => { failure = error; });
  };
  await capture();
  timer = setTimeout(poll, intervalMs);
  return async () => {
    stopped = true; clearTimeout(timer); await pending;
    if (failure) throw failure;
    await capture();
  };
}
