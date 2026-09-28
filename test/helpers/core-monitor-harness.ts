/**
 * Test harness for the deploy / status / files checkers: a local fake site (node:http on 127.0.0.1:0) and a CheckContext
 * built from real modules (in-memory Store, HttpClient with private addresses allowed) plus a fake clock and no-op sleep.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { testConfig, type Config } from '../../src/config.js';
import { Store } from '../../src/db/store.js';
import { HttpClient } from '../../src/net/http.js';
import { silentLogger } from '../../src/log.js';
import { looksLikeHtml, parseHtml } from '../../src/extract/html.js';
import type { NewWatchInput, PageRecord, Watch, WatchFeatures } from '../../src/types.js';
import type { CheckContext, HomeSnapshot } from '../../src/monitor/context.js';
import type { DnsProvider } from '../../src/net/dns.js';
import type { CtProvider } from '../../src/monitor/subdomains.js';
import type { FetchResult } from '../../src/net/http.js';

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export type Route = Reply | ((req: http.IncomingMessage) => Reply);

export interface FakeSite {
  origin: string;
  url(path?: string): string;
  /** Exact pathname → reply. Unknown paths answer 404. */
  routes: Map<string, Route>;
  /** Pathname → number of requests. */
  hits: Map<string, number>;
  hitCount(path: string): number;
  /** Every request's headers, in order. */
  requests: Array<{ path: string; headers: http.IncomingHttpHeaders }>;
  close(): Promise<void>;
}

export async function startFakeSite(): Promise<FakeSite> {
  const routes = new Map<string, Route>();
  const hits = new Map<string, number>();
  const requests: FakeSite['requests'] = [];
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://placeholder').pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    requests.push({ path, headers: req.headers });
    const route = routes.get(path);
    let reply: Reply;
    try {
      reply =
        route === undefined
          ? { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' }
          : typeof route === 'function'
            ? route(req)
            : route;
    } catch (err) {
      reply = { status: 500, body: String(err) };
    }
    const status = reply.status ?? 200;
    const body = status === 304 ? '' : (reply.body ?? '');
    const headers: Record<string, string | number> = { ...reply.headers };
    if (status !== 304 && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
      headers['content-length'] = Buffer.byteLength(body);
    }
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' || status === 304 ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    url: (p = '/') => origin + p,
    routes,
    hits,
    hitCount: (p) => hits.get(p) ?? 0,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const START_TIME = 1_750_000_000_000;

export interface Harness {
  ctx: CheckContext;
  store: Store;
  watch: Watch;
  clock: { now: number };
  advance(ms: number): void;
  /** Delays passed to ctx.sleep. */
  sleeps: number[];
  close(): void;
}

const unusedCt = {} as unknown as CtProvider;
const unusedDns: DnsProvider = {
  resolve: async () => null,
  wildcard: async () => null,
};

export function makeHarness(opts: {
  url: string;
  rootDomain?: string;
  features?: Partial<WatchFeatures>;
  watch?: Partial<NewWatchInput>;
  config?: Partial<Config>;
  baseline?: boolean;
  start?: number;
}): Harness {
  const u = new URL(opts.url);
  const store = new Store(':memory:');
  const watch = store.createWatch({
    guildId: 'g1',
    channelId: 'c1',
    name: 'Test',
    url: opts.url,
    host: u.hostname,
    rootDomain: opts.rootDomain ?? u.hostname,
    createdBy: 'u1',
    features: opts.features,
    ...opts.watch,
  });
  const config = testConfig({ confirmDelayMs: 0, ...opts.config });
  const http = new HttpClient({
    userAgent: config.userAgent,
    globalConcurrency: config.globalConcurrency,
    perHostConcurrency: config.perHostConcurrency,
    timeoutMs: config.requestTimeoutMs,
    maxBytes: config.maxBodyBytes,
    allowPrivate: true,
  });
  const clock = { now: opts.start ?? START_TIME };
  const sleeps: number[] = [];
  const ctx: CheckContext = {
    watch,
    state: store.getState(watch.id),
    store,
    http,
    config,
    log: silentLogger,
    providers: { ct: unusedCt, dns: unusedDns },
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseline: opts.baseline ?? false,
  };
  return {
    ctx,
    store,
    watch,
    clock,
    advance: (ms) => {
      clock.now += ms;
    },
    sleeps,
    close: () => store.close(),
  };
}

/** Fetch + parse the homepage the way the scheduler does. */
export async function fetchHome(ctx: CheckContext): Promise<HomeSnapshot> {
  const fetch = await ctx.http.fetch(ctx.watch.url, { ignoreBackoff: true });
  const parsed =
    fetch.ok && !fetch.blocked && fetch.bodyText !== null && looksLikeHtml(fetch.contentType, fetch.bodyText)
      ? parseHtml(fetch.bodyText, fetch.finalUrl)
      : null;
  return { fetch, parsed };
}

/** A fake FetchResult (defaults: 200 text/html). */
export function fakeFetch(status: number, over: Partial<FetchResult> = {}): FetchResult {
  return {
    url: 'https://site.example/',
    finalUrl: 'https://site.example/',
    status,
    ok: status >= 200 && status <= 299,
    notModified: status === 304,
    redirected: false,
    headers: {},
    contentType: status === 0 ? null : 'text/html',
    body: null,
    bodyText: null,
    truncated: false,
    blocked: false,
    retryAfterMs: null,
    error: status === 0 ? 'ECONNREFUSED' : null,
    elapsedMs: 3,
    ...over,
  };
}

/** A HomeSnapshot for given HTML without any network (e.g. what the first fetch of a tick saw). */
export function homeFromHtml(html: string, url: string): HomeSnapshot {
  return {
    fetch: fakeFetch(200, { url, finalUrl: url, bodyText: html, body: Buffer.from(html) }),
    parsed: parseHtml(html, url),
  };
}

export function fileRecord(watchId: number, url: string, over: Partial<PageRecord> = {}): PageRecord {
  return {
    watchId,
    url,
    kind: 'file',
    tracked: true,
    title: null,
    text: null,
    textHash: null,
    etag: null,
    lastModified: null,
    contentLength: null,
    contentType: null,
    status: null,
    failCount: 0,
    gone: false,
    maskNumbers: false,
    numericChangeTimes: [],
    flapCount: 0,
    dynamic: false,
    pendingHash: null,
    pendingSince: null,
    hashHistory: [],
    changeTimes: [],
    maskedLines: [],
    source: 'link',
    depth: 1,
    firstSeen: START_TIME - 1000,
    lastChecked: 0,
    lastChanged: null,
    ...over,
  };
}
