import { readdir, readFile } from 'node:fs/promises';

// Read only this runner's descendants. Sampling /proc does not pause a native
// process or depend on a responsive WebKit inspector connection.
export async function nativeProcessSnapshot(rootPid = process.pid, proc = '/proc') {
  const read = async path => {
    try { return (await readFile(path, 'utf8')).trim(); }
    catch (error) { return { error: error.code }; }
  };
  const processes = await Promise.all((await readdir(proc)).filter(name => /^\d+$/.test(name)).map(async pid => {
    const status = await read(`${proc}/${pid}/status`);
    if (typeof status !== 'string') return null; // Exited during enumeration.
    return { pid: Number(pid), parent: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]), status };
  }));
  const selected = new Set([Number(rootPid)]);
  let added;
  do {
    added = false;
    for (const p of processes) if (p && selected.has(p.parent) && !selected.has(p.pid)) {
      selected.add(p.pid); added = true;
    }
  } while (added);
  return Promise.all(processes.filter(p => p && selected.has(p.pid)).map(async p => {
    const base = `${proc}/${p.pid}`;
    const tasks = await readdir(`${base}/task`).catch(() => []);
    return { ...p, tasks: await Promise.all(tasks.map(async tid => ({
      tid: Number(tid), name: await read(`${base}/task/${tid}/comm`),
      wait: await read(`${base}/task/${tid}/wchan`),
      syscall: await read(`${base}/task/${tid}/syscall`),
      stack: await read(`${base}/task/${tid}/stack`),
    }))) };
  }));
}
