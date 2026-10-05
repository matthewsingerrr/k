/**
 * Scheduler unit tests: loop mechanics (non-overlap, timeouts, pause/resume/remove, stop), baseline flow, re-baselines,
 * notifier isolation, the subdomain slow loop, and alert summaries/ordering.
 *
 * Uses a fake HttpClient (no sockets) so fake timers can drive the loops deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { silentLogger } from '../src/log.js';
import type { FetchOptions, FetchResult, HttpClient } from '../src/net/http.js';
import type { DnsProvider } from '../src/net/dns.js';
import { resetSubdomainCaches, type CtProvider } from '../src/monitor/subdomains.js';
import {
  ALERT_ORDER,
  isUsableHome,
  Monitor,
  MIN_TICK_TIMEOUT_MS,
  orderAlerts,
  STAGGER_MAX_MS,
  summarizeAlert,
} from '../src/monitor/scheduler.js';
import type { Alert, NewWatchInput, Notifier, Watch, WatchFeatures } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const ORIGIN = 'http://127.0.0.1:9';

interface Reply {
  status?: number;
  body?: string | Buffer;
  type?: string;
  headers?: Record<string, string>;
  /** Pretend the request was redirected here. */
  finalUrl?: string;
  blocked?: boolean;
}
type Route = Reply | ((url: string) => Reply | Promise<Reply>);

class FakeHttp {
  routes = new Map<string, Route>();
  calls: string[] = [];
  active = 0;
  maxActive = 0;

  readonly client = {
    fetch: (url: string, opts?: FetchOptions) => this.fetch(url, opts),
    stats: () => ({ active: this.active, pending: 0 }),
  } as unknown as HttpClient;

  set(path: string, route: Route): void {
    this.routes.set(path.startsWith('http') ? path : ORIGIN + path, route);
  }

  count(path: string): number {
    const url = path.startsWith('http') ? path : ORIGIN + path;
    return this.calls.filter((c) => c === url).length;
  }

  private async fetch(url: string, _opts?: FetchOptions): Promise<FetchResult> {
    this.calls.push(url);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const route = this.routes.get(url);
      const reply: Reply = route === undefined ? { status: 404, body: 'not found', type: 'text/plain' } : typeof route === 'function' ? await route(url) : route;
      const status = reply.status ?? 200;
      const body = reply.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body);
      const contentType = reply.type ?? 'text/html';
      return {
        url,
        finalUrl: reply.finalUrl ?? url,
        status,
        ok: status >= 200 && status < 300,
        notModified: status === 304,
        redirected: reply.finalUrl !== undefined && reply.finalUrl !== url,
        headers: { 'content-type': contentType, 'content-length': String(body.length), ...reply.headers },
        contentType,
        body,
        bodyText: body.toString('utf8'),
        truncated: false,
        blocked: reply.blocked ?? false,
        retryAfterMs: null,
        error: null,
        elapsedMs: 1,
      };
    } finally {
      this.active--;
    }
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function page(title: string, body: string, scripts: string[] = ['/app-1.js']): Reply {
  return {
    body: `<!DOCTYPE html><html><head><title>${title}</title>${scripts.map((s) => `<script src="${s}"></script>`).join('')}</head><body>${body}</body></html>`,
  };
}

/** Drain every pending promise job (the fake HTTP client does no I/O). */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

interface Setup {
  store: Store;
  watch: Watch;
  http: FakeHttp;
  monitor: Monitor;
  delivered: Alert[][];
  ct: CtProvider & { certspotter: ReturnType<typeof vi.fn>; crtsh: ReturnType<typeof vi.fn> };
  live: Set<string>;
}

function setup(opts: { features?: Partial<WatchFeatures>; watch?: Partial<NewWatchInput>; notifier?: Notifier; now?: () => number } = {}): Setup {
  const store = new Store(':memory:');
  const watch = store.createWatch({
    guildId: 'g1',
    channelId: 'c1',
    name: 'Acme',
    url: `${ORIGIN}/`,
    host: '127.0.0.1',
    rootDomain: '127.0.0.1',
    createdBy: 'u1',
    intervalSec: 30,
    sweepSec: 120,
    features: opts.features,
    ...opts.watch,
  });
  const http = new FakeHttp();
  http.set('/', page('Acme', '<h1>Hello</h1><p>Welcome to Acme.</p>'));
  http.set('/app-1.js', { body: 'console.log("/docs")', type: 'application/javascript' });
  const delivered: Alert[][] = [];
  const notifier: Notifier = opts.notifier ?? {
    notify: async (_w, alerts) => {
      delivered.push(alerts);
    },
  };
  const live = new Set<string>();
  const ct = {
    certspotter: vi.fn(async () => ({ names: [] as string[], cursor: 'c0' as string | null })),
    crtsh: vi.fn(async () => [] as string[]),
  };
  const dns: DnsProvider = {
    resolve: async (host) => (live.has(host) ? { a: ['203.0.113.7'], aaaa: [], cname: [] } : null),
    wildcard: async () => null,
  };
  const monitor = new Monitor({
    store,
    http: http.client,
    notifier,
    config: testConfig({ confirmDelayMs: 0 }),
    log: silentLogger,
    providers: { ct, dns },
    sleep: async () => {},
    now: opts.now,
  });
  return { store, watch, http, monitor, delivered, ct, live };
}

beforeEach(() => {
  resetSubdomainCaches();
});

afterEach(() => {
  vi.useRealTimers();
});

function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.UTC(2026, 8, 28, 12) });
}

/** Advance fake time and let the async work it triggers finish. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

// ---------------------------------------------------------------------------
// summarizeAlert / orderAlerts / isUsableHome
// ---------------------------------------------------------------------------

describe('summarizeAlert', () => {
  it('summarizes every alert kind on one line', () => {
    const cases: Array<[Alert, string]> = [
      [
        {
          kind: 'deploy',
          url: 'https://unpeg.io/',
          host: 'unpeg.io',
          buildIdOld: 'KU791SoC2tXw-mGI_0Sms',
          buildIdNew: 'abc123def4',
          assetsAdded: ['/a.js', '/b.js', '/c.css'],
          assetsRemoved: ['/old.js', '/old.css'],
          newCodePaths: ['/airdrop', '/claim'],
          newCodeHosts: ['api.unpeg.io'],
        },
        'redeployed: build KU791SoC2t… → abc123def4, +3/−2 assets, new code paths: /airdrop, /claim, new hosts in code: api.unpeg.io',
      ],
      [
        { kind: 'deploy', url: 'u', host: 'h', buildIdOld: null, buildIdNew: null, assetsAdded: ['/x.js'], assetsRemoved: [], newCodePaths: [], newCodeHosts: [] },
        'redeployed: +1/−0 assets',
      ],
      [
        {
          kind: 'text',
          changes: ['a', 'b', 'c', 'd', 'e'].map((p) => ({
            url: `https://unpeg.io/docs/${p}`,
            title: null,
            titleChange: null,
            diff: { added: [], removed: [], numericOnly: false, unified: '', hash: 'h' },
          })),
          groups: [],
        },
        'text changed on 5 pages: /docs/a, /docs/b, /docs/c (+2 more)',
      ],
      [
        { kind: 'new_pages', pages: [{ url: 'https://unpeg.io/docs/points', title: 'Points', source: 'link' }] },
        '1 new page: /docs/points',
      ],
      [
        { kind: 'removed_pages', pages: [{ url: 'https://unpeg.io/old', status: 404 }, { url: 'https://unpeg.io/gone', status: 410 }] },
        '2 pages removed: /old (404), /gone (410)',
      ],
      [
        { kind: 'subdomain', rootDomain: 'unpeg.io', subdomains: [{ host: 'api.unpeg.io', sources: ['ct'], dns: null, http: null }] },
        '1 new subdomain: api.unpeg.io',
      ],
      [
        {
          kind: 'subdomain_live',
          rootDomain: 'unpeg.io',
          subdomains: [
            { host: 'a.unpeg.io', sources: ['ct'], dns: null, http: null },
            { host: 'b.unpeg.io', sources: ['dns'], dns: null, http: null },
          ],
        },
        '2 subdomains now live: a.unpeg.io, b.unpeg.io',
      ],
      [
        {
          kind: 'file',
          files: [
            { url: 'https://unpeg.io/whitepaper.pdf', change: 'modified', oldSize: 10, newSize: 12, contentType: 'application/pdf' },
            { url: 'https://unpeg.io/terms.md', change: 'added', oldSize: null, newSize: 3, contentType: 'text/markdown' },
          ],
        },
        '2 files changed: modified whitepaper.pdf, added terms.md',
      ],
      [{ kind: 'status', url: 'u', up: false, detail: 'HTTP 502', downForMs: null }, 'DOWN: HTTP 502'],
      [{ kind: 'status', url: 'u', up: true, detail: 'HTTP 200', downForMs: 252_000 }, 'back UP after 4m 12s (HTTP 200)'],
      [{ kind: 'info', message: 'ℹ️ /stats looks like it shows\nlive numbers' }, 'ℹ️ /stats looks like it shows live numbers'],
    ];
    for (const [alert, expected] of cases) expect(summarizeAlert(alert)).toBe(expected);
  });

  it('caps the length and never throws on malformed alerts', () => {
    const long = summarizeAlert({ kind: 'info', message: 'x'.repeat(5000) });
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith('…')).toBe(true);
    expect(summarizeAlert({ kind: 'text' } as unknown as Alert)).toBe('text changed on 0 pages');
    expect(summarizeAlert({ kind: 'deploy' } as unknown as Alert)).toBe('redeployed: +0/−0 assets');
    expect(summarizeAlert(null as unknown as Alert)).toBe('alert');
    expect(summarizeAlert({ kind: 'weird' } as unknown as Alert)).toBe('weird');
  });
});

describe('orderAlerts', () => {
  it('orders deploy, text, new_pages, removed_pages, file, status, info — stable within a kind', () => {
    const info1: Alert = { kind: 'info', message: '1' };
    const info2: Alert = { kind: 'info', message: '2' };
    const status: Alert = { kind: 'status', url: 'u', up: false, detail: 'x', downForMs: null };
    const file: Alert = { kind: 'file', files: [] };
    const removed: Alert = { kind: 'removed_pages', pages: [] };
    const fresh: Alert = { kind: 'new_pages', pages: [] };
    const text: Alert = { kind: 'text', changes: [], groups: [] };
    const deploy = { kind: 'deploy' } as Alert;
    const out = orderAlerts([info1, status, file, info2, removed, fresh, text, deploy]);
    expect(out.map((a) => a.kind)).toEqual(['deploy', 'text', 'new_pages', 'removed_pages', 'file', 'status', 'info', 'info']);
    expect(out.slice(-2)).toEqual([info1, info2]);
    expect(Object.keys(ALERT_ORDER)).toHaveLength(9);
  });
});

describe('isUsableHome', () => {
  const res = (status: number, blocked = false) => ({ status, blocked }) as FetchResult;
  it('treats network errors, 5xx, 429 and challenges as unusable', () => {
    expect(isUsableHome(res(200))).toBe(true);
    expect(isUsableHome(res(404))).toBe(true);
    expect(isUsableHome(res(0))).toBe(false);
    expect(isUsableHome(res(503))).toBe(false);
    expect(isUsableHome(res(429))).toBe(false);
    expect(isUsableHome(res(403, true))).toBe(false);
    expect(isUsableHome(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

describe('runBaseline', () => {
  it('records silently, sets baselineDone/baselineAt and returns counts; concurrent calls share one run', async () => {
    const { store, watch, http, monitor, delivered } = setup();
    http.set('/', page('Acme', '<a href="/about">About</a><a href="/paper.pdf">Paper</a>'));
    http.set('/about', page('About', '<p>About us</p>'));
    http.set('/paper.pdf', { body: '%PDF-1.4 x', type: 'application/pdf' });

    const a = monitor.runBaseline(watch.id);
    const b = monitor.runBaseline(watch.id);
    expect(b).toBe(a);
    expect(monitor.runtimeInfo(watch.id).baselineRunning).toBe(true);
    const summary = await a;
    expect(summary).toMatchObject({ watchId: watch.id, pagesTracked: 2, files: 1, homeStatus: 200, homeBlocked: false, assets: 1 });
    expect(http.count('/')).toBe(1);
    expect(delivered).toEqual([]);
    expect(store.listEvents(watch.id, 5)).toEqual([]);
    expect(store.getWatch(watch.id)?.baselineDone).toBe(true);
    expect(store.getState(watch.id).baselineAt).toBeGreaterThan(0);
    expect(monitor.runtimeInfo(watch.id).baselineRunning).toBe(false);
    expect(monitor.lastActivityAt()).not.toBeNull();
  });

  it('rejects for unknown watches', async () => {
    const { monitor } = setup();
    await expect(monitor.runBaseline(999)).rejects.toThrow(/unknown watch/);
    await expect(monitor.checkNow(999)).rejects.toThrow(/unknown watch/);
    expect(monitor.runtimeInfo(999)).toEqual({ running: false, lastTickAt: null, lastTickMs: null, nextTickAt: null, baselineRunning: false });
  });

  it('a homepage that is down at baseline time keeps the watch un-baselined; once it answers, it is baselined silently', async () => {
    useFakeClock();
    const { store, watch, http, monitor, delivered } = setup();
    http.set('/', { status: 503, body: 'maintenance' });

    const summary = await monitor.runBaseline(watch.id);
    expect(summary).toMatchObject({ homeStatus: 503, homeBlocked: false });
    expect(store.getWatch(watch.id)?.baselineDone).toBe(false);
    const check = await monitor.checkNow(watch.id);
    expect(check.alerts).toEqual([]);
    expect(check.error).toMatch(/baseline incomplete: homepage HTTP 503/);

    monitor.onWatchAdded(store.getWatch(watch.id)!);
    const before = http.calls.length;
    await advance(0); // starts immediately: baseline pending, homepage known bad → one probe only
    expect(http.calls.length - before).toBe(1);
    await advance(33_000);
    expect(http.calls.length - before).toBe(2);
    expect(store.getWatch(watch.id)?.baselineDone).toBe(false);

    // The site comes up with pages that existed all along: they must not be announced as new.
    http.set('/', page('Acme', '<a href="/about">About</a><a href="/team">Team</a>'));
    http.set('/about', page('About', '<p>About</p>'));
    http.set('/team', page('Team', '<p>Team</p>'));
    await advance(33_000);
    expect(store.getWatch(watch.id)?.baselineDone).toBe(true);
    expect(store.countPages(watch.id, { kind: 'page', tracked: true })).toBe(3);
    await advance(33_000);
    await advance(33_000);
    expect(delivered).toEqual([]);
    await monitor.stop();
  });
});

// ---------------------------------------------------------------------------
// Loop mechanics
// ---------------------------------------------------------------------------

describe('loops', () => {
  it('start() staggers first ticks within min(interval, 10s) and baselines new watches first', async () => {
    useFakeClock();
    const { store, watch, http, monitor, delivered } = setup();
    const w2 = store.createWatch({ ...watch, name: 'Two', url: `${ORIGIN}/two`, intervalSec: 5 });
    http.set('/two', page('Two', '<p>two</p>'));
    await monitor.runBaseline(watch.id);
    expect(store.getWatch(w2.id)?.baselineDone).toBe(false);

    const t0 = Date.now();
    monitor.start();
    for (const [id, cap] of [
      [watch.id, STAGGER_MAX_MS],
      [w2.id, 5_000],
    ]) {
      const info = monitor.runtimeInfo(id);
      expect(info.running).toBe(true);
      expect(info.nextTickAt).not.toBeNull();
      expect(info.nextTickAt! - t0).toBeGreaterThanOrEqual(0);
      expect(info.nextTickAt! - t0).toBeLessThanOrEqual(cap);
    }
    await advance(STAGGER_MAX_MS);
    expect(store.getWatch(w2.id)?.baselineDone).toBe(true);
    expect(http.count('/two')).toBeGreaterThanOrEqual(1);
    expect(monitor.runtimeInfo(watch.id).lastTickAt).not.toBeNull();
    expect(delivered).toEqual([]);
    await monitor.stop();
  });

  it('reschedules every interval ± 10%; a stuck tick blocks further ticks until it settles, even after its timeout guard', async () => {
    useFakeClock();
    const { store, watch, http, monitor } = setup();
    await monitor.runBaseline(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);

    const next = monitor.runtimeInfo(watch.id).nextTickAt! - Date.now();
    expect(next).toBeGreaterThanOrEqual(27_000);
    expect(next).toBeLessThanOrEqual(33_000);

    const gate = deferred();
    let homeFetches = 0;
    let firstStart = 0;
    http.set('/', async () => {
      if (homeFetches++ === 0) firstStart = Date.now();
      await gate.promise;
      return page('Acme', '<h1>Hello</h1><p>Welcome to Acme.</p>');
    });
    await advance(33_000); // scheduled tick starts and blocks on the homepage
    expect(homeFetches).toBe(1);

    const manual = monitor.checkNow(watch.id);
    await advance(1_000);
    expect(homeFetches).toBe(1); // queued behind the in-flight tick
    // Several intervals pass: no other tick starts while one is in flight…
    await advance(firstStart + MIN_TICK_TIMEOUT_MS - 1_000 - Date.now());
    expect(homeFetches).toBe(1);
    await advance(2_000);
    // The stuck tick was abandoned at the timeout guard, but it is still running: the manual tick keeps waiting, so
    // two ticks never overlap (they would race on the same records and alert twice).
    expect(homeFetches).toBe(1);
    gate.resolve();
    await flush();
    const res = await manual;
    expect(homeFetches).toBe(2);
    expect(res.error).toBeNull();
    expect(http.maxActive).toBe(1); // never two live ticks
    await monitor.stop();
  });

  it('a manual check waits for the scheduled tick, then runs its own; the timer tick queued behind it is skipped', async () => {
    useFakeClock();
    const { store, watch, http, monitor } = setup();
    await monitor.runBaseline(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    const gate = deferred();
    let concurrent = 0;
    let maxConcurrent = 0;
    let homeFetches = 0;
    http.set('/', async () => {
      homeFetches++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await gate.promise;
      concurrent--;
      return page('Acme', '<h1>Hello</h1><p>Welcome to Acme.</p>');
    });
    await advance(33_000);
    expect(homeFetches).toBe(1);
    const manual = monitor.checkNow(watch.id);
    await advance(10);
    expect(homeFetches).toBe(1);
    gate.resolve();
    await flush();
    await manual;
    expect(homeFetches).toBe(2);
    expect(maxConcurrent).toBe(1);
    // The next scheduled tick is pushed a full interval out from the manual check.
    const next = monitor.runtimeInfo(watch.id).nextTickAt! - Date.now();
    expect(next).toBeGreaterThanOrEqual(27_000);
    await monitor.stop();
  });

  it('abandons a tick that exceeds the timeout guard and lets the next one run', async () => {
    useFakeClock();
    const { watch, http, monitor } = setup();
    await monitor.runBaseline(watch.id);
    http.set('/', () => new Promise<Reply>(() => {})); // hangs forever
    const stuck = monitor.checkNow(watch.id);
    await advance(MIN_TICK_TIMEOUT_MS - 1_000);
    let settled = false;
    void stuck.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    await advance(2_000);
    const res = await stuck;
    expect(res.error).toMatch(/timed out after 120s/);
    expect(res.alerts).toEqual([]);

    // The hung run never settles: the lane is released one more timeout later.
    http.set('/', page('Acme', '<h1>Hello</h1><p>Welcome to Acme.</p>'));
    const next = monitor.checkNow(watch.id);
    let ran = false;
    void next.then(() => (ran = true));
    await advance(MIN_TICK_TIMEOUT_MS - 5_000);
    expect(ran).toBe(false);
    await advance(10_000);
    const ok = await next;
    expect(ok.error).toBeNull();
    await monitor.stop();
  });

  it('pause stops the loops, resume restarts them, interval changes reschedule', async () => {
    useFakeClock();
    const { store, watch, http, monitor } = setup();
    await monitor.runBaseline(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    await advance(33_000);
    const afterFirst = http.count('/');
    expect(afterFirst).toBe(2); // baseline + one tick

    monitor.onWatchUpdated(store.updateWatch(watch.id, { paused: true }));
    expect(monitor.runtimeInfo(watch.id)).toMatchObject({ running: false, nextTickAt: null });
    await advance(300_000);
    expect(http.count('/')).toBe(afterFirst);

    // Paused watches can still be checked on demand.
    await monitor.checkNow(watch.id);
    expect(http.count('/')).toBe(afterFirst + 1);

    monitor.onWatchUpdated(store.updateWatch(watch.id, { paused: false }));
    expect(monitor.runtimeInfo(watch.id).running).toBe(true);
    await advance(STAGGER_MAX_MS);
    expect(http.count('/')).toBe(afterFirst + 2);

    monitor.onWatchUpdated(store.updateWatch(watch.id, { intervalSec: 300 }));
    const next = monitor.runtimeInfo(watch.id).nextTickAt! - Date.now();
    expect(next).toBeGreaterThanOrEqual(270_000);
    expect(next).toBeLessThanOrEqual(330_000);
    await advance(100_000);
    expect(http.count('/')).toBe(afterFirst + 2);
    await monitor.stop();
  });

  it('onWatchRemoved stops the loops, drops in-flight alerts and forgets the watch', async () => {
    useFakeClock();
    const { store, watch, http, monitor, delivered } = setup();
    await monitor.runBaseline(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    const gate = deferred();
    http.set('/', async () => {
      await gate.promise;
      return { status: 500, body: 'boom' };
    });
    // Two failing ticks, then a third that is in flight when the watch is removed (it would cross the DOWN threshold).
    http.set('/', { status: 500, body: 'boom' });
    await advance(33_000);
    await advance(33_000);
    http.set('/', async () => {
      await gate.promise;
      return { status: 500, body: 'boom' };
    });
    await advance(33_000);
    const fetched = http.count('/');
    monitor.onWatchRemoved(watch.id);
    store.deleteWatch(watch.id);
    gate.resolve();
    await flush();
    expect(delivered).toEqual([]);
    expect(monitor.runtimeInfo(watch.id).running).toBe(false);
    await advance(300_000);
    expect(http.count('/')).toBe(fetched);
    await expect(monitor.checkNow(watch.id)).rejects.toThrow(/unknown watch/);
    await monitor.stop();
  });

  it('a watch deleted from the store without onWatchRemoved stops by itself', async () => {
    useFakeClock();
    const { store, watch, http, monitor } = setup();
    await monitor.runBaseline(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    store.deleteWatch(watch.id);
    const before = http.count('/');
    await advance(100_000);
    expect(http.count('/')).toBe(before);
    expect(monitor.runtimeInfo(watch.id).running).toBe(false);
    await monitor.stop();
  });

  it('a throwing notifier never breaks the loop; events are still recorded', async () => {
    useFakeClock();
    const notify = vi.fn(async () => {
      throw new Error('Discord is down');
    });
    const { store, watch, http, monitor } = setup({ notifier: { notify } });
    await monitor.runBaseline(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    http.set('/', { status: 500, body: 'boom' });
    for (let i = 0; i < 3; i++) await advance(33_000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(store.listEvents(watch.id, 5).map((e) => [e.kind, e.summary])).toEqual([['status', 'DOWN: HTTP 500']]);

    http.set('/', page('Acme', '<h1>Hello</h1><p>Welcome to Acme.</p>'));
    await advance(33_000);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(store.listEvents(watch.id, 5)[0].summary).toMatch(/^back UP after/);
    expect(monitor.runtimeInfo(watch.id).running).toBe(true);
    const state = store.getState(watch.id);
    expect(state.lastError).toBeNull();
    expect(state.status.up).toBe(true);
    await monitor.stop();
  });

  it('stop() clears timers and waits for the in-flight tick', async () => {
    useFakeClock();
    const { store, watch, http, monitor } = setup();
    await monitor.runBaseline(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    const gate = deferred();
    http.set('/', async () => {
      await gate.promise;
      return page('Acme', '<h1>Hello</h1><p>Welcome to Acme.</p>');
    });
    await advance(33_000);
    let stopped = false;
    const stopping = monitor.stop().then(() => (stopped = true));
    await flush();
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    const n = http.count('/');
    await advance(300_000);
    expect(http.count('/')).toBe(n);
    expect(monitor.runtimeInfo(watch.id).running).toBe(false);
    monitor.onWatchAdded(store.getWatch(watch.id)!); // ignored after stop
    expect(monitor.runtimeInfo(watch.id).running).toBe(false);
  });

  it('stop() gives up waiting after 10s on a hung tick', async () => {
    useFakeClock();
    const { store, watch, http, monitor } = setup();
    await monitor.runBaseline(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    http.set('/', () => new Promise<Reply>(() => {}));
    await advance(33_000);
    let stopped = false;
    const stopping = monitor.stop().then(() => (stopped = true));
    await advance(9_000);
    expect(stopped).toBe(false);
    await advance(1_500);
    await stopping;
    expect(stopped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Re-baselines
// ---------------------------------------------------------------------------

describe('settings changes', () => {
  it('enabling files records the linked files silently in the next check; later changes are reported', async () => {
    useFakeClock();
    const { store, watch, http, monitor, delivered } = setup({ features: { files: false } });
    http.set('/', page('Acme', '<a href="/whitepaper.pdf">Whitepaper</a><p>Hello</p>'));
    http.set('/whitepaper.pdf', { body: '%PDF-1.4 v1', type: 'application/pdf' });
    await monitor.runBaseline(watch.id);
    expect(store.countPages(watch.id, { kind: 'file' })).toBe(0);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    await advance(33_000);

    monitor.onWatchUpdated(store.updateWatch(watch.id, { features: { files: true } }));
    await advance(33_000); // the next check records the file silently
    expect(store.listPages(watch.id, { kind: 'file' }).map((r) => r.textHash !== null)).toEqual([true]);
    await advance(33_000);
    await advance(200_000);
    expect(delivered).toEqual([]); // the pre-existing whitepaper is not "added"

    // …while a real change afterwards is reported.
    http.set('/whitepaper.pdf', { body: '%PDF-1.4 v2 with more bytes', type: 'application/pdf' });
    await monitor.checkNow(watch.id, { full: true });
    expect(delivered.flat().map((a) => a.kind)).toEqual(['file']);
    await monitor.stop();
  });

  it('an ignore pattern hides what it matches right away (no refetch needed); an edit elsewhere still alerts', async () => {
    useFakeClock();
    const { store, watch, http, monitor, delivered } = setup();
    http.set('/', page('Acme', '<p>Hello</p><p>Visitors today: 5 (session abc)</p>'));
    await monitor.runBaseline(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    await advance(33_000);

    monitor.onWatchUpdated(store.updateWatch(watch.id, { name: 'Renamed', channelId: 'c2' }));
    await advance(33_000);

    monitor.onWatchUpdated(store.updateWatch(watch.id, { ignorePatterns: ['Visitors today: .*'] }));
    // The session id changes too, in the same moment: it is inside the ignored part.
    http.set('/', page('Acme', '<p>Hello</p><p>Visitors today: 9 (session xyz)</p>'));
    await advance(33_000);
    await advance(33_000);
    http.set('/', page('Acme', '<p>Hello</p><p>Visitors today: 12 (session q)</p>'));
    await advance(33_000);
    expect(delivered).toEqual([]);

    // An unrelated edit on another line is still reported.
    http.set('/', page('Acme', '<p>Hello, world</p><p>Visitors today: 13 (session r)</p>'));
    await advance(33_000);
    expect(delivered.flat().map((a) => a.kind)).toEqual(['text']);

    // "Ignore numbers" switched on: applied before the next check, quietly.
    monitor.onWatchUpdated(store.updateWatch(watch.id, { maskNumbers: true }));
    http.set('/', page('Acme', '<p>Hello, world</p><p>Visitors today: 14 (session s)</p>'));
    const res = await monitor.checkNow(watch.id);
    expect(res.error).toBeNull();
    expect(res.alerts).toEqual([]);
    await monitor.stop();
  });

  it('switching a checker on does not swallow real changes found by the others in the same check', async () => {
    useFakeClock();
    const subWatch = { host: 'acme.io', rootDomain: 'acme.io', url: `${ORIGIN}/` };
    const { store, watch, http, monitor, delivered, ct, live } = setup({ watch: subWatch, features: { status: false } });
    live.add('acme.io');
    const build = (id: string) => `<script id="__NEXT_DATA__" type="application/json">{"buildId":"${id}","page":"/"}</script>`;
    http.set('/', page('Acme', `<p>Fee is 0.3 percent.</p><a href="/a">A</a>${build('build-one-111')}`));
    http.set('/a', page('A', '<p>Docs A</p>'));
    await monitor.runBaseline(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);

    http.set('/', page('Acme', `<p>Fee is 0.5 percent now.</p><a href="/a">A</a>${build('build-two-222')}`));
    ct.certspotter.mockResolvedValue({ names: ['launch.acme.io'], cursor: 'c1' });
    live.add('launch.acme.io');
    monitor.onWatchUpdated(store.updateWatch(watch.id, { features: { status: true } }));
    await monitor.checkNow(watch.id);
    expect(delivered.flat().map((a) => a.kind).sort()).toEqual(['deploy', 'subdomain', 'text']);
    await monitor.stop();
  });

  it('a reset of noise flags (/watch ignore) while a pass is in flight is not undone by that pass', async () => {
    useFakeClock();
    const { store, watch, http, monitor, delivered } = setup();
    http.set('/', page('Acme', '<a href="/live">Live</a><p>Home</p>'));
    http.set('/live', page('Live', '<p>Stable text</p><p>Session token: aaa</p>'));
    await monitor.runBaseline(watch.id);
    const rec = store.getPage(watch.id, `${ORIGIN}/live`)!;
    store.upsertPage({ ...rec, dynamic: true, flapCount: 3 });

    // A check blocked on a slow page, holding the page rows in memory.
    const gate = deferred();
    http.set('/live', async () => {
      await gate.promise;
      return page('Live', '<p>Stable text</p><p>Session token: bbb</p>');
    });
    const tick = monitor.checkNow(watch.id, { full: true });
    await flush();
    // The /watch ignore command path runs meanwhile.
    store.resetPageNoise(watch.id);
    monitor.onWatchUpdated(store.updateWatch(watch.id, { ignorePatterns: ['Session token: \\w+'] }));
    gate.resolve();
    await tick;
    http.set('/live', page('Live', '<p>Stable text</p><p>Session token: ccc</p>'));
    await monitor.checkNow(watch.id, { full: true }); // the reset is applied first on the lane
    expect(store.getPage(watch.id, `${ORIGIN}/live`)!.dynamic).toBe(false);

    http.set('/live', page('Live', '<p>Stable text, edited</p><p>Session token: ddd</p>'));
    const res = await monitor.checkNow(watch.id, { full: true });
    expect(res.alerts.map((a) => a.kind)).toEqual(['text']);
    expect(delivered.flat().map((a) => a.kind)).toEqual(['text']);
    await monitor.stop();
  });
});

describe('overlap, shutdown and first-baseline edge cases', () => {
  it('a tick slower than its timeout guard and a manual check right after do not report the same change twice', async () => {
    useFakeClock();
    const { store, watch, http, monitor, delivered } = setup();
    http.set('/', page('Acme', '<a href="/a">A</a><p>Home</p>'));
    http.set('/a', page('A', '<p>Fee is 0.3 percent.</p>'));
    await monitor.runBaseline(watch.id);
    // /a changed, and answers the first request slowly (longer than the guard).
    let slow = true;
    http.set('/a', () => {
      const reply = page('A', '<p>Fee is 0.4 percent, final.</p>');
      if (!slow) return reply;
      slow = false;
      return new Promise<Reply>((r) => setTimeout(() => r(reply), MIN_TICK_TIMEOUT_MS + 30_000));
    });
    const first = monitor.checkNow(watch.id, { full: true });
    const second = monitor.checkNow(watch.id, { full: true });
    await advance(MIN_TICK_TIMEOUT_MS + 5_000);
    expect((await first).error).toMatch(/timed out/);
    await advance(MIN_TICK_TIMEOUT_MS + 60_000);
    await advance(MIN_TICK_TIMEOUT_MS + 60_000);
    await second;
    const texts = delivered.flat().filter((a) => a.kind === 'text');
    expect(texts).toHaveLength(1);
    expect(store.getPage(watch.id, `${ORIGIN}/a`)!.text).toContain('Fee is 0.4 percent, final.');
    await monitor.stop();
  });

  it('stop() during a slow file check still delivers the text change found before it', async () => {
    useFakeClock();
    const { store, watch, http, monitor, delivered } = setup();
    http.set('/', page('Acme', '<a href="/a">A</a><a href="/big.pdf">PDF</a><p>Home</p>'));
    http.set('/a', page('A', '<p>Old words.</p>'));
    http.set('/big.pdf', { body: '%PDF-1.4 v1', type: 'application/pdf' });
    await monitor.runBaseline(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    http.set('/a', page('A', '<p>New words.</p>'));
    let fileRequested = false;
    http.set('/big.pdf', () => {
      fileRequested = true;
      return new Promise<Reply>(() => {}); // never answers
    });
    const tick = monitor.checkNow(watch.id, { full: true });
    for (let i = 0; i < 20 && !fileRequested; i++) await flush();
    expect(fileRequested).toBe(true);
    let stopped = false;
    const stopping = monitor.stop().then(() => (stopped = true));
    await flush();
    await advance(100);
    await stopping;
    expect(stopped).toBe(true);
    expect(delivered.flat().map((a) => a.kind)).toEqual(['text']);
    void tick;
  });

  it('a start URL that redirects to another host of the same site adopts that host for the crawl', async () => {
    const { store, watch, http, monitor } = setup({ watch: { url: 'https://a.test/', host: 'a.test', rootDomain: 'a.test' } });
    const body = page('A', '<a href="/docs">Docs</a><a href="/blog">Blog</a><p>Welcome</p>');
    http.set('https://a.test/', async () => ({ ...body, finalUrl: 'https://www.a.test/' }));
    http.set('https://www.a.test/', body);
    http.set('https://www.a.test/docs', page('Docs', '<p>Docs</p>'));
    http.set('https://www.a.test/blog', page('Blog', '<p>Blog</p>'));
    http.set('https://www.a.test/app-1.js', { body: '1', type: 'application/javascript' });
    const summary = await monitor.runBaseline(watch.id);
    expect(summary.redirectedTo).toEqual({ from: 'a.test', to: 'www.a.test', adopted: true });
    const w = store.getWatch(watch.id)!;
    expect(w).toMatchObject({ url: 'https://www.a.test/', host: 'www.a.test', baselineDone: true });
    const tracked = store.listPages(watch.id, { kind: 'page', tracked: true }).map((p) => p.url).sort();
    expect(tracked).toEqual(['https://www.a.test/', 'https://www.a.test/blog', 'https://www.a.test/docs']);
    await monitor.stop();
  });

  it('a redirect to another domain is reported but not adopted', async () => {
    const { store, watch, http, monitor } = setup({ watch: { url: 'https://old.test/', host: 'old.test', rootDomain: 'old.test' } });
    http.set('https://old.test/', async () => ({ ...page('New', '<p>Moved</p>'), finalUrl: 'https://new.example/' }));
    const summary = await monitor.runBaseline(watch.id);
    expect(summary.redirectedTo).toEqual({ from: 'old.test', to: 'new.example', adopted: false });
    expect(store.getWatch(watch.id)!.host).toBe('old.test');
    await monitor.stop();
  });

  it('a homepage that keeps showing a bot challenge sends one note while the baseline waits; it baselines silently once usable', async () => {
    useFakeClock();
    const { store, watch, http, monitor, delivered } = setup();
    http.set('/', { status: 403, body: 'Just a moment...', blocked: true });
    await monitor.runBaseline(watch.id);
    expect(store.getWatch(watch.id)!.baselineDone).toBe(false);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    for (let i = 0; i < 5; i++) await advance(33_000);
    const infos = delivered.flat();
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ kind: 'info' });
    expect((infos[0] as { message: string }).message).toMatch(/blocking the watcher/);
    expect(store.getWatch(watch.id)!.baselineDone).toBe(false);

    http.set('/', page('Acme', '<a href="/about">About</a>'));
    http.set('/about', page('About', '<p>About</p>'));
    await advance(33_000);
    await advance(33_000);
    expect(store.getWatch(watch.id)!.baselineDone).toBe(true);
    expect(delivered.flat()).toHaveLength(1);
    await monitor.stop();
  });

  it('hosts in a bundle that failed at the baseline are recorded silently when it is back-filled', async () => {
    useFakeClock();
    const subWatch = { host: 'acme.io', rootDomain: 'acme.io', url: 'https://acme.io/' };
    const { store, watch, http, monitor, delivered, live } = setup({ watch: subWatch });
    live.add('acme.io');
    live.add('rpc-internal.acme.io');
    http.set('https://acme.io/', page('Acme', '<p>Hello</p>', ['https://acme.io/app-1.js']));
    let bundleUp = false;
    http.set('https://acme.io/app-1.js', () =>
      bundleUp ? { body: 'fetch("https://rpc-internal.acme.io/x")', type: 'application/javascript' } : { status: 503, body: 'busy' },
    );
    await monitor.runBaseline(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    bundleUp = true;
    await advance(11 * 60_000);
    await advance(33_000);
    await advance(400_000);
    expect(delivered.flat().filter((a) => a.kind === 'subdomain')).toEqual([]);
    expect(store.listSubdomains(watch.id).map((r) => r.host)).toContain('rpc-internal.acme.io');
    await monitor.stop();
  });
});

// ---------------------------------------------------------------------------
// Subdomain slow loop
// ---------------------------------------------------------------------------

describe('subdomain slow loop', () => {
  const subWatch = { host: 'acme.io', rootDomain: 'acme.io' };

  it('a tick that sees a link to an unknown subdomain triggers the slow loop right away', async () => {
    useFakeClock();
    const { store, watch, http, monitor, delivered, live, ct } = setup({ watch: subWatch });
    live.add('acme.io');
    await monitor.runBaseline(watch.id);
    expect(ct.certspotter).toHaveBeenCalledTimes(1);
    monitor.onWatchAdded(store.getWatch(watch.id)!);

    live.add('docs.acme.io');
    http.set('https://docs.acme.io/', page('Acme Docs', '<p>docs</p>'));
    http.set('/', page('Acme', '<p>Hello</p><a href="https://docs.acme.io/">Docs</a>'));
    await advance(33_000); // fast tick finds the link; the slow run follows without waiting 5 minutes
    const subs = delivered.flat().filter((a) => a.kind === 'subdomain');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      kind: 'subdomain',
      rootDomain: 'acme.io',
      subdomains: [{ host: 'docs.acme.io', sources: ['link'], http: { status: 200, title: 'Acme Docs' } }],
    });
    expect(store.listEvents(watch.id, 5).map((e) => e.summary)).toContain('1 new subdomain: docs.acme.io');

    // Known now: later ticks don't re-trigger or re-announce.
    await advance(33_000);
    await advance(33_000);
    expect(delivered.flat().filter((a) => a.kind === 'subdomain')).toHaveLength(1);
    await monitor.stop();
  });

  it('runs on its own interval and checkNow adds a forced run (CT polled even though not due)', async () => {
    useFakeClock();
    const { store, watch, monitor, delivered, live, ct } = setup({ watch: subWatch });
    live.add('acme.io');
    await monitor.runBaseline(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    expect(ct.certspotter).toHaveBeenCalledTimes(1);

    ct.certspotter.mockResolvedValueOnce({ names: ['launchpad7.acme.io'], cursor: 'c1' });
    live.add('launchpad7.acme.io');
    const res = await monitor.checkNow(watch.id);
    expect(ct.certspotter).toHaveBeenCalledTimes(2);
    expect(res.alerts.map((a) => a.kind)).toEqual(['subdomain']);
    expect(delivered.flat().map((a) => a.kind)).toEqual(['subdomain']);

    // The slow loop itself polls CT again once subdomainIntervalSec (300s) has passed.
    await advance(400_000);
    expect(ct.certspotter.mock.calls.length).toBeGreaterThanOrEqual(3);
    await monitor.stop();
  });

  it('disabling subdomains stops the slow loop', async () => {
    useFakeClock();
    const { store, watch, monitor, live, ct } = setup({ watch: subWatch });
    live.add('acme.io');
    await monitor.runBaseline(watch.id);
    monitor.onWatchAdded(store.getWatch(watch.id)!);
    monitor.onWatchUpdated(store.updateWatch(watch.id, { features: { subdomains: false } }));
    await advance(2_000_000);
    expect(ct.certspotter).toHaveBeenCalledTimes(1);
    await monitor.stop();
  });
});
