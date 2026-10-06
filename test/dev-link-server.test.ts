/**
 * scripts/dev-link-server.ts: the local Link API the browser extension's integration tests run against (real HTTP server,
 * Link API, scheduler and store; a fake Discord; a local fixture site). Everything stays on 127.0.0.1.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DEV_DEMOTED_TOKEN,
  DEFAULT_DEV_OTHER_TOKEN,
  DEFAULT_DEV_TOKEN,
  DEV_CHANNELS,
  DEV_GUILD_ID,
  startDevLinkServer,
  type DevLinkServer,
} from '../scripts/dev-link-server.js';

let server: DevLinkServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function api(s: DevLinkServer, method: string, path: string, body?: unknown, token = s.token) {
  const res = await fetch(`${s.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe('dev link server', () => {
  it('serves the seeded server over the real Link API and scheduler', async () => {
    const lines: string[] = [];
    server = await startDevLinkServer({ port: 0, sitePort: 0, write: (l) => lines.push(l) });
    const s = server;
    expect(s.token).toBe(DEFAULT_DEV_TOKEN);
    expect(s.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/);

    const ping = await api(s, 'GET', '/ping');
    expect(ping.json).toMatchObject({ ok: true, guild: { id: DEV_GUILD_ID }, channelId: DEV_CHANNELS.scans, label: 'Dev Chrome', watches: 3 });

    const list = await api(s, 'GET', '/watches');
    expect(list.json.watches.map((w: { name: string }) => w.name)).toEqual(['Fixture', 'Fixture docs', 'Hookedpad (seeded)']);
    expect(list.json.summary.text).toBe('Watching 3 sites · alerts in #scans · 2 up · 1 paused');

    // The fixture watches were crawled (offline) before the server reported ready.
    const fixture = s.watches.find((w) => w.name === 'Fixture')!;
    const card = (await api(s, 'GET', `/watches/${fixture.id}`)).json.card;
    expect(card).toMatchObject({ status: 'up', build: { id: 'fixture-v1', bundles: 2 }, alerts: { channelName: 'scans', canPost: true } });
    expect(card.pages.tracked).toBeGreaterThanOrEqual(5);
    expect(card.runtime.running).toBe(true);

    const seeded = s.watches.find((w) => w.name === 'Hookedpad (seeded)')!;
    const seededCard = (await api(s, 'GET', `/watches/${seeded.id}`)).json.card;
    expect(seededCard).toMatchObject({ status: 'paused', build: { bundles: 51 }, pages: { tracked: 17, known: 18, dynamic: 1 }, subdomains: { known: 3, live: 2 } });
    expect((await api(s, 'GET', `/watches/${seeded.id}/history?limit=10`)).json.nextBefore).not.toBeNull();
    expect((await api(s, 'GET', '/guild')).json.channels.map((c: { name: string }) => c.name)).toEqual(['scans', 'alerts', 'announcements']);

    // Management goes through the real scheduler; Discord notices are printed.
    let r = await api(s, 'POST', `/watches/${fixture.id}/pause`);
    expect(r.json.card.runtime.running).toBe(false);
    r = await api(s, 'PATCH', `/watches/${fixture.id}`, { paused: false, channelId: DEV_CHANNELS.alerts });
    expect(r.json.changed).toEqual(['channelId', 'paused']);
    expect(s.monitor.runtimeInfo(fixture.id).running).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lines.some((l) => l.startsWith('[discord #alerts] 📢 Alerts for **Fixture**'))).toBe(true);

    // The other server's token sees none of it.
    expect((await api(s, 'GET', `/watches/${fixture.id}`, undefined, DEFAULT_DEV_OTHER_TOKEN)).status).toBe(404);
    const other = s.watches.find((w) => w.guildId !== DEV_GUILD_ID)!;
    expect((await api(s, 'GET', `/watches/${other.id}`)).status).toBe(404);
    expect((await api(s, 'GET', '/ping', undefined, 'swb_' + 'x'.repeat(43))).status).toBe(401);

    // #mod-logs is private: not offered, and refused as an alert channel.
    r = await api(s, 'PATCH', `/watches/${fixture.id}`, { channelId: DEV_CHANNELS.modlogs });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: 'invalid_channel', field: 'channelId' });

    // The demoted creator's token reads, but every management write is 403.
    expect(s.demotedToken).toBe(DEFAULT_DEV_DEMOTED_TOKEN);
    expect((await api(s, 'GET', `/watches/${fixture.id}`, undefined, s.demotedToken)).status).toBe(200);
    r = await api(s, 'POST', `/watches/${fixture.id}/pause`, undefined, s.demotedToken);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('forbidden');
    expect((await api(s, 'DELETE', `/watches/${fixture.id}`, undefined, s.demotedToken)).status).toBe(403);
    expect(s.store.getWatch(fixture.id)?.paused).toBe(false);
  });
});
