import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testConfig, type Config } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { silentLogger } from '../src/log.js';
import { HttpClient, type FetchOptions, type FetchResult } from '../src/net/http.js';
import type { DnsProvider } from '../src/net/dns.js';
import type { CheckContext } from '../src/monitor/context.js';
import {
  COMMON_SUBDOMAINS,
  checkSubdomains,
  createCtProvider,
  ctRateLimitedUntil,
  normalizeSubdomain,
  probeHttp,
  resetSubdomainCaches,
  type CtProvider,
} from '../src/monitor/subdomains.js';
import {
  defaultWatchState,
  type DnsInfo,
  type Logger,
  type SubdomainAlert,
  type Watch,
  type WatchFeatures,
  type WatchState,
} from '../src/types.js';

const T0 = 1_760_000_000_000;
const SEC = 1000;
const HOUR = 3600 * SEC;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function result(url: string, over: Partial<FetchResult> = {}): FetchResult {
  const status = over.status ?? 200;
  return {
    url,
    finalUrl: url,
    status,
    ok: status >= 200 && status <= 299,
    notModified: false,
    redirected: false,
    headers: {},
    contentType: 'application/json',
    body: null,
    bodyText: null,
    truncated: false,
    blocked: false,
    retryAfterMs: null,
    error: status === 0 ? 'ECONNREFUSED' : null,
    elapsedMs: 1,
    ...over,
  };
}

function json(url: string, data: unknown, over: Partial<FetchResult> = {}): FetchResult {
  return result(url, { bodyText: JSON.stringify(data), ...over });
}

type Handler = (url: string, opts: FetchOptions) => FetchResult | Promise<FetchResult>;

function fakeHttp(handler: Handler) {
  const calls: Array<{ url: string; opts: FetchOptions }> = [];
  const client = {
    fetch: async (url: string, opts: FetchOptions = {}) => {
      calls.push({ url, opts });
      return handler(url, opts);
    },
  } as unknown as HttpClient;
  return { client, calls };
}

function info(...a: string[]): DnsInfo {
  return { a: [...a].sort(), aaaa: [], cname: [] };
}

/** In-memory DNS: explicit records, an optional wildcard answer for every other name under the root, outage switch. */
class FakeDns implements DnsProvider {
  readonly records = new Map<string, DnsInfo>();
  wildcardAnswer: DnsInfo | null = null;
  /** Which names the wildcard answers (default: all). */
  wildcardApplies: (host: string) => boolean = () => true;
  /** false = wildcard() is inconclusive (returns null) even though a wildcard exists. */
  detectWildcard = true;
  /** A wildcard whose answer depends on the query (rotating pools): used instead of wildcardAnswer when set. */
  dynamicAnswer: ((host: string) => DnsInfo) | null = null;
  /** Fixed answer of wildcard() for a dynamic wildcard (CloudFront-style); default: two probes of dynamicAnswer. */
  dynamicProbe: DnsInfo | null = null;
  #probeN = 0;
  down = false;
  readonly resolveCalls: string[] = [];
  wildcardCalls = 0;

  constructor(readonly root: string) {}

  set(host: string, ...a: string[]): void {
    this.records.set(host, info(...a));
  }

  async resolve(host: string): Promise<DnsInfo | null> {
    this.resolveCalls.push(host);
    if (this.down) return null;
    const r = this.records.get(host);
    if (r) return structuredClone(r);
    if (host.endsWith(`.${this.root}`) && this.wildcardApplies(host)) {
      if (this.dynamicAnswer) return this.dynamicAnswer(host);
      if (this.wildcardAnswer) return structuredClone(this.wildcardAnswer);
    }
    return null;
  }

  async wildcard(): Promise<Set<string> | null> {
    this.wildcardCalls++;
    if (!this.detectWildcard) return null;
    const answers: DnsInfo[] = [];
    if (this.dynamicAnswer) {
      if (this.dynamicProbe) answers.push(this.dynamicProbe);
      else for (let i = 0; i < 2; i++) answers.push(this.dynamicAnswer(`wc-probe-${this.#probeN++}.${this.root}`));
    } else if (this.wildcardAnswer) answers.push(this.wildcardAnswer);
    if (answers.length === 0) return null;
    return new Set(answers.flatMap((w) => [...w.a.map((x) => `A:${x}`), ...w.aaaa.map((x) => `AAAA:${x}`), ...w.cname.map((x) => `CNAME:${x}`)]));
  }

  callsFor(host: string): number {
    return this.resolveCalls.filter((h) => h === host).length;
  }
}

function fakeCt() {
  return {
    certspotter: vi.fn<CtProvider['certspotter']>(async (_domain, cursor) => ({ names: [], cursor })),
    crtsh: vi.fn<CtProvider['crtsh']>(async () => []),
  };
}

function captureLogger(): Logger & { lines: Array<{ level: string; msg: string }> } {
  const lines: Array<{ level: string; msg: string }> = [];
  const logger: Logger & { lines: typeof lines } = {
    lines,
    debug: (msg) => lines.push({ level: 'debug', msg }),
    info: (msg) => lines.push({ level: 'info', msg }),
    warn: (msg) => lines.push({ level: 'warn', msg }),
    error: (msg) => lines.push({ level: 'error', msg }),
    child: () => logger,
  };
  return logger;
}

interface Env {
  store: Store;
  watch: Watch;
  state: WatchState;
  clock: { t: number };
  dns: FakeDns;
  ct: ReturnType<typeof fakeCt>;
  probes: ReturnType<typeof fakeHttp>;
  config: Config;
  log: ReturnType<typeof captureLogger>;
  ctx(baseline?: boolean): CheckContext;
  run(opts?: { baseline?: boolean; force?: boolean; localHosts?: Array<{ host: string; source: 'link' | 'code' }> }): Promise<SubdomainAlert[]>;
  hosts(): string[];
}

const stores: Store[] = [];

function setup(opts: { root?: string; host?: string; features?: Partial<WatchFeatures>; config?: Partial<Config> } = {}): Env {
  const store = new Store(':memory:');
  stores.push(store);
  const root = opts.root ?? 'x.io';
  const host = opts.host ?? root;
  const watch = store.createWatch({
    guildId: 'g1',
    channelId: 'c1',
    name: 'X',
    url: `https://${host}/`,
    host,
    rootDomain: root,
    createdBy: 'u1',
    features: opts.features,
  });
  const state = defaultWatchState();
  const clock = { t: T0 };
  const dns = new FakeDns(root);
  dns.set(host, '9.9.9.9');
  const ct = fakeCt();
  const probes = fakeHttp((url) => {
    const h = new URL(url).hostname;
    return result(url, {
      contentType: 'text/html',
      bodyText: `<!doctype html><html><head><title>Title of ${h}</title></head><body>hi</body></html>`,
      headers: { server: 'nginx' },
    });
  });
  const config = testConfig(opts.config);
  const log = captureLogger();
  const ctx = (baseline = false): CheckContext => ({
    watch,
    state,
    store,
    http: probes.client,
    config,
    log,
    providers: { ct, dns },
    now: () => clock.t,
    sleep: async () => {},
    baseline,
  });
  return {
    store,
    watch,
    state,
    clock,
    dns,
    ct,
    probes,
    config,
    log,
    ctx,
    run: (o = {}) => checkSubdomains(ctx(o.baseline ?? false), { localHosts: o.localHosts ?? [], force: o.force }),
    hosts: () => store.listSubdomains(watch.id).map((r) => r.host),
  };
}

beforeEach(() => {
  resetSubdomainCaches();
});

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

// ---------------------------------------------------------------------------
// normalizeSubdomain
// ---------------------------------------------------------------------------

describe('normalizeSubdomain', () => {
  it('lowercases, trims, strips trailing dots and a wildcard prefix', () => {
    expect(normalizeSubdomain('*.app.x.io', 'x.io')).toBe('app.x.io');
    expect(normalizeSubdomain('  WWW.X.IO.  ', 'x.io')).toBe('www.x.io');
    expect(normalizeSubdomain('Deep.Api.X.IO', 'X.IO.')).toBe('deep.api.x.io');
    expect(normalizeSubdomain('www.x.io', 'x.io')).toBe('www.x.io');
    expect(normalizeSubdomain('a.b.co.uk', 'b.co.uk')).toBe('a.b.co.uk');
  });

  it('rejects the root itself and a bare wildcard of the root', () => {
    expect(normalizeSubdomain('x.io', 'x.io')).toBeNull();
    expect(normalizeSubdomain('*.x.io', 'x.io')).toBeNull();
    expect(normalizeSubdomain('X.IO.', 'x.io')).toBeNull();
  });

  it('rejects names outside the root', () => {
    for (const n of ['evil.com', 'x.io.evil.com', 'evilx.io', 'io', 'app.y.io', 'sni.cloudflaressl.com']) {
      expect(normalizeSubdomain(n, 'x.io'), n).toBeNull();
    }
  });

  it('rejects invalid characters and malformed labels', () => {
    for (const n of [
      'a b.x.io',
      'admin@x.io',
      'foo..x.io',
      '.app.x.io',
      '-bad.x.io',
      'bad-.x.io',
      'a*.x.io',
      '*.*.x.io',
      'app.x.io:443',
      'a/b.x.io',
      'tab\t.x.io',
      '',
      '   ',
      `${'a'.repeat(64)}.x.io`,
      `${'a.'.repeat(130)}x.io`,
    ]) {
      expect(normalizeSubdomain(n, 'x.io'), JSON.stringify(n)).toBeNull();
    }
  });

  it('converts unicode names to punycode', () => {
    expect(normalizeSubdomain('bücher.x.io', 'x.io')).toBe('xn--bcher-kva.x.io');
  });

  it('returns null for IP roots and non-string input', () => {
    expect(normalizeSubdomain('a.1.2.3.4', '1.2.3.4')).toBeNull();
    expect(normalizeSubdomain(undefined as unknown as string, 'x.io')).toBeNull();
    expect(normalizeSubdomain('a.x.io', null as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// COMMON_SUBDOMAINS
// ---------------------------------------------------------------------------

describe('COMMON_SUBDOMAINS', () => {
  it('has ~250 unique, lowercase, valid labels', () => {
    expect(COMMON_SUBDOMAINS.length).toBeGreaterThanOrEqual(230);
    expect(COMMON_SUBDOMAINS.length).toBeLessThanOrEqual(270);
    expect(new Set(COMMON_SUBDOMAINS).size).toBe(COMMON_SUBDOMAINS.length);
    for (const l of COMMON_SUBDOMAINS) expect(l).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  });

  it('includes the common and web3-flavoured labels', () => {
    const required =
      'www app api docs doc beta alpha staging stage dev test testnet devnet mainnet preview demo sandbox admin dashboard portal blog ' +
      'status cdn static assets media img images mail auth login id account accounts pay wallet bridge swap trade exchange stake ' +
      'staking earn vault vaults farm pool pools lend borrow points rewards airdrop claim mint nft launch launchpad presale sale ido ' +
      'token governance gov vote dao forum explorer scan analytics stats data rpc node ws graph subgraph indexer oracle faucet v1 v2 ' +
      'v3 v4 old new next legacy m mobile help support faq careers jobs about press brand shop store community discord events ' +
      'partners invest investors ir labs research learn academy whitepaper litepaper roadmap';
    for (const l of required.split(' ')) expect(COMMON_SUBDOMAINS, l).toContain(l);
  });
});

// ---------------------------------------------------------------------------
// createCtProvider
// ---------------------------------------------------------------------------

/** Shape of a real Cert Spotter issuance (expand=dns_names). */
function issuance(id: string, dnsNames: string[]) {
  return {
    id,
    tbs_sha256: 'a'.repeat(64),
    cert_sha256: 'b'.repeat(64),
    dns_names: dnsNames,
    pubkey_sha256: 'c'.repeat(64),
    not_before: '2026-09-22T19:36:53Z',
    not_after: '2026-12-21T19:36:52Z',
    revoked: false,
  };
}

describe('createCtProvider.certspotter', () => {
  it('parses the real response format and follows pagination with the cursor', async () => {
    const pages: Record<string, unknown[]> = {
      '': [issuance('17349501512', ['unpeg.io']), issuance('17349501513', ['unpeg.io', '*.unpeg.io', 'app.unpeg.io'])],
      '17349501513': [issuance('17349501600', ['docs.unpeg.io'])],
      '17349501600': [],
    };
    const { client, calls } = fakeHttp((url) => json(url, pages[new URL(url).searchParams.get('after') ?? '']));
    // Pages of 2: the first is full (keep paging), the second is partial (the last one — no empty terminating request).
    const ct = createCtProvider(client, { certspotterApiKey: null, pageSize: 2 });

    const res = await ct.certspotter('unpeg.io', null);
    expect(res.names.sort()).toEqual(['*.unpeg.io', 'app.unpeg.io', 'docs.unpeg.io', 'unpeg.io']);
    expect(res.cursor).toBe('17349501600');
    expect(res.rateLimitedUntil).toBeUndefined();
    expect(res.more).toBe(false);

    expect(calls).toHaveLength(2);
    const first = new URL(calls[0].url);
    expect(`${first.origin}${first.pathname}`).toBe('https://api.certspotter.com/v1/issuances');
    expect(first.searchParams.get('domain')).toBe('unpeg.io');
    expect(first.searchParams.get('include_subdomains')).toBe('true');
    expect(first.searchParams.get('expand')).toBe('dns_names');
    expect(first.searchParams.has('after')).toBe(false);
    expect(new URL(calls[1].url).searchParams.get('after')).toBe('17349501513');
    expect(calls[0].opts.headers?.authorization).toBeUndefined();
  });

  it('starts after the given cursor and returns it unchanged when nothing is new', async () => {
    const { client, calls } = fakeHttp((url) => json(url, []));
    const res = await createCtProvider(client, { certspotterApiKey: null }).certspotter('x.io', '555');
    expect(res).toEqual({ names: [], cursor: '555', more: false });
    expect(new URL(calls[0].url).searchParams.get('after')).toBe('555');
  });

  it('sends the API key as a bearer token', async () => {
    const { client, calls } = fakeHttp((url) => json(url, []));
    await createCtProvider(client, { certspotterApiKey: 'k_123' }).certspotter('x.io', null);
    expect(calls[0].opts.headers?.authorization).toBe('Bearer k_123');
  });

  it('stops at maxPages and reports a backlog', async () => {
    let n = 0;
    const { client, calls } = fakeHttp((url) => {
      n++;
      return json(url, [issuance(String(100 + n), [`h${n}.x.io`])]);
    });
    const res = await createCtProvider(client, { certspotterApiKey: null, pageSize: 1 }).certspotter('x.io', null, 3);
    expect(calls).toHaveLength(3);
    expect(res.names).toEqual(['h1.x.io', 'h2.x.io', 'h3.x.io']);
    expect(res.cursor).toBe('103');
    expect(res.more).toBe(true);
  });

  it('defaults to 10 pages per call', async () => {
    let n = 0;
    const { client, calls } = fakeHttp((url) => json(url, [issuance(String(++n), ['a.x.io'])]));
    const res = await createCtProvider(client, { certspotterApiKey: null, pageSize: 1 }).certspotter('x.io', null);
    expect(calls).toHaveLength(10);
    expect(res.cursor).toBe('10');
  });

  it('on 429 returns names so far, the last good cursor and the Retry-After deadline', async () => {
    const { client } = fakeHttp((url) =>
      new URL(url).searchParams.get('after') === '7'
        ? result(url, { status: 429, retryAfterMs: 120_000 })
        : json(url, [issuance('7', ['a.x.io'])]),
    );
    const res = await createCtProvider(client, { certspotterApiKey: null, now: () => T0, pageSize: 1 }).certspotter('x.io', null);
    expect(res).toEqual({ names: ['a.x.io'], cursor: '7', rateLimitedUntil: T0 + 120_000 });
  });

  it('on 429 without Retry-After backs off for an hour', async () => {
    const { client } = fakeHttp((url) => result(url, { status: 429 }));
    const res = await createCtProvider(client, { certspotterApiKey: null, now: () => T0 }).certspotter('x.io', '42');
    expect(res).toEqual({ names: [], cursor: '42', rateLimitedUntil: T0 + HOUR });
  });

  it('a partial page is the last one: no second request', async () => {
    const page = Array.from({ length: 37 }, (_, i) => issuance(String(1000 + i), [`h${i}.x.io`]));
    const { client, calls } = fakeHttp((url) => json(url, page));
    const res = await createCtProvider(client, { certspotterApiKey: null }).certspotter('x.io', null);
    expect(calls).toHaveLength(1);
    expect(res).toMatchObject({ cursor: '1036', more: false });
    expect(res.names).toHaveLength(37);
  });

  it('spends at most the hourly budget: further calls wait for a token without sending a request', async () => {
    const clock = { t: T0 };
    const { client, calls } = fakeHttp((url) => json(url, []));
    const ct = createCtProvider(client, { certspotterApiKey: null, now: () => clock.t, queriesPerHour: 10 });
    for (let i = 0; i < 10; i++) expect((await ct.certspotter(`d${i}.io`, null)).rateLimitedUntil).toBeUndefined();
    expect(calls).toHaveLength(10);
    const held = await ct.certspotter('other.io', '5');
    expect(calls).toHaveLength(10);
    expect(held).toMatchObject({ names: [], cursor: '5', localLimit: true });
    expect(held.rateLimitedUntil!).toBeGreaterThan(T0);
    expect(held.rateLimitedUntil! - T0).toBeLessThanOrEqual(7 * 60_000);
    clock.t = held.rateLimitedUntil!;
    expect((await ct.certspotter('other.io', '5')).localLimit).toBeUndefined();
    expect(calls).toHaveLength(11);
  });

  it('a 429 for one domain holds back every domain until Retry-After (the quota is per client)', async () => {
    const clock = { t: T0 };
    let limited = true;
    const { client, calls } = fakeHttp((url) => (limited ? result(url, { status: 429, retryAfterMs: 300_000 }) : json(url, [])));
    const ct = createCtProvider(client, { certspotterApiKey: null, now: () => clock.t });
    expect((await ct.certspotter('a.io', null)).rateLimitedUntil).toBe(T0 + 300_000);
    limited = false;
    clock.t = T0 + 60_000;
    expect(await ct.certspotter('b.io', null)).toMatchObject({ rateLimitedUntil: T0 + 300_000, localLimit: true });
    expect(calls).toHaveLength(1);
    clock.t = T0 + 301_000;
    await ct.certspotter('b.io', null);
    expect(calls).toHaveLength(2);
  });

  it('throws with the status on other errors', async () => {
    const ct500 = createCtProvider(fakeHttp((url) => result(url, { status: 500 })).client, { certspotterApiKey: null });
    await expect(ct500.certspotter('x.io', null)).rejects.toThrow(/HTTP 500/);
    const ctDown = createCtProvider(fakeHttp((url) => result(url, { status: 0, error: 'ENOTFOUND' })).client, {
      certspotterApiKey: null,
    });
    await expect(ctDown.certspotter('x.io', null)).rejects.toThrow(/ENOTFOUND/);
  });

  it('throws on invalid or non-array JSON', async () => {
    const bad = createCtProvider(fakeHttp((url) => result(url, { bodyText: '<html>oops</html>' })).client, { certspotterApiKey: null });
    await expect(bad.certspotter('x.io', null)).rejects.toThrow(/invalid JSON/);
    const obj = createCtProvider(fakeHttp((url) => json(url, { code: 'x' })).client, { certspotterApiKey: null });
    await expect(obj.certspotter('x.io', null)).rejects.toThrow(/invalid JSON/);
  });

  it('tolerates junk entries and stops when ids do not advance', async () => {
    const { client, calls } = fakeHttp((url) => json(url, [null, 5, { dns_names: 'nope' }, { id: 9, dns_names: ['a.x.io', 7] }]));
    const res = await createCtProvider(client, { certspotterApiKey: null }).certspotter('x.io', '9');
    expect(res.names).toEqual(['a.x.io']);
    expect(res.cursor).toBe('9');
    expect(calls).toHaveLength(1);
  });

  it('decodes a body without bodyText', async () => {
    const { client } = fakeHttp((url) =>
      new URL(url).searchParams.has('after')
        ? json(url, [])
        : result(url, { contentType: 'application/octet-stream', body: Buffer.from(JSON.stringify([issuance('1', ['b.x.io'])])) }),
    );
    const res = await createCtProvider(client, { certspotterApiKey: null }).certspotter('x.io', null);
    expect(res.names).toEqual(['b.x.io']);
  });
});

describe('createCtProvider.crtsh', () => {
  const entries = [
    {
      issuer_ca_id: 295815,
      issuer_name: "C=US, O=Let's Encrypt, CN=E7",
      common_name: 'app.unpeg.io',
      name_value: 'app.unpeg.io\n*.unpeg.io',
      id: 1,
      entry_timestamp: '2026-09-22T20:36:53.123',
      not_before: '2026-09-22T19:36:53',
      not_after: '2026-12-21T19:36:52',
      serial_number: '05ab',
    },
    { common_name: 'unpeg.io', name_value: 'unpeg.io\nwww.unpeg.io', id: 2 },
    { common_name: 'app.unpeg.io', name_value: 'APP.unpeg.io', id: 3 },
  ];

  it('requests the %.domain JSON query with a 60s timeout and returns unique names', async () => {
    const { client, calls } = fakeHttp((url) => json(url, entries));
    const names = await createCtProvider(client, { certspotterApiKey: 'k' }).crtsh('unpeg.io');
    expect(calls[0].url).toBe('https://crt.sh/?q=%25.unpeg.io&output=json');
    expect(calls[0].opts.timeoutMs).toBe(60_000);
    expect(calls[0].opts.headers?.authorization).toBeUndefined();
    expect(names.sort()).toEqual(['*.unpeg.io', 'APP.unpeg.io', 'app.unpeg.io', 'unpeg.io', 'www.unpeg.io']);
  });

  it('throws on non-200 and invalid JSON', async () => {
    const e502 = createCtProvider(fakeHttp((url) => result(url, { status: 502 })).client, { certspotterApiKey: null });
    await expect(e502.crtsh('x.io')).rejects.toThrow(/HTTP 502/);
    const html = createCtProvider(fakeHttp((url) => result(url, { contentType: 'text/html', bodyText: '<h1>busy</h1>' })).client, {
      certspotterApiKey: null,
    });
    await expect(html.crtsh('x.io')).rejects.toThrow(/invalid JSON/);
  });

  it('salvages complete entries from a body cut off at the size cap', async () => {
    const full = JSON.stringify([
      { common_name: 'a.x.io', name_value: 'a.x.io\nb.x.io' },
      { common_name: 'c.x.io', name_value: 'c.x.io' },
    ]);
    const cut = full.slice(0, full.indexOf('"name_value":"c.x.io') + 18);
    const { client } = fakeHttp((url) => result(url, { bodyText: cut, truncated: true }));
    const names = await createCtProvider(client, { certspotterApiKey: null }).crtsh('x.io');
    expect(names.sort()).toEqual(['a.x.io', 'b.x.io', 'c.x.io']);
  });
});

// ---------------------------------------------------------------------------
// probeHttp
// ---------------------------------------------------------------------------

describe('probeHttp', () => {
  it('probes https with the documented options and extracts title, final URL and server', async () => {
    const { client, calls } = fakeHttp((url) =>
      result(url, {
        finalUrl: 'https://app.x.io/login',
        contentType: 'text/html',
        bodyText: '<html><head><title> Launch &amp; Earn </title></head></html>',
        headers: { server: 'cloudflare' },
      }),
    );
    const p = await probeHttp(client, 'app.x.io');
    expect(p).toEqual({ status: 200, title: 'Launch & Earn', finalUrl: 'https://app.x.io/login', server: 'cloudflare' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://app.x.io/');
    expect(calls[0].opts).toMatchObject({ method: 'GET', maxBytes: 256 * 1024, timeoutMs: 8000, retries: 0 });
  });

  it('falls back to http:// when https is unreachable', async () => {
    const { client, calls } = fakeHttp((url) =>
      url.startsWith('https:') ? result(url, { status: 0 }) : result(url, { status: 404, contentType: 'text/plain', bodyText: 'nope' }),
    );
    const p = await probeHttp(client, 'old.x.io');
    expect(calls.map((c) => c.url)).toEqual(['https://old.x.io/', 'http://old.x.io/']);
    expect(p).toEqual({ status: 404, title: null, finalUrl: 'http://old.x.io/', server: null });
  });

  it('reports unreachable when both schemes fail (or the client throws)', async () => {
    const down = fakeHttp((url) => result(url, { status: 0 }));
    expect(await probeHttp(down.client, 'gone.x.io')).toEqual({ status: 0, title: null, finalUrl: null, server: null });
    const throwing = fakeHttp(() => {
      throw new Error('boom');
    });
    expect(await probeHttp(throwing.client, 'gone.x.io')).toEqual({ status: 0, title: null, finalUrl: null, server: null });
  });

  it('keeps an HTTP error status and title of a challenge page', async () => {
    const { client } = fakeHttp((url) =>
      result(url, { status: 403, contentType: 'text/html', bodyText: '<title>Just a moment...</title>', blocked: true }),
    );
    expect(await probeHttp(client, 'app.x.io')).toMatchObject({ status: 403, title: 'Just a moment...' });
  });

  describe('against a local server', () => {
    let server: http.Server;
    let port: number;
    const fixture = fs.readFileSync(new URL('./fixtures/nextjs-app-home.html', import.meta.url), 'utf8');

    beforeEach(async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', server: 'test-server' });
        res.end(fixture);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterEach(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('fails TLS on a plain-HTTP port, then succeeds over http and reads the real page title', async () => {
      const client = new HttpClient({
        userAgent: 'test',
        globalConcurrency: 4,
        perHostConcurrency: 4,
        timeoutMs: 5000,
        maxBytes: 5 * 1024 * 1024,
        allowPrivate: true,
      });
      const p = await probeHttp(client, `127.0.0.1:${port}`);
      expect(p).toEqual({ status: 200, title: 'Unpeg', finalUrl: `http://127.0.0.1:${port}/`, server: 'test-server' });
    });
  });
});

// ---------------------------------------------------------------------------
// checkSubdomains
// ---------------------------------------------------------------------------

/** Baseline with a typical spread of sources; returns the env ready for incremental runs. */
async function baselined(opts: Parameters<typeof setup>[0] = {}): Promise<Env> {
  const env = setup(opts);
  env.dns.set('www.x.io', '1.2.3.4');
  env.ct.certspotter.mockResolvedValueOnce({ names: ['x.io', '*.x.io', 'www.x.io'], cursor: '100' });
  const alerts = await env.run({ baseline: true, force: true });
  expect(alerts).toEqual([]);
  env.ct.certspotter.mockClear();
  env.ct.crtsh.mockClear();
  env.dns.resolveCalls.length = 0;
  env.probes.calls.length = 0;
  return env;
}

function hostsOf(alert: SubdomainAlert | undefined): string[] {
  return alert ? alert.subdomains.map((s) => s.host) : [];
}

describe('checkSubdomains: baseline', () => {
  it('records CT, crt.sh, DNS and local hosts silently and advances every cadence timestamp', async () => {
    const env = setup();
    env.dns.set('www.x.io', '1.2.3.4');
    env.dns.set('app.x.io', '1.2.3.5');
    env.dns.set('docs.x.io', '1.2.3.6');
    env.dns.set('cdn.x.io', '1.2.3.7');
    env.ct.certspotter.mockResolvedValueOnce({
      names: ['x.io', '*.x.io', 'app.x.io', 'mail.x.io', 'evil.com', 'x.io.evil.com', 'bad name.x.io'],
      cursor: '100',
    });
    env.ct.crtsh.mockResolvedValueOnce(['old.x.io', '*.old2.x.io', 'admin@x.io', 'x.io']);

    const alerts = await env.run({
      baseline: true,
      force: true,
      localHosts: [
        { host: 'cdn.x.io', source: 'code' },
        { host: 'x.io', source: 'link' },
        { host: 'google.com', source: 'link' },
        { host: 'www.x.io', source: 'link' },
      ],
    });

    expect(alerts).toEqual([]);
    expect(env.hosts()).toEqual(['app.x.io', 'cdn.x.io', 'docs.x.io', 'mail.x.io', 'old.x.io', 'old2.x.io', 'www.x.io']);
    const byHost = new Map(env.store.listSubdomains(env.watch.id).map((r) => [r.host, r]));
    expect(byHost.get('app.x.io')).toMatchObject({ sources: ['ct', 'dns'], alive: true, dns: info('1.2.3.5'), firstSeen: T0, lastProbe: T0 });
    expect(byHost.get('www.x.io')).toMatchObject({ sources: ['dns', 'link'], alive: true });
    expect(byHost.get('cdn.x.io')).toMatchObject({ sources: ['dns', 'code'], alive: true });
    expect(byHost.get('mail.x.io')).toMatchObject({ sources: ['ct'], alive: false, dns: null, lastProbe: T0 });
    expect(byHost.get('old.x.io')).toMatchObject({ sources: ['crtsh'], alive: false });
    expect(byHost.get('app.x.io')?.http).toMatchObject({ status: 200, title: 'Title of app.x.io', server: 'nginx' });

    expect(env.ct.certspotter).toHaveBeenCalledWith('x.io', null);
    expect(env.ct.crtsh).toHaveBeenCalledWith('x.io');
    expect(env.state).toMatchObject({ ctCursor: '100', ctLastPoll: T0, crtshLastPoll: T0, dnsLastScan: T0 });
    for (const label of ['www', 'api', 'airdrop', 'testnet']) expect(env.dns.callsFor(`${label}.x.io`)).toBeGreaterThan(0);
  });

  it('HTTP-probes at most 30 live hosts during a baseline', async () => {
    const env = setup();
    const names = Array.from({ length: 40 }, (_, i) => `h${i}.x.io`);
    for (const n of names) env.dns.set(n, '4.3.2.1');
    env.ct.certspotter.mockResolvedValueOnce({ names, cursor: '1' });
    await env.run({ baseline: true, force: true });
    expect(env.probes.calls).toHaveLength(30);
    expect(env.store.listSubdomains(env.watch.id).filter((r) => r.alive)).toHaveLength(40);
  });

  it('returns [] and touches nothing when the feature is off', async () => {
    const env = setup({ features: { subdomains: false } });
    expect(await env.run({ baseline: true, force: true })).toEqual([]);
    expect(env.ct.certspotter).not.toHaveBeenCalled();
    expect(env.dns.resolveCalls).toEqual([]);
    expect(env.state.ctLastPoll).toBe(0);
  });

  it.each(['127.0.0.1', 'localhost', '[::1]', '10.0.0.1', 'app.localhost', 'intranet'])('skips root %s entirely', async (root) => {
    const env = setup({ root, host: root });
    expect(await env.run({ baseline: true, force: true, localHosts: [{ host: `a.${root}`, source: 'link' }] })).toEqual([]);
    expect(env.ct.certspotter).not.toHaveBeenCalled();
    expect(env.ct.crtsh).not.toHaveBeenCalled();
    expect(env.dns.resolveCalls).toEqual([]);
    expect(env.hosts()).toEqual([]);
  });
});

describe('checkSubdomains: new names', () => {
  it('alerts a new CT name with DNS and HTTP probe info (and a not-yet-live one without)', async () => {
    const env = await baselined();
    env.clock.t = T0 + 300 * SEC;
    env.dns.set('beta.x.io', '5.5.5.5');
    env.ct.certspotter.mockResolvedValueOnce({ names: ['beta.x.io', 'soon.x.io', '*.soon.x.io', 'www.x.io'], cursor: '120' });

    const alerts = await env.run();

    expect(env.ct.certspotter).toHaveBeenCalledWith('x.io', '100');
    expect(env.state.ctCursor).toBe('120');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('subdomain');
    expect(alerts[0].rootDomain).toBe('x.io');
    expect(alerts[0].subdomains).toEqual([
      {
        host: 'beta.x.io',
        sources: ['ct'],
        dns: info('5.5.5.5'),
        http: { status: 200, title: 'Title of beta.x.io', finalUrl: 'https://beta.x.io/', server: 'nginx' },
      },
      { host: 'soon.x.io', sources: ['ct'], dns: null, http: null },
    ]);
    expect(env.probes.calls.map((c) => c.url)).toEqual(['https://beta.x.io/']);
    expect(env.store.getSubdomain(env.watch.id, 'soon.x.io')).toMatchObject({ alive: false, lastProbe: T0 + 300 * SEC });
    // Known name seen again: merged, no alert.
    expect(env.store.getSubdomain(env.watch.id, 'www.x.io')).toMatchObject({ sources: ['ct', 'dns'], lastSeen: T0 + 300 * SEC });

    // The same names are never announced twice.
    env.clock.t += 300 * SEC;
    env.ct.certspotter.mockResolvedValueOnce({ names: ['beta.x.io'], cursor: '130' });
    expect(await env.run()).toEqual([]);
  });

  it('alerts hosts first seen in site links / code', async () => {
    const env = await baselined();
    const alerts = await env.run({
      localHosts: [
        { host: 'api.x.io', source: 'code' },
        { host: 'www.x.io', source: 'link' },
        { host: 'cdn.other.com', source: 'code' },
      ],
    });
    expect(alerts.map((a) => a.kind)).toEqual(['subdomain']);
    expect(alerts[0].subdomains).toMatchObject([{ host: 'api.x.io', sources: ['code'], dns: null, http: null }]);
    // No source was due, so nothing else was queried.
    expect(env.ct.certspotter).not.toHaveBeenCalled();
    expect(env.ct.crtsh).not.toHaveBeenCalled();
  });

  it('alerts new wordlist hits from a later DNS sweep', async () => {
    const env = await baselined();
    env.clock.t = T0 + 900 * SEC;
    env.dns.set('staging.x.io', '7.7.7.7');
    const alerts = await env.run();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subdomains).toEqual([
      {
        host: 'staging.x.io',
        sources: ['dns'],
        dns: info('7.7.7.7'),
        http: { status: 200, title: 'Title of staging.x.io', finalUrl: 'https://staging.x.io/', server: 'nginx' },
      },
    ]);
    expect(env.state.dnsLastScan).toBe(T0 + 900 * SEC);
  });

  it('caps the listed hosts at 50 per run but records all of them', async () => {
    const env = await baselined();
    env.clock.t = T0 + 300 * SEC;
    const names = Array.from({ length: 60 }, (_, i) => `n${String(i).padStart(2, '0')}.x.io`);
    for (const n of names.slice(0, 10)) env.dns.set(n, '8.8.4.4');
    env.ct.certspotter.mockResolvedValueOnce({ names, cursor: '200' });

    const alerts = await env.run();
    expect(alerts[0].subdomains).toHaveLength(50);
    // Live hosts are preferred when capping; the list itself is sorted by host.
    const listed = hostsOf(alerts[0]);
    expect(listed).toEqual([...listed].sort());
    for (const n of names.slice(0, 10)) expect(listed).toContain(n);
    expect(env.hosts().filter((h) => h.startsWith('n'))).toHaveLength(60);
    expect(env.probes.calls).toHaveLength(10);
    expect(env.log.lines.some((l) => l.level === 'warn' && /cap/.test(l.msg))).toBe(true);
  });
});

describe('checkSubdomains: wildcard DNS', () => {
  it('ignores wordlist hits equal to the wildcard answer but reports a label with its own answer', async () => {
    const env = setup({ root: 'wc.io' });
    env.dns.wildcardAnswer = info('1.1.1.1');
    env.dns.set('www.wc.io', '3.3.3.3');
    expect(await env.run({ baseline: true, force: true })).toEqual([]);
    expect(env.hosts()).toEqual(['www.wc.io']);

    env.clock.t = T0 + 900 * SEC;
    env.dns.set('beta.wc.io', '4.4.4.4');
    env.ct.certspotter.mockResolvedValueOnce({ names: ['ghost.wc.io'], cursor: '9' });
    const alerts = await env.run();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].subdomains).toMatchObject([
      { host: 'beta.wc.io', sources: ['dns'], dns: info('4.4.4.4') },
      // A CT name that only resolves through the wildcard is new but not live.
      { host: 'ghost.wc.io', sources: ['ct'], dns: null, http: null },
    ]);
    expect(env.hosts()).toEqual(['beta.wc.io', 'ghost.wc.io', 'www.wc.io']);
    expect(env.store.getSubdomain(env.watch.id, 'ghost.wc.io')?.alive).toBe(false);
  });

  it('treats a CNAME wildcard with rotating addresses as the wildcard', async () => {
    const env = setup({ root: 'cn.io' });
    env.dns.wildcardAnswer = { a: ['1.1.1.1'], aaaa: [], cname: ['lb.host.net'] };
    // Same CNAME target, different A record this time.
    env.dns.records.set('api.cn.io', { a: ['1.1.1.2'], aaaa: [], cname: ['lb.host.net'] });
    await env.run({ baseline: true, force: true });
    expect(env.hosts()).toEqual([]);
  });

  it('re-verifies an inconclusive wildcard probe when many labels suddenly resolve', async () => {
    const env = setup({ root: 'wc.io' });
    env.dns.wildcardAnswer = info('1.1.1.1');
    env.dns.detectWildcard = false;
    env.dns.set('www.wc.io', '3.3.3.3');
    await env.run({ baseline: true, force: true });
    expect(env.hosts()).toEqual(['www.wc.io']);
    expect(env.dns.resolveCalls.some((h) => /^wc-[0-9a-f]{16}\.wc\.io$/.test(h))).toBe(true);
  });

  it('remembers the wildcard answer when a later probe is inconclusive', async () => {
    const env = setup({ root: 'wc.io' });
    env.dns.wildcardAnswer = info('1.1.1.1');
    env.dns.set('www.wc.io', '3.3.3.3');
    await env.run({ baseline: true, force: true });

    // Probe now fails and fresh random labels don't resolve either, yet every wordlist label hits the old answer.
    env.dns.detectWildcard = false;
    env.dns.wildcardApplies = (h) => !h.startsWith('wc-');
    env.clock.t = T0 + 900 * SEC;
    expect(await env.run()).toEqual([]);
    expect(env.hosts()).toEqual(['www.wc.io']);
    // Filtered by the remembered answer, not by the shared-answer heuristic.
    expect(env.log.lines.some((l) => /treating it as a wildcard/.test(l.msg))).toBe(false);
  });

  it('treats many new labels sharing one answer as an undetected wildcard', async () => {
    const env = setup({ root: 'wc.io' });
    env.dns.set('www.wc.io', '3.3.3.3');
    await env.run({ baseline: true, force: true });

    env.clock.t = T0 + 900 * SEC;
    env.dns.wildcardAnswer = info('6.6.6.6');
    env.dns.detectWildcard = false;
    env.dns.wildcardApplies = (h) => !h.startsWith('wc-');
    env.dns.set('beta.wc.io', '4.4.4.4');
    const alerts = await env.run();
    expect(alerts.map(hostsOf)).toEqual([['beta.wc.io']]);
    expect(env.log.lines.some((l) => /treating it as a wildcard/.test(l.msg))).toBe(true);
  });
});

describe('checkSubdomains: going live', () => {
  it('alerts subdomain_live when a known dead name starts resolving', async () => {
    const env = setup();
    env.ct.certspotter.mockResolvedValueOnce({ names: ['soon.x.io'], cursor: '1' });
    await env.run({ baseline: true, force: true });
    expect(env.store.getSubdomain(env.watch.id, 'soon.x.io')).toMatchObject({ alive: false, lastProbe: T0 });

    // Not re-resolved before the interval.
    env.dns.resolveCalls.length = 0;
    env.clock.t = T0 + 60 * SEC;
    env.dns.set('soon.x.io', '5.5.5.5');
    expect(await env.run()).toEqual([]);
    expect(env.dns.callsFor('soon.x.io')).toBe(0);

    env.clock.t = T0 + 300 * SEC;
    const alerts = await env.run();
    expect(alerts).toEqual([
      {
        kind: 'subdomain_live',
        rootDomain: 'x.io',
        subdomains: [
          {
            host: 'soon.x.io',
            sources: ['ct'],
            dns: info('5.5.5.5'),
            http: { status: 200, title: 'Title of soon.x.io', finalUrl: 'https://soon.x.io/', server: 'nginx' },
          },
        ],
      },
    ]);
    expect(env.store.getSubdomain(env.watch.id, 'soon.x.io')).toMatchObject({ alive: true, lastProbe: T0 + 300 * SEC });

    // Alive is sticky: a later failed lookup neither flips it back nor re-alerts.
    env.dns.records.delete('soon.x.io');
    env.clock.t = T0 + 900 * SEC;
    expect(await env.run()).toEqual([]);
    expect(env.dns.callsFor('soon.x.io')).toBe(1);
    expect(env.store.getSubdomain(env.watch.id, 'soon.x.io')?.alive).toBe(true);
  });

  it('reports new and live names together, new first', async () => {
    const env = setup();
    env.ct.certspotter.mockResolvedValueOnce({ names: ['soon.x.io'], cursor: '1' });
    await env.run({ baseline: true, force: true });
    env.clock.t = T0 + 300 * SEC;
    env.dns.set('soon.x.io', '5.5.5.5');
    const alerts = await env.run({ localHosts: [{ host: 'fresh.x.io', source: 'link' }] });
    expect(alerts.map((a) => [a.kind, hostsOf(a)])).toEqual([
      ['subdomain', ['fresh.x.io']],
      ['subdomain_live', ['soon.x.io']],
    ]);
  });

  it('does not alert when a never-probed record resolves on its first probe', async () => {
    const env = await baselined();
    env.store.upsertSubdomain({
      watchId: env.watch.id,
      host: 'queued.x.io',
      sources: ['crtsh'],
      firstSeen: T0,
      lastSeen: T0,
      alive: false,
      lastProbe: 0,
      dns: null,
      http: null,
    });
    env.dns.set('queued.x.io', '5.5.5.5');
    expect(await env.run()).toEqual([]);
    expect(env.store.getSubdomain(env.watch.id, 'queued.x.io')).toMatchObject({ alive: true, dns: info('5.5.5.5') });
  });

  it('does not mark names dead while the resolver is down', async () => {
    const env = setup();
    env.dns.down = true;
    env.ct.certspotter.mockResolvedValueOnce({ names: ['app.x.io'], cursor: '1' });
    await env.run({ baseline: true, force: true });
    expect(env.store.getSubdomain(env.watch.id, 'app.x.io')).toMatchObject({ alive: false, lastProbe: 0 });
    expect(env.state.dnsLastScan).toBe(0);

    env.dns.down = false;
    env.dns.set('app.x.io', '5.5.5.5');
    env.clock.t = T0 + 300 * SEC;
    // First real probe: alive, but no "went live" claim; the first completed sweep is a silent backfill.
    env.dns.set('www.x.io', '1.2.3.4');
    expect(await env.run()).toEqual([]);
    expect(env.store.getSubdomain(env.watch.id, 'app.x.io')?.alive).toBe(true);
    expect(env.hosts()).toContain('www.x.io');
    expect(env.state.dnsLastScan).toBe(T0 + 300 * SEC);
  });

  it('backs off re-probing names that have been dead for weeks', async () => {
    const env = await baselined();
    env.store.upsertSubdomain({
      watchId: env.watch.id,
      host: 'ancient.x.io',
      sources: ['crtsh'],
      firstSeen: T0 - 60 * 24 * HOUR,
      lastSeen: T0,
      alive: false,
      lastProbe: T0,
      dns: null,
      http: null,
    });
    env.clock.t = T0 + 600 * SEC;
    await env.run();
    expect(env.dns.callsFor('ancient.x.io')).toBe(0);
    env.clock.t = T0 + 3 * HOUR;
    await env.run();
    expect(env.dns.callsFor('ancient.x.io')).toBe(1);
  });
});

describe('checkSubdomains: source isolation & noise guards', () => {
  it('keeps other sources working when Cert Spotter throws', async () => {
    const env = await baselined();
    env.clock.t = T0 + 1800 * SEC;
    env.ct.certspotter.mockRejectedValueOnce(new Error('certspotter: HTTP 500'));
    env.ct.crtsh.mockResolvedValueOnce(['www.x.io', 'shop.x.io']);
    env.dns.set('vault.x.io', '2.2.2.2');

    const alerts = await env.run({ localHosts: [{ host: 'api.x.io', source: 'code' }] });
    expect(hostsOf(alerts[0])).toEqual(['api.x.io', 'shop.x.io', 'vault.x.io']);
    expect(env.state.ctLastPoll).toBe(T0 + 1800 * SEC);
    expect(env.state.ctCursor).toBe('100');
    expect(env.log.lines.some((l) => l.level === 'warn' && /certspotter failed/.test(l.msg))).toBe(true);
  });

  it('keeps other sources working when crt.sh and the wildcard probe throw', async () => {
    const env = await baselined();
    env.clock.t = T0 + 1800 * SEC;
    env.ct.crtsh.mockRejectedValueOnce(new Error('crt.sh: timeout after 60s'));
    env.dns.wildcard = async () => {
      throw new Error('resolver exploded');
    };
    env.ct.certspotter.mockResolvedValueOnce({ names: ['new.x.io'], cursor: '101' });
    const alerts = await env.run();
    expect(hostsOf(alerts[0])).toEqual(['new.x.io']);
    expect(env.state.crtshLastPoll).toBe(T0 + 1800 * SEC);
  });

  it('never throws when the store fails', async () => {
    const env = await baselined();
    env.store.close();
    stores.splice(stores.indexOf(env.store), 1);
    expect(await env.run({ localHosts: [{ host: 'api.x.io', source: 'code' }] })).toEqual([]);
    expect(env.log.lines.some((l) => l.level === 'error')).toBe(true);
  });

  it('records the first successful polls after a failed baseline silently', async () => {
    const env = setup();
    env.ct.certspotter.mockRejectedValueOnce(new Error('certspotter: HTTP 503'));
    env.ct.crtsh.mockRejectedValueOnce(new Error('crt.sh: HTTP 502'));
    await env.run({ baseline: true, force: true });
    expect(env.state.ctCursor).toBeNull();

    env.clock.t = T0 + 1800 * SEC;
    env.dns.set('site9.x.io', '1.1.1.9');
    env.ct.certspotter.mockResolvedValueOnce({ names: ['site9.x.io', 'old.x.io'], cursor: '50' });
    env.ct.crtsh.mockResolvedValueOnce(['older.x.io', 'site9.x.io']);
    expect(await env.run()).toEqual([]);
    expect(env.hosts()).toEqual(['old.x.io', 'older.x.io', 'site9.x.io']);
    expect(env.store.getSubdomain(env.watch.id, 'site9.x.io')).toMatchObject({ sources: ['ct', 'crtsh'], alive: true });

    // From now on, new names are news.
    env.clock.t = T0 + 3600 * SEC;
    env.ct.certspotter.mockResolvedValueOnce({ names: ['brandnew.x.io'], cursor: '51' });
    env.ct.crtsh.mockResolvedValueOnce(['older.x.io', 'crtnew.x.io']);
    const alerts = await env.run();
    expect(hostsOf(alerts[0])).toEqual(['brandnew.x.io', 'crtnew.x.io']);
  });

  it('treats names after an empty-but-successful baseline poll as news', async () => {
    const env = setup();
    // Default fake: no issuances yet, cursor stays null.
    await env.run({ baseline: true, force: true });
    expect(env.state.ctCursor).toBeNull();
    env.clock.t = T0 + 300 * SEC;
    env.ct.certspotter.mockResolvedValueOnce({ names: ['first.x.io'], cursor: '1' });
    expect((await env.run()).map(hostsOf)).toEqual([['first.x.io']]);
  });

  it('keeps names silent when the baseline poll was rate-limited before any page', async () => {
    const env = setup();
    env.ct.certspotter.mockResolvedValueOnce({ names: [], cursor: null, rateLimitedUntil: T0 + 60 * SEC });
    await env.run({ baseline: true, force: true });
    env.clock.t = T0 + 300 * SEC;
    env.ct.certspotter.mockResolvedValueOnce({ names: ['historic.x.io'], cursor: '9' });
    expect(await env.run()).toEqual([]);
    expect(env.hosts()).toContain('historic.x.io');
  });

  it('pages through a large CT backlog during baseline, and keeps a leftover backlog silent', async () => {
    const env = setup();
    let n = 0;
    env.ct.certspotter.mockImplementation(async () => {
      n++;
      return { names: [`b${n}.x.io`], cursor: String(n), more: true };
    });
    await env.run({ baseline: true, force: true });
    expect(env.ct.certspotter).toHaveBeenCalledTimes(5);
    expect(env.state.ctCursor).toBe('5');

    // Still catching up: silent.
    env.clock.t = T0 + 300 * SEC;
    env.ct.certspotter.mockImplementation(async () => ({ names: ['b6.x.io'], cursor: '6', more: true }));
    expect(await env.run()).toEqual([]);
    // Last page of the backlog: still silent.
    env.clock.t = T0 + 600 * SEC;
    env.ct.certspotter.mockImplementation(async () => ({ names: ['b7.x.io'], cursor: '7', more: false }));
    expect(await env.run()).toEqual([]);
    // Caught up: new issuance is news.
    env.clock.t = T0 + 900 * SEC;
    env.ct.certspotter.mockImplementation(async () => ({ names: ['launch.x.io'], cursor: '8' }));
    expect((await env.run()).map(hostsOf)).toEqual([['launch.x.io']]);
    expect(env.hosts().filter((h) => h.startsWith('b'))).toHaveLength(7);
  });

  it('skips the DNS sweep (without recording it) when the watched host does not resolve', async () => {
    const env = await baselined();
    env.dns.records.delete('x.io');
    env.clock.t = T0 + 900 * SEC;
    await env.run();
    expect(env.state.dnsLastScan).toBe(T0);
    expect(env.dns.callsFor('www.x.io')).toBe(0);
  });
});

describe('checkSubdomains: cadence & rate limits', () => {
  it('polls each source only when due, unless forced', async () => {
    const env = await baselined();

    env.clock.t = T0 + 60 * SEC;
    await env.run();
    expect(env.ct.certspotter).not.toHaveBeenCalled();
    expect(env.ct.crtsh).not.toHaveBeenCalled();
    expect(env.dns.callsFor('www.x.io')).toBe(0);

    // force: Cert Spotter and the DNS sweep run, crt.sh keeps its own (slow) cadence.
    await env.run({ force: true });
    expect(env.ct.certspotter).toHaveBeenCalledTimes(1);
    expect(env.ct.crtsh).not.toHaveBeenCalled();
    expect(env.dns.callsFor('www.x.io')).toBe(1);
    expect(env.state).toMatchObject({ ctLastPoll: T0 + 60 * SEC, dnsLastScan: T0 + 60 * SEC, crtshLastPoll: T0 });

    env.clock.t = T0 + 400 * SEC;
    await env.run();
    expect(env.ct.certspotter).toHaveBeenCalledTimes(2);
    expect(env.ct.crtsh).not.toHaveBeenCalled();
    expect(env.dns.callsFor('www.x.io')).toBe(1);

    env.clock.t = T0 + 1800 * SEC;
    await env.run();
    expect(env.ct.certspotter).toHaveBeenCalledTimes(3);
    expect(env.ct.crtsh).toHaveBeenCalledTimes(1);
    expect(env.dns.callsFor('www.x.io')).toBe(2);
  });

  it('tolerates scheduler jitter slightly under the interval', async () => {
    const env = await baselined();
    env.clock.t = T0 + 270 * SEC; // 300s - 10%
    await env.run();
    expect(env.ct.certspotter).toHaveBeenCalledTimes(1);
  });

  it('skips Cert Spotter after a 429 until the deadline, even when forced', async () => {
    const env = await baselined();
    env.clock.t = T0 + 300 * SEC;
    const until = env.clock.t + HOUR;
    env.ct.certspotter.mockResolvedValueOnce({ names: ['partial.x.io'], cursor: '110', rateLimitedUntil: until });
    const alerts = await env.run();
    expect(hostsOf(alerts[0])).toEqual(['partial.x.io']);
    expect(env.state.ctCursor).toBe('110');
    expect(ctRateLimitedUntil('x.io', env.clock.t)).toBe(until);

    env.clock.t = T0 + 900 * SEC;
    await env.run({ force: true });
    env.clock.t = until - SEC;
    await env.run();
    expect(env.ct.certspotter).toHaveBeenCalledTimes(1);

    env.clock.t = until + SEC;
    await env.run();
    expect(env.ct.certspotter).toHaveBeenCalledTimes(2);
    expect(env.ct.certspotter).toHaveBeenLastCalledWith('x.io', '110');
    expect(ctRateLimitedUntil('x.io', env.clock.t)).toBeNull();
  });

  it('shares a rate limit between watches of the same root domain', async () => {
    const a = await baselined();
    a.clock.t = T0 + 300 * SEC;
    a.ct.certspotter.mockResolvedValueOnce({ names: [], cursor: '100', rateLimitedUntil: a.clock.t + HOUR });
    await a.run();

    const b = setup();
    await b.run({ baseline: true, force: true });
    expect(b.ct.certspotter).not.toHaveBeenCalled();
  });
});

/** Deterministic pseudo-random generator (tests must be reproducible). */
function seeded(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** Simulates a process restart for the subdomain checker: module caches are gone, the state comes back from storage. */
function restart(env: Env): void {
  resetSubdomainCaches();
  const reloaded = JSON.parse(JSON.stringify(env.state)) as WatchState;
  for (const k of Object.keys(env.state)) delete (env.state as unknown as Record<string, unknown>)[k];
  Object.assign(env.state, reloaded);
}

describe('checkSubdomains: rotating wildcard DNS', () => {
  const pick2 = (pool: string[], rnd: () => number) => {
    const a = Math.floor(rnd() * pool.length);
    let b = Math.floor(rnd() * pool.length);
    if (b === a) b = (b + 1) % pool.length;
    return info(pool[a], pool[b]);
  };

  it('a wildcard answering random pairs from one address pool (Vercel-style) never yields fake subdomains; a real new host still does', async () => {
    const env = setup({ root: 'vc.io' });
    const pool = ['1', '65', '129', '193'].flatMap((x) => [`64.239.109.${x}`, `64.239.123.${x}`]);
    const rnd = seeded(7);
    env.dns.dynamicAnswer = () => pick2(pool, rnd);
    env.ct.certspotter.mockResolvedValueOnce({ names: ['ieee.vc.io', 'proprod.vc.io'], cursor: '1' });
    expect(await env.run({ baseline: true, force: true })).toEqual([]);
    expect(env.hosts().filter((h) => env.store.getSubdomain(env.watch.id, h)!.sources.includes('dns'))).toEqual([]);

    const alerts: SubdomainAlert[] = [];
    for (let i = 1; i <= 6; i++) {
      if (i === 3) restart(env);
      env.clock.t = T0 + i * 16 * 60 * SEC;
      alerts.push(...(await env.run()));
    }
    expect(alerts).toEqual([]);
    expect(env.store.getSubdomain(env.watch.id, 'ieee.vc.io')!.alive).toBe(false);

    // A real host with its own address outside the pool is still found by the sweep.
    env.dns.set('staging.vc.io', '203.0.113.5');
    env.clock.t = T0 + 8 * 16 * 60 * SEC;
    const found = await env.run();
    expect(found.map(hostsOf)).toEqual([['staging.vc.io']]);
    expect(found[0].subdomains[0].sources).toEqual(['dns']);
  });

  it('a wildcard spread over many networks (CloudFront-style) makes DNS say nothing; CT names are still reported', async () => {
    const env = setup({ root: 'cf.io' });
    const nets = ['18.67.65', '13.225.196', '65.8.70', '3.160.5', '54.230.1', '99.84.2', '108.138.7', '143.204.9'];
    const pool = nets.flatMap((n) => [`${n}.12`, `${n}.77`]);
    const rnd = seeded(11);
    env.dns.dynamicAnswer = () => pick2(pool, rnd);
    env.ct.certspotter.mockResolvedValueOnce({ names: ['demoday.cf.io'], cursor: '1' });
    await env.run({ baseline: true, force: true });
    expect(env.store.getSubdomain(env.watch.id, 'demoday.cf.io')).toMatchObject({ alive: false });

    const alerts: SubdomainAlert[] = [];
    for (let i = 1; i <= 6; i++) {
      env.clock.t = T0 + i * 16 * 60 * SEC;
      alerts.push(...(await env.run()));
    }
    expect(alerts).toEqual([]);
    expect(env.store.listSubdomains(env.watch.id).some((r) => r.sources.includes('dns'))).toBe(false);

    env.clock.t = T0 + 7 * 16 * 60 * SEC;
    env.ct.certspotter.mockResolvedValueOnce({ names: ['launch.cf.io'], cursor: '2' });
    const ct = await env.run();
    expect(ct).toHaveLength(1);
    expect(ct[0]).toMatchObject({ kind: 'subdomain', subdomains: [{ host: 'launch.cf.io', sources: ['ct'] }] });
  });

  it('per-name answers with one fixed probe answer (alias records) are treated as the wildcard too', async () => {
    const env = setup({ root: 'al.io' });
    const nets = ['18.67.65', '13.225.196', '65.8.70', '3.160.5', '54.230.1', '99.84.2'];
    env.dns.dynamicAnswer = (host) => {
      const h = hashOf(host);
      return info(`${nets[h % nets.length]}.${h % 250}`, `${nets[(h >> 3) % nets.length]}.${(h >> 5) % 250}`);
    };
    env.dns.dynamicProbe = info('18.67.65.1', '13.225.196.2');
    await env.run({ baseline: true, force: true });
    const alerts: SubdomainAlert[] = [];
    for (let i = 1; i <= 4; i++) {
      env.clock.t = T0 + i * 16 * 60 * SEC;
      alerts.push(...(await env.run()));
    }
    expect(alerts).toEqual([]);
    // DNS says nothing in such a zone: the wordlist labels were not recorded as subdomains.
    expect(env.store.listSubdomains(env.watch.id).some((r) => r.sources.includes('dns'))).toBe(false);
  });
});

describe('checkSubdomains: Cert Spotter backlog across restarts', () => {
  /** A backlog of 9 old names served 3 per call; every other call is rate-limited. */
  function backlog(env: Env) {
    let next = 1;
    let call = 0;
    env.ct.certspotter.mockImplementation(async (_d, cursor) => {
      call++;
      if (call % 2 === 0) return { names: [], cursor, rateLimitedUntil: env.clock.t + 60 * SEC };
      if (next > 9) return { names: [], cursor };
      const names = [next, next + 1, next + 2].map((i) => `old-${i}.x.io`);
      next += 3;
      return { names, cursor: String(next), more: next <= 9 };
    });
  }

  it('a restart while a backlog is still being paged through does not announce the rest of it', async () => {
    const env = setup();
    backlog(env);
    await env.run({ baseline: true, force: true });
    expect(env.state.ctBackfill).toBe(true);
    restart(env);
    const alerts: SubdomainAlert[] = [];
    for (let i = 1; i <= 8; i++) {
      env.clock.t = T0 + i * 5 * 60 * SEC;
      alerts.push(...(await env.run()));
      if (i === 4) restart(env);
    }
    expect(alerts).toEqual([]);
    expect(env.hosts().filter((h) => h.startsWith('old-'))).toHaveLength(9);
    expect(env.state.ctBackfill).toBe(false);

    env.ct.certspotter.mockImplementation(async () => ({ names: ['brand-new.x.io'], cursor: '99' }));
    env.clock.t = T0 + 60 * 60 * SEC;
    expect((await env.run()).map(hostsOf)).toEqual([['brand-new.x.io']]);
  });

  it('a failed baseline poll followed by a partial, rate-limited first poll keeps the whole backlog silent', async () => {
    const env = setup();
    let next = 1;
    let call = 0;
    env.ct.certspotter.mockImplementation(async (_d, cursor) => {
      call++;
      if (call === 1) throw new Error('certspotter: HTTP 502');
      if (next > 9) return { names: [], cursor };
      // The first poll after the failure gets one page, then runs into the rate limit (cut short) …
      if (call === 2) {
        next = 4;
        return { names: ['old-1.x.io', 'old-2.x.io', 'old-3.x.io'], cursor: '4', rateLimitedUntil: env.clock.t + 60 * SEC };
      }
      // … and the rest of the backlog fits in the next call.
      const names = Array.from({ length: 10 - next }, (_, i) => `old-${next + i}.x.io`);
      next = 10;
      return { names, cursor: '10', more: false };
    });
    await env.run({ baseline: true, force: true });
    const alerts: SubdomainAlert[] = [];
    for (let i = 1; i <= 10; i++) {
      env.clock.t = T0 + i * 5 * 60 * SEC;
      alerts.push(...(await env.run()));
    }
    expect(alerts).toEqual([]);
    expect(env.hosts().filter((h) => h.startsWith('old-'))).toHaveLength(9);
  });
});

describe('checkSubdomains: shared Cert Spotter limit', () => {
  it('a rate limit hit by one watch holds back every other root until it passes', async () => {
    const a = await baselined();
    a.clock.t = T0 + 300 * SEC;
    a.ct.certspotter.mockResolvedValueOnce({ names: [], cursor: '100', rateLimitedUntil: a.clock.t + 10 * 60 * SEC });
    await a.run();

    const b = setup({ root: 'other.io' });
    b.clock.t = T0 + 360 * SEC;
    await b.run({ force: true });
    expect(b.ct.certspotter).not.toHaveBeenCalled();
    b.clock.t = T0 + 300 * SEC + 11 * 60 * SEC;
    await b.run({ force: true });
    expect(b.ct.certspotter).toHaveBeenCalledTimes(1);
  });

  it('local hosts marked quiet are recorded without an alert', async () => {
    const env = await baselined();
    env.dns.set('old.x.io', '5.5.5.5');
    env.dns.set('fresh.x.io', '5.5.5.6');
    env.clock.t = T0 + 60 * SEC;
    const alerts = await env.run({
      localHosts: [
        { host: 'old.x.io', source: 'link', loud: false } as { host: string; source: 'link' },
        { host: 'fresh.x.io', source: 'link' },
      ],
    });
    expect(alerts.map(hostsOf)).toEqual([['fresh.x.io']]);
    expect(env.hosts()).toContain('old.x.io');
  });
});
