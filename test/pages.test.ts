import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { testConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { applyIgnorePatterns, sha1 } from '../src/diff/text.js';
import { looksLikeHtml, parseHtml } from '../src/extract/html.js';
import { normalizeUrl } from '../src/extract/url.js';
import { silentLogger } from '../src/log.js';
import type { DnsProvider } from '../src/net/dns.js';
import { HttpClient } from '../src/net/http.js';
import type { CheckContext, HomeSnapshot } from '../src/monitor/context.js';
import {
  DISCOVERY_FETCHES_FULL,
  DISCOVERY_FETCHES_NORMAL,
  DYNAMIC_RESET_MS,
  GONE_RECHECK_MS,
  STALE_BACKFILL_PER_PASS,
  checkPages,
  isOpaqueIdUrl,
  resetPagesWarnings,
  type PagesCheckResult,
} from '../src/monitor/pages.js';
import { alignNumbers, groupChanges, pageDiff } from '../src/monitor/pages-text.js';
import type { CtProvider } from '../src/monitor/subdomains.js';
import type {
  InfoAlert,
  NewPagesAlert,
  NewWatchInput,
  RemovedPagesAlert,
  TextAlert,
  TextChange,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Fake site (node:http on 127.0.0.1, mutable content)
// ---------------------------------------------------------------------------

interface Reply {
  status?: number;
  body?: string;
  type?: string;
  headers?: Record<string, string>;
  /** Redirect target (status defaults to 302). */
  location?: string;
  /** Serve a strong ETag and honour If-None-Match. */
  etag?: boolean;
}

interface PageModel {
  title: string;
  paras?: string[];
  links?: string[];
  head?: string;
}

class FakeSite {
  private readonly routes = new Map<string, () => Reply>();
  private readonly hits = new Map<string, number>();
  private readonly server = http.createServer((req, res) => this.handle(req, res));
  /** Shared footer rendered on every html() page (for site-wide edits). */
  footer = 'Contact us';
  base = '';
  stopped = false;

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  url(path: string): string {
    return normalizeUrl(this.base + path) as string;
  }

  count(path: string): number {
    return this.hits.get(path) ?? 0;
  }

  set(path: string, reply: Reply | (() => Reply)): void {
    this.routes.set(path, typeof reply === 'function' ? reply : () => reply);
  }

  delete(path: string): void {
    this.routes.delete(path);
  }

  /** An HTML page rendered from a (possibly changing) model. */
  html(path: string, model: PageModel | (() => PageModel), extra: Omit<Reply, 'body'> = {}): void {
    this.set(path, () => ({ ...extra, body: render(typeof model === 'function' ? model() : model, this.footer) }));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const key = req.url ?? '/';
    this.hits.set(key, (this.hits.get(key) ?? 0) + 1);
    const route = this.routes.get(key);
    const r: Reply = route ? route() : { status: 404, body: render({ title: 'Not found', paras: ['This page could not be found.'] }, '') };
    if (r.location) {
      res.writeHead(r.status ?? 302, { location: r.location });
      res.end();
      return;
    }
    const body = r.body ?? '';
    const headers: Record<string, string> = { 'content-type': r.type ?? 'text/html; charset=utf-8', ...r.headers };
    if (r.etag) {
      const tag = `"${sha1(body)}"`;
      headers.etag = tag;
      if (req.headers['if-none-match'] === tag) {
        res.writeHead(304, { etag: tag });
        res.end();
        return;
      }
    }
    res.writeHead(r.status ?? 200, headers);
    res.end(body);
  }
}

function render(m: PageModel, footer: string): string {
  const links = (m.links ?? []).map((l) => `<li><a href="${l}">Go to ${l}</a></li>`).join('');
  const paras = (m.paras ?? []).map((p) => `<p>${p}</p>`).join('');
  return `<!doctype html><html><head><title>${m.title}</title>${m.head ?? ''}</head><body>
<header><ul>${links}</ul></header><main>${paras}</main><footer><p>${footer}</p></footer></body></html>`;
}

function randomLetters(n: number): string {
  return [...randomBytes(n)].map((b) => String.fromCharCode(97 + (b % 26))).join('');
}

// ---------------------------------------------------------------------------
// Harness: real Store(':memory:') + real HttpClient + fake clock
// ---------------------------------------------------------------------------

interface Env {
  site: FakeSite;
  store: Store;
  ctx: CheckContext;
  clock: { t: number };
}

const envs: Env[] = [];

afterEach(async () => {
  for (const env of envs.splice(0)) {
    await env.site.stop();
    try {
      env.store.close();
    } catch {
      // already closed by the test
    }
  }
});

async function setup(site: FakeSite, input: Partial<NewWatchInput> = {}, startPath = '/'): Promise<Env> {
  if (!site.base) await site.start();
  const store = new Store(':memory:');
  const watch = store.createWatch({
    guildId: 'g1',
    channelId: 'c1',
    name: 'Test',
    url: site.url(startPath),
    host: '127.0.0.1',
    rootDomain: '127.0.0.1',
    createdBy: 'tester',
    intervalSec: 30,
    sweepSec: 120,
    ...input,
  });
  const client = new HttpClient({
    userAgent: 'pages-test',
    globalConcurrency: 16,
    perHostConcurrency: 8,
    timeoutMs: 5000,
    maxBytes: 5 * 1024 * 1024,
    allowPrivate: true,
  });
  const clock = { t: 1_800_000_000_000 };
  const ctx: CheckContext = {
    watch,
    state: store.getState(watch.id),
    store,
    http: client,
    config: testConfig({ confirmDelayMs: 0 }),
    log: silentLogger,
    providers: { ct: {} as CtProvider, dns: {} as DnsProvider },
    now: () => clock.t,
    sleep: async () => {},
    baseline: false,
  };
  const env = { site, store, ctx, clock };
  envs.push(env);
  return env;
}

/** What the scheduler does before calling checkPages: a plain GET of watch.url, parsed when it is 2xx HTML. */
async function homeSnap(env: Env): Promise<HomeSnapshot> {
  const fetch = await env.ctx.http.fetch(env.ctx.watch.url, { ignoreBackoff: true });
  const parsed =
    fetch.ok && !fetch.blocked && fetch.bodyText !== null && looksLikeHtml(fetch.contentType, fetch.bodyText)
      ? parseHtml(fetch.bodyText, fetch.finalUrl)
      : null;
  return { fetch, parsed };
}

async function runBaseline(env: Env, opts: { home?: boolean } = {}): Promise<PagesCheckResult> {
  env.ctx.baseline = true;
  try {
    return await checkPages(env.ctx, { home: opts.home === false ? null : await homeSnap(env), full: true });
  } finally {
    env.ctx.baseline = false;
    env.ctx.state.baselineAt = env.clock.t;
  }
}

async function pass(
  env: Env,
  opts: { home?: boolean; full?: boolean; extraPaths?: string[]; advanceMs?: number } = {},
): Promise<PagesCheckResult> {
  env.clock.t += opts.advanceMs ?? 121_000;
  const home = opts.home === false ? null : await homeSnap(env);
  return checkPages(env.ctx, { home, full: opts.full ?? false, extraPaths: opts.extraPaths });
}

const textAlerts = (r: PagesCheckResult) => r.alerts.filter((a): a is TextAlert => a.kind === 'text');
const newPageAlerts = (r: PagesCheckResult) => r.alerts.filter((a): a is NewPagesAlert => a.kind === 'new_pages');
const removedAlerts = (r: PagesCheckResult) => r.alerts.filter((a): a is RemovedPagesAlert => a.kind === 'removed_pages');
const infoAlerts = (r: PagesCheckResult) => r.alerts.filter((a): a is InfoAlert => a.kind === 'info');

/** A small static site: home → about, docs → docs/a, plus a PDF. */
function smallSite(): FakeSite {
  const site = new FakeSite();
  site.html('/', { title: 'Home', paras: ['Welcome to the site.', 'We build things.'], links: ['/about', '/docs', '/whitepaper.pdf'] });
  site.html('/about', { title: 'About', paras: ['We are a small team.', 'Old line'], links: ['/'] });
  site.html('/docs', { title: 'Docs', paras: ['Documentation index.'], links: ['/docs/a'] });
  site.html('/docs/a', { title: 'Doc A', paras: ['First doc page.'], links: ['/docs'] });
  site.set('/whitepaper.pdf', { body: '%PDF-1.4 fake', type: 'application/pdf' });
  return site;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkPages: baseline', () => {
  it('records pages, files and hosts silently', async () => {
    const site = smallSite();
    site.html('/', {
      title: 'Home',
      paras: ['Welcome to the site.'],
      links: ['/about', '/docs', '/whitepaper.pdf', 'https://twitter.com/someone', 'https://files.other-site.io/deck.pdf'],
      head: '<script src="https://cdn.assets-host.io/app.js"></script>',
    });
    const env = await setup(site);
    const r = await runBaseline(env);

    expect(r.alerts).toEqual([]);
    const pages = env.store.listPages(env.ctx.watch.id, { kind: 'page' });
    expect(pages.map((p) => p.url).sort()).toEqual([site.url('/'), site.url('/about'), site.url('/docs'), site.url('/docs/a')].sort());
    for (const p of pages) {
      expect(p.tracked).toBe(true);
      expect(p.textHash).toMatch(/^[0-9a-f]{40}$/);
      expect(p.text).toBeTruthy();
      expect(p.status).toBe(200);
    }
    const home = env.store.getPage(env.ctx.watch.id, site.url('/'))!;
    expect(home.source).toBe('start');
    expect(home.depth).toBe(0);
    const docA = env.store.getPage(env.ctx.watch.id, site.url('/docs/a'))!;
    expect(docA.source).toBe('link');
    expect(docA.depth).toBe(2);
    expect(docA.title).toBe('Doc A');
    expect(docA.text).toContain('First doc page.');

    const files = env.store.listPages(env.ctx.watch.id, { kind: 'file' });
    expect(files.map((f) => f.url)).toEqual([site.url('/whitepaper.pdf')]);
    expect(files[0].tracked).toBe(true);
    expect(files[0].textHash).toBeNull();

    expect(r.hosts).toContain('127.0.0.1');
    expect(r.hosts).toContain('twitter.com');
    expect(r.hosts).toContain('cdn.assets-host.io');
    expect(r.hosts).toContain('files.other-site.io');
    expect(env.ctx.state.sitemapLastScan).toBe(env.clock.t);
  });

  it('does not create file rows when features.files is off', async () => {
    const env = await setup(smallSite(), { features: { files: false } });
    await runBaseline(env);
    expect(env.store.countPages(env.ctx.watch.id, { kind: 'file' })).toBe(0);
    expect(env.store.countPages(env.ctx.watch.id, { kind: 'page' })).toBe(4);
  });

  it('records the start page even when the home snapshot is null / non-2xx', async () => {
    const site = smallSite();
    const env = await setup(site);
    const r1 = await runBaseline(env, { home: false });
    expect(r1.alerts).toEqual([]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/'))?.textHash).toBeTruthy();

    // A 503 snapshot: skipped without state damage.
    site.set('/', { status: 503, body: 'down' });
    const snap = await homeSnap(env);
    env.clock.t += 121_000;
    const r2 = await checkPages(env.ctx, { home: snap, full: false });
    expect(r2.alerts).toEqual([]);
    const home = env.store.getPage(env.ctx.watch.id, site.url('/'))!;
    expect(home.status).toBe(503);
    expect(home.textHash).toBeTruthy();
    expect(home.gone).toBe(false);
  });
});

describe('checkPages: stability', () => {
  it('a stable site produces zero alerts over 5 passes', async () => {
    const env = await setup(smallSite());
    await runBaseline(env);
    for (let i = 0; i < 5; i++) {
      const r = await pass(env);
      expect(r.alerts).toEqual([]);
    }
  });

  it('a real Next.js app-router site (fixtures) is stable and fully discovered', async () => {
    const homeHtml = readFileSync(new URL('./fixtures/nextjs-app-home.html', import.meta.url), 'utf8');
    const docsHtml = readFileSync(new URL('./fixtures/nextjs-app-docs.html', import.meta.url), 'utf8');
    const site = new FakeSite();
    site.set('/', { body: homeHtml });
    for (const p of ['/docs', '/docs/api', '/docs/brand', '/docs/faq', '/docs/guides', '/docs/how-it-works', '/docs/markets',
      '/docs/notes', '/docs/oracle', '/docs/risks', '/docs/terms']) {
      site.set(p, { body: docsHtml });
    }
    site.set('/whitepaper.pdf', { body: '%PDF-1.7', type: 'application/pdf' });
    const env = await setup(site);
    const b = await runBaseline(env);
    expect(b.alerts).toEqual([]);
    const known = env.store.knownUrls(env.ctx.watch.id);
    expect(known.has(site.url('/docs/risks'))).toBe(true);
    expect(known.has(site.url('/docs/oracle'))).toBe(true);
    expect(known.has(site.url('/whitepaper.pdf'))).toBe(true);
    // /app is linked but 404 here: known, untracked.
    const app = env.store.getPage(env.ctx.watch.id, site.url('/app'))!;
    expect(app.tracked).toBe(false);
    expect(app.status).toBe(404);
    // Asset-like links are never pages.
    expect([...known].some((u) => u.includes('/_next/'))).toBe(false);

    for (let i = 0; i < 5; i++) {
      const r = await pass(env);
      expect(r.alerts).toEqual([]);
    }
  });

  it('uses the home snapshot instead of re-fetching the start URL', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    const before = site.count('/');
    await pass(env);
    // Only homeSnap() fetched "/".
    expect(site.count('/')).toBe(before + 1);
  });
});

describe('checkPages: text changes', () => {
  it('a text edit on one page yields a TextAlert with a readable diff', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    site.html('/about', { title: 'About', paras: ['We are a small team.', 'New line'], links: ['/'] });

    const r = await pass(env);
    const [alert] = textAlerts(r);
    expect(r.alerts).toHaveLength(1);
    expect(alert.changes).toHaveLength(1);
    const change = alert.changes[0];
    expect(change.url).toBe(site.url('/about'));
    expect(change.title).toBe('About');
    expect(change.titleChange).toBeNull();
    expect(change.diff.unified).toContain('- Old line');
    expect(change.diff.unified).toContain('+ New line');
    expect(change.diff.removed).toEqual(['Old line']);
    expect(change.diff.added).toEqual(['New line']);
    expect(alert.groups).toEqual([{ hash: change.diff.hash, urls: [change.url], diff: change.diff }]);

    const rec = env.store.getPage(env.ctx.watch.id, site.url('/about'))!;
    expect(rec.text).toContain('New line');
    expect(rec.lastChanged).toBe(env.clock.t);
    expect(env.ctx.state.lastChangeAt).toBe(env.clock.t);

    expect((await pass(env)).alerts).toEqual([]);
  });

  it('reports a title change', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    site.html('/docs', { title: 'Documentation', paras: ['Documentation index.'], links: ['/docs/a'] });
    const [alert] = textAlerts(await pass(env));
    expect(alert.changes[0].titleChange).toEqual({ from: 'Docs', to: 'Documentation' });
    expect(alert.changes[0].title).toBe('Documentation');
  });

  it('detects a homepage change when no home snapshot is given (own fetch)', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env, { home: false });
    site.html('/', { title: 'Home', paras: ['Welcome to the site.', 'Big announcement!'], links: ['/about', '/docs', '/whitepaper.pdf'] });
    const [alert] = textAlerts(await pass(env, { home: false }));
    expect(alert.changes.map((c) => c.url)).toEqual([site.url('/')]);
    expect(alert.changes[0].diff.added).toEqual(['Big announcement!']);
  });

  it('an identical nav/footer edit on every page is one group with all urls', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    site.footer = 'Contact the team';

    const r = await pass(env);
    const [alert] = textAlerts(r);
    expect(alert.changes).toHaveLength(4);
    expect(alert.groups).toHaveLength(1);
    expect(alert.groups[0].urls.sort()).toEqual([site.url('/'), site.url('/about'), site.url('/docs'), site.url('/docs/a')].sort());
    expect(alert.groups[0].diff.unified).toContain('- Contact us');
    expect(alert.groups[0].diff.unified).toContain('+ Contact the team');
  });

  it('a transient change (confirm fetch returns the old text) is ignored', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    const original = { title: 'About', paras: ['We are a small team.', 'Old line'], links: ['/'] };
    let flash = true;
    site.html('/about', () => {
      if (flash) {
        flash = false;
        return { ...original, paras: ['We are a small team.', 'Flash sale!'] };
      }
      return original;
    });
    const hashBefore = env.store.getPage(env.ctx.watch.id, site.url('/about'))!.textHash;
    const hitsBefore = site.count('/about');

    const r = await pass(env);
    expect(r.alerts).toEqual([]);
    expect(site.count('/about')).toBe(hitsBefore + 2); // check + confirm
    const rec = env.store.getPage(env.ctx.watch.id, site.url('/about'))!;
    expect(rec.textHash).toBe(hashBefore);
    expect(rec.text).toContain('Old line');
    expect(rec.flapCount).toBe(0);
    expect((await pass(env)).alerts).toEqual([]);
  });

  it('a transient homepage change is confirmed with a re-fetch and ignored', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    const original = { title: 'Home', paras: ['Welcome to the site.', 'We build things.'], links: ['/about', '/docs', '/whitepaper.pdf'] };
    let flash = true;
    site.html('/', () => {
      if (flash) {
        flash = false;
        return { ...original, paras: ['Maintenance in progress'] };
      }
      return original;
    });
    const before = site.count('/');
    const r = await pass(env); // homeSnap sees the flash, checkPages re-fetches once
    expect(r.alerts).toEqual([]);
    expect(site.count('/')).toBe(before + 2);
  });

  it('ignorePatterns strip a changing line so it never alerts (and never shows in diffs)', async () => {
    const site = new FakeSite();
    let build = 'abcdef';
    let body = 'Status: all systems normal';
    site.html('/', () => ({ title: 'Status', paras: [`Build: ${build}`, body] }));
    const env = await setup(site, { ignorePatterns: ['^Build: [a-z]+$'] });
    await runBaseline(env);

    build = 'ghijkl';
    expect((await pass(env)).alerts).toEqual([]);
    build = 'mnopqr';
    expect((await pass(env)).alerts).toEqual([]);

    build = 'stuvwx';
    body = 'Status: degraded performance';
    const [alert] = textAlerts(await pass(env));
    expect(alert.changes[0].diff.unified).toContain('+ Status: degraded performance');
    expect(alert.changes[0].diff.unified).not.toContain('Build:');
  });

  it('an invalid ignore pattern is skipped without breaking the check', async () => {
    const site = smallSite();
    const env = await setup(site, { ignorePatterns: ['([unclosed'] });
    await runBaseline(env);
    expect((await pass(env)).alerts).toEqual([]);
    site.html('/about', { title: 'About', paras: ['We are a small team.', 'New line'], links: ['/'] });
    expect(textAlerts(await pass(env))).toHaveLength(1);
  });

  it('a blank 200 render is inconclusive, not "everything removed"', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    site.set('/about', { body: '<!doctype html><html><head></head><body></body></html>' });
    expect((await pass(env)).alerts).toEqual([]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/about'))!.text).toContain('Old line');
  });
});

describe('checkPages: noise handling', () => {
  it('a number ticker that changes on every request is auto-masked without text alerts (one info)', async () => {
    const site = smallSite();
    let n = 1000;
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/stats'] });
    site.html('/stats', () => ({ title: 'Stats', paras: [`Total value locked: $${(n++).toLocaleString('en-US')}.25`, 'Updated live'] }));
    const env = await setup(site);
    await runBaseline(env);

    const r1 = await pass(env);
    expect(r1.alerts).toEqual([
      { kind: 'info', message: 'ℹ️ /stats shows live numbers; ignoring number-only changes on the lines that tick.' },
    ]);
    const rec = env.store.getPage(env.ctx.watch.id, site.url('/stats'))!;
    expect(rec.maskedLines).toEqual(['Total value locked: $#']);
    expect(rec.maskNumbers).toBe(false);
    expect(rec.dynamic).toBe(false);
    for (let i = 0; i < 3; i++) expect((await pass(env)).alerts).toEqual([]);

    // A real edit on the masked page still alerts, and the diff is not polluted by old numbers.
    site.html('/stats', () => ({ title: 'Stats', paras: [`Total value locked: $${(n++).toLocaleString('en-US')}.25`, 'Updated hourly'] }));
    const [alert] = textAlerts(await pass(env));
    expect(alert.changes[0].diff.removed).toEqual(['Updated live']);
    expect(alert.changes[0].diff.added).toEqual(['Updated hourly']);
  });

  it('masking is per line: a live ticker line is ignored, a fee edit elsewhere on the page is still reported', async () => {
    const site = smallSite();
    let tvl = 1_000_000;
    let fee = '0.3%';
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/stats'] });
    site.html('/stats', () => ({ title: 'Stats', paras: [`TVL: $${(tvl++).toLocaleString('en-US')}`, `Fee: ${fee}`, 'Docs'] }));
    const env = await setup(site);
    await runBaseline(env);
    expect(textAlerts(await pass(env))).toEqual([]); // the ticker is learned
    for (let i = 0; i < 3; i++) expect((await pass(env)).alerts).toEqual([]);
    fee = '0.5%';
    expect((await pass(env)).alerts).toEqual([]); // held one check
    const [alert] = textAlerts(await pass(env));
    expect(alert.changes[0].diff.removed).toEqual(['Fee: 0.3%']);
    expect(alert.changes[0].diff.added).toEqual(['Fee: 0.5%']);
    for (let i = 0; i < 2; i++) expect((await pass(env)).alerts).toEqual([]);
  });

  it('a number that ticks between checks is masked silently after 3 observations (one info, no text alerts)', async () => {
    const site = smallSite();
    let price = 100;
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/price'] });
    site.html('/price', () => ({ title: 'Price', paras: [`Price: ${price} USD`] }));
    const env = await setup(site);
    await runBaseline(env);

    price = 101;
    const r1 = await pass(env); // held: maybe a real edit, maybe a ticker
    expect(r1.alerts).toEqual([]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/price'))!.pendingHash).toBeTruthy();

    price = 102;
    expect((await pass(env)).alerts).toEqual([]); // moved again before it could be reported

    price = 103;
    const r3 = await pass(env);
    expect(textAlerts(r3)).toHaveLength(0);
    const infos = infoAlerts(r3);
    expect(infos).toHaveLength(1);
    expect(infos[0].message).toBe('ℹ️ /price shows live numbers; ignoring number-only changes on the lines that tick.');
    const rec = env.store.getPage(env.ctx.watch.id, site.url('/price'))!;
    expect(rec.maskedLines).toEqual(['Price: # USD']);
    expect(rec.pendingHash).toBeNull();

    for (const p of [104, 105, 999]) {
      price = p;
      expect((await pass(env)).alerts).toEqual([]);
    }
  });

  it('a start page checked every 30s with a minute-granularity clock never alerts; a real number edit there still does', async () => {
    const site = smallSite();
    let fee = '0.3%';
    const minute = () => {
      const d = new Date(env.clock.t);
      return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    };
    site.html('/', () => ({
      title: 'Home',
      paras: [`mSOL −16 bps · 2026-09-28 ${minute()} UTC`, `JitoSOL −8 bps · 2026-09-28 ${minute()} UTC`, `Redemption fee: ${fee}`],
      links: ['/about'],
    }));
    const env = await setup(site);
    await runBaseline(env);
    let texts = 0;
    let infos = 0;
    for (let i = 0; i < 16; i++) {
      const r = await pass(env, { advanceMs: 30_000 });
      texts += textAlerts(r).length;
      infos += infoAlerts(r).length;
    }
    expect(texts).toBe(0);
    expect(infos).toBeLessThanOrEqual(1);

    fee = '0.5%';
    const found: TextAlert[] = [];
    for (let i = 0; i < 8; i++) found.push(...textAlerts(await pass(env, { advanceMs: 30_000 })));
    expect(found).toHaveLength(1);
    expect(found[0].changes[0].diff.added).toEqual(['Redemption fee: 0.5%']);
  });

  it('a single number edit that holds is reported one check later (exactly once)', async () => {
    const site = smallSite();
    let fee = '0.3%';
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/fees'] });
    site.html('/fees', () => ({ title: 'Fees', paras: [`Redemption fee: ${fee}`, 'Charged on withdrawal.'] }));
    const env = await setup(site);
    await runBaseline(env);

    fee = '0.5%';
    expect((await pass(env)).alerts).toEqual([]); // held for one check
    const r2 = await pass(env);
    const [alert] = textAlerts(r2);
    expect(alert.changes[0].diff.removed).toEqual(['Redemption fee: 0.3%']);
    expect(alert.changes[0].diff.added).toEqual(['Redemption fee: 0.5%']);
    expect(alert.changes[0].diff.numericOnly).toBe(true);
    for (let i = 0; i < 3; i++) expect((await pass(env)).alerts).toEqual([]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/fees'))!.maskedLines).toEqual([]);
  });

  it('numeric changes spread beyond the window do not trigger masking', async () => {
    const site = smallSite();
    let price = 100;
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/price'] });
    site.html('/price', () => ({ title: 'Price', paras: [`Price: ${price} USD`] }));
    const env = await setup(site);
    await runBaseline(env);
    for (let i = 1; i <= 4; i++) {
      price = 100 + i;
      expect((await pass(env, { advanceMs: 4 * 60 * 60 * 1000 })).alerts).toEqual([]); // held
      const r = await pass(env);
      expect(textAlerts(r)).toHaveLength(1);
      expect(infoAlerts(r)).toHaveLength(0);
    }
    expect(env.store.getPage(env.ctx.watch.id, site.url('/price'))!.maskedLines).toEqual([]);
  });

  it('held numbers that go back to the stored ones are forgotten silently', async () => {
    const site = smallSite();
    let n = 7;
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/count'] });
    site.html('/count', () => ({ title: 'Count', paras: [`Open positions: ${n}`] }));
    const env = await setup(site);
    await runBaseline(env);
    n = 8;
    expect((await pass(env)).alerts).toEqual([]);
    n = 7;
    expect((await pass(env)).alerts).toEqual([]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/count'))!.pendingHash).toBeNull();
    expect((await pass(env)).alerts).toEqual([]);
  });

  it('relative times ("59 minutes ago" → "1 hour ago") are never a change, also for pages stored before the rule', async () => {
    const site = smallSite();
    let ago = '59 minutes ago';
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/news'] });
    site.html('/news', () => ({ title: 'News', paras: [`Launch recap · posted ${ago}`] }));
    const env = await setup(site);
    await runBaseline(env);
    // A row hashed by an older version (raw relative time in the hash) is re-hashed silently, not reported.
    const rec = env.store.getPage(env.ctx.watch.id, site.url('/news'))!;
    env.store.upsertPage({ ...rec, textHash: sha1(applyIgnorePatterns(rec.text!, [])) });
    ago = '1 hour ago';
    expect((await pass(env)).alerts).toEqual([]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/news'))!.textHash).not.toBe(sha1(applyIgnorePatterns(rec.text!, [])));
    ago = '3h ago';
    expect((await pass(env)).alerts).toEqual([]);
    expect((await pass(env)).alerts).toEqual([]);
  });

  it('a random token on every load marks the page dynamic after 3 passes with one info alert', async () => {
    const site = smallSite();
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/session', '/about'] });
    site.html('/session', () => ({ title: 'Session', paras: ['Your session', `Token: ${randomLetters(16)}`] }));
    const env = await setup(site);
    await runBaseline(env);

    let infos = 0;
    for (let i = 1; i <= 3; i++) {
      const r = await pass(env);
      expect(textAlerts(r)).toHaveLength(0);
      infos += infoAlerts(r).length;
      const rec = env.store.getPage(env.ctx.watch.id, site.url('/session'))!;
      expect(rec.flapCount).toBe(i);
      expect(rec.dynamic).toBe(i >= 3);
      if (i === 3) {
        expect(infoAlerts(r)[0].message).toBe(
          'ℹ️ /session changes on every load; ignoring its text. Use /watch ignore to filter the changing part.',
        );
      }
    }
    expect(infos).toBe(1);
    for (let i = 0; i < 3; i++) expect((await pass(env)).alerts).toEqual([]);
  });

  it('dynamic pages are still crawled for links', async () => {
    const site = smallSite();
    const links = ['/'];
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/session'] });
    site.html('/session', () => ({ title: 'Session', paras: [`Token: ${randomLetters(16)}`], links }));
    const env = await setup(site);
    await runBaseline(env);
    for (let i = 0; i < 3; i++) await pass(env);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/session'))!.dynamic).toBe(true);

    links.push('/secret-launch');
    site.html('/secret-launch', { title: 'Launch', paras: ['Coming now'] });
    const [np] = newPageAlerts(await pass(env));
    expect(np.pages.map((p) => p.url)).toEqual([site.url('/secret-launch')]);
  });

  it('never stores validators of unaccepted content (a 304 cannot hide a change)', async () => {
    const site = smallSite();
    const oldModel = { title: 'About', paras: ['We are a small team.', 'Old line'], links: ['/'] };
    const newModel = { title: 'About', paras: ['We are a small team.', 'New line'], links: ['/'] };
    let mode: 'old' | 'flash' | 'new' = 'old';
    site.html(
      '/about',
      () => {
        if (mode === 'flash') {
          mode = 'old';
          return newModel;
        }
        return mode === 'new' ? newModel : oldModel;
      },
      { etag: true },
    );
    const env = await setup(site);
    await runBaseline(env);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/about'))!.etag).toMatch(/^"/);

    // Unchanged → 304 path.
    expect((await pass(env)).alerts).toEqual([]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/about'))!.status).toBe(304);

    // New content seen once, confirm fetch serves the old version → transient.
    mode = 'flash';
    expect((await pass(env)).alerts).toEqual([]);

    // Now the new version is live for real: a stored etag of the flash would 304 here and hide it.
    mode = 'new';
    const [alert] = textAlerts(await pass(env));
    expect(alert.changes[0].diff.added).toEqual(['New line']);
    expect((await pass(env)).alerts).toEqual([]);
  });
});

describe('checkPages: new & removed pages', () => {
  it('a newly linked page yields a NewPagesAlert with its title', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    site.html('/', { title: 'Home', paras: ['Welcome to the site.', 'We build things.'], links: ['/about', '/docs', '/whitepaper.pdf', '/airdrop'] });
    site.html('/airdrop', { title: 'Airdrop Season 1', paras: ['Claim now'] });

    const r = await pass(env);
    const alerts = newPageAlerts(r);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].pages).toEqual([{ url: site.url('/airdrop'), title: 'Airdrop Season 1', source: 'link' }]);
    // The homepage text changed too (new nav link).
    expect(textAlerts(r)).toHaveLength(1);

    const rec = env.store.getPage(env.ctx.watch.id, site.url('/airdrop'))!;
    expect(rec.tracked).toBe(true);
    expect(rec.depth).toBe(1);
    expect(rec.textHash).toBeTruthy();
    expect(env.ctx.state.lastChangeAt).toBe(env.clock.t);
    expect((await pass(env)).alerts).toEqual([]);
  });

  it('a page that 404s twice is reported removed once, and returns silently', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    site.delete('/about');

    const r1 = await pass(env);
    expect(r1.alerts).toEqual([]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/about'))!.failCount).toBe(1);

    const r2 = await pass(env);
    expect(removedAlerts(r2)).toEqual([{ kind: 'removed_pages', pages: [{ url: site.url('/about'), status: 404 }] }]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/about'))!.gone).toBe(true);

    expect((await pass(env)).alerts).toEqual([]);

    // Removed pages are re-checked hourly, not on every sweep.
    const hits = site.count('/about');
    await pass(env);
    expect(site.count('/about')).toBe(hits);

    site.html('/about', { title: 'About', paras: ['We are a small team.', 'Old line'], links: ['/'] });
    expect((await pass(env, { advanceMs: GONE_RECHECK_MS })).alerts).toEqual([]);
    const rec = env.store.getPage(env.ctx.watch.id, site.url('/about'))!;
    expect(rec.gone).toBe(false);
    expect(rec.failCount).toBe(0);
  });

  it('a 5xx does not count towards removal', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    site.set('/about', { status: 404, body: 'nope' });
    await pass(env);
    site.set('/about', { status: 502, body: 'bad gateway' });
    expect((await pass(env)).alerts).toEqual([]);
    const rec = env.store.getPage(env.ctx.watch.id, site.url('/about'))!;
    expect(rec.failCount).toBe(1);
    expect(rec.status).toBe(502);
  });

  it('maxPages caps tracked pages; the rest are known but untracked, and promoted when the cap is raised', async () => {
    const site = new FakeSite();
    const kids = ['/p1', '/p2', '/p3', '/p4', '/p5'];
    site.html('/', { title: 'Home', paras: ['Welcome'], links: kids });
    for (const k of kids) site.html(k, { title: `Page ${k}`, paras: [`Content of ${k}`] });
    const env = await setup(site, { maxPages: 3 });
    await runBaseline(env);

    const id = env.ctx.watch.id;
    expect(env.store.countPages(id, { kind: 'page', tracked: true })).toBe(3);
    expect(env.store.countPages(id, { kind: 'page', tracked: false })).toBe(3);
    const untracked = env.store.listPages(id, { kind: 'page', tracked: false });
    for (const u of untracked) {
      expect(u.text).toBeNull();
      expect(u.textHash).toBeNull();
      expect(u.title).toMatch(/^Page \/p\d$/);
      expect(u.status).toBe(200);
    }
    expect((await pass(env)).alerts).toEqual([]);

    env.ctx.watch = env.store.updateWatch(id, { maxPages: 10 });
    expect((await pass(env)).alerts).toEqual([]);
    expect(env.store.countPages(id, { kind: 'page', tracked: true })).toBe(6);
    for (const p of env.store.listPages(id, { kind: 'page' })) expect(p.textHash).toBeTruthy();
    expect((await pass(env)).alerts).toEqual([]);

    env.ctx.watch = env.store.updateWatch(id, { maxPages: 2 });
    expect((await pass(env)).alerts).toEqual([]);
    expect(env.store.countPages(id, { kind: 'page', tracked: true })).toBe(2);
    expect(env.store.getPage(id, site.url('/'))!.tracked).toBe(true);
  });

  it('scopePath limits the crawl', async () => {
    const site = new FakeSite();
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/docs', '/about', '/docsx'] });
    site.html('/docs', { title: 'Docs', paras: ['Docs'], links: ['/docs/a', '/pricing'] });
    site.html('/docs/a', { title: 'A', paras: ['A'] });
    site.html('/about', { title: 'About', paras: ['About'] });
    site.html('/docsx', { title: 'X', paras: ['X'] });
    site.html('/pricing', { title: 'Pricing', paras: ['Pricing'] });
    const env = await setup(site, { scopePath: '/docs' });
    await runBaseline(env);
    const known = [...env.store.knownUrls(env.ctx.watch.id)].sort();
    expect(known).toEqual([site.url('/'), site.url('/docs'), site.url('/docs/a')].sort());
  });

  it('excludePatterns are honoured (also for files) and invalid ones ignored', async () => {
    const site = new FakeSite();
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/public', '/private/area', '/private-report.pdf', '/ok.pdf'] });
    site.html('/public', { title: 'Public', paras: ['Hi'] });
    site.html('/private/area', { title: 'Private', paras: ['Secret'] });
    const env = await setup(site, { excludePatterns: ['/private', '(broken'] });
    await runBaseline(env);
    const known = [...env.store.knownUrls(env.ctx.watch.id)].sort();
    expect(known).toEqual([site.url('/'), site.url('/ok.pdf'), site.url('/public')].sort());
  });

  it('an excluded tracked page is demoted when the pattern is added later', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    env.ctx.watch = env.store.updateWatch(env.ctx.watch.id, { excludePatterns: ['/about$'] });
    await pass(env);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/about'))!.tracked).toBe(false);
    site.delete('/about');
    expect((await pass(env)).alerts).toEqual([]);
    expect((await pass(env)).alerts).toEqual([]);
  });

  it('query-string links are ignored', async () => {
    const site = smallSite();
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/about', '/search?q=x', '/list?page=2', '/about?utm_source=x'] });
    site.html('/search?q=x', { title: 'Search', paras: ['results'] });
    const env = await setup(site);
    await runBaseline(env);
    const known = [...env.store.knownUrls(env.ctx.watch.id)];
    expect(known.some((u) => u.includes('?'))).toBe(false);
    expect(known).toContain(site.url('/about'));
  });

  it('discovers sitemap-only pages (silently at baseline, announced later)', async () => {
    const site = smallSite();
    const locs = ['/hidden'];
    site.set('/sitemap.xml', () => ({
      type: 'application/xml',
      body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
        .map((l) => `<url><loc>${site.base}${l}</loc></url>`)
        .join('')}</urlset>`,
    }));
    site.html('/hidden', { title: 'Hidden', paras: ['Not linked anywhere'] });
    const env = await setup(site);
    await runBaseline(env);
    const hidden = env.store.getPage(env.ctx.watch.id, site.url('/hidden'))!;
    expect(hidden.source).toBe('sitemap');
    expect(hidden.depth).toBe(1);
    expect(hidden.tracked).toBe(true);

    locs.push('/stealth-drop');
    site.html('/stealth-drop', { title: 'Stealth', paras: ['Shh'] });
    // Not due yet (sitemap interval 600s).
    expect((await pass(env)).alerts).toEqual([]);
    const r = await pass(env, { advanceMs: 600_000 });
    expect(newPageAlerts(r)).toEqual([
      { kind: 'new_pages', pages: [{ url: site.url('/stealth-drop'), title: 'Stealth', source: 'sitemap' }] },
    ]);
  });

  it('a large sitemap dump after baseline is recorded silently (backfill, not news)', async () => {
    const site = smallSite();
    const locs: string[] = [];
    site.set('/sitemap.xml', () => ({
      type: 'application/xml',
      status: locs.length ? 200 : 500,
      body: `<urlset>${locs.map((l) => `<url><loc>${site.base}${l}</loc></url>`).join('')}</urlset>`,
    }));
    for (let i = 0; i < 80; i++) site.html(`/post-${i}`, { title: `Post ${i}`, paras: [`Post body ${i}`] });
    const env = await setup(site);
    await runBaseline(env); // sitemap failed (500) at baseline

    for (let i = 0; i < 80; i++) locs.push(`/post-${i}`);
    for (let i = 0; i < 4; i++) {
      const r = await pass(env, { advanceMs: 600_000 });
      expect(newPageAlerts(r)).toEqual([]);
    }
    expect(env.store.getPage(env.ctx.watch.id, site.url('/post-5'))).toBeDefined();
  });

  it('extraPaths from code intel: 200 → new page (source code), 404 → not recorded', async () => {
    const site = smallSite();
    site.html('/docs/points', { title: 'Points Program', paras: ['Earn points'] });
    const env = await setup(site);
    await runBaseline(env);

    const r = await pass(env, { extraPaths: ['/docs/points', '/api/secret', '/docs', 'not a path at all ::'] });
    expect(newPageAlerts(r)).toEqual([
      { kind: 'new_pages', pages: [{ url: site.url('/docs/points'), title: 'Points Program', source: 'code' }] },
    ]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/docs/points'))!.source).toBe('code');
    expect(env.store.getPage(env.ctx.watch.id, site.url('/api/secret'))).toBeUndefined();
    expect(site.count('/api/secret')).toBe(1);
  });

  it('a code path that fails transiently is retried later and dropped once it 404s', async () => {
    const site = smallSite();
    site.set('/api/flaky', { status: 503, body: 'busy' });
    const env = await setup(site);
    await runBaseline(env);
    await pass(env, { extraPaths: ['/api/flaky'] });
    expect(env.store.getPage(env.ctx.watch.id, site.url('/api/flaky'))!.status).toBe(503);

    site.delete('/api/flaky');
    const r = await pass(env, { advanceMs: 11 * 60_000 });
    expect(r.alerts).toEqual([]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/api/flaky'))).toBeUndefined();
  });

  it('a redirect to another in-scope URL records the final URL', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    site.html('/', { title: 'Home', paras: ['Welcome to the site.', 'We build things.'], links: ['/about', '/docs', '/whitepaper.pdf', '/go'] });
    site.set('/go', { status: 301, location: '/landing' });
    site.html('/landing', { title: 'Landing', paras: ['You made it'] });

    const r = await pass(env);
    expect(newPageAlerts(r)).toEqual([{ kind: 'new_pages', pages: [{ url: site.url('/landing'), title: 'Landing', source: 'redirect' }] }]);
    const landing = env.store.getPage(env.ctx.watch.id, site.url('/landing'))!;
    expect(landing.source).toBe('redirect');
    expect(landing.tracked).toBe(true);
    const go = env.store.getPage(env.ctx.watch.id, site.url('/go'))!;
    expect(go.tracked).toBe(false);
    expect((await pass(env)).alerts).toEqual([]);
    // The redirecting link is not re-fetched every pass.
    const hits = site.count('/go');
    await pass(env);
    expect(site.count('/go')).toBe(hits);
  });

  it('a linked 404 page that goes live is announced', async () => {
    const site = smallSite();
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/about', '/soon'] });
    const env = await setup(site);
    await runBaseline(env);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/soon'))!.status).toBe(404);

    site.html('/soon', { title: 'Launch Day', paras: ['Live now'] });
    expect((await pass(env)).alerts).toEqual([]); // not re-probed yet
    const r = await pass(env, { advanceMs: 16 * 60_000 });
    expect(newPageAlerts(r)).toEqual([{ kind: 'new_pages', pages: [{ url: site.url('/soon'), title: 'Launch Day', source: 'link' }] }]);
  });
});

describe('checkPages: budgets & robustness', () => {
  it('normal passes fetch at most the due batch + 40 candidates; leftovers are announced in later passes', async () => {
    const site = new FakeSite();
    const links = ['/a', '/b'];
    site.html('/', () => ({ title: 'Home', paras: ['Welcome'], links }));
    site.html('/a', { title: 'A', paras: ['A'] });
    site.html('/b', { title: 'B', paras: ['B'] });
    for (let i = 0; i < 100; i++) site.html(`/n${i}`, { title: `N${i}`, paras: [`Body ${i}`] });
    const env = await setup(site);
    await runBaseline(env);

    for (let i = 0; i < 100; i++) links.push(`/n${i}`);
    const announced = new Set<string>();
    const r1 = await pass(env);
    expect(r1.fetched).toBeLessThanOrEqual(5 + DISCOVERY_FETCHES_NORMAL + 1 /* home confirm */);
    const np1 = newPageAlerts(r1)[0].pages;
    expect(np1).toHaveLength(DISCOVERY_FETCHES_NORMAL);
    np1.forEach((p) => announced.add(p.url));
    // Leftovers are known (pending) right away.
    expect(env.store.knownUrls(env.ctx.watch.id).size).toBe(103);

    for (let i = 0; i < 3; i++) {
      const r = await pass(env);
      for (const a of newPageAlerts(r)) for (const p of a.pages) {
        expect(announced.has(p.url)).toBe(false);
        announced.add(p.url);
      }
    }
    expect(announced.size).toBe(100);
  });

  it('baseline fetches at most 200 candidates; leftovers are probed later without alerts', async () => {
    const site = new FakeSite();
    const links: string[] = [];
    for (let i = 0; i < 250; i++) {
      links.push(`/item-${i}`);
      site.html(`/item-${i}`, { title: `Item ${i}`, paras: [`Item body ${i}`] });
    }
    site.html('/', { title: 'Catalog', paras: ['All items'], links });
    const env = await setup(site, { maxPages: 500 });
    const b = await runBaseline(env);
    expect(b.fetched).toBeLessThanOrEqual(DISCOVERY_FETCHES_FULL);
    expect(env.store.knownUrls(env.ctx.watch.id).size).toBe(251);
    const pending = env.store.listPages(env.ctx.watch.id, { kind: 'page' }).filter((p) => p.status === null);
    expect(pending).toHaveLength(50);

    // Silent backfill is background work: STALE_BACKFILL_PER_PASS per normal pass.
    const r = await pass(env);
    expect(newPageAlerts(r)).toEqual([]);
    expect(env.store.listPages(env.ctx.watch.id, { kind: 'page' }).filter((p) => p.status === null)).toHaveLength(
      50 - STALE_BACKFILL_PER_PASS,
    );
    for (let i = 0; i < 5; i++) expect(newPageAlerts(await pass(env))).toEqual([]);
    expect(env.store.listPages(env.ctx.watch.id, { kind: 'page' }).filter((p) => p.status === null)).toHaveLength(0);
  });

  it('respects config.maxKnownUrls', async () => {
    const site = new FakeSite();
    const links = Array.from({ length: 30 }, (_, i) => `/k${i}`);
    site.html('/', { title: 'Home', paras: ['x'], links });
    for (const l of links) site.html(l, { title: l, paras: [l] });
    const env = await setup(site);
    env.ctx.config = testConfig({ confirmDelayMs: 0, maxKnownUrls: 10 });
    await runBaseline(env);
    expect(env.store.knownUrls(env.ctx.watch.id).size).toBe(10);
    expect((await pass(env)).alerts).toEqual([]);
  });

  it('does not crawl deeper than MAX_CRAWL_DEPTH', async () => {
    const site = new FakeSite();
    for (let d = 0; d <= 6; d++) {
      site.html(d === 0 ? '/' : `/d${d}`, { title: `Depth ${d}`, paras: [`depth ${d}`], links: [`/d${d + 1}`] });
    }
    const env = await setup(site);
    await runBaseline(env);
    const known = env.store.knownUrls(env.ctx.watch.id);
    expect(known.has(site.url('/d4'))).toBe(true);
    expect(known.has(site.url('/d5'))).toBe(false);
  });

  it('an unreachable site never throws and changes nothing', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    const before = env.store.getPage(env.ctx.watch.id, site.url('/about'))!;
    await site.stop();
    const r = await pass(env);
    expect(r.alerts).toEqual([]);
    const after = env.store.getPage(env.ctx.watch.id, site.url('/about'))!;
    expect(after.status).toBe(0);
    expect(after.textHash).toBe(before.textHash);
    expect(after.failCount).toBe(0);
  });

  it('never throws even when the store is broken', async () => {
    const site = smallSite();
    const env = await setup(site);
    env.store.close();
    const r = await checkPages(env.ctx, { home: null, full: false });
    expect(r.alerts).toEqual([]);
  });

  it('does nothing when text, pages and files are all disabled', async () => {
    const site = smallSite();
    const env = await setup(site, { features: { text: false, pages: false, files: false } });
    const r = await runBaseline(env);
    expect(r.fetched).toBe(0);
    expect(env.store.knownUrls(env.ctx.watch.id).size).toBe(0);
  });

  it('extra URLs are always tracked, even beyond maxPages and out of scope', async () => {
    const site = smallSite();
    site.html('/unlinked', { title: 'Unlinked', paras: ['Only via extraUrls'] });
    await site.start();
    const env = await setup(site, { maxPages: 1, scopePath: '/docs', extraUrls: [`${site.base}/unlinked/`] });
    await runBaseline(env);
    const rec = env.store.getPage(env.ctx.watch.id, site.url('/unlinked'))!;
    expect(rec.tracked).toBe(true);
    expect(rec.source).toBe('extra');
    site.html('/unlinked', { title: 'Unlinked', paras: ['Changed!'] });
    const [alert] = textAlerts(await pass(env));
    expect(alert.changes[0].url).toBe(site.url('/unlinked'));
  });
});

describe('checkPages: feature flags & re-baseline', () => {
  it('a re-baseline pass silently accepts changed text', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    site.html('/about', { title: 'About', paras: ['We are a small team.', 'Edited while re-baselining'], links: ['/'] });
    env.clock.t += 121_000;
    expect((await runBaseline(env)).alerts).toEqual([]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/about'))!.text).toContain('Edited while re-baselining');
    expect((await pass(env)).alerts).toEqual([]);
  });

  it('features.pages=false: new pages are tracked for text but never announced', async () => {
    const site = smallSite();
    const env = await setup(site, { features: { pages: false } });
    await runBaseline(env);
    site.html('/', { title: 'Home', paras: ['Welcome to the site.', 'We build things.'], links: ['/about', '/docs', '/new'] });
    site.html('/new', { title: 'New', paras: ['Fresh'] });
    const r = await pass(env);
    expect(newPageAlerts(r)).toEqual([]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/new'))!.tracked).toBe(true);

    site.delete('/about');
    await pass(env);
    // Removal still reported: it is part of watching tracked pages' text.
    expect(removedAlerts(await pass(env))).toHaveLength(1);
  });

  it('crawl off (pages=false, maxPages=1): only the start page is fetched', async () => {
    const site = smallSite();
    const env = await setup(site, { features: { pages: false }, maxPages: 1 });
    await runBaseline(env);
    expect([...env.store.knownUrls(env.ctx.watch.id)].sort()).toEqual([site.url('/'), site.url('/whitepaper.pdf')].sort());
    expect(site.count('/about')).toBe(0);
    expect(site.count('/sitemap.xml')).toBe(0);
    for (let i = 0; i < 2; i++) expect((await pass(env)).alerts).toEqual([]);
    expect(site.count('/about')).toBe(0);
  });

  it('features.text=false: text edits are silent, new pages still alert', async () => {
    const site = smallSite();
    const env = await setup(site, { features: { text: false } });
    await runBaseline(env);
    site.html('/about', { title: 'About', paras: ['Completely different'], links: ['/', '/careers'] });
    site.html('/careers', { title: 'Careers', paras: ['Join us'] });
    const r = await pass(env);
    expect(textAlerts(r)).toEqual([]);
    expect(newPageAlerts(r)[0].pages.map((p) => p.url)).toEqual([site.url('/careers')]);
  });

  it('features.text=false: a new link on the start page is still announced', async () => {
    const site = smallSite();
    const env = await setup(site, { features: { text: false } });
    await runBaseline(env);
    site.html('/', { title: 'Home', paras: ['Welcome to the site.', 'We build things.'], links: ['/about', '/docs', '/whitepaper.pdf', '/launch'] });
    site.html('/launch', { title: 'Launch', paras: ['New'] });
    expect(newPageAlerts(await pass(env))[0].pages.map((p) => p.url)).toEqual([site.url('/launch')]);
  });

  it('a site that blocked the baseline does not announce all of its pages once it answers', async () => {
    const site = smallSite();
    const blocked = { status: 414, body: 'URI Too Long', type: 'text/plain' };
    site.set('/', blocked);
    const env = await setup(site);
    await runBaseline(env);
    site.html('/', { title: 'Home', paras: ['Welcome to the site.', 'We build things.'], links: ['/about', '/docs', '/whitepaper.pdf'] });
    for (let i = 0; i < 3; i++) expect(newPageAlerts(await pass(env))).toEqual([]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/docs/a'))).toBeDefined();
  });

  it('links to opaque ids (tx hashes, addresses, tokens) are not crawled', async () => {
    const site = smallSite();
    const feed = () => ({
      title: 'Activity',
      paras: ['Latest trades'],
      links: [`/tx/0x${randomBytes(32).toString('hex')}`, `/wallet/${randomBytes(24).toString('base64url').replace(/[-_]/g, 'a')}9`, '/about'],
    });
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/activity'] });
    site.html('/activity', feed);
    const env = await setup(site);
    await runBaseline(env);
    for (let i = 0; i < 3; i++) expect(newPageAlerts(await pass(env))).toEqual([]);
    expect([...env.store.knownUrls(env.ctx.watch.id)].some((u) => /\/(tx|wallet)\//.test(u))).toBe(false);
  });
});

describe('checkPages: churn, flip-flops and held numbers', () => {
  it('a page rotating between two versions (A,B,A,B,A) alerts only for the first switch', async () => {
    const site = smallSite();
    let variant = 'A';
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/customers'] });
    site.html('/customers', () => ({
      title: 'Customers',
      paras: ['Trusted by teams', variant === 'A' ? 'Tray.ai cut build times by 80%.' : 'How Conductor moved to the edge.'],
    }));
    const env = await setup(site);
    await runBaseline(env);
    let texts = 0;
    for (const v of ['B', 'A', 'B', 'A', 'B', 'A']) {
      variant = v;
      const r = await pass(env, { advanceMs: 150_000 });
      texts += textAlerts(r).length;
      expect(infoAlerts(r)).toEqual([]);
    }
    expect(texts).toBe(1);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/customers'))!.dynamic).toBe(false);
  });

  it('content that changes on every check (not every load) alerts 3 times, is muted with one info, and is trusted again after a quiet day', async () => {
    const site = smallSite();
    let item = 0;
    let frozen = false;
    const word = (n: number) => String.fromCharCode(97 + (n % 26)).repeat(3) + String.fromCharCode(97 + ((n * 7) % 26));
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/newest'] });
    site.html('/newest', () => ({ title: 'Newest', paras: ['Latest posts', `Story ${frozen ? 'final' : word(item)} is on top`] }));
    const env = await setup(site);
    await runBaseline(env);

    const counts = { text: 0, info: 0 };
    const infos: string[] = [];
    for (let i = 1; i <= 8; i++) {
      item = i;
      const r = await pass(env);
      counts.text += textAlerts(r).length;
      for (const a of infoAlerts(r)) infos.push(a.message);
    }
    expect(counts.text).toBe(3);
    expect(infos).toEqual([
      'ℹ️ /newest changes too often; ignoring its text until it settles down. Use /watch ignore to filter the changing part.',
    ]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/newest'))!.dynamic).toBe(true);

    // It stops churning; after a quiet day it is compared again (silently re-baselined) …
    frozen = true;
    expect((await pass(env)).alerts).toEqual([]);
    expect((await pass(env, { advanceMs: DYNAMIC_RESET_MS })).alerts).toEqual([]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/newest'))!.dynamic).toBe(false);
    // … and a real change afterwards is reported again.
    frozen = false;
    item = 20;
    const [alert] = textAlerts(await pass(env));
    expect(alert.changes[0].diff.added).toEqual([`Story ${word(20)} is on top`]);
  });

  it('two separate edits 30 minutes apart are both reported (an actively edited page is not muted)', async () => {
    const site = smallSite();
    let line = 'Fees are charged monthly.';
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/docs/fees'] });
    site.html('/docs/fees', () => ({ title: 'Fees', paras: ['Fee schedule', line] }));
    const env = await setup(site);
    await runBaseline(env);
    line = 'Fees are charged weekly.';
    expect(textAlerts(await pass(env))).toHaveLength(1);
    line = 'Fees are charged weekly, in USDC.';
    expect(textAlerts(await pass(env, { advanceMs: 30 * 60_000 }))).toHaveLength(1);
    line = 'Fees are charged daily, in USDC.';
    expect(textAlerts(await pass(env, { advanceMs: 10 * 60_000 }))).toHaveLength(1);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/docs/fees'))!.dynamic).toBe(false);
  });

  it('a live "Pools" table (drifting numbers and timestamps, a status toggling with a row reorder) costs at most 2 alerts + 1 info, and a real edit still alerts', async () => {
    const site = new FakeSite();
    let sweep = 0;
    let docsLine = 'Docs: read the risks page before depositing.';
    const pools = () => {
      const eligible = sweep >= 5 && Math.floor((sweep - 5) / 3) % 2 === 0;
      const rows = [
        { name: 'mSOL', n: 13 + (sweep % 4), status: 'SETTLEMENT_ELIGIBLE' },
        { name: 'JitoSOL', n: 16 + (sweep % 3), status: eligible ? 'SETTLEMENT_ELIGIBLE' : 'MONITOR_ONLY' },
        { name: 'hSOL', n: 4 + (sweep % 5), status: 'MONITOR_ONLY' },
      ];
      if (eligible) rows.unshift(rows.splice(1, 1)[0]);
      const minute = String(10 + sweep).padStart(2, '0');
      const out: string[] = ['Pools'];
      for (const r of rows) out.push(`${r.name}${r.n}`, r.status, `−${r.n + sweep} bps · 2026-09-28 16:${minute} UTC`);
      return out;
    };
    site.html('/', () => ({ title: 'Unpeg', paras: [...pools(), docsLine], links: ['/docs'] }));
    site.html('/docs', { title: 'Docs', paras: ['Introduction'] });
    const env = await setup(site);
    await runBaseline(env);

    let texts = 0;
    let infos = 0;
    for (sweep = 1; sweep <= 20; sweep++) {
      const r = await pass(env, { advanceMs: 121_000 });
      texts += textAlerts(r).length;
      infos += infoAlerts(r).length;
    }
    expect(texts).toBeLessThanOrEqual(2);
    expect(infos).toBeLessThanOrEqual(1);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/'))!.dynamic).toBe(false);

    docsLine = 'Docs: read the new risks page before depositing.';
    sweep++;
    const r = await pass(env, { advanceMs: 121_000 });
    const [alert] = textAlerts(r);
    expect(alert.changes[0].diff.added).toContain('Docs: read the new risks page before depositing.');
  });

  it('pages that become noisy in one pass share one info alert', async () => {
    const site = new FakeSite();
    const paths = Array.from({ length: 10 }, (_, i) => `/market-${i}`);
    let n = 0;
    site.html('/', { title: 'Home', paras: ['Markets'], links: paths });
    for (const p of paths) site.html(p, () => ({ title: p, paras: [`Price ${p}: $${(n++).toFixed(2)}`, 'Live data'] }));
    const env = await setup(site);
    await runBaseline(env);
    const r = await pass(env, { full: true });
    const infos = infoAlerts(r);
    expect(textAlerts(r)).toEqual([]);
    expect(infos).toHaveLength(1);
    expect(infos[0].message).toMatch(/^ℹ️ Ignoring number-only changes on the ticking lines of 10 pages that show live numbers: \/market-\d, /);
  });
});

describe('checkPages: backfill after the baseline', () => {
  it('pages only reachable through baseline-era backfill pages are never announced; a new link still is', async () => {
    const site = new FakeSite();
    const cats = Array.from({ length: 250 }, (_, i) => `/cat-${i}`);
    const homeLinks = [...cats];
    site.html('/', () => ({ title: 'Blog', paras: ['All categories'], links: homeLinks }));
    for (const c of cats) {
      site.html(c, { title: `Category ${c}`, paras: [`Posts in ${c}`], links: [`${c}/post`] });
      site.html(`${c}/post`, { title: `Post of ${c}`, paras: [`Old post in ${c}`], links: [`${c}/post/comments`] });
      site.html(`${c}/post/comments`, { title: 'Comments', paras: ['No comments'] });
    }
    const env = await setup(site, { maxPages: 1000 });
    await runBaseline(env);
    for (let i = 0; i < 30; i++) {
      const r = await pass(env);
      expect(newPageAlerts(r)).toEqual([]);
    }
    // The backlog was worked through silently.
    expect(env.store.getPage(env.ctx.watch.id, site.url('/cat-249/post'))).toBeDefined();

    homeLinks.push('/launch');
    site.html('/launch', { title: 'Launch', paras: ['New!'] });
    const r = await pass(env);
    expect(newPageAlerts(r).flatMap((a) => a.pages.map((p) => p.url))).toEqual([site.url('/launch')]);
  });

  it('hosts seen only on backfill pages are quiet; hosts on known pages are loud', async () => {
    const site = new FakeSite();
    const links = Array.from({ length: 210 }, (_, i) => `/p${i}`);
    site.html('/', { title: 'Home', paras: ['x'], links: [...links, 'https://www.example.test/'] });
    for (const l of links) site.html(l, { title: l, paras: [l], links: l === '/p209' ? ['https://old.example.test/'] : [] });
    const env = await setup(site, { maxPages: 1000 });
    await runBaseline(env);
    const quiet = new Set<string>();
    const loud = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = await pass(env);
      r.quietHosts.forEach((h) => quiet.add(h));
      r.hosts.forEach((h) => loud.add(h));
    }
    expect(quiet.has('old.example.test')).toBe(true);
    expect(loud.has('old.example.test')).toBe(false);
    expect(loud.has('www.example.test')).toBe(true);
  });

  it('a sitemap that failed transiently at the baseline does not announce its pages on the first good read', async () => {
    const site = smallSite();
    let failing = true;
    const locs = Array.from({ length: 40 }, (_, i) => `/blog/post-${i}`);
    site.set('/sitemap.xml', () =>
      failing
        ? { status: 429, body: 'slow down', type: 'text/plain' }
        : {
            type: 'application/xml',
            body: `<urlset>${locs.map((l) => `<url><loc>${site.base}${l}</loc></url>`).join('')}</urlset>`,
          },
    );
    for (const l of locs) site.html(l, { title: l, paras: [l] });
    const env = await setup(site);
    await runBaseline(env);
    expect(env.ctx.state.sitemapComplete).toBe(false);
    failing = false;
    for (let i = 0; i < 6; i++) expect(newPageAlerts(await pass(env, { advanceMs: 600_000 }))).toEqual([]);
    expect(env.ctx.state.sitemapComplete).toBe(true);

    locs.push('/blog/brand-new');
    site.html('/blog/brand-new', { title: 'Brand new', paras: ['Fresh'] });
    const r = await pass(env, { advanceMs: 600_000 });
    expect(newPageAlerts(r).flatMap((a) => a.pages.map((p) => p.url))).toEqual([site.url('/blog/brand-new')]);
  });
});

describe('checkPages: known-URL cap and item pages', () => {
  it('sitemap item pages with opaque ids (token mints) are never recorded', async () => {
    const site = smallSite();
    const mints = Array.from({ length: 5 }, () => `/coin/${randomBytes(33).toString('base64url').replace(/[-_]/g, 'k')}pump`);
    site.set('/sitemap.xml', {
      type: 'application/xml',
      body: `<urlset>${[...mints, '/docs'].map((l) => `<url><loc>${site.base}${l}</loc></url>`).join('')}</urlset>`,
    });
    for (const m of mints) site.html(m, { title: 'Coin', paras: ['Price $0.015'] });
    const env = await setup(site);
    await runBaseline(env);
    expect([...env.store.knownUrls(env.ctx.watch.id)].some((u) => u.includes('/coin/'))).toBe(false);
  });

  it('at the cap, a new page linked from the start page evicts a never-fetched sitemap row and is announced', async () => {
    const site = smallSite();
    const env = await setup(site);
    env.ctx.config = testConfig({ confirmDelayMs: 0, maxKnownUrls: 20 });
    await runBaseline(env);
    const id = env.ctx.watch.id;
    const known = env.store.knownUrls(id).size;
    const filler = Array.from({ length: 20 - known }, (_, i) => ({
      watchId: id,
      url: site.url(`/sitemap-only-${i}`),
      kind: 'page' as const,
      tracked: false,
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
      source: 'sitemap' as const,
      depth: 1,
      firstSeen: env.ctx.state.baselineAt,
      lastChecked: 0,
      lastChanged: null,
    }));
    env.store.upsertPages(filler);
    expect(env.store.knownUrls(id).size).toBe(20);

    site.html('/', { title: 'Home', paras: ['Welcome to the site.', 'We build things.'], links: ['/about', '/docs', '/whitepaper.pdf', '/launch'] });
    site.html('/launch', { title: 'Launch', paras: ['It is here'] });
    const r = await pass(env);
    expect(newPageAlerts(r).flatMap((a) => a.pages.map((p) => p.url))).toEqual([site.url('/launch')]);
    expect(env.store.knownUrls(id).size).toBeLessThanOrEqual(20);
    expect(env.store.getPage(id, site.url('/launch'))).toBeDefined();
  });

  it('a capped watch does not fetch links it cannot record, pass after pass', async () => {
    const site = new FakeSite();
    const links = Array.from({ length: 30 }, (_, i) => `/k${i}`);
    site.html('/', { title: 'Home', paras: ['x'], links });
    for (const l of links) site.html(l, { title: l, paras: [l] });
    const env = await setup(site);
    env.ctx.config = testConfig({ confirmDelayMs: 0, maxKnownUrls: 10 });
    await runBaseline(env);
    const unrecorded = links.find((l) => !env.store.getPage(env.ctx.watch.id, site.url(l)))!;
    const before = site.count(unrecorded);
    await pass(env);
    await pass(env);
    expect(site.count(unrecorded)).toBe(before);
  });
});

describe('checkPages: removals', () => {
  it('an extra URL tracked before its launch is not "removed" while it 404s, and is announced when it goes live', async () => {
    const site = smallSite();
    await site.start();
    const env = await setup(site, { extraUrls: [`${site.base}/airdrop`] });
    await runBaseline(env);
    for (let i = 0; i < 3; i++) expect((await pass(env)).alerts).toEqual([]);
    expect(env.store.getPage(env.ctx.watch.id, site.url('/airdrop'))!.gone).toBe(true);

    site.html('/airdrop', { title: 'Airdrop', paras: ['Claim now'] });
    const r = await pass(env, { advanceMs: GONE_RECHECK_MS });
    expect(newPageAlerts(r)).toEqual([{ kind: 'new_pages', pages: [{ url: site.url('/airdrop'), title: 'Airdrop', source: 'extra' }] }]);
    expect((await pass(env)).alerts).toEqual([]);
  });

  it('a site-wide 404 for a minute (every page, the start URL included) is not a removal', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    const saved = ['/', '/about', '/docs', '/docs/a'];
    for (const p of saved) site.set(p, { status: 404, body: 'NOT_FOUND', type: 'text/plain' });
    for (let i = 0; i < 3; i++) expect((await pass(env, { advanceMs: 30_000 })).alerts).toEqual([]);
    const full = await pass(env, { advanceMs: 30_000, full: true });
    expect(removedAlerts(full)).toEqual([]);
    site.html('/', { title: 'Home', paras: ['Welcome to the site.', 'We build things.'], links: ['/about', '/docs', '/whitepaper.pdf'] });
    site.html('/about', { title: 'About', paras: ['We are a small team.', 'Old line'], links: ['/'] });
    site.html('/docs', { title: 'Docs', paras: ['Documentation index.'], links: ['/docs/a'] });
    site.html('/docs/a', { title: 'Doc A', paras: ['First doc page.'], links: ['/docs'] });
    expect((await pass(env, { advanceMs: GONE_RECHECK_MS, full: true })).alerts).toEqual([]);
    expect((await pass(env)).alerts).toEqual([]);
  });

  it('a page that 404s on two normal sweeps 2 minutes apart is still reported removed', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    site.delete('/docs/a');
    await pass(env);
    const r = await pass(env);
    expect(removedAlerts(r)[0].pages.map((p) => p.url)).toEqual([site.url('/docs/a')]);
  });

  it('removed pages are re-checked hourly, so they do not grow the per-tick fetch load', async () => {
    const site = new FakeSite();
    let week = 0;
    const jobs = (w: number) => Array.from({ length: 10 }, (_, i) => `/jobs/w${w}-${i}`);
    site.html('/', () => ({ title: 'Careers', paras: ['Open roles'], links: jobs(week) }));
    const serve = (w: number) => {
      for (const j of jobs(w)) site.html(j, { title: j, paras: [j] });
    };
    serve(0);
    const env = await setup(site, { maxPages: 20 });
    await runBaseline(env);
    for (week = 1; week <= 4; week++) {
      for (const j of jobs(week - 1)) site.delete(j);
      serve(week);
      for (let i = 0; i < 6; i++) await pass(env, { advanceMs: 24 * 3600_000 });
    }
    week = 4;
    await pass(env, { full: true });
    const gone = env.store.listPages(env.ctx.watch.id, { kind: 'page', tracked: true }).filter((p) => p.gone);
    expect(gone.length).toBeGreaterThan(0);
    const before = gone.map((p) => site.count(new URL(p.url).pathname));
    for (let i = 0; i < 5; i++) await pass(env);
    expect(gone.map((p) => site.count(new URL(p.url).pathname))).toEqual(before);
    await pass(env, { advanceMs: GONE_RECHECK_MS });
    await pass(env);
    await pass(env);
    expect(gone.some((p, i) => site.count(new URL(p.url).pathname) > before[i])).toBe(true);
  });
});

describe('checkPages: robustness of text handling', () => {
  it('an ignore pattern that is too slow on one page skips that page without alerting or changing it', async () => {
    const site = smallSite();
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/blob'] });
    site.html('/blob', { title: 'Blob', paras: ['Data', 'a'.repeat(200_000)] });
    const env = await setup(site);
    await runBaseline(env);
    const before = env.store.getPage(env.ctx.watch.id, site.url('/blob'))!;
    env.ctx.watch = env.store.updateWatch(env.ctx.watch.id, { ignorePatterns: ['\\w+@'] });
    resetPagesWarnings();
    const t0 = Date.now();
    const r = await pass(env);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(textAlerts(r)).toEqual([]);
    const after = env.store.getPage(env.ctx.watch.id, site.url('/blob'))!;
    expect(after.textHash).toBe(before.textHash);
    expect(after.text).toBe(before.text);
  }, 20_000);

  it('a cancelled pass starts no confirm fetch; the change is found on the next pass', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    site.html('/about', { title: 'About', paras: ['We are a small team.', 'New line'], links: ['/'] });
    let cancelled = false;
    env.ctx.cancelled = () => cancelled;
    const realGet = env.ctx.http.fetch.bind(env.ctx.http);
    env.ctx.http = {
      ...env.ctx.http,
      fetch: async (url: string, o?: Parameters<typeof realGet>[1]) => {
        const res = await realGet(url, o);
        if (url === site.url('/about')) cancelled = true;
        return res;
      },
    } as typeof env.ctx.http;
    const hits = () => site.count('/about');
    const before = hits();
    expect(textAlerts(await pass(env))).toEqual([]);
    expect(hits() - before).toBe(1); // the sweep fetch only, no confirm
    cancelled = false;
    env.ctx.cancelled = undefined;
    env.ctx.http = { ...env.ctx.http, fetch: realGet } as typeof env.ctx.http;
    expect(textAlerts(await pass(env))).toHaveLength(1);
  });

  it('when saving page records fails, changes are not reported (one storage info), and are reported once saving works', async () => {
    const site = smallSite();
    const env = await setup(site);
    await runBaseline(env);
    resetPagesWarnings();
    site.html('/about', { title: 'About', paras: ['We are a small team.', 'Changed line'], links: ['/'] });
    const real = env.store.upsertPages.bind(env.store);
    env.store.upsertPages = () => {
      throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
    };
    const infos: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await pass(env);
      expect(textAlerts(r)).toEqual([]);
      infos.push(...infoAlerts(r).map((a) => a.message));
    }
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatch(/SQLITE_FULL/);
    env.store.upsertPages = real;
    expect(textAlerts(await pass(env))).toHaveLength(1);
    expect(textAlerts(await pass(env))).toEqual([]);
  });
});

describe('checkPages: page twins', () => {
  it('".md" twins of pages and llms.txt dumps are not tracked as files; real documents are', async () => {
    const site = smallSite();
    site.html('/', { title: 'Home', paras: ['Welcome'], links: ['/guide', '/guide.md', '/llms.txt', '/llms-full.txt', '/handbook.md', '/audit.pdf'] });
    site.html('/guide', { title: 'Guide', paras: ['Guide'] });
    const env = await setup(site);
    await runBaseline(env);
    const files = env.store.listPages(env.ctx.watch.id, { kind: 'file', tracked: true }).map((f) => f.url).sort();
    expect(files).toEqual([site.url('/audit.pdf'), site.url('/handbook.md')].sort());
  });
});

describe('isOpaqueIdUrl', () => {
  it('flags hashes, addresses, uuids and tokens but not slugs or small ids', () => {
    expect(isOpaqueIdUrl('https://a.io/tx/0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060')).toBe(true);
    expect(isOpaqueIdUrl('https://a.io/address/0x742d35Cc6634C0532925a3b844Bc454e4438f44e')).toBe(true);
    expect(isOpaqueIdUrl('https://a.io/s/5hd5o7cwebqwq7sxtktybf9n5a9abae8jh1xbq31aedk')).toBe(true);
    expect(isOpaqueIdUrl('https://a.io/r/123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isOpaqueIdUrl('https://a.io/blog/2026-09-28-launch-notes-and-roadmap-update')).toBe(false);
    expect(isOpaqueIdUrl('https://a.io/docs/how-it-works')).toBe(false);
    expect(isOpaqueIdUrl('https://a.io/post/123456')).toBe(false);
    expect(isOpaqueIdUrl('https://a.io/internationalizationandlocalization')).toBe(false);
    expect(isOpaqueIdUrl('not a url')).toBe(false);
  });
});

describe('pages-text helpers', () => {
  it('alignNumbers swaps stale numbers for current ones only where the rest of the line matches', () => {
    const oldText = 'Price: 100\nTitle\nHolders: 5';
    const newText = 'Price: 250\nTitle v2\nHolders: 7';
    expect(alignNumbers(oldText, newText)).toBe('Price: 250\nTitle\nHolders: 7');
    expect(alignNumbers('', newText)).toBe('');
  });

  it('pageDiff hides ignored parts and aligned numbers', () => {
    const d = pageDiff('A 1\nBuild: x\nB', 'A 2\nBuild: y\nC', { ignorePatterns: ['^Build: \\w+$'], maskNumbers: true });
    expect(d.removed).toEqual(['B']);
    expect(d.added).toEqual(['C']);
  });

  it('groupChanges sorts by group size, ties by first appearance', () => {
    const mk = (url: string, hash: string): TextChange => ({
      url,
      title: null,
      titleChange: null,
      diff: { added: [], removed: [], numericOnly: false, unified: '', hash },
    });
    const groups = groupChanges([mk('u1', 'h1'), mk('u2', 'h2'), mk('u3', 'h2'), mk('u4', 'h3')]);
    expect(groups.map((g) => [g.hash, g.urls])).toEqual([
      ['h2', ['u2', 'u3']],
      ['h1', ['u1']],
      ['h3', ['u4']],
    ]);
  });
});
