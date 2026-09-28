/**
 * End-to-end: Monitor.runBaseline + Monitor.checkNow against a mutable fake Next.js (app router) site on 127.0.0.1,
 * with the real Store, HttpClient, checkers and Discord formatter. Only the clock, sleep and CT/DNS providers are fake.
 *
 * The steps share one site/monitor and run in order, like a story: each step mutates the site, runs checks and asserts
 * exactly which alerts come out (noise is the #1 failure mode, so "no alert" steps matter as much as the others).
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { HttpClient } from '../src/net/http.js';
import { silentLogger } from '../src/log.js';
import { Monitor, summarizeAlert, type TickSummary } from '../src/monitor/scheduler.js';
import { formatAlerts, type MessagePayload } from '../src/discord/format.js';
import type {
  Alert,
  DeployAlert,
  FileAlert,
  InfoAlert,
  NewPagesAlert,
  Notifier,
  RemovedPagesAlert,
  StatusAlert,
  TextAlert,
  Watch,
} from '../src/types.js';
import type { CtProvider } from '../src/monitor/subdomains.js';
import type { DnsProvider } from '../src/net/dns.js';

// ---------------------------------------------------------------------------
// Fake Next.js app-router site
// ---------------------------------------------------------------------------

interface PageDef {
  title: string;
  description: string;
  body: () => string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const WEBPACK_JS = `!function(){"use strict";var e,t,n,r={},o={};function i(e){var t=o[e];if(void 0!==t)return t.exports;var n=o[e]={exports:{}};return r[e](n,n.exports,i),n.exports}i.m=r,i.p="/_next/",i.u=function(e){return"static/chunks/"+e+".js"}}();`;
const MAIN_APP_JS = `(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[744],{9001:function(e,t,n){"use strict";n.d(t,{default:function(){return a}});let r={docs:"/docs",stats:"/api/stats",ticker:"/ticker"};function a(){return fetch(r.stats).then(e=>e.json())}}}]);`;
const LAYOUT_JS = `(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[185],{4410:function(e,t,n){"use strict";n.r(t);let r=[{href:"/docs/getting-started",label:"Start"},{href:"/docs/tokenomics",label:"Tokenomics"}],o="https://twitter.com/acme";t.default=function(){return r.map(e=>e.href).concat(o)}}}]);`;
const AIRDROP_JS = `(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[512],{7331:function(e,t,n){"use strict";n.r(t);let r="/airdrop",o="https://api.example.com/v1/claim",a="https://rpc.acmefi.io";t.default=function(){return fetch(o,{method:"POST",body:JSON.stringify({route:r,rpc:a})})}}}]);`;

interface Build {
  buildId: string;
  css: string;
  chunks: Record<string, string>;
}

const BUILD_1: Build = {
  buildId: 'bLd1QmX9pA7vK2sR4tY6w',
  css: 'app-5e4d3c2b1a09f8e7.css',
  chunks: {
    'webpack-3f2a1b9c8d7e6f50.js': WEBPACK_JS,
    'main-app-8d7e6f5a4b3c2d1e.js': MAIN_APP_JS,
    'app/layout-1a2b3c4d5e6f7a8b.js': LAYOUT_JS,
  },
};

const BUILD_2: Build = {
  buildId: 'bLd2ZzY8xW7vU6tS5rQ4p',
  css: 'app-0f1e2d3c4b5a6978.css',
  chunks: {
    'webpack-77aa88bb99cc00dd.js': WEBPACK_JS,
    'main-app-1122334455667788.js': MAIN_APP_JS,
    'app/layout-99aabbccddeeff00.js': LAYOUT_JS,
    'app/airdrop/page-a1b2c3d4e5f60718.js': AIRDROP_JS,
  },
};

const BUILD_3: Build = {
  buildId: 'bLd3Hh5Gg4Ff3Ee2Dd1Cc',
  css: 'app-3c3c3c3c3c3c3c3c.css',
  chunks: {
    'webpack-0123456789abcdef.js': WEBPACK_JS,
    'main-app-fedcba9876543210.js': MAIN_APP_JS,
    'app/layout-00ff00ff00ff00ff.js': LAYOUT_JS,
    'app/airdrop/page-a1b2c3d4e5f60718.js': AIRDROP_JS,
  },
};

const FLAP_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];

class FakeNextSite {
  build: Build = BUILD_1;
  nav: Array<[string, string]> = [
    ['/docs', 'Docs'],
    ['/ticker', 'Stats'],
    ['/whitepaper.pdf', 'Whitepaper'],
  ];
  docs = new Map<string, { title: string; paras: string[] }>([
    ['/docs/getting-started', { title: 'Getting started', paras: ['Connect a Solana wallet to begin.', 'Deposit SOL to mint positions.'] }],
    [
      '/docs/tokenomics',
      { title: 'Tokenomics', paras: ['Total supply is fixed at one billion ACME.', 'Team allocation is fifteen percent, vested.'] },
    ],
    ['/docs/faq', { title: 'FAQ', paras: ['Is Acme audited? Yes, by two firms.', 'Where are funds held? In program-owned vaults.'] }],
    ['/docs/risks', { title: 'Risks', paras: ['Smart contract risk exists.', 'Oracle failures can delay settlement.'] }],
  ]);
  docsIndexExtra = '';
  homeStatus = 200;
  missing = new Set<string>();
  pdf: Buffer = Buffer.from('%PDF-1.4\n% Acme whitepaper v1\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  flappy = false;
  private flapIdx = 0;
  private tickerIdx = 0;
  requests: string[] = [];
  origin = '';
  private server: http.Server | null = null;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.closeAllConnections();
      this.server?.close(() => resolve());
    });
  }

  url(path = '/'): string {
    return this.origin + path;
  }

  private pages(): Map<string, PageDef> {
    const docsLinks = () =>
      [...this.docs].map(([p, d]) => `<li><a href="${p}">${esc(d.title)}</a></li>`).join('');
    const map = new Map<string, PageDef>();
    map.set('/', {
      title: 'Acme Protocol',
      description: 'Fully collateralized yield on Solana.',
      body: () =>
        `<section><h1>Yield without the depeg risk</h1><p>Acme splits liquid staking tokens into fixed and variable legs.</p>` +
        `<a href="/docs">Read the docs</a><a href="/whitepaper.pdf">Whitepaper</a></section>` +
        `<section><h2>Backed by</h2><ul><li>Two audits</li><li>Open source programs</li></ul></section>`,
    });
    map.set('/docs', {
      title: 'Docs | Acme',
      description: 'Acme documentation.',
      body: () => `<article><h1>Documentation</h1><p>Everything about the Acme protocol.</p><ul>${docsLinks()}</ul>${this.docsIndexExtra}</article>`,
    });
    for (const [path, d] of this.docs) {
      map.set(path, {
        title: `${d.title} | Acme Docs`,
        description: `${d.title} — Acme documentation.`,
        body: () =>
          `<div class="docs"><aside><ul>${docsLinks()}</ul></aside><article><h1>${esc(d.title)}</h1>${d.paras
            .map((p) => `<p>${esc(p)}</p>`)
            .join('')}</article></div>`,
      });
    }
    map.set('/ticker', {
      title: 'Live stats | Acme',
      description: 'Protocol statistics.',
      body: () => {
        const n = this.tickerIdx++;
        const tvl = (12_345_678 + n * 4_321).toLocaleString('en-US');
        const price = (0.9912 + (n % 7) / 10_000).toFixed(4);
        return `<section><h1>Live stats</h1><dl><dt>TVL</dt><dd>$${tvl}</dd><dt>ACME price</dt><dd>${price} USDC</dd>` +
          `<dt>Updated</dt><dd>${(n % 50) + 2} seconds ago</dd></dl></section>`;
      },
    });
    map.set('/community', {
      title: 'Community | Acme',
      description: 'Posts from the community.',
      body: () => `<section><h1>Community</h1><p>Featured post: ${this.flappy ? FLAP_WORDS[this.flapIdx++ % FLAP_WORDS.length] : 'none'}</p></section>`,
    });
    return map;
  }

  private shell(path: string, page: PageDef): string {
    const b = this.build;
    const chunkNames = Object.keys(b.chunks);
    const nonce = randomBytes(8).toString('hex'); // per-request, like a CSP nonce: must never matter
    const flight0 = `0:${JSON.stringify({ P: null, b: b.buildId, p: '', c: ['', ...path.split('/').filter(Boolean)], i: false, f: [], S: true })}\n`;
    const flight1 = `2:I[9001,${JSON.stringify(chunkNames.map((c) => `/_next/static/chunks/${c}`))},"default"]\n`;
    const nav = this.nav.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join('');
    return (
      `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>` +
      `<link rel="stylesheet" href="/_next/static/css/${b.css}" data-precedence="next"/>` +
      `<link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/${chunkNames[0]}"/>` +
      chunkNames.map((c) => `<script src="/_next/static/chunks/${c}" async="" nonce="${nonce}"></script>`).join('') +
      `<title>${esc(page.title)}</title><meta name="description" content="${esc(page.description)}"/>` +
      `<link rel="icon" href="/favicon.ico" sizes="any"/></head><body><div hidden=""><!--$--><!--/$--></div>` +
      `<header><a class="logo" href="/">ACME</a><nav>${nav}</nav></header><main>${page.body()}</main>` +
      `<footer><span>© 2026 Acme Labs</span><a href="https://twitter.com/acme">Twitter</a><a href="https://discord.gg/acme">Discord</a></footer>` +
      `<script nonce="${nonce}">(self.__next_f=self.__next_f||[]).push([0])</script>` +
      `<script nonce="${nonce}">self.__next_f.push(${JSON.stringify([1, flight0])})</script>` +
      `<script nonce="${nonce}">self.__next_f.push(${JSON.stringify([1, flight1])})</script>` +
      `</body></html>`
    );
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    this.requests.push(path);
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'x-powered-by': 'Next.js' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const notFound = () =>
      send(
        404,
        'text/html; charset=utf-8',
        '<!DOCTYPE html><html><head><title>404: This page could not be found.</title></head><body><h1>404</h1><h2>This page could not be found.</h2></body></html>',
      );

    if (path === '/' && this.homeStatus !== 200) {
      send(this.homeStatus, 'text/html; charset=utf-8', `<!DOCTYPE html><html><body><h1>${this.homeStatus} Internal Server Error</h1></body></html>`);
      return;
    }
    if (this.missing.has(path)) return notFound();
    if (path.startsWith('/_next/static/chunks/')) {
      const js = this.build.chunks[path.slice('/_next/static/chunks/'.length)];
      return js ? send(200, 'application/javascript; charset=utf-8', js) : notFound();
    }
    if (path === `/_next/static/css/${this.build.css}`) return send(200, 'text/css; charset=utf-8', 'body{margin:0}');
    if (path === '/whitepaper.pdf') return send(200, 'application/pdf', this.pdf);
    if (path === '/robots.txt') return send(200, 'text/plain', `User-agent: *\nAllow: /\nSitemap: ${this.origin}/sitemap.xml\n`);
    if (path === '/sitemap.xml') {
      const urls = [...this.pages().keys()].filter((p) => !this.missing.has(p));
      return send(
        200,
        'application/xml',
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
          .map((p) => `<url><loc>${this.origin}${p}</loc></url>`)
          .join('')}</urlset>`,
      );
    }
    const page = this.pages().get(path);
    if (!page) return notFound();
    send(200, 'text/html; charset=utf-8', this.shell(path, page));
  }
}

// ---------------------------------------------------------------------------
// Discord limit checks (independent of the formatter's own bookkeeping)
// ---------------------------------------------------------------------------

function embedChars(e: MessagePayload['embeds'][number]): number {
  return (
    (e.title?.length ?? 0) +
    (e.description?.length ?? 0) +
    (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0) +
    (e.footer?.text.length ?? 0) +
    (e.author?.name.length ?? 0)
  );
}

function assertDiscordLimits(p: MessagePayload): void {
  const content = p.content ?? '';
  expect(content.length).toBeLessThanOrEqual(2000);
  expect(p.embeds.length > 0 || content.length > 0).toBe(true);
  expect(p.embeds.length).toBeLessThanOrEqual(10);
  let total = 0;
  for (const e of p.embeds) {
    if (e.title !== undefined) expect(e.title.length).toBeLessThanOrEqual(256);
    if (e.description !== undefined) {
      expect(e.description.length).toBeGreaterThan(0);
      expect(e.description.length).toBeLessThanOrEqual(4096);
      expect((e.description.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(e.fields?.length ?? 0).toBeLessThanOrEqual(25);
    for (const f of e.fields ?? []) {
      expect(f.name.length).toBeGreaterThan(0);
      expect(f.name.length).toBeLessThanOrEqual(256);
      expect(f.value.length).toBeGreaterThan(0);
      expect(f.value.length).toBeLessThanOrEqual(1024);
    }
    if (e.footer) expect(e.footer.text.length).toBeLessThanOrEqual(2048);
    if (e.url !== undefined) expect(new URL(e.url).protocol).toMatch(/^https?:$/);
    total += embedChars(e);
  }
  expect(total).toBeLessThanOrEqual(6000);
  expect(p.components?.length ?? 0).toBeLessThanOrEqual(5);
}

// ---------------------------------------------------------------------------
// The story
// ---------------------------------------------------------------------------

describe('e2e: monitor against a fake Next.js app-router site', () => {
  const site = new FakeNextSite();
  const clock = { now: Date.UTC(2026, 8, 28, 12, 0, 0) };
  const delivered: Array<{ watch: Watch; alerts: Alert[] }> = [];
  const notifier: Notifier = {
    notify: async (watch, alerts) => {
      delivered.push({ watch, alerts });
    },
  };
  const ct: CtProvider = {
    certspotter: vi.fn(async () => ({ names: [], cursor: null })),
    crtsh: vi.fn(async () => []),
  };
  const dns: DnsProvider = { resolve: vi.fn(async () => null), wildcard: vi.fn(async () => null) };
  const allAlerts: Alert[] = [];
  let store: Store;
  let monitor: Monitor;
  let watch: Watch;

  /** Advance the fake clock, run one normal check, and return its alerts (also asserting they were delivered as-is). */
  async function tick(advanceMs: number, opts: { full?: boolean } = {}): Promise<TickSummary> {
    clock.now += advanceMs;
    const before = delivered.length;
    const res = await monitor.checkNow(watch.id, opts);
    expect(res.error).toBeNull();
    if (res.alerts.length === 0) {
      expect(delivered.length).toBe(before);
    } else {
      expect(delivered.length).toBe(before + 1);
      expect(delivered[before].alerts).toEqual(res.alerts);
    }
    allAlerts.push(...res.alerts);
    return res;
  }
  /** Nothing tracked is due: only the homepage (status/deploy) is looked at. */
  const SHORT = 61_000;
  /** Everything tracked (pages & files, sweepSec 600) is due again. */
  const LONG = 601_000;

  const kinds = (r: TickSummary) => r.alerts.map((a) => a.kind);
  const find = <K extends Alert['kind']>(r: TickSummary, kind: K) =>
    r.alerts.filter((a): a is Extract<Alert, { kind: K }> => a.kind === kind);

  beforeAll(async () => {
    await site.start();
    store = new Store(':memory:');
    const config = testConfig({ confirmDelayMs: 0 });
    const client = new HttpClient({
      userAgent: config.userAgent,
      globalConcurrency: config.globalConcurrency,
      perHostConcurrency: config.perHostConcurrency,
      timeoutMs: config.requestTimeoutMs,
      maxBytes: config.maxBodyBytes,
      allowPrivate: true,
    });
    monitor = new Monitor({
      store,
      http: client,
      notifier,
      config,
      log: silentLogger,
      providers: { ct, dns },
      now: () => clock.now,
      sleep: async () => {},
    });
    watch = store.createWatch({
      guildId: 'g1',
      channelId: 'c1',
      name: 'Acme',
      url: site.url('/'),
      host: '127.0.0.1',
      rootDomain: '127.0.0.1',
      createdBy: 'u1',
      // interval = sweep: a LONG advance makes every tracked page due AND within the per-pass budget
      // (max(5, tracked × interval / sweep)); a SHORT advance makes nothing due.
      intervalSec: 600,
      sweepSec: 600,
    });
  });

  afterAll(async () => {
    await monitor?.stop();
    await site.close();
    store?.close();
  });

  it('baseline records everything silently and reports counts', async () => {
    const summary = await monitor.runBaseline(watch.id);
    expect(summary).toMatchObject({
      watchId: watch.id,
      pagesTracked: 8, // /, /docs, 4 docs pages, /ticker, /community
      files: 1,
      subdomains: 0,
      buildId: BUILD_1.buildId,
      homeStatus: 200,
      homeBlocked: false,
    });
    expect(summary.pagesKnown).toBeGreaterThanOrEqual(summary.pagesTracked);
    expect(summary.assets).toBe(Object.keys(BUILD_1.chunks).length + 1); // scripts (+ preload dup) + stylesheet
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);

    expect(delivered).toHaveLength(0);
    expect(store.listEvents(watch.id, 10)).toHaveLength(0);
    watch = store.getWatch(watch.id)!;
    expect(watch.baselineDone).toBe(true);
    const state = store.getState(watch.id);
    expect(state.baselineAt).toBe(clock.now);
    expect(state.codePaths).toEqual(expect.arrayContaining(['/docs', '/docs/getting-started']));
    // An IP-literal watch has no public subdomains to discover: CT and DNS are never consulted.
    expect(ct.certspotter).not.toHaveBeenCalled();
    expect(dns.resolve).not.toHaveBeenCalled();
  });

  it('five stable ticks produce no change alerts (per-request nonces and a live ticker are not changes)', async () => {
    const infos: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await tick(LONG);
      for (const a of r.alerts) {
        expect(a.kind).toBe('info');
        infos.push((a as InfoAlert).message);
      }
    }
    // The ticker's numbers change on every load: it was learned as a live-numbers page instead of alerting — said once.
    expect(infos).toEqual(['ℹ️ /ticker shows live numbers; ignoring number-only changes on the lines that tick.']);
    expect(delivered).toHaveLength(1);
    expect(store.getPage(watch.id, site.url('/ticker'))?.maskedLines.length).toBeGreaterThan(0);
    expect(monitor.runtimeInfo(watch.id)).toMatchObject({ running: false, baselineRunning: false, lastTickAt: clock.now });
    expect(monitor.lastActivityAt()).toBe(clock.now);
  });

  it('redeploy → exactly one deploy alert with new code paths, and the full sweep catches docs edits in the same tick', async () => {
    site.build = BUILD_2;
    site.docs.get('/docs/tokenomics')!.paras[1] = 'Team allocation is twenty percent, vested over four years.';
    site.docs.get('/docs/getting-started')!.paras.push('Bridged assets are supported too.');

    const r = await tick(SHORT); // docs pages are NOT due: only the post-deploy full sweep can see these edits
    expect(kinds(r)).toEqual(['deploy', 'text']);
    const [deploy] = find(r, 'deploy') as DeployAlert[];
    expect(deploy.buildIdOld).toBe(BUILD_1.buildId);
    expect(deploy.buildIdNew).toBe(BUILD_2.buildId);
    expect(deploy.assetsAdded.length).toBeGreaterThanOrEqual(4);
    expect(deploy.assetsRemoved.length).toBeGreaterThanOrEqual(3);
    expect(deploy.newCodePaths).toContain('/airdrop');
    expect(deploy.newCodePaths).not.toContain('/docs');
    expect(deploy.newCodeHosts).toContain('rpc.acmefi.io');

    const [text] = find(r, 'text') as TextAlert[];
    expect(text.changes.map((c) => c.url).sort()).toEqual([site.url('/docs/getting-started'), site.url('/docs/tokenomics')]);
    const tok = text.changes.find((c) => c.url.endsWith('/tokenomics'))!;
    expect(tok.diff.added).toContain('Team allocation is twenty percent, vested over four years.');
    expect(tok.diff.removed).toContain('Team allocation is fifteen percent, vested.');

    // /airdrop is referenced by code but not live yet: it is probed, never recorded or announced.
    expect(site.requests).toContain('/airdrop');
    expect(store.getPage(watch.id, site.url('/airdrop'))).toBeUndefined();

    // The new build is now the reference: no repeat alert.
    expect((await tick(SHORT)).alerts).toEqual([]);
    expect(store.listEvents(watch.id, 10).map((e) => e.kind).sort()).toEqual(['deploy', 'info', 'text']);
  });

  it('docs text edit → one text alert with a readable diff', async () => {
    site.docs.get('/docs/faq')!.paras[0] = 'Is Acme audited? Yes, by three independent firms.';
    const r = await tick(LONG);
    expect(kinds(r)).toEqual(['text']);
    const [text] = find(r, 'text') as TextAlert[];
    expect(text.changes).toHaveLength(1);
    const change = text.changes[0];
    expect(change.url).toBe(site.url('/docs/faq'));
    expect(change.title).toBe('FAQ | Acme Docs');
    expect(change.diff.numericOnly).toBe(false);
    expect(change.diff.unified).toContain('+ Is Acme audited? Yes, by three independent firms.');
    expect(change.diff.unified).toContain('- Is Acme audited? Yes, by two firms.');
    expect(text.groups).toHaveLength(1);
  });

  it('nav edit on every page → one text alert whose changes collapse into a single group', async () => {
    site.nav.push(['https://snapshot.org/#/acme.eth', 'Governance']);
    const r = await tick(LONG);
    expect(kinds(r)).toEqual(['text']);
    const [text] = find(r, 'text') as TextAlert[];
    expect(text.changes).toHaveLength(8); // including the live ticker (numbers masked) and the homepage
    expect(text.groups).toHaveLength(1);
    expect(text.groups[0].urls).toHaveLength(8);
    expect(text.groups[0].diff.added).toEqual(['Governance']);
    expect(text.groups[0].diff.removed).toEqual([]);
    expect((await tick(LONG)).alerts).toEqual([]);
  });

  it('new page linked from the docs index → new_pages (plus the index text change)', async () => {
    site.docs.set('/docs/staking', { title: 'Staking', paras: ['Stake ACME to earn protocol fees.'] });
    const r = await tick(LONG);
    expect(kinds(r)).toEqual(['text', 'new_pages']);
    const [np] = find(r, 'new_pages') as NewPagesAlert[];
    expect(np.pages).toEqual([{ url: site.url('/docs/staking'), title: 'Staking | Acme Docs', source: 'link' }]);
    expect(store.getPage(watch.id, site.url('/docs/staking'))?.tracked).toBe(true);
    // The sidebar on every docs page gained the link: one grouped diff.
    const [text] = find(r, 'text') as TextAlert[];
    expect(text.groups[0].diff.added).toEqual(['Staking']);
    expect((await tick(LONG)).alerts).toEqual([]);
  });

  it('page removed → removed_pages only after the second 404', async () => {
    site.missing.add('/docs/risks');
    expect((await tick(LONG)).alerts).toEqual([]);
    const r = await tick(LONG);
    expect(kinds(r)).toEqual(['removed_pages']);
    const [rm] = find(r, 'removed_pages') as RemovedPagesAlert[];
    expect(rm.pages).toEqual([{ url: site.url('/docs/risks'), status: 404 }]);
    expect((await tick(LONG)).alerts).toEqual([]);
  });

  it('whitepaper bytes change → file alert', async () => {
    const oldSize = site.pdf.length;
    site.pdf = Buffer.from('%PDF-1.4\n% Acme whitepaper v2 — now with a staking chapter\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
    const r = await tick(LONG);
    expect(kinds(r)).toEqual(['file']);
    const [file] = find(r, 'file') as FileAlert[];
    expect(file.files).toEqual([
      { url: site.url('/whitepaper.pdf'), change: 'modified', oldSize, newSize: site.pdf.length, contentType: 'application/pdf' },
    ]);
    expect((await tick(LONG)).alerts).toEqual([]);
  });

  it('homepage 500 ×3 → one DOWN alert, then one UP alert on recovery', async () => {
    site.homeStatus = 500;
    expect((await tick(SHORT)).alerts).toEqual([]);
    expect((await tick(SHORT)).alerts).toEqual([]);
    const down = await tick(SHORT);
    expect(kinds(down)).toEqual(['status']);
    expect(down.alerts[0]).toMatchObject({ kind: 'status', up: false, detail: 'HTTP 500', url: watch.url });
    expect((await tick(SHORT)).alerts).toEqual([]); // still down: no repeat

    site.homeStatus = 200;
    const up = await tick(SHORT);
    expect(kinds(up)).toEqual(['status']);
    const s = up.alerts[0] as StatusAlert;
    expect(s.up).toBe(true);
    expect(s.downForMs).toBe(4 * SHORT);
    expect((await tick(SHORT)).alerts).toEqual([]);
  });

  it('live ticker never produced a text alert', () => {
    const tickerUrl = site.url('/ticker');
    const tickerOnly = allAlerts.filter(
      (a) => a.kind === 'text' && a.changes.some((c) => c.url === tickerUrl) && a.changes.length === 1,
    );
    expect(tickerOnly).toEqual([]);
  });

  it('a tick with every kind of change delivers alerts in order: deploy, text, new_pages, removed_pages, file, status, info', async () => {
    // Prepare: a page that changes on every load (dynamic after 3 unstable checks) and a page whose first 404 is recorded.
    site.flappy = true;
    expect((await tick(LONG)).alerts).toEqual([]); // flap 1
    site.missing.add('/docs/faq');
    expect((await tick(LONG)).alerts).toEqual([]); // flap 2, faq 404 #1
    site.homeStatus = 500;
    await tick(SHORT);
    await tick(SHORT);
    expect(kinds(await tick(SHORT))).toEqual(['status']);

    // Everything at once: back up with a new build, edited docs, a new page, a second 404, a new whitepaper, a 3rd flap.
    site.homeStatus = 200;
    site.build = BUILD_3;
    site.docs.get('/docs/tokenomics')!.paras.push('Emissions end in 2030.');
    site.docsIndexExtra = '<p><a href="/docs/security">Security overview</a></p>';
    site.docs.set('/docs/security', { title: 'Security', paras: ['Programs are immutable.'] });
    site.pdf = Buffer.from('%PDF-1.4\n% Acme whitepaper v3\n%%EOF\n');
    const r = await tick(SHORT);
    expect(kinds(r)).toEqual(['deploy', 'text', 'new_pages', 'removed_pages', 'file', 'status', 'info']);
    expect((r.alerts[3] as RemovedPagesAlert).pages.map((p) => p.url)).toEqual([site.url('/docs/faq')]);
    expect((r.alerts[5] as StatusAlert).up).toBe(true);
    expect((r.alerts[6] as InfoAlert).message).toContain('/community');
    expect(store.getPage(watch.id, site.url('/community'))?.dynamic).toBe(true);

    // Events mirror the delivered alerts, one per alert, with one-line summaries.
    const events = store.listEvents(watch.id, 7);
    expect(events.map((e) => e.kind).reverse()).toEqual(kinds(r));
    for (const e of events) expect(e.summary).toBe(summarizeAlert(r.alerts.find((a) => a.kind === e.kind)!));

    // Settles: nothing more to say.
    expect((await tick(SHORT)).alerts).toEqual([]);
    expect((await tick(LONG)).alerts).toEqual([]);
  });

  it('every alert produced in this run renders within Discord limits', () => {
    expect(allAlerts.length).toBeGreaterThanOrEqual(15);
    const w = { ...watch, pingRoleId: '123456789012345678' };
    for (const alert of allAlerts) {
      const payloads = formatAlerts(w, [alert]);
      expect(payloads.length).toBeGreaterThan(0);
      for (const p of payloads) assertDiscordLimits(p);
    }
    // And as the batches the notifier actually received.
    for (const { alerts } of delivered) {
      for (const p of formatAlerts(w, alerts)) assertDiscordLimits(p);
    }
  });
});
