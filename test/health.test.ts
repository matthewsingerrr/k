/**
 * /health: 503 until the Discord client has been ready once, so a deploy that cannot log in fails its healthcheck.
 */

import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startHealthServer } from '../src/health.js';
import { silentLogger } from '../src/log.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function start(everReady: () => boolean): Promise<string> {
  const server = startHealthServer(
    0,
    { discordReady: everReady, everReady, watches: () => 2, lastActivityAt: () => null, httpStats: () => ({ active: 0, pending: 0 }) },
    silentLogger,
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
