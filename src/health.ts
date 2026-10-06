import http from 'node:http';
import { LINK_API_PREFIX } from './link/types.js';
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

/** A route handler that answers the request and returns true, or returns false (without touching `res`) to pass. */
export type HttpRouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => boolean;

export interface HealthServerOptions {
  /** Link API (/api/v1, see src/link/api.ts); absent when LINK_API is off. */
  linkApi?: HttpRouteHandler | null;
}

/** Whole request (headers + body) must arrive within this long; slow-loris clients are cut off. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Headers must arrive within this long. */
export const HEADERS_TIMEOUT_MS = 10_000;
/** Max request header bytes. */
const MAX_HEADER_BYTES = 16 * 1024;
/** Open connections at once (health checks + link clients are few; this only bounds file descriptors). */
const MAX_CONNECTIONS = 512;

function pathOf(url: string | undefined): string {
  const raw = typeof url === 'string' ? url : '/';
  const q = raw.indexOf('?');
  return q >= 0 ? raw.slice(0, q) : raw;
}

function isLinkPath(path: string): boolean {
  return path === LINK_API_PREFIX || path.startsWith(`${LINK_API_PREFIX}/`);
}

/**
 * Tiny HTTP server for Railway health checks: GET /health (and /) → JSON status (503 until Discord was ready once).
 * With `opts.linkApi`, requests under /api/v1 go to the Link API instead.
 */
export function startHealthServer(port: number, src: HealthSource, log: Logger, opts: HealthServerOptions = {}): http.Server {
  const startedAt = Date.now();
  const linkApi = opts.linkApi ?? null;

  const health = (req: http.IncomingMessage, res: http.ServerResponse) => {
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
  };

  const server = http.createServer(
    {
      headersTimeout: HEADERS_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      maxHeaderSize: MAX_HEADER_BYTES,
      connectionsCheckingInterval: 5_000,
    },
    (req, res) => {
      try {
        if (isLinkPath(pathOf(req.url))) {
          if (linkApi && linkApi(req, res)) return;
          const json = JSON.stringify({
            error: {
              code: 'not_found',
              message: linkApi ? 'Unknown endpoint.' : 'The Link API is turned off on this bot (LINK_API=false).',
            },
          });
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }).end(json);
          return;
        }
        health(req, res);
      } catch (err) {
        log.error('http request handler failed', { err: err instanceof Error ? err : String(err) });
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      }
    },
  );
  // Malformed requests and header/request timeouts get Node's default 400/408/431 answer (no 'clientError' override).
  server.maxConnections = MAX_CONNECTIONS;
  server.on('error', (err) => log.warn('health server error', { err }));
  server.listen(port, () => log.info(`health server listening on :${port}`));
  return server;
}
