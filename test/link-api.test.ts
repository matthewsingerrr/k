/**
 * Link API (/api/v1): a real HTTP server on 127.0.0.1 with the handler, a real in-memory Store, a fake Monitor and a fake
 * scan function. Nothing here touches the public internet.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig, type Config } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { createLinkApi, MAX_BODY_BYTES, type LinkApiDeps } from '../src/link/api.js';
import { ScanInputError, type ScanDeps, type ScanOptions } from '../src/link/scan.js';
import type { ScanResult } from '../src/link/types.js';
import type { BaselineSummary, Monitor, TickSummary } from '../src/monitor/scheduler.js';
import type { Alert, Logger, Watch } from '../src/types.js';

const G1 = '100000000000000001';
const G2 = '100000000000000002';
const C1 = '200000000000000001';
const C2 = '200000000000000002';

// ---------------------------------------------------------------------------
// Fakes & harness
// ---------------------------------------------------------------------------

interface LogEntry {
  level: string;
  msg: string;
  meta?: Record<string, unknown>;
}

function spyLogger(entries: LogEntry[]): Logger {
  const log: Logger = {
    debug: (msg, meta) => entries.push({ level: 'debug', msg, meta }),
    info: (msg, meta) => entries.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => entries.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => entries.push({ level: 'error', msg, meta }),
    child: () => log,
  };
  return log;
}

function summaryFor(id: number, over: Partial<BaselineSummary> = {}): BaselineSummary {
  return {
    watchId: id,
    pagesTracked: 12,
    pagesKnown: 40,
    files: 2,
    subdomains: 5,
    buildId: 'KU79abcdefghijklmnop',
    assets: 23,
    homeStatus: 200,
    homeBlocked: false,
    durationMs: 4200,
    ...over,
  };
}

function fakeMonitor(store: Store) {
  const timeline: string[] = [];
  const calls = { baseline: [] as number[], added: [] as Watch[], removed: [] as number[], checkNow: [] as number[] };
  let releaseBaseline: (() => void) | null = null;
  const m = {
    calls,
    timeline,
    /** When true, runBaseline waits until release() is called. */
    holdBaseline: false,
    release() {
      releaseBaseline?.();
    },
    checkResult: (id: number): Promise<TickSummary> => Promise.resolve({ watchId: id, alerts: [], durationMs: 5, error: null }),
    async runBaseline(id: number): Promise<BaselineSummary> {
      calls.baseline.push(id);
      timeline.push(`baseline:${id}`);
      if (m.holdBaseline) await new Promise<void>((r) => (releaseBaseline = r));
      store.updateWatch(id, { baselineDone: true });
      return summaryFor(id);
    },
    onWatchAdded(w: Watch) {
      calls.added.push(w);
      timeline.push(`added:${w.id}`);
    },
    onWatchRemoved(id: number) {
      calls.removed.push(id);
    },
    onWatchUpdated() {},
    checkNow(id: number) {
      calls.checkNow.push(id);
      return m.checkResult(id);
    },
    runtimeInfo: () => ({ running: true, lastTickAt: null, lastTickMs: null, nextTickAt: null, baselineRunning: false }),
    lastActivityAt: () => null,
  };
  return m;
}

function scanResult(url: string, over: Partial<ScanResult> = {}): ScanResult {
  return {
    url,
    finalUrl: url,
    host: 'unpeg.io',
    rootDomain: 'unpeg.io',
    status: 200,
    blocked: false,
    error: null,
    title: 'Unpeg',
    description: null,
    ogImage: null,
    tech: [{ name: 'Next.js', category: 'framework', version: null, evidence: 'x-powered-by header' }],
    build: { id: 'abc', assets: 3, generator: null },
    server: { server: 'Vercel', poweredBy: null, ips: ['76.76.21.21'] },
    apiEndpoints: ['/api/launches'],
    codeHosts: ['api.unpeg.io'],
    subdomains: [],
    socials: [{ kind: 'x', url: 'https://x.com/unpeg' }],
    links: { internal: 4, external: 2 },
    watched: null,
    scannedAt: new Date(0).toISOString(),
    elapsedMs: 12,
    ...over,
  };
}

interface Harness {
  base: string;
  store: Store;
  monitor: ReturnType<typeof fakeMonitor>;
  announced: Array<{ channelId: string; content: string }>;
  scanCalls: Array<{ deps: ScanDeps; url: string; opts: ScanOptions }>;
  logs: LogEntry[];
  clock: { t: number };
  setScan(fn: (url: string) => Promise<ScanResult>): void;
  token: string;
  tokenId: number;
  token2: string;
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  vi.restoreAllMocks();
});

async function setup(
  opts: { config?: Partial<Config>; monitor?: boolean; isGuildActive?: (guildId: string) => boolean; isRestoring?: () => boolean } = {},
): Promise<Harness> {
  const store = new Store(':memory:');
  const config = testConfig({ defaultIntervalSec: 30, minIntervalSec: 5, ...opts.config });
  const monitor = fakeMonitor(store);
  const announced: Harness['announced'] = [];
  const scanCalls: Harness['scanCalls'] = [];
  const logs: LogEntry[] = [];
  const clock = { t: 1_700_000_000_000 };
  let scanImpl: (url: string) => Promise<ScanResult> = async (url) => scanResult(url);
  const deps: LinkApiDeps = {
    store,
    config,
    log: spyLogger(logs),
    getMonitor: () => (opts.monitor === false ? null : (monitor as unknown as Monitor)),
    scan: { http: {} as never, dns: {} as never, ct: {} as never },
    announce: async (channelId, content) => {
      announced.push({ channelId, content });
    },
    scanFn: async (d, url, o) => {
      scanCalls.push({ deps: d, url, opts: o });
      return scanImpl(url);
    },
    now: () => clock.t,
    isGuildActive: opts.isGuildActive,
    isRestoring: opts.isRestoring,
  };
  const handler = createLinkApi(deps);
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(418).end('fallthrough');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token, record } = store.createLinkToken({ guildId: G1, channelId: C1, label: 'Arkham Dev Tags', createdBy: 'u1' });
  const { token: token2 } = store.createLinkToken({ guildId: G2, channelId: C2, label: 'Other', createdBy: 'u2' });
  return {
    base,
    store,
    monitor,
    announced,
    scanCalls,
    logs,
    clock,
    setScan: (fn) => (scanImpl = fn),
    token,
    tokenId: record.id,
    token2,
  };
}

async function call(
  h: Harness,
  method: string,
  path: string,
  body?: unknown,
  opts: { token?: string | null; headers?: Record<string, string>; raw?: string } = {},
): Promise<{ status: number; headers: Headers; json: any }> {
  const headers: Record<string, string> = { ...opts.headers };
  const token = opts.token === undefined ? h.token : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (opts.raw !== undefined) payload = opts.raw;
  else if (body !== undefined) payload = JSON.stringify(body);
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${h.base}/api/v1${path}`, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

function addWatch(store: Store, guildId: string, url: string, name?: string): Watch {
  const host = new URL(url).hostname;
  return store.createWatch({ guildId, channelId: C1, name: name ?? host, url, host, rootDomain: host, createdBy: 'u1' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Link API: routing, auth & CORS', () => {
  it('falls through for paths outside /api/v1', async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/health`);
    expect(res.status).toBe(418);
    const res2 = await fetch(`${h.base}/api/v10/ping`);
    expect(res2.status).toBe(418);
  });

  it('answers 503 + Retry-After for unknown tokens while the backup restore is still running', async () => {
    let restoring = true;
    const h = await setup({ isRestoring: () => restoring });
    let r = await call(h, 'GET', '/ping', undefined, { token: 'swb_' + 'B'.repeat(43) });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('unavailable');
    expect(r.headers.get('retry-after')).toBe('15');
    expect((await call(h, 'GET', '/ping')).status).toBe(200); // known tokens work meanwhile
    restoring = false;
    r = await call(h, 'GET', '/ping', undefined, { token: 'swb_' + 'B'.repeat(43) });
    expect(r.status).toBe(401);
  });

  it('rejects missing, malformed, unknown and revoked tokens with 401', async () => {
    const h = await setup();
    let r = await call(h, 'GET', '/ping', undefined, { token: null });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('unauthorized');
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');

    r = await call(h, 'GET', '/ping', undefined, { token: h.token.replace(/^swb_/, 'xyz_') });
    expect(r.status).toBe(401);
    r = await call(h, 'GET', '/ping', undefined, { token: 'swb_' + 'A'.repeat(43) });
    expect(r.status).toBe(401);
    r = await call(h, 'GET', '/ping', undefined, { token: null, headers: { authorization: `Basic ${h.token}` } });
    expect(r.status).toBe(401);

    expect((await call(h, 'GET', '/ping')).status).toBe(200);
    expect(h.store.revokeLinkToken(G1, h.tokenId)).toBe(1);
    r = await call(h, 'GET', '/ping');
    expect(r.status).toBe(401);
    expect(r.json.error.message).toMatch(/revoked/i);
  });

  it('401s tokens of a server the bot has left, or of other servers when locked to DISCORD_GUILD_ID', async () => {
    const present = new Set([G1]);
    const h = await setup({ isGuildActive: (g) => present.has(g) });
    expect((await call(h, 'GET', '/ping')).status).toBe(200);
    let r = await call(h, 'GET', '/ping', undefined, { token: h.token2 });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('unauthorized');
    expect(r.json.error.message).toMatch(/no longer in this token's Discord server/);
    r = await call(h, 'POST', '/watches', { url: 'unpeg.io' }, { token: h.token2 });
    expect(r.status).toBe(401);
    expect(h.store.listWatches(G2)).toHaveLength(0);
    present.delete(G1); // kicked
    expect((await call(h, 'GET', '/ping')).status).toBe(401);

    // A throwing probe (Discord not connected) doesn't lock anyone out.
    const h2 = await setup({
      isGuildActive: () => {
        throw new Error('not ready');
      },
    });
    expect((await call(h2, 'GET', '/ping')).status).toBe(200);

    const locked = await setup({ config: { discordGuildId: G1 } });
    expect((await call(locked, 'GET', '/ping')).status).toBe(200);
    expect((await call(locked, 'GET', '/ping', undefined, { token: locked.token2 })).status).toBe(401);
  });

  it('accepts X-Link-Token and records token use at most once a minute', async () => {
    const h = await setup();
    const r = await call(h, 'GET', '/ping', undefined, { token: null, headers: { 'x-link-token': h.token } });
    expect(r.status).toBe(200);
    const used = h.store.listLinkTokens(G1)[0].lastUsedAt;
    expect(used).toBe(h.clock.t);
    h.clock.t += 30_000;
    await call(h, 'GET', '/ping');
    expect(h.store.listLinkTokens(G1)[0].lastUsedAt).toBe(used);
    h.clock.t += 31_000;
    await call(h, 'GET', '/ping');
    expect(h.store.listLinkTokens(G1)[0].lastUsedAt).toBe(h.clock.t);
  });

  it('answers OPTIONS preflights without auth and puts CORS headers on every response', async () => {
    const h = await setup();
    const pre = await fetch(`${h.base}/api/v1/watches`, {
      method: 'OPTIONS',
      headers: { origin: 'chrome-extension://abc', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type, X-Link-Token');
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE, OPTIONS');
    expect(pre.headers.get('access-control-max-age')).toBe('600');

    for (const r of [await call(h, 'GET', '/ping'), await call(h, 'GET', '/ping', undefined, { token: null }), await call(h, 'GET', '/nope')]) {
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
      expect(r.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE, OPTIONS');
    }
  });

  it('404s unknown routes and 405s wrong methods', async () => {
    const h = await setup();
    let r = await call(h, 'GET', '/nope');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('not_found');
    r = await call(h, 'GET', '');
    expect(r.status).toBe(404);
    r = await call(h, 'DELETE', '/ping');
    expect(r.status).toBe(405);
    expect(r.json.error.code).toBe('method_not_allowed');
    expect(r.headers.get('allow')).toBe('GET, OPTIONS');
    r = await call(h, 'PUT', '/watches');
    expect(r.status).toBe(405);
    r = await call(h, 'GET', '/scan');
    expect(r.status).toBe(405);
  });

  it('pings with the token’s guild, channel and label', async () => {
    const h = await setup();
    addWatch(h.store, G1, 'https://a.io/');
    addWatch(h.store, G2, 'https://b.io/');
    const r = await call(h, 'GET', '/ping/');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      bot: 'site-watcher',
      apiVersion: 1,
      guild: { id: G1 },
      channelId: C1,
      label: 'Arkham Dev Tags',
      watches: 1,
    });
    expect(typeof r.json.version).toBe('string');
  });
});

describe('Link API: request bodies', () => {
  it('413s bodies over 32 KB (declared or streamed) and 400s bad JSON', async () => {
    const h = await setup();
    const big = JSON.stringify({ url: 'unpeg.io', pad: 'x'.repeat(MAX_BODY_BYTES) });
    let r = await call(h, 'POST', '/watches', undefined, { raw: big });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe('too_large');

    // Chunked upload without content-length.
    const streamed = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(`${h.base}/api/v1/scan`, {
        method: 'POST',
        headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      for (let i = 0; i < 5; i++) req.write('x'.repeat(10_000));
      req.end();
    });
    expect(streamed.status).toBe(413);
    expect(JSON.parse(streamed.body).error.code).toBe('too_large');
    expect(h.scanCalls).toHaveLength(0);

    r = await call(h, 'POST', '/watches', undefined, { raw: '{"url": "unpeg.io",' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('bad_request');
    r = await call(h, 'POST', '/watches', undefined, { raw: '["unpeg.io"]' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('bad_request');
    expect(h.store.listWatches()).toHaveLength(0);
  });
});

describe('Link API: rate limits', () => {
  it('limits 120 requests/min per token with Retry-After, independently per token', async () => {
    const h = await setup();
    for (let i = 0; i < 120; i++) expect((await call(h, 'GET', '/ping')).status).toBe(200);
    const r = await call(h, 'GET', '/ping');
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe('rate_limited');
    const retry = Number(r.headers.get('retry-after'));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(r.headers.get('access-control-expose-headers')).toMatch(/Retry-After/);
    // Another token is unaffected.
    expect((await call(h, 'GET', '/ping', undefined, { token: h.token2 })).status).toBe(200);
    // Time heals.
    h.clock.t += retry * 1000;
    expect((await call(h, 'GET', '/ping')).status).toBe(200);
  });

  it('limits scans to 20 per 10 minutes', async () => {
    const h = await setup();
    for (let i = 0; i < 20; i++) expect((await call(h, 'POST', '/scan', { url: 'unpeg.io' })).status).toBe(200);
    const r = await call(h, 'POST', '/scan', { url: 'unpeg.io' });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(h.scanCalls).toHaveLength(20);
    // Pings still work (only the scan bucket is empty).
    expect((await call(h, 'GET', '/ping')).status).toBe(200);
    h.clock.t += 30_000;
    expect((await call(h, 'POST', '/scan', { url: 'unpeg.io' })).status).toBe(200);
  });
});

describe('Link API: /scan', () => {
  it('passes the scan through with the shared deps, guild and subdomain mode', async () => {
    const h = await setup();
    let r = await call(h, 'POST', '/scan', { url: 'unpeg.io' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ url: 'unpeg.io', host: 'unpeg.io', tech: [{ name: 'Next.js' }], apiEndpoints: ['/api/launches'] });
    expect(h.scanCalls[0].opts).toEqual({ guildId: G1, subdomains: 'quick' });
    expect(h.scanCalls[0].deps.store).toBe(h.store);
    expect(h.scanCalls[0].deps).toHaveProperty('http');
    expect(h.scanCalls[0].deps).toHaveProperty('dns');
    expect(h.scanCalls[0].deps).toHaveProperty('ct');
    expect(h.scanCalls[0].deps).toHaveProperty('config');

    r = await call(h, 'POST', '/scan', { url: 'https://unpeg.io/docs', subdomains: 'full' });
    expect(r.status).toBe(200);
    expect(h.scanCalls[1].opts.subdomains).toBe('full');
    r = await call(h, 'POST', '/scan', { url: 'https://unpeg.io/', subdomains: 'all' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('bad_request');
  });

  it('400s invalid urls without scanning and 502s scan failures', async () => {
    const h = await setup();
    for (const body of [{}, { url: 'not a url' }, { url: 'javascript:alert(1)' }, { url: 42 }, { url: 'nodot' }]) {
      const r = await call(h, 'POST', '/scan', body);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('invalid_url');
    }
    expect(h.scanCalls).toHaveLength(0);

    // scanSite reports network trouble inside its result; a throw is a bug: 502 with a generic message, details logged.
    h.setScan(async () => {
      throw new Error('SQLITE_BUSY: database is locked at /data/watcher.db');
    });
    let r = await call(h, 'POST', '/scan', { url: 'unpeg.io' });
    expect(r.status).toBe(502);
    expect(r.json.error.code).toBe('scan_failed');
    expect(r.json.error.message).toBe('The scan failed unexpectedly — try again in a minute.');
    expect(JSON.stringify(r.json)).not.toMatch(/SQLITE|watcher\.db/);
    expect(h.logs.some((l) => l.level === 'warn' && String(l.meta?.err).includes('SQLITE_BUSY'))).toBe(true);

    // The scanner's own input refusal maps to 400 invalid_url with its message.
    h.setScan(async () => {
      throw new ScanInputError('"x" doesn\'t look like a website URL — try something like unpeg.io.');
    });
    r = await call(h, 'POST', '/scan', { url: 'unpeg.io' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('invalid_url');
    expect(r.json.error.message).toMatch(/website URL/);
  });

  it('refuses private / internal targets (SSRF) for scans and adds unless ALLOW_PRIVATE_NETWORK', async () => {
    const h = await setup({ config: { allowPrivateNetwork: false } });
    const targets = ['localhost:3000', 'http://127.0.0.1:8080/', '10.0.0.5', '169.254.169.254', 'postgres.railway.internal', 'http://[::1]/', 'nas.local'];
    for (const url of targets) {
      let r = await call(h, 'POST', '/scan', { url });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('invalid_url');
      expect(r.json.error.message).toMatch(/private or internal address/);
      r = await call(h, 'POST', '/watches', { url });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('invalid_url');
    }
    expect(h.scanCalls).toHaveLength(0);
    expect(h.store.listWatches()).toHaveLength(0);
    // Public sites still work.
    expect((await call(h, 'POST', '/scan', { url: 'unpeg.io' })).status).toBe(200);
    expect((await call(h, 'POST', '/watches', { url: 'unpeg.io' })).status).toBe(201);

    // Self-hosting (ALLOW_PRIVATE_NETWORK=true, as in testConfig): allowed.
    const open = await setup();
    expect((await call(open, 'POST', '/scan', { url: 'localhost:3000' })).status).toBe(200);
  });
});

describe('Link API: /watches', () => {
  it('creates a watch (201), runs its first scan in the background and announces both steps', async () => {
    const h = await setup();
    h.monitor.holdBaseline = true;
    const r = await call(h, 'POST', '/watches', { url: 'https://unpeg.io/', features: { files: false, subdomains: false } });
    expect(r.status).toBe(201);
    expect(r.json.created).toBe(true);
    const w = r.json.watch;
    expect(w).toMatchObject({
      name: 'Unpeg',
      url: 'https://unpeg.io/',
      host: 'unpeg.io',
      channelId: C1,
      intervalSec: 30,
      paused: false,
      status: 'scanning',
      lastCheckAt: null,
      lastChangeAt: null,
      pagesTracked: 0,
      subdomains: 0,
    });
    expect(w.features).toMatchObject({ files: false, subdomains: false, deploy: true, text: true });
    const stored = h.store.getWatch(w.id)!;
    expect(stored.guildId).toBe(G1);
    expect(stored.createdBy).toBe('link:Arkham Dev Tags');
    expect(stored.features.files).toBe(false);

    await vi.waitFor(() => expect(h.announced).toHaveLength(1));
    expect(h.announced[0]).toEqual({
      channelId: C1,
      content: '➕ **Unpeg** (<https://unpeg.io/>) was added from **Arkham Dev Tags** — first scan running…',
    });
    expect(h.monitor.calls.baseline).toEqual([w.id]);
    expect(h.monitor.calls.added).toHaveLength(0); // not started before its baseline

    h.monitor.release();
    await vi.waitFor(() => expect(h.announced).toHaveLength(2));
    expect(h.monitor.timeline).toEqual([`baseline:${w.id}`, `added:${w.id}`]);
    expect(h.announced[1].channelId).toBe(C1);
    expect(h.announced[1].content).toMatch(/^✅ Now watching \*\*Unpeg\*\* \(<https:\/\/unpeg\.io\/>\) — 12 pages, 2 files, build `KU79abcd…` · every 30s\.$/);

    const g = await call(h, 'GET', `/watches/${w.id}`);
    expect(g.json.watch.status).toBe('up');
    expect(h.logs.some((l) => l.level === 'info' && l.meta?.action === 'add' && l.meta?.label === 'Arkham Dev Tags' && l.meta?.guild === G1)).toBe(true);
  });

  it('answers 200 created:false for a site the guild already watches (any scheme)', async () => {
    const h = await setup();
    const first = await call(h, 'POST', '/watches', { url: 'unpeg.io' });
    expect(first.status).toBe(201);
    for (const url of ['unpeg.io', 'http://unpeg.io/', 'https://unpeg.io']) {
      const r = await call(h, 'POST', '/watches', { url });
      expect(r.status).toBe(200);
      expect(r.json.created).toBe(false);
      expect(r.json.watch.id).toBe(first.json.watch.id);
    }
    // "www." on the site root is the same site too (matches ?url= and scan.watched).
    const www = await call(h, 'POST', '/watches', { url: 'https://www.unpeg.io/' });
    expect(www.status).toBe(200);
    expect(www.json.watch.id).toBe(first.json.watch.id);
    // ...but a sub-page is its own watch.
    expect((await call(h, 'POST', '/watches', { url: 'https://www.unpeg.io/docs' })).status).toBe(201);
    h.store.deleteWatch(h.store.listWatches(G1).find((w) => w.url.endsWith('/docs'))!.id);
    expect(h.store.listWatches(G1)).toHaveLength(1);
    // The other guild can add the same site independently.
    const other = await call(h, 'POST', '/watches', { url: 'unpeg.io' }, { token: h.token2 });
    expect(other.status).toBe(201);
    expect(other.json.watch.channelId).toBe(C2);
  });

  it('enforces the per-guild limit with 409', async () => {
    const h = await setup({ config: { maxWatchesPerGuild: 2 } });
    expect((await call(h, 'POST', '/watches', { url: 'a.io' })).status).toBe(201);
    expect((await call(h, 'POST', '/watches', { url: 'b.io' })).status).toBe(201);
    const r = await call(h, 'POST', '/watches', { url: 'c.io' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('limit_reached');
    // Duplicates still answer 200 at the limit.
    expect((await call(h, 'POST', '/watches', { url: 'a.io' })).status).toBe(200);
  });

  it('validates url, interval, name and features; clamps intervals; makes names unique', async () => {
    const h = await setup();
    let r = await call(h, 'POST', '/watches', { url: 'ftp://x.io' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('invalid_url');
    for (const intervalSec of ['30', -5, 0, { x: 1 }, true]) {
      r = await call(h, 'POST', '/watches', { url: 'unpeg.io', intervalSec });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('invalid_interval');
    }

    r = await call(h, 'POST', '/watches', { url: 'unpeg.io', features: { text: 'yes' } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('bad_request');
    r = await call(h, 'POST', '/watches', { url: 'unpeg.io', name: '123' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('bad_request');
    expect(h.store.listWatches(G1)).toHaveLength(0);

    r = await call(h, 'POST', '/watches', { url: 'unpeg.io', intervalSec: 99_999, name: 'Unpeg' });
    expect(r.status).toBe(201);
    expect(r.json.watch.intervalSec).toBe(3600);
    r = await call(h, 'POST', '/watches', { url: 'unpeg.io/docs', intervalSec: 1, name: 'Unpeg' });
    expect(r.status).toBe(201);
    expect(r.json.watch.intervalSec).toBe(5);
    expect(r.json.watch.name).toBe('Unpeg 2');
    r = await call(h, 'POST', '/watches', { url: 'docs.unpeg.io' });
    expect(r.status).toBe(201);
    expect(r.json.watch.name).toBe('Unpeg docs');
  });

  it('503s adds while the monitor is not running yet', async () => {
    const h = await setup({ monitor: false });
    const r = await call(h, 'POST', '/watches', { url: 'unpeg.io' });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('unavailable');
    expect(h.store.listWatches()).toHaveLength(0);
  });

  it('lists only the guild’s watches and filters by url / host', async () => {
    const h = await setup();
    const a = addWatch(h.store, G1, 'https://unpeg.io/', 'Unpeg');
    addWatch(h.store, G1, 'https://other.io/', 'Other');
    addWatch(h.store, G2, 'https://unpeg.io/', 'Theirs');
    h.store.updateWatch(a.id, { baselineDone: true });

    let r = await call(h, 'GET', '/watches');
    expect(r.status).toBe(200);
    expect(r.json.watches.map((w: { name: string }) => w.name)).toEqual(['Unpeg', 'Other']);
    expect(r.json).not.toHaveProperty('watched');
    expect(r.json.watches[0].status).toBe('up');
    expect(r.json.watches[1].status).toBe('scanning');

    r = await call(h, 'GET', `/watches?url=${encodeURIComponent('https://www.unpeg.io/some/page?x=1')}`);
    expect(r.json.watched).toBe(true);
    expect(r.json.watches.map((w: { id: number }) => w.id)).toEqual([a.id]);
    r = await call(h, 'GET', '/watches?url=nothere.io');
    expect(r.json).toEqual({ watches: [], watched: false });
    r = await call(h, 'GET', '/watches?url=%20');
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('invalid_url');
  });

  it('reports paused / down / blocked status and counts', async () => {
    const h = await setup();
    const w = addWatch(h.store, G1, 'https://unpeg.io/');
    h.store.updateWatch(w.id, { baselineDone: true });
    const st = h.store.getState(w.id);
    st.status.up = false;
    st.lastCheckAt = 111;
    st.lastChangeAt = 222;
    h.store.saveState(w.id, st);
    let r = await call(h, 'GET', `/watches/${w.id}`);
    expect(r.json.watch).toMatchObject({ status: 'down', lastCheckAt: 111, lastChangeAt: 222 });
    st.status.up = true;
    st.status.consecutiveBlocked = 99;
    h.store.saveState(w.id, st);
    r = await call(h, 'GET', `/watches/${w.id}`);
    expect(r.json.watch.status).toBe('blocked');
    h.store.updateWatch(w.id, { paused: true });
    r = await call(h, 'GET', `/watches/${w.id}`);
    expect(r.json.watch).toMatchObject({ status: 'paused', paused: true });
  });
});

describe('Link API: /watches/:id', () => {
  it('returns the watch with its newest 20 events, and 404s other guilds and junk ids', async () => {
    const h = await setup();
    const mine = addWatch(h.store, G1, 'https://unpeg.io/', 'Unpeg');
    const theirs = addWatch(h.store, G2, 'https://secret.io/', 'Secret');
    for (let i = 1; i <= 25; i++) h.store.addEvent(mine.id, 'deploy', `deploy ${i}`, 1000 + i);
    h.store.addEvent(theirs.id, 'text', 'secret change', 5000);

    const r = await call(h, 'GET', `/watches/${mine.id}`);
    expect(r.status).toBe(200);
    expect(r.json.watch.id).toBe(mine.id);
    expect(r.json.events).toHaveLength(20);
    expect(r.json.events[0]).toMatchObject({ watchId: mine.id, watchName: 'Unpeg', watchUrl: 'https://unpeg.io/', kind: 'deploy', summary: 'deploy 25' });

    for (const path of [`/watches/${theirs.id}`, '/watches/99999', '/watches/abc', `/watches/0${mine.id}`, `/watches/${mine.id}.0`, '/watches/1e1']) {
      const x = await call(h, 'GET', path);
      expect(x.status, path).toBe(404);
      expect(x.json.error.code).toBe('not_found');
    }
    expect(JSON.stringify(await call(h, 'GET', '/watches'))).not.toContain('secret');
  });

  it('deletes only the guild’s own watches, stops them and announces the removal', async () => {
    const h = await setup();
    const mine = addWatch(h.store, G1, 'https://unpeg.io/', 'Unpeg');
    const theirs = addWatch(h.store, G2, 'https://secret.io/', 'Secret');

    let r = await call(h, 'DELETE', `/watches/${theirs.id}`);
    expect(r.status).toBe(404);
    expect(h.store.getWatch(theirs.id)).toBeDefined();
    expect(h.monitor.calls.removed).toEqual([]);

    r = await call(h, 'DELETE', `/watches/${mine.id}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ deleted: true });
    expect(h.store.getWatch(mine.id)).toBeUndefined();
    expect(h.monitor.calls.removed).toEqual([mine.id]);
    await vi.waitFor(() => expect(h.announced).toHaveLength(1));
    expect(h.announced[0]).toEqual({ channelId: C1, content: '➖ **Unpeg** was removed from **Arkham Dev Tags**' });
    expect(h.logs.some((l) => l.level === 'info' && l.meta?.action === 'remove' && l.meta?.watchId === mine.id)).toBe(true);

    r = await call(h, 'DELETE', `/watches/${mine.id}`);
    expect(r.status).toBe(404);
  });

  it('runs a check and reports alert count, kinds and error; 404s other guilds', async () => {
    const h = await setup();
    const mine = addWatch(h.store, G1, 'https://unpeg.io/');
    const theirs = addWatch(h.store, G2, 'https://secret.io/');
    const alert = (kind: Alert['kind']) => ({ kind }) as Alert;
    h.monitor.checkResult = async (id) => ({ watchId: id, alerts: [alert('deploy'), alert('text'), alert('deploy')], durationMs: 9, error: null });

    let r = await call(h, 'POST', `/watches/${mine.id}/check`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ alerts: 3, kinds: ['deploy', 'text'], error: null });
    expect(h.monitor.calls.checkNow).toEqual([mine.id]);

    // A second manual check right away is throttled per site.
    r = await call(h, 'POST', `/watches/${mine.id}/check`);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('30');
    h.clock.t += 31_000;

    h.monitor.checkResult = async () => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    };
    r = await call(h, 'POST', `/watches/${mine.id}/check`, {});
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ alerts: 0, kinds: [], error: 'The check could not run — try again in a minute.' });
    expect(h.logs.some((l) => l.level === 'warn' && String(l.meta?.err).includes('SQLITE_IOERR'))).toBe(true);

    r = await call(h, 'POST', `/watches/${theirs.id}/check`);
    expect(r.status).toBe(404);
    expect(h.monitor.calls.checkNow).toEqual([mine.id, mine.id]);
  });
});

describe('Link API: /events', () => {
  it('polls the guild’s events oldest first with since / nextSince / limit', async () => {
    const h = await setup();
    const a = addWatch(h.store, G1, 'https://a.io/', 'A');
    const b = addWatch(h.store, G1, 'https://b.io/', 'B');
    const x = addWatch(h.store, G2, 'https://x.io/', 'X');
    h.store.addEvent(a.id, 'deploy', 'a1', 1);
    h.store.addEvent(x.id, 'deploy', 'x1', 2);
    h.store.addEvent(b.id, 'text', 'b1', 3);
    h.store.addEvent(a.id, 'status', 'a2', 4);

    let r = await call(h, 'GET', '/events');
    expect(r.status).toBe(200);
    expect(r.json.events.map((e: { summary: string }) => e.summary)).toEqual(['a1', 'b1', 'a2']);
    expect(r.json.events[1]).toMatchObject({ watchId: b.id, watchName: 'B', watchUrl: 'https://b.io/', kind: 'text', createdAt: 3 });
    const last = r.json.nextSince;
    expect(last).toBe(r.json.events[2].id);

    r = await call(h, 'GET', `/events?since=${last}`);
    expect(r.json).toEqual({ events: [], nextSince: last });

    r = await call(h, 'GET', '/events?since=0&limit=1');
    expect(r.json.events.map((e: { summary: string }) => e.summary)).toEqual(['a1']);
    r = await call(h, 'GET', `/events?since=${r.json.nextSince}&limit=1`);
    expect(r.json.events.map((e: { summary: string }) => e.summary)).toEqual(['b1']);

    h.store.addEvent(b.id, 'deploy', 'b2', 5);
    r = await call(h, 'GET', `/events?since=${last}`);
    expect(r.json.events.map((e: { summary: string }) => e.summary)).toEqual(['b2']);

    for (const q of ['since=-1', 'since=abc', 'limit=1.5']) {
      const bad = await call(h, 'GET', `/events?${q}`);
      expect(bad.status, q).toBe(400);
      expect(bad.json.error.code).toBe('bad_request');
    }
    r = await call(h, 'GET', '/events?limit=9999');
    expect(r.status).toBe(200);
  });
});

describe('Link API: failures', () => {
  it('turns unexpected errors into a generic 500 without leaking details', async () => {
    const h = await setup();
    vi.spyOn(h.store, 'listGuildEvents').mockImplementation(() => {
      throw new Error('SQLITE_CORRUPT: secret path /data/watcher.db');
    });
    const r = await call(h, 'GET', '/events');
    expect(r.status).toBe(500);
    expect(r.json.error.code).toBe('internal_error');
    expect(JSON.stringify(r.json)).not.toContain('SQLITE');
    expect(h.logs.some((l) => l.level === 'error')).toBe(true);
  });

  it('is off when config.linkApi is false', async () => {
    const h = await setup({ config: { linkApi: false } });
    const res = await fetch(`${h.base}/api/v1/ping`, { headers: { authorization: `Bearer ${h.token}` } });
    expect(res.status).toBe(418);
  });
});

