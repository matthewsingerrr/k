/**
 * /health: 503 until the Discord client has been ready once, so a deploy that cannot log in fails its healthcheck.
 */

import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, startHealthServer, type HttpRouteHandler } from '../src/health.js';
import { silentLogger } from '../src/log.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function start(everReady: () => boolean, linkApi?: HttpRouteHandler | null): Promise<string> {
  const server = startHealthServer(
    0,
    { discordReady: everReady, everReady, watches: () => 2, lastActivityAt: () => null, httpStats: () => ({ active: 0, pending: 0 }) },
    silentLogger,
    { linkApi },
  );
  servers.push(server);
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('health server', () => {
  it('answers 503 until Discord was ready once, then 200', async () => {
    let ready = false;
    const base = await start(() => ready);
    let res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, discord: false, watches: 2 });
    ready = true;
    res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, discord: true });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe('health server + Link API routing', () => {
  it('sends /api/v1 requests to the link handler and keeps /health as before', async () => {
    const seen: string[] = [];
    const base = await start(
      () => true,
      (req, res) => {
        seen.push(`${req.method} ${req.url}`);
        if (req.url === '/api/v1/pass') return false;
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"link":true}');
        return true;
      },
    );
    expect(await (await fetch(`${base}/api/v1/ping?x=1`)).json()).toEqual({ link: true });
    const pass = await fetch(`${base}/api/v1/pass`);
    expect(pass.status).toBe(404);
    expect(((await pass.json()) as { error: { code: string } }).error.code).toBe('not_found');
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/v2/ping`)).status).toBe(404);
    expect(seen).toEqual(['GET /api/v1/ping?x=1', 'GET /api/v1/pass']);
  });

  it('answers a JSON 404 for /api/v1 when the Link API is off', async () => {
    const base = await start(() => true, null);
    const res = await fetch(`${base}/api/v1/ping`);
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/LINK_API/);
  });

  it('answers 500 instead of crashing when a handler throws', async () => {
    const base = await start(
      () => true,
      () => {
        throw new Error('boom');
      },
    );
    expect((await fetch(`${base}/api/v1/ping`)).status).toBe(500);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('bounds how long a request may take to arrive', async () => {
    await start(() => true);
    const server = servers[servers.length - 1];
    expect(server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    expect(server.maxConnections).toBeGreaterThan(0);
  });
});
