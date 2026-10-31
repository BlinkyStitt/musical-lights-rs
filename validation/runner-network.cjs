// Opt-in NODE_OPTIONS preload for GPU CI dependency transfers and artifact actions.
// Observe the actual libc lookups; never change families, resolvers, or retries.
const dns = require('node:dns');
const fs = require('node:fs');
const { isIP } = require('node:net');
const { syncBuiltinESMExports } = require('node:module');

let sequence = 0;
const files = [
  '/etc/resolv.conf', '/etc/nsswitch.conf', '/proc/self/cgroup',
  '/proc/net/route', '/proc/net/ipv6_route', '/proc/net/snmp',
];

function snapshot() {
  return Object.fromEntries(files.map(path => {
    let fd;
    try {
      fd = fs.openSync(path, 'r');
      const buffer = Buffer.alloc(16385);
      const length = fs.readSync(fd, buffer, 0, buffer.length, null);
      return [path, { text: buffer.subarray(0, Math.min(length, 16384)).toString(), truncated: length > 16384 }];
    } catch (error) {
      return [path, { error: error.code }];
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* Keep a snapshot failure observational. */ }
      }
    }
  }));
}

function emit(data) {
  // Job stderr survives an artifact-service outage. Never log URLs, headers,
  // credentials, or the ambient environment, and never mask a transfer failure.
  try {
    fs.writeSync(2, `RUNNER_NETWORK ${JSON.stringify({ at: new Date().toISOString(),
      pid: process.pid, ppid: process.ppid, node: process.version, ...data })}\n`);
  } catch { /* A broken stderr must not alter the observed operation. */ }
}

function begin(api, hostname, options) {
  // Local app traffic is outside this recorder, including browser measurements.
  if (typeof hostname !== 'string' || !hostname || isIP(hostname)
    || hostname === 'localhost' || hostname.endsWith('.localhost')) return null;
  const id = ++sequence;
  if (id === 1) emit({ event: 'resolver', files: snapshot(),
    resolverOptions: process.env.RES_OPTIONS, localDomain: process.env.LOCALDOMAIN });
  const started = performance.now();
  emit({ event: 'lookup-start', id, api, hostname,
    options: typeof options === 'number' ? { family: options } :
      options && typeof options === 'object' ? {
        family: options.family, hints: options.hints, all: options.all,
        verbatim: options.verbatim, order: options.order,
      } : {} });
  return (error, address, family) => {
    const elapsedMs = performance.now() - started;
    emit({ event: 'lookup-end', id, api, hostname, elapsedMs,
      ...(error ? { error: { code: error.code, errno: error.errno, syscall: error.syscall }, files: snapshot() }
        : { addresses: Array.isArray(address) ? address : [{ address, family }] }) });
  };
}

const lookup = dns.lookup;
function observedLookup(...args) {
  const callback = args.at(-1);
  // Preserve native validation and synchronous errors for invalid signatures.
  if (typeof callback !== 'function') return Reflect.apply(lookup, this, args);
  const finish = begin('callback', args[0], args[1]);
  if (finish) args[args.length - 1] = function (error, address, family) {
    finish(error, address, family);
    return Reflect.apply(callback, this, arguments);
  };
  return Reflect.apply(lookup, this, args);
}
// Keep Node's custom promisification result names and other function metadata.
Object.defineProperties(observedLookup, Object.getOwnPropertyDescriptors(lookup));
dns.lookup = observedLookup;

const promiseLookup = dns.promises.lookup;
dns.promises.lookup = function (...args) {
  const finish = begin('promise', args[0], args[1]);
  const promise = Reflect.apply(promiseLookup, this, args);
  if (!finish) return promise;
  // Return the observed rejection so an uncaught DNS error still fails Node.
  return promise.then(result => {
    if (Array.isArray(result)) finish(null, result);
    else finish(null, result.address, result.family);
    return result;
  }, error => { finish(error); throw error; });
};
syncBuiltinESMExports();
