/**
 * Link API (/api/v1): a real HTTP server on 127.0.0.1 with the handler, a real in-memory Store, a fake Monitor and a fake
 * scan function. Nothing here touches the public internet.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig, type Config } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { createLinkApi, MAX_BODY_BYTES, type GuildSnapshot, type LinkApiDeps } from '../src/link/api.js';
import { ScanInputError, type ScanDeps, type ScanOptions } from '../src/link/scan.js';
import type { ScanResult } from '../src/link/types.js';
import { Monitor, type BaselineSummary, type TickSummary } from '../src/monitor/scheduler.js';
import type { Alert, DeployFingerprint, Logger, PageRecord, SubdomainRecord, Watch } from '../src/types.js';
import { renderSiteInfo, type CommandDeps } from '../src/discord/commands.js';
import { silentLogger } from '../src/log.js';
import type { HttpClient } from '../src/net/http.js';

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
  const calls = {
    baseline: [] as number[],
    added: [] as Watch[],
    removed: [] as number[],
    checkNow: [] as number[],
    checkFull: [] as boolean[],
    updated: [] as Watch[],
  };
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
    onWatchUpdated(w: Watch) {
      calls.updated.push(w);
    },
    checkNow(id: number, opts?: { full?: boolean }) {
      calls.checkNow.push(id);
      calls.checkFull.push(Boolean(opts?.full));
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
  opts: {
    config?: Partial<Config>;
    monitor?: boolean;
    isGuildActive?: (guildId: string) => boolean;
    isRestoring?: () => boolean;
    guildInfo?: LinkApiDeps['guildInfo'];
    creatorAccess?: LinkApiDeps['creatorAccess'];
    getMonitor?: () => Monitor | null;
  } = {},
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
    getMonitor: opts.getMonitor ?? (() => (opts.monitor === false ? null : (monitor as unknown as Monitor))),
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
    guildInfo: opts.guildInfo,
    creatorAccess: opts.creatorAccess,
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
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET, POST, PATCH, DELETE, OPTIONS');
    expect(pre.headers.get('access-control-max-age')).toBe('600');

    for (const r of [await call(h, 'GET', '/ping'), await call(h, 'GET', '/ping', undefined, { token: null }), await call(h, 'GET', '/nope')]) {
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
      expect(r.headers.get('access-control-allow-methods')).toBe('GET, POST, PATCH, DELETE, OPTIONS');
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
    expect(r.json).toMatchObject({ watches: [], watched: false });
    expect(r.json.summary.total).toBe(2); // the summary always covers every watch of the server
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


// ---------------------------------------------------------------------------
// Management: the Discord site card, its buttons and the server list
// ---------------------------------------------------------------------------

/** G1's announcement channel (the bot can't post there). */
const C3 = '200000000000000003';
/** G1's voice channel: its chat may hold alerts, but it is never offered as an alert channel. */
const CV = '200000000000000004';
/** A G1 role and a G2 role. */
const R1 = '300000000000000001';
const R2 = '300000000000000002';

function fakeGuilds(): (guildId: string) => GuildSnapshot | null {
  const guilds: Record<string, GuildSnapshot> = {
    [G1]: {
      guild: { id: G1, name: 'Alpha Calls' },
      channels: [
        { id: C1, name: 'scans', type: 'text', category: 'MONITORING', canPost: true, missing: [] },
        { id: C3, name: 'announcements', type: 'announcement', category: null, canPost: false, missing: ['Send Messages', 'Embed Links'] },
      ],
      roles: [
        { id: R1, name: 'Alpha', everyone: false, managed: false, color: 15844367 },
        { id: G1, name: '@everyone', everyone: true, managed: false, color: 0 },
      ],
      otherChannels: [{ id: CV, name: 'Voice lounge', missing: [] }],
    },
    [G2]: {
      guild: { id: G2, name: 'Other' },
      channels: [{ id: C2, name: 'other-alerts', type: 'text', category: null, canPost: true, missing: [] }],
      roles: [
        { id: R2, name: 'Theirs', everyone: false, managed: false, color: 0 },
        { id: G2, name: '@everyone', everyone: true, managed: false, color: 0 },
      ],
    },
  };
  return (guildId) => guilds[guildId] ?? null;
}

/** A harness with Discord's guild cache, G1's "Hookedpad" (baselined, subdomains off) and G2's "Secret". */
async function manage(opts: Parameters<typeof setup>[0] = {}) {
  const h = await setup({ guildInfo: fakeGuilds(), ...opts });
  const created = addWatch(h.store, G1, 'https://hookedpad.com/', 'Hookedpad');
  const w = h.store.updateWatch(created.id, { baselineDone: true, features: { subdomains: false } });
  const theirs = addWatch(h.store, G2, 'https://secret.io/', 'Secret');
  return { h, w, theirs };
}

function pageRec(watchId: number, url: string, over: Partial<PageRecord> = {}): PageRecord {
  return {
    watchId,
    url,
    kind: 'page',
    tracked: true,
    title: null,
    text: 'SECRET PAGE TEXT',
    textHash: 'h',
    etag: null,
    lastModified: null,
    contentLength: null,
    contentType: 'text/html',
    status: 200,
    failCount: 0,
    gone: false,
    maskNumbers: false,
    maskedLines: [],
    numericChangeTimes: [],
    flapCount: 0,
    dynamic: false,
    pendingHash: null,
    pendingSince: null,
    hashHistory: [],
    changeTimes: [],
    source: 'link',
    depth: 1,
    firstSeen: 1000,
    lastChecked: 2000,
    lastChanged: null,
    ...over,
  };
}

function subRec(watchId: number, host: string, alive: boolean, over: Partial<SubdomainRecord> = {}): SubdomainRecord {
  return { watchId, host, sources: ['ct'], firstSeen: 10, lastSeen: 20, alive, lastProbe: 0, dns: null, http: null, ...over };
}

/** 17 tracked pages (1 too dynamic, 1 gone), 1 known-only page, 2 files, 3 subdomains (2 live), a 51-bundle build. */
function seedSite(store: Store, w: Watch): void {
  const pages = [pageRec(w.id, 'https://hookedpad.com/', { source: 'start', depth: 0, title: 'Hookedpad', firstSeen: 1, lastChanged: 1500 })];
  for (let i = 1; i <= 16; i++) {
    pages.push(pageRec(w.id, `https://hookedpad.com/p${String(i).padStart(2, '0')}`, { firstSeen: 100 + i, dynamic: i === 3, gone: i === 4 }));
  }
  pages.push(pageRec(w.id, 'https://hookedpad.com/known', { tracked: false, depth: 2 }));
  pages.push(pageRec(w.id, 'https://hookedpad.com/a.pdf', { kind: 'file', text: null, contentType: 'application/pdf', contentLength: 1234, lastChecked: 0 }));
  pages.push(pageRec(w.id, 'https://hookedpad.com/b.md', { kind: 'file', text: null, tracked: false, depth: 3 }));
  store.upsertPages(pages);
  store.upsertSubdomains([
    subRec(w.id, 'zeta.hookedpad.com', true),
    subRec(w.id, 'beta.hookedpad.com', false),
    subRec(w.id, 'app.hookedpad.com', true, {
      sources: ['ct', 'dns'],
      dns: { a: ['76.76.21.21'], aaaa: [], cname: [] },
      http: { status: 200, title: 'Hookedpad App', finalUrl: 'https://app.hookedpad.com/', server: 'Vercel' },
    }),
  ]);
  const st = store.getState(w.id);
  st.deploy = { assets: Array.from({ length: 51 }, (_, i) => `https://hookedpad.com/_next/${i}.js`), buildId: null, generator: null, sig: 's', seenAt: 1 } as DeployFingerprint;
  st.lastCheckAt = 1_759_676_541_000;
  st.lastChangeAt = 1_759_675_012_000;
  store.saveState(w.id, st);
}

describe('Link API management: isolation, pipeline, CORS', () => {
  it('404s every management route for another server’s watch, and junk ids', async () => {
    const { h, theirs } = await manage();
    const routes: Array<[string, string, unknown?]> = [
      ['GET', `/watches/${theirs.id}`],
      ['PATCH', `/watches/${theirs.id}`, { paused: true }],
      ['POST', `/watches/${theirs.id}/pause`],
      ['POST', `/watches/${theirs.id}/resume`],
      ['GET', `/watches/${theirs.id}/rules`],
      ['PATCH', `/watches/${theirs.id}/rules`, { maxPages: 5 }],
      ['GET', `/watches/${theirs.id}/pages`],
      ['GET', `/watches/${theirs.id}/subdomains`],
      ['PATCH', `/watches/${theirs.id}/subdomains`, { enabled: false }],
      ['POST', `/watches/${theirs.id}/subdomains/watch`, { host: 'app.secret.io' }],
      ['GET', `/watches/${theirs.id}/history`],
      ['POST', `/watches/${theirs.id}/check`, { full: true }],
      ['PATCH', '/watches/99999', { paused: true }],
      ['GET', '/watches/abc/rules'],
      ['POST', '/watches/0/pause'],
    ];
    for (const [method, path, body] of routes) {
      const r = await call(h, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json.error).toEqual({ code: 'not_found', message: 'Unknown watch.' });
    }
    const after = h.store.getWatch(theirs.id)!;
    expect(after).toMatchObject({ paused: false, maxPages: theirs.maxPages });
    expect(h.store.listWatches(G2)).toHaveLength(1);
    expect(h.monitor.calls.updated).toEqual([]);
    expect(h.monitor.calls.checkNow).toEqual([]);
  });

  it('refuses another server’s channels and roles', async () => {
    const { h, w } = await manage();
    let r = await call(h, 'PATCH', `/watches/${w.id}`, { channelId: C2 });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: 'invalid_channel', field: 'channelId' });
    for (const role of [R2, G2]) {
      r = await call(h, 'PATCH', `/watches/${w.id}`, { pingRoleId: role });
      expect(r.status).toBe(400);
      expect(r.json.error).toMatchObject({ code: 'invalid_role', field: 'pingRoleId' });
    }
    // A voice channel's chat, a forged id and junk are not alert channels either.
    for (const channelId of [CV, '299999999999999999', 'scans']) {
      r = await call(h, 'PATCH', `/watches/${w.id}`, { channelId });
      expect(r.json.error.code, channelId).toBe('invalid_channel');
    }
    r = await call(h, 'POST', '/watches', { url: 'unpeg.io', channelId: C2 });
    expect(r.json.error.code).toBe('invalid_channel');
    r = await call(h, 'POST', '/watches', { url: 'unpeg.io', pingRoleId: R2 });
    expect(r.json.error.code).toBe('invalid_role');
    expect(h.store.getWatch(w.id)).toEqual(w);
    expect(h.store.listWatches(G1)).toHaveLength(1);
  });

  it('keeps the order unknown route → wrong method → auth, and 503s unknown tokens while restoring', async () => {
    const { h, w } = await manage({ isRestoring: () => true });
    let r = await call(h, 'GET', `/watches/${w.id}/nope`, undefined, { token: null });
    expect(r.status).toBe(404);
    r = await call(h, 'PUT', `/watches/${w.id}`, undefined, { token: null });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET, PATCH, DELETE, OPTIONS');
    expect(r.json.error.message).toBe('Use GET, PATCH or DELETE for this endpoint.');
    r = await call(h, 'PATCH', '/watches', {});
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET, POST, OPTIONS');
    r = await call(h, 'DELETE', `/watches/${w.id}/rules`);
    expect(r.headers.get('allow')).toBe('GET, PATCH, OPTIONS');
    r = await call(h, 'GET', `/watches/${w.id}/subdomains/watch`);
    expect(r.headers.get('allow')).toBe('POST, OPTIONS');
    r = await call(h, 'PATCH', `/watches/${w.id}`, { paused: true }, { token: null });
    expect(r.status).toBe(401);
    r = await call(h, 'PATCH', `/watches/${w.id}`, { paused: true }, { token: 'swb_' + 'C'.repeat(43) });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('unavailable');
    expect(h.store.getWatch(w.id)!.paused).toBe(false);
  });

  it('allows PATCH in CORS preflights of the new routes', async () => {
    const { h, w } = await manage();
    for (const path of [`/watches/${w.id}`, `/watches/${w.id}/rules`, `/watches/${w.id}/subdomains`, '/guild']) {
      const pre = await fetch(`${h.base}/api/v1${path}`, { method: 'OPTIONS', headers: { origin: 'chrome-extension://abc', 'access-control-request-method': 'PATCH' } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-methods')).toBe('GET, POST, PATCH, DELETE, OPTIONS');
    }
  });
});

describe('Link API management: the card, limits and the server list', () => {
  it('GET /watches/:id returns the site card, matching the Discord card', async () => {
    const { h, w } = await manage();
    seedSite(h.store, w);
    h.store.addEvent(w.id, 'deploy', 'Hookedpad redeployed', 5);
    const r = await call(h, 'GET', `/watches/${w.id}`);
    expect(r.status).toBe(200);
    expect(r.json.watch).toMatchObject({ id: w.id, name: 'Hookedpad', pagesTracked: 17, subdomains: 3 });
    expect(r.json.events.map((e: { summary: string }) => e.summary)).toEqual(['Hookedpad redeployed']);
    expect(r.json.limits).toEqual({
      minIntervalSec: 5,
      maxIntervalSec: 3600,
      sweepMinSec: 30,
      sweepMaxSec: 86400,
      maxPagesLimit: 1000,
      maxPatterns: 25,
      maxPatternChars: 300,
      maxExtraUrls: 50,
      maxScopeChars: 200,
      maxNameChars: 100,
      maxWatches: 50,
    });
    const card = r.json.card;
    expect(card).toMatchObject({
      id: w.id,
      name: 'Hookedpad',
      url: 'https://hookedpad.com/',
      host: 'hookedpad.com',
      rootDomain: 'hookedpad.com',
      status: 'up',
      statusLabel: 'Up',
      downSince: null,
      downError: null,
      lastCheckAt: 1_759_676_541_000,
      lastChangeAt: 1_759_675_012_000,
      schedule: { intervalSec: 2, sweepSec: 120 },
      alerts: { channelId: C1, channelName: 'scans', canPost: true, missing: [], ping: 'none', pingRoleId: null, pingRoleName: null },
      build: { id: null, bundles: 51, generator: null },
      pages: { tracked: 17, maxPages: 150, known: 18, files: 2, gone: 1, dynamic: 1 },
      subdomains: { enabled: false, known: 3, live: 2 },
      rules: { ignorePatterns: 0, excludePatterns: 0, extraUrls: 0, scopePath: null },
      runtime: { running: true, baselineRunning: false, lastTickAt: null, lastTickMs: null, nextTickAt: null },
      lastError: null,
      warnings: [],
      createdAt: w.createdAt,
    });
    expect(card.checks.map((c: { key: string }) => c.key)).toEqual(['deploy', 'text', 'pages', 'subdomains', 'files', 'status', 'codeIntel', 'maskNumbers']);
    expect(card.checks[0]).toEqual({ key: 'deploy', label: 'Redeploys', emoji: '🌐', hint: 'new JS/CSS bundles or build id', on: true });
    expect(card.checks.find((c: { key: string }) => c.key === 'subdomains').on).toBe(false);
    expect(card.checks.find((c: { key: string }) => c.key === 'maskNumbers').on).toBe(false);

    // Same numbers as the Discord card (renderSiteInfo).
    const embed = renderSiteInfo({ store: h.store, config: testConfig(), log: silentLogger, monitor: h.monitor as unknown as Monitor } as CommandDeps, h.store.getWatch(w.id)!);
    const field = (name: string) => embed.fields!.find((f) => f.name === name)!.value;
    const p = card.pages;
    expect(field('Pages')).toBe(`${p.tracked} tracked (max ${p.maxPages}) · ${p.known} known\n${p.files} files · ${p.gone} gone · ${p.dynamic} too dynamic`);
    expect(field('Subdomains')).toBe(`off (${card.subdomains.known} known)`);
    expect(field('Build')).toBe(`${card.build.bundles} bundles`);
    expect(field('Rules')).toBe('0 ignore patterns\n0 skipped URL patterns\n0 extra pages\nscope: whole site');
    expect(JSON.stringify(r.json)).not.toContain('SECRET PAGE TEXT');
  });

  it('shows down / paused states, delivery problems, pings, the CT note and an unknown Discord cache', async () => {
    const { h, w } = await manage();
    const st = h.store.getState(w.id);
    st.status.up = false;
    st.status.downSince = 123;
    st.status.lastError = 'HTTP 503';
    st.lastError = 'boom';
    h.store.saveState(w.id, st);
    h.store.updateWatch(w.id, { channelId: C3, pingRoleId: R1 });
    let card = (await call(h, 'GET', `/watches/${w.id}`)).json.card;
    expect(card).toMatchObject({ status: 'down', statusLabel: 'Down', downSince: 123, downError: 'HTTP 503', lastError: 'boom' });
    expect(card.alerts).toEqual({
      channelId: C3,
      channelName: 'announcements',
      canPost: false,
      missing: ['Send Messages', 'Embed Links'],
      ping: 'role',
      pingRoleId: R1,
      pingRoleName: 'Alpha',
    });
    expect(card.warnings).toEqual(["I'm missing Send Messages, Embed Links in #announcements — alerts can't be delivered until that's fixed."]);

    h.store.updateWatch(w.id, { paused: true, channelId: '299999999999999999', pingRoleId: G1 });
    card = (await call(h, 'GET', `/watches/${w.id}`)).json.card;
    expect(card).toMatchObject({ status: 'paused', statusLabel: 'Paused', downSince: null, downError: null });
    expect(card.alerts).toMatchObject({ channelName: null, canPost: false, missing: ['channel not found'], ping: 'everyone', pingRoleId: G1, pingRoleName: '@everyone' });
    expect(card.warnings[0]).toBe("The alert channel 299999999999999999 no longer exists — alerts can't be delivered. Pick another channel in Settings.");

    // A voice channel's chat that already gets alerts is known (just not offered as a new choice).
    h.store.updateWatch(w.id, { channelId: CV, features: { subdomains: true } });
    addWatch(h.store, G1, 'https://a.io/');
    addWatch(h.store, G2, 'https://b.io/');
    card = (await call(h, 'GET', `/watches/${w.id}`)).json.card;
    expect(card.alerts).toMatchObject({ channelName: 'Voice lounge', canPost: true, missing: [] });
    // Unpaused watches with subdomains on share Cert Spotter's quota (both servers): the Discord card's note, as text.
    expect(card.warnings).toEqual(['3 sites share one Certificate Transparency quota (no CERTSPOTTER_API_KEY): new names can take a while.']);
    h.store.updateWatch(w.id, { paused: false });
    card = (await call(h, 'GET', `/watches/${w.id}`)).json.card;
    expect(card.warnings).toEqual(['4 sites share one Certificate Transparency quota (no CERTSPOTTER_API_KEY): new names can take a while.']);
    h.store.updateWatch(w.id, { features: { subdomains: false } });
    expect((await call(h, 'GET', `/watches/${w.id}`)).json.card.warnings).toEqual([]);

    // Discord not ready: names unknown, nothing claimed about delivery; the monitor not started: no runtime.
    const blind = await manage({ guildInfo: () => null, monitor: false });
    card = (await call(blind.h, 'GET', `/watches/${blind.w.id}`)).json.card;
    expect(card.alerts).toMatchObject({ channelId: C1, channelName: null, canPost: null, missing: [] });
    expect(card.runtime).toBeNull();
    const throwing = await manage({
      guildInfo: () => {
        throw new Error('not ready');
      },
    });
    expect((await call(throwing.h, 'GET', `/watches/${throwing.w.id}`)).json.card.alerts.canPost).toBeNull();
  });

  it('ping carries the limits; GET /guild lists the token server’s channels and roles (503 until Discord is ready)', async () => {
    const { h } = await manage();
    expect((await call(h, 'GET', '/ping')).json.limits).toMatchObject({ minIntervalSec: 5, maxWatches: 50 });
    let r = await call(h, 'GET', '/guild');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      guild: { id: G1, name: 'Alpha Calls' },
      tokenChannelId: C1,
      channels: [
        { id: C1, name: 'scans', type: 'text', category: 'MONITORING', canPost: true, missing: [] },
        { id: C3, name: 'announcements', type: 'announcement', category: null, canPost: false, missing: ['Send Messages', 'Embed Links'] },
      ],
      roles: [
        { id: R1, name: 'Alpha', everyone: false, managed: false, color: 15844367 },
        { id: G1, name: '@everyone', everyone: true, managed: false, color: 0 },
      ],
    });
    r = await call(h, 'GET', '/guild', undefined, { token: h.token2 });
    expect(r.json.guild.id).toBe(G2);
    expect(JSON.stringify(r.json)).not.toContain(C1);

    for (const guildInfo of [() => null, undefined]) {
      const blind = await setup({ guildInfo });
      r = await call(blind, 'GET', '/guild');
      expect(r.status).toBe(503);
      expect(r.json.error.code).toBe('unavailable');
      expect(r.headers.get('retry-after')).toBe('5');
    }
    // A snapshot of the wrong server is never used.
    const wrong = await setup({ guildInfo: () => fakeGuilds()(G2) });
    expect((await call(wrong, 'GET', '/guild')).status).toBe(503);
  });

  it('GET /watches adds the dashboard summary over every watch of the server', async () => {
    const h = await setup({ guildInfo: fakeGuilds() });
    let r = await call(h, 'GET', '/watches');
    expect(r.json.summary).toEqual({ total: 0, limit: 50, counts: { up: 0, down: 0, blocked: 0, paused: 0, scanning: 0 }, channels: [], text: 'No sites yet.' });
    const up = addWatch(h.store, G1, 'https://up.io/');
    addWatch(h.store, G1, 'https://scanning.io/');
    const paused = addWatch(h.store, G1, 'https://paused.io/');
    const blocked = addWatch(h.store, G1, 'https://blocked.io/');
    const down = addWatch(h.store, G1, 'https://down.io/');
    addWatch(h.store, G2, 'https://theirs.io/');
    for (const w of [up, paused, blocked, down]) h.store.updateWatch(w.id, { baselineDone: true });
    h.store.updateWatch(paused.id, { paused: true });
    let st = h.store.getState(blocked.id);
    st.status.consecutiveBlocked = 99;
    h.store.saveState(blocked.id, st);
    st = h.store.getState(down.id);
    st.status.up = false;
    h.store.saveState(down.id, st);

    r = await call(h, 'GET', '/watches');
    expect(r.json.summary).toEqual({
      total: 5,
      limit: 50,
      counts: { up: 1, down: 1, blocked: 1, paused: 1, scanning: 1 },
      channels: [{ id: C1, name: 'scans', watches: 5 }],
      text: 'Watching 5 sites · alerts in #scans · 1 up · 1 down · 1 blocked · 1 paused · 1 scanning',
    });
    h.store.updateWatch(down.id, { channelId: C3 });
    h.store.updateWatch(blocked.id, { paused: true });
    r = await call(h, 'GET', `/watches?url=${encodeURIComponent('https://up.io/x')}`);
    expect(r.json.watches.map((w: { id: number }) => w.id)).toEqual([up.id]);
    expect(r.json.watched).toBe(true);
    expect(r.json.summary).toMatchObject({
      total: 5,
      counts: { up: 1, down: 1, blocked: 0, paused: 2, scanning: 1 },
      channels: [
        { id: C1, name: 'scans', watches: 4 },
        { id: C3, name: 'announcements', watches: 1 },
      ],
      text: 'Watching 5 sites · alerts in 2 channels · 1 up · 1 down · 2 paused · 1 scanning',
    });

    // Unknown channel names: the raw id; one site: singular.
    const blind = await setup();
    addWatch(blind.store, G1, 'https://one.io/');
    r = await call(blind, 'GET', '/watches');
    expect(r.json.summary.text).toBe(`Watching 1 site · alerts in ${C1} · 1 scanning`);
    expect(r.json.summary.channels).toEqual([{ id: C1, name: null, watches: 1 }]);
  });
});

describe('Link API management: PATCH /watches/:id (Settings, Features, Pause)', () => {
  it('saves every field in one write, describes it, warns, and announces only the channel move', async () => {
    const { h, w } = await manage();
    const update = vi.spyOn(h.store, 'updateWatch');
    const r = await call(h, 'PATCH', `/watches/${w.id}`, {
      name: '  Hooked\npad ',
      intervalSec: 7,
      sweepSec: 300,
      channelId: C3,
      pingRoleId: R1,
      checks: { text: false, maskNumbers: true, deploy: true },
    });
    expect(r.status).toBe(200);
    expect(r.json.changed).toEqual(['name', 'intervalSec', 'sweepSec', 'channelId', 'pingRoleId', 'checks.text', 'checks.maskNumbers']);
    expect(r.json.message).toBe(
      'Saved — name → Hooked pad · interval 2s → 7s · full sweep 120s → 300s · channel → #announcements · ping → @Alpha · Text changes off · Ignore numbers on',
    );
    expect(r.json.warnings).toEqual(["I'm missing Send Messages, Embed Links in #announcements — alerts can't be delivered until that's fixed."]);
    expect(r.json.watch).toMatchObject({ id: w.id, name: 'Hooked pad', intervalSec: 7, channelId: C3 });
    expect(r.json.watch.features).toMatchObject({ text: false, deploy: true });
    expect(r.json.card).toMatchObject({
      name: 'Hooked pad',
      schedule: { intervalSec: 7, sweepSec: 300 },
      alerts: { channelId: C3, channelName: 'announcements', canPost: false, ping: 'role', pingRoleName: 'Alpha' },
    });
    expect(update).toHaveBeenCalledTimes(1);
    const stored = h.store.getWatch(w.id)!;
    expect(stored).toMatchObject({ name: 'Hooked pad', intervalSec: 7, sweepSec: 300, channelId: C3, pingRoleId: R1, maskNumbers: true });
    expect(stored.features).toEqual({ ...w.features, text: false });
    expect(stored.features).not.toHaveProperty('maskNumbers');
    expect(h.monitor.calls.updated).toHaveLength(1);
    expect(h.monitor.calls.updated[0]).toMatchObject({ id: w.id, intervalSec: 7, maskNumbers: true });
    await vi.waitFor(() => expect(h.announced).toHaveLength(1));
    expect(h.announced[0]).toEqual({
      channelId: C3,
      content: `📢 Alerts for **Hooked pad** (<https://hookedpad.com/>) now post here — moved from <#${C1}> by **Arkham Dev Tags**.`,
    });
    expect(h.logs.some((l) => l.meta?.action === 'update' && l.meta?.watchId === w.id && Array.isArray(l.meta?.changes))).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain(h.token);
    expect(h.monitor.calls.checkNow).toEqual([]);
  });

  it('a body that changes nothing writes nothing', async () => {
    const { h, w } = await manage();
    const update = vi.spyOn(h.store, 'updateWatch');
    for (const body of [
      undefined,
      {},
      { name: 'Hookedpad', sweepSec: 120, channelId: C1, pingRoleId: null, paused: false, checks: { text: true, maskNumbers: false } },
      { checks: {} },
    ]) {
      const r = await call(h, 'PATCH', `/watches/${w.id}`, body);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ changed: [], message: 'Nothing changed.', warnings: [] });
      expect(r.json.card.id).toBe(w.id);
    }
    // The current channel needs no Discord lookup.
    const blind = await manage({ guildInfo: () => null });
    expect((await call(blind.h, 'PATCH', `/watches/${blind.w.id}`, { channelId: C1 })).json.changed).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(h.monitor.calls.updated).toEqual([]);
    expect(h.announced).toEqual([]);
  });

  it('rejects wrong types and unknown fields without writing anything', async () => {
    const { h, w } = await manage();
    const update = vi.spyOn(h.store, 'updateWatch');
    const cases: Array<[unknown, number, string, string | undefined]> = [
      [{ name: 5 }, 400, 'bad_request', 'name'],
      [{ name: null }, 400, 'bad_request', 'name'],
      [{ intervalSec: '5' }, 400, 'invalid_interval', 'intervalSec'],
      [{ intervalSec: 0 }, 400, 'invalid_interval', 'intervalSec'],
      [{ intervalSec: -3 }, 400, 'invalid_interval', 'intervalSec'],
      [{ sweepSec: true }, 400, 'invalid_interval', 'sweepSec'],
      [{ channelId: 12 }, 400, 'bad_request', 'channelId'],
      [{ pingRoleId: 7 }, 400, 'bad_request', 'pingRoleId'],
      [{ paused: 'yes' }, 400, 'bad_request', 'paused'],
      [{ checks: ['text'] }, 400, 'bad_request', 'checks'],
      [{ checks: { text: 'off' } }, 400, 'bad_request', 'checks.text'],
      [{ checks: { bogus: true } }, 400, 'bad_request', 'checks.bogus'],
      [{ url: 'https://evil.io/' }, 400, 'bad_request', 'url'],
      [{ features: { text: false } }, 400, 'bad_request', 'features'],
      [{ maxPages: 5 }, 400, 'bad_request', 'maxPages'],
      // Valid fields before an invalid one are not saved either.
      [{ intervalSec: 60, checks: { text: false }, paused: 1 }, 400, 'bad_request', 'paused'],
    ];
    for (const [body, status, code, field] of cases) {
      const r = await call(h, 'PATCH', `/watches/${w.id}`, body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(r.json.error.code, JSON.stringify(body)).toBe(code);
      expect(r.json.error.field, JSON.stringify(body)).toBe(field);
    }
    const raw = await call(h, 'PATCH', `/watches/${w.id}`, undefined, { raw: '[1]' });
    expect(raw.json.error.code).toBe('bad_request');
    expect(update).not.toHaveBeenCalled();
    expect(h.store.getWatch(w.id)).toEqual(w);
    expect(h.monitor.calls.updated).toEqual([]);
  });

  it('takes intervals like the Settings modal: whole seconds in range, else 400 invalid_interval (no clamping)', async () => {
    const { h, w } = await manage();
    const update = vi.spyOn(h.store, 'updateWatch');
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ intervalSec: 0.4 }, 'intervalSec'],
      [{ intervalSec: 4 }, 'intervalSec'], // below MIN_INTERVAL_SEC = 5 here
      [{ intervalSec: 3601 }, 'intervalSec'],
      [{ intervalSec: 42.6 }, 'intervalSec'],
      [{ sweepSec: 5 }, 'sweepSec'],
      [{ sweepSec: 999_999 }, 'sweepSec'],
      [{ intervalSec: 60, sweepSec: 29.5 }, 'sweepSec'],
    ];
    for (const [body, field] of cases) {
      const r = await call(h, 'PATCH', `/watches/${w.id}`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.code, JSON.stringify(body)).toBe('invalid_interval');
      expect(r.json.error.field, JSON.stringify(body)).toBe(field);
    }
    expect(update).not.toHaveBeenCalled();
    let r = await call(h, 'PATCH', `/watches/${w.id}`, { intervalSec: 5, sweepSec: 30 });
    expect(r.json.card.schedule).toEqual({ intervalSec: 5, sweepSec: 30 });
    r = await call(h, 'PATCH', `/watches/${w.id}`, { intervalSec: 3600, sweepSec: 86400 });
    expect(r.json.card.schedule).toEqual({ intervalSec: 3600, sweepSec: 86400 });
    // the value the watch already has is a no-op even when the limits moved since
    h.store.updateWatch(w.id, { intervalSec: 2 });
    r = await call(h, 'PATCH', `/watches/${w.id}`, { intervalSec: 2, name: 'Hooked' });
    expect(r.status).toBe(200);
    expect(r.json.changed).toEqual(['name']);
    expect(h.monitor.calls.updated).toHaveLength(3);
  });

  it('renames like the Settings modal: unique per server, not number-only', async () => {
    const { h, w } = await manage();
    addWatch(h.store, G1, 'https://unpeg.io/', 'Unpeg');
    let r = await call(h, 'PATCH', `/watches/${w.id}`, { name: 'unpeg' });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'name_taken', field: 'name' });
    expect(r.json.error.message).toBe('A site named unpeg already exists in this server. Pick another name.');
    for (const name of ['123', '#45', '   ', 'x'.repeat(101)]) {
      r = await call(h, 'PATCH', `/watches/${w.id}`, { name });
      expect(r.status, name).toBe(400);
      expect(r.json.error.code).toBe('bad_request');
      expect(r.json.error.message).not.toMatch(/\*\*|`/);
    }
    // Another server's names don't count; a case change of its own name is fine.
    expect((await call(h, 'PATCH', `/watches/${w.id}`, { name: 'Secret' })).json.changed).toEqual(['name']);
    expect((await call(h, 'PATCH', `/watches/${w.id}`, { name: 'SECRET' })).json.message).toBe('Saved — name → SECRET');
  });

  it('pings: a role of the server, @everyone (the guild id) or none', async () => {
    const { h, w } = await manage();
    let r = await call(h, 'PATCH', `/watches/${w.id}`, { pingRoleId: G1 });
    expect(r.json.message).toBe('Saved — ping → @everyone');
    expect(r.json.card.alerts).toMatchObject({ ping: 'everyone', pingRoleId: G1, pingRoleName: '@everyone' });
    r = await call(h, 'PATCH', `/watches/${w.id}`, { pingRoleId: null });
    expect(r.json.message).toBe('Saved — ping → none');
    expect(h.store.getWatch(w.id)!.pingRoleId).toBeNull();
    // @everyone needs no Discord lookup; other roles and channels do (503 until Discord is ready).
    const blind = await manage({ guildInfo: () => null });
    expect((await call(blind.h, 'PATCH', `/watches/${blind.w.id}`, { pingRoleId: G1 })).status).toBe(200);
    for (const body of [{ pingRoleId: R1 }, { channelId: C3 }]) {
      r = await call(blind.h, 'PATCH', `/watches/${blind.w.id}`, body);
      expect(r.status).toBe(503);
      expect(r.json.error.code).toBe('unavailable');
      expect(r.headers.get('retry-after')).toBe('5');
    }
    expect(blind.h.store.getWatch(blind.w.id)!.channelId).toBe(C1);
  });

  it('checks: partial, "Ignore numbers" is watch.maskNumbers, one write per request', async () => {
    const { h, w } = await manage();
    let r = await call(h, 'PATCH', `/watches/${w.id}`, { checks: { files: false } });
    expect(r.json).toMatchObject({ changed: ['checks.files'], message: 'Saved — Files off' });
    let stored = h.store.getWatch(w.id)!;
    expect(stored.features).toEqual({ ...w.features, files: false });
    r = await call(h, 'PATCH', `/watches/${w.id}`, { checks: { maskNumbers: true } });
    expect(r.json.changed).toEqual(['checks.maskNumbers']);
    stored = h.store.getWatch(w.id)!;
    expect(stored.maskNumbers).toBe(true);
    expect(stored.features).toEqual({ ...w.features, files: false });
    expect(r.json.card.checks.find((c: { key: string }) => c.key === 'maskNumbers').on).toBe(true);
    expect(h.monitor.calls.updated).toHaveLength(2);
  });

  it('warns when switching subdomains on while another watch of the domain already tracks them', async () => {
    const { h, w } = await manage();
    const other = h.store.createWatch({ guildId: G1, channelId: C1, name: 'Hookedpad app', url: 'https://app.hookedpad.com/', host: 'app.hookedpad.com', rootDomain: 'hookedpad.com', createdBy: 'u' });
    const r = await call(h, 'PATCH', `/watches/${w.id}`, { checks: { subdomains: true } });
    expect(r.json.warnings).toEqual([`Subdomains of hookedpad.com are already tracked by #${other.id} Hookedpad app — new subdomains will be announced twice.`]);
    expect(h.store.getWatch(w.id)!.features.subdomains).toBe(true);
  });

  it('paused: true / false announces in the watch channel', async () => {
    const { h, w } = await manage();
    let r = await call(h, 'PATCH', `/watches/${w.id}`, { paused: true });
    expect(r.json).toMatchObject({ changed: ['paused'], message: 'Saved — paused' });
    expect(r.json.card).toMatchObject({ status: 'paused', statusLabel: 'Paused' });
    await vi.waitFor(() => expect(h.announced).toHaveLength(1));
    expect(h.announced[0]).toEqual({ channelId: C1, content: '⏸️ **Hookedpad** was paused from **Arkham Dev Tags**.' });
    r = await call(h, 'PATCH', `/watches/${w.id}`, { paused: false });
    expect(r.json.message).toBe('Saved — resumed');
    await vi.waitFor(() => expect(h.announced).toHaveLength(2));
    expect(h.announced[1].content).toBe('▶️ **Hookedpad** was resumed from **Arkham Dev Tags**.');
    expect(h.monitor.calls.checkNow).toEqual([]);
  });

  it('503s writes before the monitor has started', async () => {
    const { h, w } = await manage({ monitor: false });
    for (const [method, path, body] of [
      ['PATCH', `/watches/${w.id}`, { paused: true }],
      ['POST', `/watches/${w.id}/pause`, undefined],
      ['PATCH', `/watches/${w.id}/rules`, { maxPages: 3 }],
      ['PATCH', `/watches/${w.id}/subdomains`, { enabled: true }],
      ['POST', `/watches/${w.id}/subdomains/watch`, { host: 'app.hookedpad.com' }],
    ] as const) {
      const r = await call(h, method, path, body);
      expect(r.status, path).toBe(503);
      expect(r.json.error.code).toBe('unavailable');
      expect(r.headers.get('retry-after')).toBe('5');
    }
    expect(h.store.getWatch(w.id)).toEqual(w);
    expect(h.store.listWatches(G1)).toHaveLength(1);
    // Reads still work.
    expect((await call(h, 'GET', `/watches/${w.id}/rules`)).status).toBe(200);
  });
});

describe('Link API management: pause / resume', () => {
  it('sets an explicit state, idempotently, and never checks', async () => {
    const { h, w } = await manage();
    let r = await call(h, 'POST', `/watches/${w.id}/pause`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ changed: ['paused'], message: 'Paused Hookedpad — no checks until you resume it.', warnings: [] });
    expect(r.json.watch).toMatchObject({ paused: true, status: 'paused' });
    expect(h.store.getWatch(w.id)!.paused).toBe(true);
    expect(h.monitor.calls.updated.map((x) => x.paused)).toEqual([true]);
    r = await call(h, 'POST', `/watches/${w.id}/pause`, {});
    expect(r.json).toMatchObject({ changed: [], message: 'Hookedpad is already paused.' });
    r = await call(h, 'POST', `/watches/${w.id}/resume`);
    expect(r.json).toMatchObject({ changed: ['paused'], message: 'Resumed Hookedpad.' });
    expect(r.json.card.status).toBe('up');
    r = await call(h, 'POST', `/watches/${w.id}/resume`);
    expect(r.json).toMatchObject({ changed: [], message: 'Hookedpad is already running.' });
    expect(h.monitor.calls.updated.map((x) => x.paused)).toEqual([true, false]);
    await vi.waitFor(() => expect(h.announced).toHaveLength(2));
    expect(h.announced.map((a) => a.content)).toEqual([
      '⏸️ **Hookedpad** was paused from **Arkham Dev Tags**.',
      '▶️ **Hookedpad** was resumed from **Arkham Dev Tags**.',
    ]);
    expect(h.logs.filter((l) => l.meta?.action === 'pause' || l.meta?.action === 'resume')).toHaveLength(2);
    r = await call(h, 'POST', `/watches/${w.id}/pause`, { now: true });
    expect(r.json.error).toMatchObject({ code: 'bad_request', field: 'now' });
    expect(h.monitor.calls.checkNow).toEqual([]);
  });

  it('stops and restarts the real scheduler without starting a check', async () => {
    let real: Monitor | null = null;
    const h = await setup({ guildInfo: fakeGuilds(), getMonitor: () => real });
    const created = addWatch(h.store, G1, 'http://127.0.0.1:9/', 'Local');
    const w = h.store.updateWatch(created.id, { baselineDone: true, intervalSec: 3600, features: { subdomains: false } });
    const fetched: string[] = [];
    const http = {
      fetch: async (url: string) => {
        fetched.push(url);
        throw new Error('no network in this test');
      },
      stats: () => ({ active: 0, pending: 0 }),
    } as unknown as HttpClient;
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // first ticks ~10 s out: none fires during the test
    real = new Monitor({
      store: h.store,
      http,
      notifier: { notify: async () => {} },
      config: testConfig(),
      log: silentLogger,
      providers: { ct: { certspotter: async (_d, cursor) => ({ names: [], cursor }), crtsh: async () => [] }, dns: { resolve: async () => null, wildcard: async () => null } },
    });
    try {
      real.start();
      expect(real.runtimeInfo(w.id).running).toBe(true);
      let r = await call(h, 'POST', `/watches/${w.id}/pause`);
      expect(real.runtimeInfo(w.id)).toMatchObject({ running: false, nextTickAt: null });
      expect(r.json.card.runtime).toMatchObject({ running: false, nextTickAt: null });
      r = await call(h, 'POST', `/watches/${w.id}/resume`);
      expect(real.runtimeInfo(w.id).running).toBe(true);
      expect(r.json.card.runtime.running).toBe(true);
      expect(r.json.card.runtime.nextTickAt).toBeGreaterThan(Date.now());
      r = await call(h, 'PATCH', `/watches/${w.id}`, { paused: true, intervalSec: 60 });
      expect(real.runtimeInfo(w.id).running).toBe(false);
      r = await call(h, 'PATCH', `/watches/${w.id}`, { paused: false });
      expect(real.runtimeInfo(w.id).running).toBe(true);
      expect(fetched).toEqual([]);
    } finally {
      await real.stop();
    }
  });
});

describe('Link API management: rules', () => {
  it('round-trips the Rules modal: replacement lists, scope and max pages', async () => {
    const { h, w } = await manage();
    let r = await call(h, 'GET', `/watches/${w.id}/rules`);
    expect(r.json.rules).toEqual({ ignorePatterns: [], excludePatterns: [], extraUrls: [], scopePath: null, maxPages: 150 });
    expect(r.json.limits.maxPatterns).toBe(25);
    const reset = vi.spyOn(h.store, 'resetPageNoise');
    const update = vi.spyOn(h.store, 'updateWatch');
    r = await call(h, 'PATCH', `/watches/${w.id}/rules`, {
      ignorePatterns: ['  Last updated.*  ', '', 'Last updated.*', '\\d+ online'],
      excludePatterns: ['/profile/*'],
      extraUrls: ['/secret', 'https://hookedpad.com/hidden', '/secret', 'hookedpad.com/docs/x'],
      scopePath: '/docs/',
      maxPages: 200,
    });
    expect(r.status).toBe(200);
    const rules = {
      ignorePatterns: ['Last updated.*', '\\d+ online'],
      excludePatterns: ['/profile/*'],
      extraUrls: ['https://hookedpad.com/secret', 'https://hookedpad.com/hidden', 'https://hookedpad.com/docs/x'],
      scopePath: '/docs',
      maxPages: 200,
    };
    expect(r.json.rules).toEqual(rules);
    expect(r.json.changed).toEqual(['ignorePatterns', 'excludePatterns', 'extraUrls', 'scopePath', 'maxPages']);
    expect(r.json.message).toBe(
      'Rules saved — 2 ignore patterns · 1 skipped URL pattern · 3 extra pages · scope /docs · max 200 pages. Affected pages are re-baselined silently.',
    );
    expect(r.json.card.rules).toEqual({ ignorePatterns: 2, excludePatterns: 1, extraUrls: 3, scopePath: '/docs' });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(reset.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]);
    expect(h.monitor.calls.updated).toHaveLength(1);
    expect((await call(h, 'GET', `/watches/${w.id}/rules`)).json.rules).toEqual(rules);

    // Sending the same rules again changes nothing.
    r = await call(h, 'PATCH', `/watches/${w.id}/rules`, rules);
    expect(r.json).toMatchObject({ changed: [], message: 'Nothing changed.', rules });
    expect(update).toHaveBeenCalledTimes(1);
    expect(h.announced).toEqual([]);
    expect(h.monitor.calls.checkNow).toEqual([]);
  });

  it('applies { add, remove } edits to the current lists', async () => {
    const { h, w } = await manage();
    h.store.updateWatch(w.id, {
      ignorePatterns: ['Last updated.*'],
      excludePatterns: ['/profile/*', '/tag/*'],
      extraUrls: ['https://hookedpad.com/secret', 'https://hookedpad.com/hidden'],
    });
    const reset = vi.spyOn(h.store, 'resetPageNoise');
    let r = await call(h, 'PATCH', `/watches/${w.id}/rules`, {
      excludePatterns: { add: ['/blog/*', '/tag/*', ' '], remove: [' /profile/* ', '/unknown/*'] },
      extraUrls: { remove: ['/secret'], add: ['/new', 'https://hookedpad.com/hidden'] },
    });
    expect(r.json.rules).toMatchObject({
      excludePatterns: ['/tag/*', '/blog/*'],
      extraUrls: ['https://hookedpad.com/hidden', 'https://hookedpad.com/new'],
      ignorePatterns: ['Last updated.*'],
    });
    expect(r.json.changed).toEqual(['excludePatterns', 'extraUrls']);
    expect(reset).not.toHaveBeenCalled(); // only ignore patterns reset the noise flags
    r = await call(h, 'PATCH', `/watches/${w.id}/rules`, { ignorePatterns: { add: ['Last updated.*', 'Online: \\d+'] }, extraUrls: { remove: ['https://hookedpad.com/hidden'] } });
    expect(r.json.rules).toMatchObject({ ignorePatterns: ['Last updated.*', 'Online: \\d+'], extraUrls: ['https://hookedpad.com/new'] });
    expect(reset).toHaveBeenCalledTimes(1);
    r = await call(h, 'PATCH', `/watches/${w.id}/rules`, { ignorePatterns: { remove: ['Last updated.*', 'Online: \\d+'] } });
    expect(r.json.rules.ignorePatterns).toEqual([]);
  });

  it('validates patterns like the Rules modal, with the failing field', async () => {
    const { h, w } = await manage();
    h.store.updateWatch(w.id, { ignorePatterns: ['(a+)+'] }); // grandfathered (saved before the check existed)
    const update = vi.spyOn(h.store, 'updateWatch');
    const reset = vi.spyOn(h.store, 'resetPageNoise');
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ excludePatterns: ['/ok/*', '(a+)+'] }, 'invalid_pattern', 'excludePatterns[1]'],
      [{ excludePatterns: { add: ['(b+)+'] } }, 'invalid_pattern', 'excludePatterns.add[0]'],
      [{ ignorePatterns: ['x', '', 'x', '[unclosed'] }, 'invalid_pattern', 'ignorePatterns[3]'],
      [{ ignorePatterns: ['.*'] }, 'invalid_pattern', 'ignorePatterns[0]'],
      [{ excludePatterns: ['.*'] }, 'invalid_pattern', 'excludePatterns[0]'],
      [{ ignorePatterns: Array.from({ length: 26 }, (_, i) => `p${i}`) }, 'invalid_pattern', 'ignorePatterns'],
      [{ ignorePatterns: ['x'.repeat(301)] }, 'invalid_pattern', 'ignorePatterns[0]'],
      [{ ignorePatterns: 'x' }, 'bad_request', 'ignorePatterns'],
      [{ ignorePatterns: null }, 'bad_request', 'ignorePatterns'],
      [{ ignorePatterns: [1] }, 'bad_request', 'ignorePatterns[0]'],
      [{ excludePatterns: { add: 'x' } }, 'bad_request', 'excludePatterns.add'],
      [{ excludePatterns: { drop: [] } }, 'bad_request', 'excludePatterns.drop'],
      [{ name: 'x' }, 'bad_request', 'name'],
      // A valid change next to an invalid one is not saved either.
      [{ maxPages: 10, excludePatterns: ['(c+)+'] }, 'invalid_pattern', 'excludePatterns[0]'],
    ];
    for (const [body, code, field] of cases) {
      const r = await call(h, 'PATCH', `/watches/${w.id}/rules`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error, JSON.stringify(body)).toMatchObject({ code, field });
      expect(r.json.error.message).not.toMatch(/\*\*|`/);
    }
    const r = await call(h, 'PATCH', `/watches/${w.id}/rules`, { excludePatterns: ['(a+)+'] });
    expect(r.json.error.message).toBe('Skip-URL pattern (a+)+: That pattern has nested repetition like (a+)+, which can freeze the bot on some pages. Please simplify it.');
    expect(update).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(h.store.getWatch(w.id)!.maxPages).toBe(150);

    // The grandfathered pattern is not re-validated; a path glob is accepted; a pattern matching the start URL warns.
    const ok = await call(h, 'PATCH', `/watches/${w.id}/rules`, { ignorePatterns: { add: ['Last updated.*'] }, excludePatterns: ['/profile/*', 'hookedpad'] });
    expect(ok.status).toBe(200);
    expect(ok.json.rules).toMatchObject({ ignorePatterns: ['(a+)+', 'Last updated.*'], excludePatterns: ['/profile/*', 'hookedpad'] });
    expect(ok.json.warnings).toEqual(['hookedpad also matches the start URL.']);
  });

  it('resolves extra pages against the watch and refuses private targets and junk', async () => {
    const { h, w } = await manage({ config: { allowPrivateNetwork: false } });
    h.store.updateWatch(w.id, { extraUrls: ['http://10.0.0.5/old'] }); // added in Discord before: kept
    const cases: Array<[unknown, string, string]> = [
      [['/ok', 'http://127.0.0.1/x'], 'invalid_url', 'extraUrls[1]'],
      [{ add: ['http://[::1]/x'] }, 'invalid_url', 'extraUrls.add[0]'],
      [['http://localhost:3000/x'], 'invalid_url', 'extraUrls[0]'],
      [['ftp://hookedpad.com/x'], 'invalid_url', 'extraUrls[0]'],
      [['a b'], 'invalid_url', 'extraUrls[0]'],
      [[`/${'x'.repeat(2000)}`], 'invalid_url', 'extraUrls[0]'],
      [Array.from({ length: 51 }, (_, i) => `/p${i}`), 'bad_request', 'extraUrls'],
    ];
    for (const [extraUrls, code, field] of cases) {
      const r = await call(h, 'PATCH', `/watches/${w.id}/rules`, { extraUrls });
      expect(r.status, JSON.stringify(extraUrls).slice(0, 80)).toBe(400);
      expect(r.json.error).toMatchObject({ code, field });
    }
    expect(h.store.getWatch(w.id)!.extraUrls).toEqual(['http://10.0.0.5/old']);
    const r = await call(h, 'PATCH', `/watches/${w.id}/rules`, { extraUrls: { add: ['/secret', 'app.hookedpad.com/beta'] } });
    expect(r.json.rules.extraUrls).toEqual(['http://10.0.0.5/old', 'https://hookedpad.com/secret', 'https://app.hookedpad.com/beta']);
    expect((await call(h, 'PATCH', `/watches/${w.id}/rules`, { extraUrls: Array.from({ length: 50 }, (_, i) => `/p${i}`) })).status).toBe(200);
  });

  it('parses scope and max pages like the Rules modal', async () => {
    const { h, w } = await manage();
    const scopes: Array<[unknown, string | null]> = [
      ['/docs/', '/docs'],
      ['docs', '/docs'],
      ['https://hookedpad.com/blog/x/', '/blog/x'],
      ['', null],
      ['/docs', '/docs'],
      [null, null],
      ['off', null],
    ];
    for (const [scopePath, want] of scopes) {
      const r = await call(h, 'PATCH', `/watches/${w.id}/rules`, { scopePath });
      expect(r.status, String(scopePath)).toBe(200);
      expect(r.json.rules.scopePath, String(scopePath)).toBe(want);
    }
    for (const scopePath of ['/a b', '/x?y', 5, `/${'d'.repeat(201)}`]) {
      const r = await call(h, 'PATCH', `/watches/${w.id}/rules`, { scopePath });
      expect(r.json.error, String(scopePath)).toMatchObject({ code: 'bad_request', field: 'scopePath' });
    }
    for (const maxPages of [0, 1001, 1.5, '10', null]) {
      const r = await call(h, 'PATCH', `/watches/${w.id}/rules`, { maxPages });
      expect(r.json.error, String(maxPages)).toMatchObject({ code: 'bad_request', field: 'maxPages' });
    }
    for (const maxPages of [1, 1000]) expect((await call(h, 'PATCH', `/watches/${w.id}/rules`, { maxPages })).json.rules.maxPages).toBe(maxPages);
  });
});

describe('Link API management: pages, subdomains, history', () => {
  it('pages: counts, lists, paging — without page text', async () => {
    const { h, w } = await manage();
    seedSite(h.store, w);
    const listPages = vi.spyOn(h.store, 'listPages');
    const getPage = vi.spyOn(h.store, 'getPage');
    let r = await call(h, 'GET', `/watches/${w.id}/pages`);
    expect(r.status).toBe(200);
    expect(r.json.counts).toEqual({ tracked: 17, maxPages: 150, known: 18, files: 2, gone: 1, dynamic: 1 });
    expect(r.json).toMatchObject({ list: 'tracked', total: 17, nextOffset: null });
    expect(r.json.pages).toHaveLength(17);
    expect(r.json.pages[0]).toEqual({
      url: 'https://hookedpad.com/',
      path: '/',
      title: 'Hookedpad',
      kind: 'page',
      tracked: true,
      gone: false,
      dynamic: false,
      status: 200,
      source: 'start',
      depth: 0,
      firstSeen: 1,
      lastChecked: 2000,
      lastChanged: 1500,
      contentType: 'text/html',
      contentLength: null,
    });
    expect(r.json.pages.find((p: { path: string }) => p.path === '/p03').dynamic).toBe(true);
    r = await call(h, 'GET', `/watches/${w.id}/pages?limit=5`);
    expect(r.json.pages.map((p: { path: string }) => p.path)).toEqual(['/', '/p01', '/p02', '/p03', '/p04']);
    expect(r.json.nextOffset).toBe(5);
    r = await call(h, 'GET', `/watches/${w.id}/pages?limit=5&offset=15`);
    expect(r.json.pages.map((p: { path: string }) => p.path)).toEqual(['/p15', '/p16']);
    expect(r.json.nextOffset).toBeNull();
    r = await call(h, 'GET', `/watches/${w.id}/pages?list=files`);
    expect(r.json).toMatchObject({ list: 'files', total: 2 });
    expect(r.json.pages.map((p: { path: string; lastChecked: number | null; contentLength: number | null }) => [p.path, p.lastChecked, p.contentLength])).toEqual([
      ['/a.pdf', null, 1234],
      ['/b.md', 2000, null],
    ]);
    r = await call(h, 'GET', `/watches/${w.id}/pages?list=untracked`);
    expect(r.json).toMatchObject({ total: 1, pages: [{ path: '/known', tracked: false }] });
    for (const q of ['list=all', 'limit=-1', 'offset=x', 'limit=1.5']) {
      r = await call(h, 'GET', `/watches/${w.id}/pages?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.json.error.code).toBe('bad_request');
    }
    expect((await call(h, 'GET', `/watches/${w.id}/pages?limit=0`)).json.pages).toHaveLength(1);
    expect((await call(h, 'GET', `/watches/${w.id}/pages?limit=99999`)).json.pages).toHaveLength(17);

    // Read paths never load page text.
    await call(h, 'GET', `/watches/${w.id}`);
    await call(h, 'GET', `/watches/${w.id}/subdomains`);
    await call(h, 'GET', `/watches/${w.id}/history`);
    await call(h, 'GET', '/watches');
    expect(listPages).not.toHaveBeenCalled();
    expect(getPage).not.toHaveBeenCalled();
    const sql = [...(h.store as unknown as { stmts: Map<string, unknown> }).stmts.keys()].filter((q) => /^\s*SELECT[\s\S]*FROM pages/.test(q));
    expect(sql.length).toBeGreaterThan(0);
    for (const q of sql) {
      expect(q).not.toMatch(/SELECT\s+\*/);
      expect(q).not.toMatch(/\btext\b/);
    }
  });

  it('subdomains: live first, paging, watchedAs, and the on/off switch', async () => {
    const { h, w } = await manage();
    seedSite(h.store, w);
    const beta = h.store.createWatch({ guildId: G1, channelId: C1, name: 'Hookedpad (beta)', url: 'https://beta.hookedpad.com/', host: 'beta.hookedpad.com', rootDomain: 'hookedpad.com', createdBy: 'u', features: { subdomains: false } });
    addWatch(h.store, G2, 'https://app.hookedpad.com/', 'Theirs'); // another server's watch doesn't count
    addWatch(h.store, G1, 'https://zeta.hookedpad.com/docs', 'Zeta docs'); // not the root URL
    let r = await call(h, 'GET', `/watches/${w.id}/subdomains`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ enabled: false, rootDomain: 'hookedpad.com', known: 3, live: 2, total: 3, nextOffset: null });
    expect(r.json.subdomains.map((s: { host: string }) => s.host)).toEqual(['app.hookedpad.com', 'zeta.hookedpad.com', 'beta.hookedpad.com']);
    expect(r.json.subdomains[0]).toEqual({
      host: 'app.hookedpad.com',
      sources: ['ct', 'dns'],
      alive: true,
      firstSeen: 10,
      lastSeen: 20,
      dns: { a: ['76.76.21.21'], aaaa: [], cname: [] },
      http: { status: 200, title: 'Hookedpad App', finalUrl: 'https://app.hookedpad.com/', server: 'Vercel' },
      watchedAs: null,
    });
    expect(r.json.subdomains[1].watchedAs).toBeNull();
    expect(r.json.subdomains[2].watchedAs).toEqual({ id: beta.id, name: 'Hookedpad (beta)' });
    r = await call(h, 'GET', `/watches/${w.id}/subdomains?limit=2`);
    expect(r.json.subdomains).toHaveLength(2);
    expect(r.json.nextOffset).toBe(2);
    r = await call(h, 'GET', `/watches/${w.id}/subdomains?limit=2&offset=2`);
    expect(r.json.subdomains.map((s: { host: string }) => s.host)).toEqual(['beta.hookedpad.com']);
    expect(r.json.nextOffset).toBeNull();

    r = await call(h, 'PATCH', `/watches/${w.id}/subdomains`, { enabled: true });
    expect(r.json).toMatchObject({ changed: ['checks.subdomains'], message: 'Saved — Subdomains on', warnings: [] });
    expect(r.json.card.subdomains.enabled).toBe(true);
    expect(h.store.getWatch(w.id)!.features).toEqual({ ...w.features, subdomains: true });
    r = await call(h, 'PATCH', `/watches/${w.id}/subdomains`, { enabled: true });
    expect(r.json.changed).toEqual([]);
    h.store.updateWatch(beta.id, { features: { subdomains: true } });
    await call(h, 'PATCH', `/watches/${w.id}/subdomains`, { enabled: false });
    r = await call(h, 'PATCH', `/watches/${w.id}/subdomains`, { enabled: true });
    expect(r.json.warnings).toEqual([`Subdomains of hookedpad.com are already tracked by #${beta.id} Hookedpad (beta) — new subdomains will be announced twice.`]);
    for (const body of [{ enabled: 'yes' }, { enabled: true, mode: 'full' }]) {
      r = await call(h, 'PATCH', `/watches/${w.id}/subdomains`, body);
      expect(r.json.error.code).toBe('bad_request');
    }
    expect(h.logs.filter((l) => l.meta?.action === 'subdomains')).toHaveLength(3);
    expect(h.monitor.calls.checkNow).toEqual([]);
  });

  it('history: newest first, paged with before / nextBefore', async () => {
    const { h, w, theirs } = await manage();
    for (let i = 1; i <= 30; i++) h.store.addEvent(w.id, 'text', `change ${i}`, 1000 + i);
    h.store.addEvent(theirs.id, 'text', 'their change', 5000);
    let r = await call(h, 'GET', `/watches/${w.id}/history`);
    expect(r.json.events).toHaveLength(25);
    expect(r.json.events[0]).toMatchObject({ watchId: w.id, watchName: 'Hookedpad', watchUrl: 'https://hookedpad.com/', kind: 'text', summary: 'change 30', createdAt: 1030 });
    const seen: string[] = [];
    let before: number | null = null;
    for (let page = 0; page < 5; page++) {
      r = await call(h, 'GET', `/watches/${w.id}/history?limit=12${before === null ? '' : `&before=${before}`}`);
      seen.push(...r.json.events.map((e: { summary: string }) => e.summary));
      before = r.json.nextBefore;
      if (before === null) break;
    }
    expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => `change ${30 - i}`));
    r = await call(h, 'GET', `/watches/${w.id}/history?limit=10`);
    expect(r.json.nextBefore).toBe(r.json.events[9].id);
    expect((await call(h, 'GET', `/watches/${w.id}/history?limit=0`)).json.events).toHaveLength(1);
    expect((await call(h, 'GET', `/watches/${w.id}/history?limit=500`)).json.events).toHaveLength(30);
    expect((await call(h, 'GET', `/watches/${w.id}/history?before=0`)).json).toEqual({ events: [], nextBefore: null });
    expect((await call(h, 'GET', `/watches/${w.id}/history?before=abc`)).status).toBe(400);
    expect(JSON.stringify(r.json)).not.toContain('their change');
  });
});

describe('Link API management: watch a subdomain, add with channel/ping, check full', () => {
  it('watches a subdomain as its own site, inheriting the parent’s settings', async () => {
    const { h, w } = await manage();
    h.store.updateWatch(w.id, {
      channelId: C3,
      pingRoleId: R1,
      intervalSec: 45,
      sweepSec: 300,
      maxPages: 99,
      ignorePatterns: ['x+'],
      maskNumbers: true,
      features: { files: false, subdomains: true },
    });
    h.monitor.holdBaseline = true;
    let r = await call(h, 'POST', `/watches/${w.id}/subdomains/watch`, { host: 'APP.hookedpad.com.' });
    expect(r.status).toBe(201);
    expect(r.json.created).toBe(true);
    const child = h.store.getWatch(r.json.watch.id)!;
    expect(child).toMatchObject({
      guildId: G1,
      url: 'https://app.hookedpad.com/',
      host: 'app.hookedpad.com',
      rootDomain: 'hookedpad.com',
      name: 'Hookedpad (app)',
      channelId: C3,
      pingRoleId: R1,
      intervalSec: 45,
      sweepSec: 300,
      maxPages: 99,
      ignorePatterns: ['x+'],
      maskNumbers: true,
      createdBy: 'link:Arkham Dev Tags',
    });
    expect(child.features).toEqual({ ...h.store.getWatch(w.id)!.features, subdomains: false });
    expect(r.json.watch.status).toBe('scanning');
    await vi.waitFor(() => expect(h.announced).toHaveLength(1));
    expect(h.announced[0]).toEqual({
      channelId: C3,
      content: '➕ **Hookedpad (app)** (<https://app.hookedpad.com/>) was added from **Arkham Dev Tags** — first scan running…',
    });
    h.monitor.release();
    await vi.waitFor(() => expect(h.announced).toHaveLength(2));
    expect(h.announced[1].content).toMatch(/^✅ Now watching \*\*Hookedpad \(app\)\*\*/);
    expect(h.monitor.timeline).toEqual([`baseline:${child.id}`, `added:${child.id}`]);

    r = await call(h, 'POST', `/watches/${w.id}/subdomains/watch`, { host: 'app.hookedpad.com' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ created: false, watch: { id: child.id } });
    for (const host of ['evil.com', 'hookedpad.com.evil.io', 'a b.hookedpad.com', 42, undefined, '']) {
      r = await call(h, 'POST', `/watches/${w.id}/subdomains/watch`, host === undefined ? {} : { host });
      expect(r.status, String(host)).toBe(400);
      expect(r.json.error).toMatchObject({ code: 'invalid_url', field: 'host' });
    }
    r = await call(h, 'POST', `/watches/${w.id}/subdomains/watch`, { host: 'b.hookedpad.com', channelId: C1 });
    expect(r.json.error).toMatchObject({ code: 'bad_request', field: 'channelId' });
    expect(h.store.listWatches(G1)).toHaveLength(2);
    expect(h.monitor.calls.checkNow).toEqual([]);
  });

  it('subdomain watches: server limit (409), private hosts (400), and the shared add bucket', async () => {
    const limited = await manage({ config: { maxWatchesPerGuild: 2 } });
    expect((await call(limited.h, 'POST', `/watches/${limited.w.id}/subdomains/watch`, { host: 'a.hookedpad.com' })).status).toBe(201);
    let r = await call(limited.h, 'POST', `/watches/${limited.w.id}/subdomains/watch`, { host: 'b.hookedpad.com' });
    expect(r.status).toBe(409);
    expect(r.json.error).toEqual({ code: 'limit_reached', message: 'This server already watches 2 sites (the limit). Remove one first.' });
    // Already watched still answers 200 at the limit.
    expect((await call(limited.h, 'POST', `/watches/${limited.w.id}/subdomains/watch`, { host: 'a.hookedpad.com' })).status).toBe(200);

    const strict = await setup({ config: { allowPrivateNetwork: false } });
    const nas = strict.store.createWatch({ guildId: G1, channelId: C1, name: 'NAS', url: 'https://nas.local/', host: 'nas.local', rootDomain: 'nas.local', createdBy: 'u' });
    r = await call(strict, 'POST', `/watches/${nas.id}/subdomains/watch`, { host: 'files.nas.local' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: 'invalid_url', field: 'host' });
    expect(r.json.error.message).toMatch(/private or internal address/);

    const { h, w } = await manage({ config: { maxWatchesPerGuild: 0 } });
    for (let i = 0; i < 30; i++) expect((await call(h, 'POST', `/watches/${w.id}/subdomains/watch`, { host: `s${i}.hookedpad.com` })).status).toBe(201);
    r = await call(h, 'POST', `/watches/${w.id}/subdomains/watch`, { host: 's30.hookedpad.com' });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await call(h, 'POST', '/watches', { url: 'unpeg.io' })).status).toBe(429); // the same bucket as POST /watches
  });

  it('POST /watches takes an alert channel and ping role of the token’s server', async () => {
    const { h } = await manage();
    let r = await call(h, 'POST', '/watches', { url: 'unpeg.io', channelId: C3, pingRoleId: R1 });
    expect(r.status).toBe(201);
    expect(r.json.watch.channelId).toBe(C3);
    expect(h.store.getWatch(r.json.watch.id)!.pingRoleId).toBe(R1);
    await vi.waitFor(() => expect(h.announced.length).toBeGreaterThan(0));
    expect(h.announced[0].channelId).toBe(C3);
    r = await call(h, 'POST', '/watches', { url: 'b.io', channelId: C1, pingRoleId: G1 });
    expect(r.status).toBe(201);
    expect(h.store.getWatch(r.json.watch.id)).toMatchObject({ channelId: C1, pingRoleId: G1 });
    for (const [body, code] of [
      [{ url: 'c.io', channelId: 5 }, 'bad_request'],
      [{ url: 'c.io', pingRoleId: 5 }, 'bad_request'],
      [{ url: 'c.io', channelId: CV }, 'invalid_channel'],
      [{ url: 'c.io', pingRoleId: R2 }, 'invalid_role'],
    ] as const) {
      r = await call(h, 'POST', '/watches', body);
      expect(r.json.error.code).toBe(code);
    }
    // Discord not ready: only another channel / role needs it.
    const blind = await setup({ guildInfo: () => null });
    expect((await call(blind, 'POST', '/watches', { url: 'c.io', channelId: C3 })).status).toBe(503);
    expect((await call(blind, 'POST', '/watches', { url: 'c.io', channelId: C1, pingRoleId: G1 })).status).toBe(201);
    expect(h.store.listWatches(G1).map((w) => w.host)).toEqual(['hookedpad.com', 'unpeg.io', 'b.io']);
  });

  it('POST /watches/:id/check takes full, keeps the per-site cooldown and joins a running check', async () => {
    const { h, w } = await manage();
    let release!: () => void;
    h.monitor.checkResult = (id) => new Promise((r) => (release = () => r({ watchId: id, alerts: [], durationMs: 5, error: null })));
    const first = call(h, 'POST', `/watches/${w.id}/check`, { full: true });
    await vi.waitFor(() => expect(h.monitor.calls.checkNow).toHaveLength(1));
    const joined = call(h, 'POST', `/watches/${w.id}/check`, { full: false });
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await first).json).toEqual({ alerts: 0, kinds: [], error: null });
    expect((await joined).status).toBe(200);
    expect(h.monitor.calls.checkFull).toEqual([true]);
    let r = await call(h, 'POST', `/watches/${w.id}/check`, { full: true });
    expect(r.status).toBe(429);
    for (const full of ['yes', 1]) {
      r = await call(h, 'POST', `/watches/${w.id}/check`, { full });
      expect(r.json.error).toMatchObject({ code: 'bad_request', field: 'full' });
    }
  });
});

describe('Link API management: rate limits', () => {
  it('limits management writes to 60 per 10 minutes per token, on top of the overall limit', async () => {
    const { h, w } = await manage();
    const routes: Array<[string, string, unknown]> = [
      ['PATCH', `/watches/${w.id}`, {}],
      ['POST', `/watches/${w.id}/pause`, undefined],
      ['POST', `/watches/${w.id}/resume`, undefined],
      ['PATCH', `/watches/${w.id}/rules`, {}],
      ['PATCH', `/watches/${w.id}/subdomains`, {}],
    ];
    for (let i = 0; i < 60; i++) {
      const [method, path, body] = routes[i % routes.length];
      expect((await call(h, method, path, body)).status, `${i}`).toBe(200);
    }
    const r = await call(h, 'PATCH', `/watches/${w.id}`, { paused: true });
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe('rate_limited');
    const retry = Number(r.headers.get('retry-after'));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(10);
    expect(h.store.getWatch(w.id)!.paused).toBe(false);
    // Reads, and other tokens, are unaffected.
    expect((await call(h, 'GET', `/watches/${w.id}`)).status).toBe(200);
    expect((await call(h, 'GET', `/watches/${w.id}/rules`)).status).toBe(200);
    expect((await call(h, 'PATCH', `/watches/${w.id + 1}`, {}, { token: h.token2 })).status).toBe(200);
    h.clock.t += retry * 1000;
    expect((await call(h, 'PATCH', `/watches/${w.id}`, { paused: true })).status).toBe(200);
  });
});

describe('Link API: the token creator must still have Manage Server', () => {
  it('403s management writes once the creator is demoted, 503s when Discord cannot tell, keeps reads working', async () => {
    const mgr: Record<string, boolean | null> = { u1: true };
    const asked: string[] = [];
    const { h, w } = await manage({
      creatorAccess: async (_g: string, u: string) => {
        asked.push(u);
        const m = u in mgr ? mgr[u] : false;
        return m === null ? null : { manager: m, viewable: null };
      },
    });
    expect((await call(h, 'PATCH', `/watches/${w.id}`, { pingRoleId: G1 })).status).toBe(200);
    expect((await call(h, 'POST', `/watches/${w.id}/pause`, {})).status).toBe(200);
    expect(asked).toEqual(['u1']); // cached
    mgr.u1 = false; // demoted
    h.clock.t += 5 * 60_000;
    let r = await call(h, 'PATCH', `/watches/${w.id}`, { channelId: C3, pingRoleId: null });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('forbidden');
    expect(r.json.error.message).toMatch(/no longer has Manage Server/);
    expect((await call(h, 'DELETE', `/watches/${w.id}`)).status).toBe(403);
    expect((await call(h, 'POST', `/watches/${w.id}/resume`, {})).status).toBe(403);
    expect((await call(h, 'PATCH', `/watches/${w.id}/rules`, { ignorePatterns: ['x'] })).status).toBe(403);
    expect((await call(h, 'PATCH', `/watches/${w.id}/subdomains`, { enabled: true })).status).toBe(403);
    expect((await call(h, 'POST', `/watches/${w.id}/subdomains/watch`, { host: 'app.hookedpad.com' })).status).toBe(403);
    expect((await call(h, 'POST', '/watches', { url: 'unpeg.io' })).status).toBe(403);
    expect(h.store.getWatch(w.id)?.channelId).toBe(C1);
    expect(h.store.getWatch(w.id)?.paused).toBe(true);
    // reads (and Check now, which the Discord card offers to everyone) still work
    expect((await call(h, 'GET', `/watches/${w.id}`)).status).toBe(200);
    expect((await call(h, 'GET', '/watches')).status).toBe(200);
    expect((await call(h, 'GET', '/guild')).status).toBe(200);
    mgr.u1 = null;
    h.clock.t += 5 * 60_000;
    r = await call(h, 'DELETE', `/watches/${w.id}`);
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('30');
    expect(h.store.getWatch(w.id)).toBeTruthy();
  });

  it('offers and accepts only alert channels the creator can see', async () => {
    const { h, w } = await manage({ creatorAccess: async () => ({ manager: true, viewable: new Set([C1, CV]) }) });
    const g = await call(h, 'GET', '/guild');
    expect(g.status).toBe(200);
    expect(g.json.channels.map((c: { id: string }) => c.id)).toEqual([C1]); // C3 is hidden from the creator
    let r = await call(h, 'PATCH', `/watches/${w.id}`, { channelId: C3 });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('invalid_channel');
    expect(r.json.error.field).toBe('channelId');
    expect(h.store.getWatch(w.id)?.channelId).toBe(C1);
    expect(h.announced).toEqual([]);
    r = await call(h, 'POST', '/watches', { url: 'unpeg.io', channelId: C3 });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('invalid_channel');
    expect(h.store.listWatches(G1).some((x) => x.host === 'unpeg.io')).toBe(false);
    // an unchanged channel the creator can't see is not re-checked
    h.store.updateWatch(w.id, { channelId: C3 });
    r = await call(h, 'PATCH', `/watches/${w.id}`, { channelId: C3, name: 'Hooked' });
    expect(r.status).toBe(200);
    expect(r.json.changed).toEqual(['name']);
  });

  it('takes DELETE from the manage bucket (60 per 10 min)', async () => {
    const { h } = await manage();
    const ids = Array.from({ length: 61 }, (_, n) => addWatch(h.store, G1, `https://s${n}.io/`, `S${n}`).id);
    for (const id of ids.slice(0, 60)) expect((await call(h, 'DELETE', `/watches/${id}`)).status).toBe(200);
    const r = await call(h, 'DELETE', `/watches/${ids[60]}`);
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe('rate_limited');
    expect(h.store.getWatch(ids[60])).toBeTruthy();
  });
});
