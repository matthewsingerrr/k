/**
 * API tracking (JSON endpoints found in site code are tracked and diffed) and polite behaviour while a site walls the
 * watcher off with a bot challenge — end to end through Monitor against a fake site on 127.0.0.1.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { HttpClient } from '../src/net/http.js';
import { silentLogger } from '../src/log.js';
import { Monitor } from '../src/monitor/scheduler.js';
import { apiCandidates } from '../src/monitor/api.js';
import { isWalledOff } from '../src/monitor/status.js';
import { jsonLines, looksLikeJson } from '../src/extract/json.js';
import type { Alert, InfoAlert, Notifier, TextAlert, Watch } from '../src/types.js';

const site = {
  count: { count: 705, status: 'live' } as Record<string, unknown>,
  walled: false,
  hits: new Map<string, number>(),
};

const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  site.hits.set(path, (site.hits.get(path) ?? 0) + 1);
  if (site.walled) {
    res.writeHead(403, { 'content-type': 'text/html', 'x-vercel-mitigated': 'challenge', server: 'Vercel' });
    res.end('<!doctype html><title>Vercel Security Checkpoint</title>');
    return;
  }
  if (path === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><title>Pad</title><script src="/_next/static/chunks/app-1.js"></script></head><body><h1>Pad</h1><p>Launch tokens.</p></body></html>');
  } else if (path === '/_next/static/chunks/app-1.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end('let a="/api/launches/count",b="/api/flywheel",c="/api/auth/session",d="/api/[id]";fetch(a);fetch(b);');
  } else if (path === '/api/launches/count') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(site.count));
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

let origin = '';
let store: Store;
let monitor: Monitor;
let watch: Watch;
const delivered: Alert[][] = [];
const clock = { now: 1_800_000_000_000 };

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await monitor?.stop();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  await monitor?.stop();
  site.count = { count: 705, status: 'live' };
  site.walled = false;
  site.hits.clear();
  delivered.length = 0;
  store = new Store(':memory:');
  const config = testConfig({ confirmDelayMs: 0 });
  const client = new HttpClient({ userAgent: 'test', globalConcurrency: 8, perHostConcurrency: 8, timeoutMs: 5000, maxBytes: 5e6, allowPrivate: true });
  const notifier: Notifier = { notify: async (_w, alerts) => void delivered.push(alerts) };
  monitor = new Monitor({
    store,
    http: client,
    notifier,
    config,
    log: silentLogger,
    providers: {
      ct: { certspotter: async () => ({ names: [], cursor: null }), crtsh: async () => [] },
      dns: { resolve: async () => null, wildcard: async () => null },
    },
    now: () => clock.now,
    sleep: async () => {},
  });
  watch = store.createWatch({
    guildId: 'g', channelId: 'c', name: 'Pad', url: `${origin}/`, host: '127.0.0.1', rootDomain: '127.0.0.1', createdBy: 'u',
    intervalSec: 2, sweepSec: 60, features: { subdomains: false },
  });
  await monitor.runBaseline(watch.id);
});

const tick = async (full = true) => {
  clock.now += 61_000;
  return (await monitor.checkNow(watch.id, { full })).alerts;
};

describe('JSON helpers', () => {
  it('canonicalises JSON (sorted keys, pretty lines) and recognises JSON bodies', () => {
    expect(jsonLines('{"b":1,"a":{"d":2,"c":[3]}}')).toEqual(['{', '  "a": {', '    "c": [', '      3', '    ],', '    "d": 2', '  },', '  "b": 1', '}']);
    expect(jsonLines('nope')).toBeNull();
    expect(looksLikeJson('application/json', '{}')).toBe(true);
    expect(looksLikeJson(null, ' [1]')).toBe(true);
    expect(looksLikeJson('text/html', '{}')).toBe(false);
    expect(apiCandidates(['/api/launches/count', '/api/auth/session', '/api/[id]', '/docs', '/v1/api/x', '/api/'])).toEqual([
      '/api/launches/count',
      '/v1/api/x',
    ]);
  });
});

describe('API tracking', () => {
  it('tracks JSON endpoints found in code silently at baseline, then posts a JSON diff when the response changes', async () => {
    const rec = store.getPage(watch.id, `${origin}/api/launches/count`);
    expect(rec).toMatchObject({ tracked: true, source: 'code', kind: 'page' });
    expect(store.getPage(watch.id, `${origin}/api/flywheel`)).toBeUndefined(); // 404 → not tracked
    expect(site.hits.get('/api/auth/session') ?? 0).toBe(0); // never probed
    expect(delivered).toEqual([]);

    expect(await tick()).toEqual([]); // stable → silent
    site.count = { count: 705, status: 'paused', paused_at: 'today' };
    const alerts = await tick();
    const text = alerts.find((a): a is TextAlert => a.kind === 'text');
    expect(text?.changes.map((c) => c.url)).toEqual([`${origin}/api/launches/count`]);
    const unified = text!.changes[0].diff.unified;
    expect(unified).toContain('- "status": "live"');
    expect(unified).toContain('+ "status": "paused"');
    expect(unified).toContain('+ "paused_at": "today",');
  });

  it('announces endpoints it starts tracking after the baseline once', async () => {
    store.deletePage(watch.id, `${origin}/api/launches/count`);
    const st = store.getState(watch.id);
    st.apiProbed = [];
    store.saveState(watch.id, st);
    // Rebuild the monitor's in-memory state from the store.
    monitor.onWatchRemoved(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    const alerts = await tick();
    const info = alerts.filter((a): a is InfoAlert => a.kind === 'info');
    expect(info).toHaveLength(1);
    expect(info[0].message).toMatch(/Now tracking an API endpoint .*`\/api\/launches\/count`/);
    expect(alerts.filter((a) => a.kind === 'text')).toEqual([]);
    expect((await tick()).filter((a) => a.kind === 'info')).toEqual([]);
  });
});

describe('bot challenge', () => {
  it('stops crawling while walled off, posts one note, and says when it is let back in', async () => {
    site.walled = true;
    const notes: string[] = [];
    for (let i = 0; i < 4; i++) for (const a of await tick()) if (a.kind === 'info') notes.push(a.message);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/blocking the watcher with its Vercel bot check/);
    expect(isWalledOff(store.getState(watch.id))).toBe(true);
    // Only the homepage was asked while walled off: no page sweep, API or bundle requests.
    const others = [...site.hits.entries()].filter(([p]) => p !== '/');
    site.hits.clear();
    await tick();
    expect([...site.hits.keys()]).toEqual(['/']);
    expect(others.length).toBeGreaterThan(0); // (baseline traffic from before the wall)

    site.walled = false;
    const back = (await tick()).filter((a): a is InfoAlert => a.kind === 'info');
    expect(back.map((a) => a.message)).toEqual([expect.stringMatching(/letting the watcher in again/)]);
    expect(isWalledOff(store.getState(watch.id))).toBe(false);
  });
});
