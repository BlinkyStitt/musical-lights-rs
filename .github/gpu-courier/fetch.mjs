import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const audience = 'ski-musical-gpu-return-v1';
const endpoint = 'https://gpu-artifacts.shorthair-fir.ts.net/v1/musical-gpu/result';
const maxBytes = 300 * 1024 * 1024;

export async function receive(core, identity, output, dependencies = {}) {
  const request = dependencies.fetch ?? fetch;
  const wait = dependencies.sleep ?? sleep;
  const now = dependencies.now ?? Date.now;
  const expires = now() + (112 * 60 * 1000);
  while (now() < expires) {
    const bearer = await core.getIDToken(audience);
    if (typeof bearer !== 'string' || bearer.length > 14000) throw Error('Invalid OIDC response');
    const segments = bearer.split('.');
    if (segments.length !== 3) throw Error('Invalid OIDC identity');
    const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    if (claims.aud !== audience || claims.actor_id !== '624221' ||
        claims.repository_id !== '736904496' || claims.runner_environment !== 'github-hosted' ||
        claims.event_name !== 'pull_request' || claims.sha !== identity.tested ||
        claims.ref !== identity.ref || String(claims.run_id) !== identity.run ||
        String(claims.run_attempt) !== identity.attempt || !/^[1-9][0-9]{0,17}$/.test(String(claims.check_run_id)) ||
        !/^[a-f0-9]{40}$/.test(claims.job_workflow_sha)) {
      throw Error('Wrong exact hosted OIDC identity');
    }
    const response = await request(endpoint, {
      method: 'GET', redirect: 'error',
      headers: { Authorization: 'Bearer ' + bearer, 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(185000),
    });
    if (response.status === 404 || response.status === 503) {
      await response.body?.cancel();
      await wait(15000);
      continue;
    }
    const length = Number(response.headers.get('Content-Length'));
    if (response.status !== 200 || response.headers.get('Content-Type') !== 'application/zip' ||
        response.headers.has('Content-Encoding') || !Number.isSafeInteger(length) ||
        length <= 0 || length > maxBytes || !response.body) {
      await response.body?.cancel();
      throw Error('Invalid bounded artifact response');
    }
    let observed = 0;
    const partial = output + '.partial';
    const bound = new Transform({
      transform(chunk, _encoding, end) {
        observed += chunk.length;
        if (observed > length) end(Error('GPU report size exceeded Content-Length'));
        else end(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body), bound, createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
      if (observed !== length) throw Error('GPU report was truncated');
      await rename(partial, output);
    } catch {
      await rm(partial, { force: true });
      throw Error('GPU report transport incomplete');
    }
    return { check: String(claims.check_run_id), callee: claims.job_workflow_sha };
  }
  throw Error('No exact native GPU artifact arrived before deadline');
}
