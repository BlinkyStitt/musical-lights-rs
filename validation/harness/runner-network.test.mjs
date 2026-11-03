import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const preload = fileURLToPath(new URL('../runner-network.cjs', import.meta.url));

function probe(body) {
  const result = spawnSync(process.execPath, ['--input-type=commonjs', '-e', `
    const assert = require('node:assert/strict');
    const dns = require('node:dns');
    const fs = require('node:fs');
    const preload = ${JSON.stringify(preload)};
    (async () => { ${body} })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stderr.split('\n').filter(line => line.startsWith('RUNNER_NETWORK '))
    .map(line => JSON.parse(line.slice('RUNNER_NETWORK '.length)));
}

test('CI resolver recorder retains callback overloads, receiver, return value and partial family answers', () => {
  const rows = probe(`
    const receiver = {}, returned = {};
    let calls = 0;
    dns.lookup = function (host, options, callback) {
      calls++;
      assert.equal(this, dns);
      assert.equal(host, 'cdn.playwright.dev');
      if (typeof options === 'function') options.call(receiver, null, '192.0.2.1', 4);
      else if (typeof options === 'number') { assert.equal(options, 6); callback.call(receiver, null, '2001:db8::1', 6); }
      else { assert.deepEqual(options, { all: true }); callback.call(receiver, null, [{ address: '2001:db8::1', family: 6 }]); }
      return returned;
    };
    require(preload);
    assert.equal(dns.lookup('cdn.playwright.dev', function (error, address, family) {
      assert.equal(this, receiver); assert.equal(error, null);
      assert.equal(address, '192.0.2.1'); assert.equal(family, 4);
    }), returned);
    dns.lookup('cdn.playwright.dev', 6, (error, address, family) => { assert.equal(family, 6); });
    dns.lookup('cdn.playwright.dev', { all: true }, (error, addresses) => { assert.equal(addresses.length, 1); });
    assert.equal(calls, 3);
  `);
  assert.equal(rows.filter(row => row.event === 'resolver').length, 1);
  const ended = rows.filter(row => row.event === 'lookup-end');
  assert.equal(ended.length, 3);
  assert.deepEqual(ended.map(row => row.addresses[0].family), [4, 6, 6]);
  for (const row of ended) {
    assert(row.elapsedMs >= 0);
    assert(Number.isFinite(Date.parse(row.at)));
    assert(row.pid > 0 && row.ppid > 0);
  }
});

test('CI resolver recorder preserves original promise errors without retrying', () => {
  const rows = probe(`
    const failure = Object.assign(new Error('private transfer details'), { code: 'EAI_AGAIN', errno: -3001, syscall: 'getaddrinfo' });
    const original = Promise.reject(failure);
    let calls = 0;
    dns.promises.lookup = function (host, options) {
      calls++; assert.equal(this, dns.promises);
      assert.equal(host, 'storage.googleapis.com'); assert.deepEqual(options, { all: true });
      return original;
    };
    require(preload);
    const result = dns.promises.lookup('storage.googleapis.com', { all: true });
    await assert.rejects(result, error => error === failure);
    assert.equal(calls, 1);
  `);
  assert.deepEqual(rows.map(row => row.event), ['resolver', 'lookup-start', 'lookup-end']);
  const failure = rows.at(-1);
  assert.deepEqual(failure.error, { code: 'EAI_AGAIN', errno: -3001, syscall: 'getaddrinfo' });
  assert(failure.files['/etc/resolv.conf']);
  assert(failure.files['/proc/net/route']);
  assert(!JSON.stringify(rows).includes('private transfer details'));
});

test('CI resolver recorder retains callback errors and reports unavailable native evidence', () => {
  const rows = probe(`
    const failure = Object.assign(new Error('DNS failed'), { code: 'EAI_AGAIN' });
    dns.lookup = (host, callback) => { callback(failure); };
    const open = fs.openSync;
    fs.openSync = (path, ...args) => {
      if (path === '/proc/net/route') throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
      return open(path, ...args);
    };
    require(preload);
    dns.lookup('results-receiver.actions.githubusercontent.com', error => assert.equal(error, failure));
  `);
  assert.deepEqual(rows.at(-1).files['/proc/net/route'], { error: 'EACCES' });
  assert.equal(rows.at(-1).error.code, 'EAI_AGAIN');
});

test('CI resolver recorder leaves local traffic and native promisification intact', () => {
  const rows = probe(`
    const { promisify } = require('node:util');
    require(preload);
    const result = await promisify(dns.lookup)('127.0.0.1');
    assert.deepEqual(result, { address: '127.0.0.1', family: 4 });
    assert.deepEqual(await dns.promises.lookup('::1'), { address: '::1', family: 6 });
    assert.throws(() => dns.lookup('example.com', {}), { code: 'ERR_INVALID_ARG_TYPE' });
  `);
  assert.deepEqual(rows, []);
});

test('preload observes ESM promise lookups and preserves array results', () => {
  const rows = probe(`
    const addresses = [{ address: '192.0.2.1', family: 4 }, { address: '2001:db8::1', family: 6 }];
    dns.promises.lookup = async () => addresses;
    require(preload);
    const { lookup } = await import('node:dns/promises');
    assert.equal(await lookup('cdn.playwright.dev', { all: true }), addresses);
  `);
  assert.deepEqual(rows.at(-1).addresses, [
    { address: '192.0.2.1', family: 4 }, { address: '2001:db8::1', family: 6 },
  ]);
});

test('CI recorder output failure cannot replace a transfer error', () => {
  probe(`
    const failure = Object.assign(new Error('DNS failed'), { code: 'EAI_AGAIN' });
    dns.lookup = (host, callback) => callback(failure);
    fs.writeSync = () => { throw new Error('closed stderr'); };
    require(preload);
    dns.lookup('cdn.playwright.dev', error => assert.equal(error, failure));
  `);
});

test('an unhandled promise DNS failure still fails the instrumented process', () => {
  const result = spawnSync(process.execPath, ['--input-type=commonjs', '-e', `
    const dns = require('node:dns');
    dns.promises.lookup = () => Promise.reject(Object.assign(new Error('DNS transfer failed'), { code: 'EAI_AGAIN' }));
    require(${JSON.stringify(preload)});
    dns.promises.lookup('storage.googleapis.com');
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Error: DNS transfer failed/);
  assert.match(result.stderr, /"event":"lookup-end".*"code":"EAI_AGAIN"/);
});
