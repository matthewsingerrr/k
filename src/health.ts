import http from 'node:http';
import type { Logger } from './types.js';

export interface HealthSource {
  discordReady(): boolean;
  /**
   * The Discord client has been ready at least once. Until then /health answers 503, so a deploy whose token or gateway
   * connection does not work fails its healthcheck and the previous deployment keeps running.
   */
  everReady?(): boolean;
  watches(): number;
  lastActivityAt(): number | null;
  httpStats(): { active: number; pending: number };
}

/** Tiny HTTP server for Railway health checks: GET /health (and /) → JSON status (503 until Discord was ready once). */
export function startHealthServer(port: number, src: HealthSource, log: Logger): http.Server {
  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || !(req.url === '/' || req.url?.startsWith('/health'))) {
      res.writeHead(404).end();
      return;
    }
    const last = src.lastActivityAt();
    let ok = true;
    try {
      ok = src.everReady ? src.everReady() : true;
    } catch {
      ok = false;
    }
    const body = {
      ok,
      discord: src.discordReady(),
      watches: src.watches(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      lastActivitySecAgo: last === null ? null : Math.round((Date.now() - last) / 1000),
      http: src.httpStats(),
    };
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  server.on('error', (err) => log.warn('health server error', { err }));
  server.listen(port, () => log.info(`health server listening on :${port}`));
  return server;
}
