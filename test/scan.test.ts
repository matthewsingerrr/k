/**
 * scanSite end-to-end against a local fake site. Public-looking hostnames (unpegtest.io, …) are mapped to a node:http
 * server on 127.0.0.1 by the HttpClient's fetch seam; any other host fails like an unresolvable name, so nothing here
 * can reach the internet. DNS and Cert Spotter are fakes.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { HttpClient } from '../src/net/http.js';
import { silentLogger } from '../src/log.js';
import type { DnsProvider } from '../src/net/dns.js';
import type { CtProvider } from '../src/monitor/subdomains.js';
import type { DnsInfo } from '../src/types.js';
import { resetScanCache, scanSite, ScanInputError, type ScanDeps } from '../src/link/scan.js';

// ---------------------------------------------------------------------------
// Fake web
// ---------------------------------------------------------------------------

interface Reply {
  status?: number;
  headers?: Record<string, string | string[] | undefined>;
  body?: string;
  delayMs?: number;
}
type Handler = (path: string) => Reply | undefined;

interface FakeWeb {
  origin: string;
  /** "<site>:<path>" → request count. */
  hits: Map<string, number>;
  count(site: string, path: string): number;
  sites: Map<string, Handler>;
  close(): Promise<void>;
}

/** One server for every fake site: requests arrive as /__site/<site><path>. */
async function startWeb(): Promise<FakeWeb> {
  const sites = new Map<string, Handler>();
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/__site\/([^/]+)(\/.*)$/.exec(url.pathname);
    const site = m?.[1] ?? '';
    const path = m?.[2] ?? '/';
    const k = `${site}:${path}`;
    hits.set(k, (hits.get(k) ?? 0) + 1);
    const reply = sites.get(site)?.(path) ?? { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' };
    const send = () => {
      if (res.destroyed) return;
      const body = reply.body ?? '';
      const headers: Record<string, string | string[] | number> = { 'content-length': Buffer.byteLength(body) };
      for (const [k, v] of Object.entries(reply.headers ?? {})) if (v !== undefined) headers[k] = v;
      res.writeHead(reply.status ?? 200, headers);
      res.end(body);
    };
    if (reply.delayMs) setTimeout(send, reply.delayMs).unref();
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    count: (site, path) => hits.get(`${site}:${path}`) ?? 0,
    sites,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** HttpClient whose fetch maps https://<host>/<path> → the fake web; unknown hosts fail like NXDOMAIN. */
function makeHttp(web: FakeWeb, hostMap: Record<string, string>): HttpClient {
  return new HttpClient({
    userAgent: 'test',
    globalConcurrency: 16,
    perHostConcurrency: 8,
    timeoutMs: 5000,
    maxBytes: 5 * 1024 * 1024,
    allowPrivate: true,
    fetch: async (raw, init) => {
      const u = new URL(raw);
      const target = hostMap[u.hostname];
      if (!target) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${u.hostname}`), { code: 'ENOTFOUND' }) });
      const dest = target.startsWith('http') ? `${target}${u.pathname}${u.search}` : `${web.origin}/__site/${target}${u.pathname}${u.search}`;
      return fetch(dest, init as RequestInit);
    },
  });
}

function fakeDns(records: Record<string, string[]>, wildcard: string[] | null = null): DnsProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolve(host: string): Promise<DnsInfo | null> {
      calls.push(host);
      const a = records[host];
      if (a) return { a, aaaa: [], cname: [] };
      if (wildcard && host.endsWith('.unpegtest.io')) return { a: wildcard, aaaa: [], cname: [] };
      return null;
    },
    async wildcard(domain: string) {
      return wildcard && domain === 'unpegtest.io' ? new Set(wildcard.map((ip) => `A:${ip}`)) : null;
    },
  };
}

function fakeCt(impl?: CtProvider['certspotter']): CtProvider & { calls: number } {
  const ct = {
    calls: 0,
    async certspotter(domain: string, cursor: string | null, maxPages?: number) {
      ct.calls++;
      if (impl) return impl(domain, cursor, maxPages);
      return { names: ['*.unpegtest.io', 'secret-staging.unpegtest.io', 'unpegtest.io', 'evil.example', 'APP.unpegtest.io.'], cursor: '42' };
    },
    async crtsh(): Promise<string[]> {
      throw new Error('crt.sh is not used by scans');
    },
  };
  return ct;
}

// ---------------------------------------------------------------------------
// The fake site
// ---------------------------------------------------------------------------

const BUILD_ID = 'Bq7xK2mN9pR4sT6vW8yZ1';
const HOME = `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>
<title>Unpeg Test — Launch &amp; trade</title>
<meta name="description" content="Fair launches on Solana."/>
<meta property="og:image" content="https://unpegtest.io/og.png"/>
<meta name="twitter:site" content="@unpegtest"/>
<link rel="stylesheet" href="/_next/static/css/a1b2c3d4.css"/>
<link rel="preload" as="script" href="/_next/static/chunks/pages/index-5e6f7a8b.js"/>
<script src="/_next/static/chunks/main-1a2b3c4d.js" defer=""></script>
<script src="/_next/static/chunks/framework-9f8e7d6c.js" defer=""></script>
<script src="/_next/static/${BUILD_ID}/_buildManifest.js" defer=""></script>
<script src="https://auth.privy.io/js/privy-embed.js" defer=""></script>
</head><body><div id="__next">
<nav><a href="/">Home</a><a href="/about">About</a><a href="/docs">Docs</a><a href="https://docs.unpegtest.io/intro">Guide</a>
<a href="https://app.unpegtest.io/">Launch app</a></nav>
<footer>
<a href="https://x.com/unpegtest?s=21">X</a><a href="https://twitter.com/unpegtest">Twitter</a>
<a href="https://t.me/unpegtest">Telegram</a><a href="https://discord.gg/unpeg">Discord</a>
<a href="https://github.com/unpegtest/contracts/tree/main">GitHub</a>
<a href="https://dexscreener.com/solana/5hd5o7cwebqwq7sxtktybf9n5a9abae8jh1xbq31aedk">Chart</a>
<a href="https://twitter.com/intent/tweet?text=hi">Share</a>
</footer></div>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}},"page":"/","query":{},"buildId":"${BUILD_ID}"}</script>
</body></html>`;

const MAIN_JS = [
  '(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[792],{1:function(e,t,n){',
  'var Ys={bundleType:0,version:"18.3.1",rendererPackageName:"react-dom"};',
  'const s="@solana/web3.js";const rpc="https://mainnet.helius-rpc.com/?api-key="+k;',
  'fetch("/api/launches/count");fetch("/api/pools?limit=5".split("?")[0]);const p="/api/token/[mint]";',
  'const api="https://api.unpegtest.io/v1/markets";const idx="https://indexer.unpegtest.io/graphql";',
  'const ghost="https://ghost.unpegtest.io/";const h={"privy-app-id":id};',
  'const pages=["/about","/docs/how-it-works"];',
  '}}]);',
].join('\n');

function unpegSite(): Handler {
  return (path) => {
    switch (path) {
      case '/':
        return {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            server: 'Vercel',
            'x-vercel-id': 'fra1::abc-123',
            'x-powered-by': 'Next.js',
            'set-cookie': ['privy-session=t; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly', 'theme=dark; Path=/'],
          },
          body: HOME,
        };
      case '/_next/static/chunks/main-1a2b3c4d.js':
        return { headers: { 'content-type': 'application/javascript' }, body: MAIN_JS };
      case '/_next/static/chunks/framework-9f8e7d6c.js':
        return { headers: { 'content-type': 'application/javascript' }, body: '/* framework */ var a="/api/health";' };
      case '/_next/static/chunks/pages/index-5e6f7a8b.js':
        return { headers: { 'content-type': 'application/javascript' }, body: 'fetch("/api/stats/overview");' };
      case `/_next/static/${BUILD_ID}/_buildManifest.js`:
        // SPA fallback: an HTML page where a script was expected is never mined as code.
        return { headers: { 'content-type': 'text/html' }, body: '<!doctype html><html><body>"/api/should-not-appear"</body></html>' };
      default:
        return undefined;
    }
  };
}

const DNS_RECORDS: Record<string, string[]> = {
  'unpegtest.io': ['76.76.21.21'],
  'www.unpegtest.io': ['76.76.21.22'],
  'app.unpegtest.io': ['76.76.21.61'],
  'api.unpegtest.io': ['34.1.2.3'],
  'docs.unpegtest.io': ['104.18.1.1'],
  'indexer.unpegtest.io': ['34.1.2.4'],
  'secret-staging.unpegtest.io': ['34.9.9.9'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let web: FakeWeb;
let store: Store;
let clock: { now: number };

beforeAll(async () => {
  web = await startWeb();
});
afterAll(async () => {
  await web.close();
});
beforeEach(() => {
  resetScanCache();
  web.hits.clear();
  web.sites.clear();
  store = new Store(':memory:');
  clock = { now: Date.UTC(2026, 9, 5, 14, 3, 11) };
});
afterEach(() => {
  store.close();
});

function deps(over: Partial<ScanDeps> & { hostMap?: Record<string, string> } = {}): ScanDeps {
  const { hostMap, ...rest } = over;
  return {
    http: makeHttp(web, hostMap ?? { 'unpegtest.io': 'unpeg', 'www.unpegtest.io': 'unpeg' }),
    store,
    config: testConfig(),
    dns: fakeDns(DNS_RECORDS),
    ct: fakeCt(),
    log: silentLogger,
    now: () => clock.now,
    ...rest,
  };
}

describe('scanSite — a healthy site', () => {
  it('reports page facts, tech, build, code intel, socials, server, subdomains and the watched flag', async () => {
    web.sites.set('unpeg', unpegSite());
    const watch = store.createWatch({
      guildId: 'g1',
      channelId: 'c1',
      name: 'Unpeg',
      url: 'https://unpegtest.io/',
      host: 'unpegtest.io',
      rootDomain: 'unpegtest.io',
      createdBy: 'u1',
    });
    const r = await scanSite(deps(), 'unpegtest.io', { guildId: 'g1' });

    expect(r).toMatchObject({
      url: 'https://unpegtest.io/',
      finalUrl: 'https://unpegtest.io/',
      host: 'unpegtest.io',
      rootDomain: 'unpegtest.io',
      status: 200,
      blocked: false,
      error: null,
      title: 'Unpeg Test — Launch & trade',
      description: 'Fair launches on Solana.',
      ogImage: 'https://unpegtest.io/og.png',
      scannedAt: '2026-10-05T14:03:11.000Z',
    });
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);

    // build fingerprint
    expect(r.build.id).toBe(BUILD_ID);
    expect(r.build.assets).toBe(5);
    expect(r.build.generator).toBeNull();

    // tech
    const tech = new Map(r.tech.map((t) => [t.name, t]));
    expect(tech.get('Next.js')?.evidence).toMatch(/^pages router/);
    expect(tech.get('React')?.version).toBe('18.3.1');
    expect(tech.get('Vercel')?.evidence).toBe('x-vercel-id header');
    expect(tech.get('Privy')).toBeDefined();
    expect(tech.get('Solana web3.js')).toBeDefined();
    expect(tech.get('Helius')).toBeDefined();
    expect(tech.has('DexScreener')).toBe(false);

    // code intel: API routes from the bundles (not from the HTML fallback page), hosts referenced by code / HTML
    expect(r.apiEndpoints).toEqual(['/api/health', '/api/launches/count', '/api/stats/overview', '/api/token/[mint]']);
    expect(r.codeHosts).toEqual(
      expect.arrayContaining(['api.unpegtest.io', 'auth.privy.io', 'ghost.unpegtest.io', 'indexer.unpegtest.io', 'mainnet.helius-rpc.com']),
    );
    expect(r.codeHosts).not.toContain('unpegtest.io');
    expect(r.codeHosts).not.toContain('x.com'); // a plain link, not code
    expect([...r.codeHosts].sort()).toEqual(r.codeHosts);

    // socials: canonical, deduped (x.com + twitter.com + twitter:site are one), share links ignored
    expect(r.socials).toEqual([
      { kind: 'docs', url: 'https://unpegtest.io/docs' },
      { kind: 'docs', url: 'https://docs.unpegtest.io/' },
      { kind: 'x', url: 'https://x.com/unpegtest' },
      { kind: 'telegram', url: 'https://t.me/unpegtest' },
      { kind: 'discord', url: 'https://discord.gg/unpeg' },
      { kind: 'github', url: 'https://github.com/unpegtest/contracts' },
      { kind: 'dexscreener', url: 'https://dexscreener.com/solana/5hd5o7cwebqwq7sxtktybf9n5a9abae8jh1xbq31aedk' },
    ]);
    expect(r.links).toEqual({ internal: 5, external: 7 });

    // server
    expect(r.server).toEqual({ server: 'Vercel', poweredBy: 'Next.js', ips: ['76.76.21.21'] });

    // subdomains: DNS sweep + names from code and links, resolved for `alive`
    const subs = new Map(r.subdomains.map((s) => [s.host, s]));
    expect(subs.get('www.unpegtest.io')).toEqual({ host: 'www.unpegtest.io', sources: ['dns'], alive: true });
    expect(subs.get('app.unpegtest.io')).toEqual({ host: 'app.unpegtest.io', sources: ['dns', 'link'], alive: true });
    expect(subs.get('api.unpegtest.io')).toEqual({ host: 'api.unpegtest.io', sources: ['dns', 'code'], alive: true });
    expect(subs.get('docs.unpegtest.io')).toEqual({ host: 'docs.unpegtest.io', sources: ['dns', 'link'], alive: true });
    expect(subs.get('indexer.unpegtest.io')).toEqual({ host: 'indexer.unpegtest.io', sources: ['code'], alive: true });
    expect(subs.get('ghost.unpegtest.io')).toEqual({ host: 'ghost.unpegtest.io', sources: ['code'], alive: false });
    expect(subs.has('unpegtest.io')).toBe(false);
    expect(subs.has('secret-staging.unpegtest.io')).toBe(false); // CT only in 'full' mode
    // alive first
    const firstDead = r.subdomains.findIndex((s) => !s.alive);
    expect(r.subdomains.slice(firstDead).every((s) => !s.alive)).toBe(true);

    expect(r.watched).toEqual({ id: watch.id, name: 'Unpeg', url: 'https://unpegtest.io/' });
  });

  it('caches per (url, mode) for 60 s, shares concurrent runs and fills `watched` per guild', async () => {
    web.sites.set('unpeg', unpegSite());
    store.createWatch({ guildId: 'g1', channelId: 'c1', name: 'Unpeg', url: 'https://unpegtest.io/docs', host: 'unpegtest.io', rootDomain: 'unpegtest.io', createdBy: 'u1' });
    const d = deps();

    const [a, b] = await Promise.all([
      scanSite(d, 'https://unpegtest.io', { guildId: 'g1' }),
      scanSite(d, 'unpegtest.io/', { guildId: 'g2' }),
    ]);
    expect(web.count('unpeg', '/')).toBe(1);
    expect(a.watched?.name).toBe('Unpeg'); // same host (the watch is scoped to /docs)
    expect(b.watched).toBeNull();
    expect(b.scannedAt).toBe(a.scannedAt);

    clock.now += 30_000;
    const c = await scanSite(d, 'unpegtest.io', { guildId: 'g1' });
    expect(web.count('unpeg', '/')).toBe(1);
    expect(c.scannedAt).toBe(a.scannedAt);
    c.tech.length = 0; // callers get copies
    expect((await scanSite(d, 'unpegtest.io', { guildId: 'g1' })).tech.length).toBeGreaterThan(0);

    await scanSite(d, 'unpegtest.io', { guildId: 'g1', subdomains: 'none' });
    expect(web.count('unpeg', '/')).toBe(2); // another mode, another key

    clock.now += 31_000;
    const e = await scanSite(d, 'unpegtest.io', { guildId: 'g1' });
    expect(web.count('unpeg', '/')).toBe(3);
    expect(e.scannedAt).not.toBe(a.scannedAt);
  });

  it("'full' adds Cert Spotter names; 'none' skips discovery; CT failures are skipped", async () => {
    web.sites.set('unpeg', unpegSite());
    const ct = fakeCt();
    const full = await scanSite(deps({ ct }), 'unpegtest.io', { guildId: 'g1', subdomains: 'full' });
    expect(ct.calls).toBe(1);
    const subs = new Map(full.subdomains.map((s) => [s.host, s]));
    expect(subs.get('secret-staging.unpegtest.io')).toEqual({ host: 'secret-staging.unpegtest.io', sources: ['ct'], alive: true });
    expect(subs.get('app.unpegtest.io')?.sources).toEqual(['dns', 'ct', 'link']);
    expect([...subs.keys()].some((h) => h.includes('evil'))).toBe(false);

    const quietCt = fakeCt();
    const none = await scanSite(deps({ ct: quietCt }), 'unpegtest.io', { guildId: 'g1', subdomains: 'none' });
    expect(none.subdomains).toEqual([]);
    expect(quietCt.calls).toBe(0);

    resetScanCache();
    const failing = fakeCt(async () => {
      throw new Error('Cert Spotter: HTTP 500');
    });
    const r = await scanSite(deps({ ct: failing }), 'unpegtest.io', { guildId: 'g1', subdomains: 'full' });
    expect(r.error).toBeNull();
    expect(r.subdomains.map((s) => s.host)).toContain('app.unpegtest.io');

    resetScanCache();
    const limited = fakeCt(async () => ({ names: ['late.unpegtest.io'], cursor: null, rateLimitedUntil: Date.now() + 3600_000 }));
    const l = await scanSite(deps({ ct: limited }), 'unpegtest.io', { guildId: 'g1', subdomains: 'full' });
    expect(l.subdomains.find((s) => s.host === 'late.unpegtest.io')).toEqual({ host: 'late.unpegtest.io', sources: ['ct'], alive: false });
  });

  it('drops wildcard DNS answers from the sweep but keeps names seen in code', async () => {
    web.sites.set('unpeg', unpegSite());
    const records = { ...DNS_RECORDS };
    delete records['www.unpegtest.io'];
    const r = await scanSite(deps({ dns: fakeDns(records, ['9.9.9.9']) }), 'unpegtest.io', { guildId: 'g1' });
    const subs = new Map(r.subdomains.map((s) => [s.host, s]));
    expect(subs.has('www.unpegtest.io')).toBe(false); // only the wildcard answers
    expect(subs.has('staging.unpegtest.io')).toBe(false);
    expect(subs.get('app.unpegtest.io')?.sources).toEqual(['dns', 'link']); // a real record
    expect(subs.get('ghost.unpegtest.io')).toEqual({ host: 'ghost.unpegtest.io', sources: ['code'], alive: true }); // resolves (via the wildcard)
  });

  it('follows redirects and reports the final URL', async () => {
    web.sites.set('apex', (path) => (path === '/' ? { status: 301, headers: { location: 'https://www.unpegtest.io/' } } : undefined));
    web.sites.set('unpeg', unpegSite());
    const r = await scanSite(deps({ hostMap: { 'unpegtest.io': 'apex', 'www.unpegtest.io': 'unpeg' } }), 'unpegtest.io', { guildId: 'g1' });
    expect(r.url).toBe('https://unpegtest.io/');
    expect(r.finalUrl).toBe('https://www.unpegtest.io/');
    expect(r.status).toBe(200);
    expect(r.title).toBe('Unpeg Test — Launch & trade');
    expect(r.server.ips).toEqual(['76.76.21.22']); // the final host answered
    expect(r.apiEndpoints).toContain('/api/launches/count');
    expect(r.subdomains.some((s) => s.host === 'www.unpegtest.io')).toBe(true);
  });
});

describe('scanSite — failures give partial results', () => {
  it('a bot-protection challenge: headers, DNS and subdomains only, no bundles', async () => {
    const challenge = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=8a"></script><script src="/_next/static/chunks/main-1a2b3c4d.js"></script></body></html>';
    web.sites.set('cf', (path) =>
      path === '/'
        ? { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge', 'cf-ray': '8a1b2c-FRA', server: 'cloudflare' }, body: challenge }
        : { headers: { 'content-type': 'application/javascript' }, body: MAIN_JS },
    );
    const r = await scanSite(deps({ hostMap: { 'unpegtest.io': 'cf' } }), 'unpegtest.io', { guildId: 'g1' });
    expect(r.status).toBe(403);
    expect(r.blocked).toBe(true);
    expect(r.error).toMatch(/bot-protection/);
    expect(r.title).toBeNull();
    expect(r.build).toEqual({ id: null, assets: 0, generator: null });
    expect(r.apiEndpoints).toEqual([]);
    expect(web.count('cf', '/_next/static/chunks/main-1a2b3c4d.js')).toBe(0);
    const names = r.tech.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['Cloudflare', 'Cloudflare Bot Management']));
    expect(r.server.server).toBe('cloudflare');
    expect(r.server.ips).toEqual(['76.76.21.21']);
    expect(r.subdomains.map((s) => s.host)).toContain('app.unpegtest.io');
  });

  it('an unreachable site: status 0 with the network error', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const r = await scanSite(deps({ hostMap: { 'unpegtest.io': `http://127.0.0.1:${port}` } }), 'unpegtest.io', { guildId: 'g1', subdomains: 'none' });
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/ECONNREFUSED|fetch failed|connect/i);
    expect(r.title).toBeNull();
    expect(r.tech).toEqual([]);
    expect(r.finalUrl).toBe('https://unpegtest.io/');
    expect(r.server.ips).toEqual(['76.76.21.21']);
  });

  it('a host that does not resolve still returns a result', async () => {
    const r = await scanSite(deps({ hostMap: {} }), 'nothing-here.example', { guildId: 'g1' });
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/ENOTFOUND|fetch failed/);
    expect(r.server.ips).toEqual([]);
  });

  it('HTTP errors are reported but the page is still read', async () => {
    web.sites.set('err', (path) =>
      path === '/' ? { status: 500, headers: { 'content-type': 'text/html' }, body: '<html><head><title>Oops</title><meta name="generator" content="WordPress 6.5.2"></head></html>' } : undefined,
    );
    const r = await scanSite(deps({ hostMap: { 'unpegtest.io': 'err' } }), 'unpegtest.io', { guildId: 'g1', subdomains: 'none' });
    expect(r.status).toBe(500);
    expect(r.error).toBe('HTTP 500');
    expect(r.title).toBe('Oops');
    expect(r.tech.find((t) => t.name === 'WordPress')?.version).toBe('6.5.2');
  });

  it('returns within the budget with what it has when bundles are slow', async () => {
    web.sites.set('slow', (path) => {
      if (path === '/') return { headers: { 'content-type': 'text/html', server: 'Vercel' }, body: HOME };
      return { headers: { 'content-type': 'application/javascript' }, body: MAIN_JS, delayMs: 4000 };
    });
    const t = Date.now();
    const r = await scanSite(deps({ hostMap: { 'unpegtest.io': 'slow' } }), 'unpegtest.io', { guildId: 'g1', budgetMs: 2000 });
    const took = Date.now() - t;
    expect(took).toBeLessThan(3500);
    expect(r.status).toBe(200);
    expect(r.title).toBe('Unpeg Test — Launch & trade');
    expect(r.build.id).toBe(BUILD_ID);
    expect(r.apiEndpoints).toEqual([]); // the bundles never arrived
    expect(r.tech.map((t) => t.name)).toContain('Next.js');
  });

  it('refuses private / internal hosts up front — nothing is fetched or resolved — unless ALLOW_PRIVATE_NETWORK', async () => {
    const dns = fakeDns({ 'postgres.railway.internal': ['10.250.0.7'], localhost: ['127.0.0.1'] });
    const strict = deps({ config: testConfig({ allowPrivateNetwork: false }), dns, hostMap: {} });
    for (const target of [
      'localhost:3000',
      'http://127.0.0.1/',
      '10.0.0.5',
      '192.168.1.1/admin',
      '169.254.169.254/latest/meta-data',
      'http://[::1]:8080/',
      'postgres.railway.internal',
      'printer.local',
      'app.localhost',
    ]) {
      await expect(scanSite(strict, target, { guildId: 'g1' })).rejects.toMatchObject({
        name: 'ScanInputError',
        code: 'invalid_url',
        message: expect.stringMatching(/private or internal address/),
      });
    }
    expect(dns.calls).toEqual([]);
    expect(web.hits.size).toBe(0);

    // Self-hosting / tests (testConfig allows private networks): the same host is scanned normally.
    web.sites.set('local', () => ({ headers: { 'content-type': 'text/html' }, body: '<title>Local</title>' }));
    const r = await scanSite(deps({ hostMap: { localhost: 'local' } }), 'http://localhost/', { guildId: 'g1', subdomains: 'none' });
    expect(r.title).toBe('Local');
  });

  it('a public name that resolves to a private address is not fetched and says so', async () => {
    let fetched = 0;
    const http = new HttpClient({
      userAgent: 'test',
      globalConcurrency: 4,
      perHostConcurrency: 2,
      timeoutMs: 2000,
      maxBytes: 1024 * 1024,
      allowPrivate: false,
      lookup: async () => [{ address: '10.1.2.3', family: 4 }],
      fetch: async () => {
        fetched++;
        throw new Error('must not be called');
      },
    });
    const r = await scanSite(deps({ http, config: testConfig({ allowPrivateNetwork: false }) }), 'intranet.unpegtest.io', {
      guildId: 'g1',
      subdomains: 'none',
    });
    expect(fetched).toBe(0);
    expect(r.status).toBe(0);
    expect(r.error).toBe('The site resolves to a private or internal network address, so the bot did not fetch it.');
  });

  it('caps page-provided strings and keeps only http(s) image / social URLs', async () => {
    const longTitle = 'T'.repeat(5000);
    const longDesc = 'D'.repeat(5000);
    const longGh = 'g'.repeat(400);
    web.sites.set('hostile', () => ({
      headers: { 'content-type': 'text/html' },
      body:
        `<html><head><title>${longTitle}</title><meta name="description" content="${longDesc}">` +
        `<meta property="og:image" content="javascript:alert(1)"></head><body>` +
        `<a href="https://github.com/${longGh}">gh</a><a href="https://t.me/unpegtest">tg</a></body></html>`,
    }));
    const r = await scanSite(deps({ hostMap: { 'unpegtest.io': 'hostile' } }), 'unpegtest.io', { guildId: 'g1', subdomains: 'none' });
    expect(r.title).toHaveLength(300);
    expect(r.title?.endsWith('…')).toBe(true);
    expect(r.description).toHaveLength(500);
    expect(r.ogImage).toBeNull();
    expect(r.socials).toEqual([{ kind: 'telegram', url: 'https://t.me/unpegtest' }]);
  });

  it('rejects input that is not a website URL', async () => {
    for (const bad of ['', '   ', 'not a url', 'ftp://unpegtest.io', 'javascript:alert(1)', 'localhost-without-dot']) {
      await expect(scanSite(deps(), bad, { guildId: 'g1' })).rejects.toBeInstanceOf(ScanInputError);
    }
    await expect(scanSite(deps(), 'not a url', { guildId: 'g1' })).rejects.toMatchObject({ code: 'invalid_url', message: expect.stringMatching(/website URL/) });
    expect(web.hits.size).toBe(0);
  });
});
