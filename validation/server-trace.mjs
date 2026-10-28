// HTTP lifecycle evidence complements native wait samples when navigation never
// commits. Record no headers or bodies, and retain aborted responses explicitly.
export function traceRequest(request, response, port, write) {
  const start = performance.now();
  const id = `${port}:${request.socket.remotePort}:${start}`;
  const record = (event, extra = {}) => write(JSON.stringify({
    at: new Date().toISOString(), id, event, port, method: request.method,
    path: request.url, elapsedMs: performance.now() - start, ...extra,
  }) + '\n');
  record('request');
  response.once('finish', () => record('finish', { status: response.statusCode }));
  response.once('close', () => record('close', { complete: response.writableFinished }));
}
