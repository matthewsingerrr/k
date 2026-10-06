/**
 * Local Link API server for the browser extension's integration tests — no Discord, no Railway.
 *
 *   npm run dev:link                      # API on http://127.0.0.1:8721/api/v1, fixture site on :8722
 *   PORT=8731 npm run dev:link            # another port (the fixture site uses PORT + 1 unless DEV_SITE_PORT is set)
 *
 * It runs the bot's real HTTP server (/health + the Link API), the real monitor (scheduler) and the real store
 * (in-memory SQLite, or DEV_DB=<file>). Discord is faked: a cached server with channels and roles answers the guildInfo
 * lookups, and Discord notices and alerts are printed to the console instead of posted.
 *
 * Seeded on every start:
 * - "Dev Server" (guild 1280000000000000000) with a fixed token (DEV_TOKEN, default below), alert channel #scans:
 *   #1 "Fixture"            http://127.0.0.1:<site>/      — a local fixture website, crawled for real (offline)
 *   #2 "Fixture docs"       http://localhost:<site>/docs  — the same site under another host name, every 30 s
 *   #3 "Hookedpad (seeded)" https://hookedpad.com/        — paused, never fetched; a full card: 17 tracked pages
 *                            (1 too dynamic), 51 bundles, 3 subdomains, rules, a ping role and 30 history events.
 *                            Resuming it makes the monitor fetch the real hookedpad.com.
 *   + one watch per URL in DEV_SEED_URLS (comma-separated; real network crawls).
 * - "Other Server" (guild 1380000000000000000) with its own token (DEV_OTHER_TOKEN) and one paused watch, for
 *   cross-server checks (its watch id is a 404 with the Dev Server token).
 *
 * The fixture site: GET /__bump makes the next check see a redeploy, a text change on /about and a new page.
 *
 * Env: PORT (8721), DEV_SITE_PORT (PORT + 1), DEV_DB (:memory:), DEV_TOKEN, DEV_OTHER_TOKEN, DEV_SEED_URLS,
 * DEV_ALLOW_PRIVATE=1 (the API accepts private / local targets, as with ALLOW_PRIVATE_NETWORK), DEV_REAL_NET=1 (real
 * Certificate Transparency and DNS lookups for subdomains; default: offline stubs), LOG_LEVEL (info).
 */

import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testConfig, type Config } from '../src/config.js';
import { Store, hashLinkToken } from '../src/db/store.js';
import { HttpClient } from '../src/net/http.js';
import { createDnsProvider, type DnsProvider } from '../src/net/dns.js';
import { createCtProvider, type CtProvider } from '../src/monitor/subdomains.js';
import { Monitor } from '../src/monitor/scheduler.js';
import { createLinkApi, type GuildSnapshot } from '../src/link/api.js';
import { LINK_API_PREFIX } from '../src/link/types.js';
import { startHealthServer } from '../src/health.js';
import { createLogger, silentLogger } from '../src/log.js';
import { ConsoleNotifier } from '../src/cli.js';
import { parseWatchInput } from '../src/extract/url.js';
import type { DeployFingerprint, Logger, Notifier, PageRecord, Watch } from '../src/types.js';

export const DEV_GUILD_ID = '1280000000000000000';
export const DEV_OTHER_GUILD_ID = '1380000000000000000';
export const DEV_CHANNELS = {
  scans: '1290000000000000001',
  alerts: '1290000000000000002',
  announcements: '1290000000000000003',
  other: '1390000000000000001',
} as const;
export const DEV_ROLES = { alpha: '1280000000000000077', bots: '1280000000000000078', other: '1380000000000000077' } as const;
/** Fixed so the extension's tests can hard-code them; local use only ("swb_" + 43 URL-safe characters, like real ones). */
export const DEFAULT_DEV_TOKEN = 'swb_dev-local-link-token-for-extension-tests000';
export const DEFAULT_DEV_OTHER_TOKEN = 'swb_dev-other-server-token-for-isolation-test00';

export interface DevLinkServerOptions {
  /** API port (0 = any free port). */
  port?: number;
  /** Fixture site port (0 = any free port). */
  sitePort?: number;
  /** SQLite file, default in-memory. */
  db?: string;
  token?: string;
  otherToken?: string;
  /** Extra watches of real sites in the Dev Server. */
  seedUrls?: string[];
  /** The API accepts private / local targets (ALLOW_PRIVATE_NETWORK). */
  allowPrivate?: boolean;
  /** Real CT / DNS lookups for subdomains (default: offline stubs). */
  realNet?: boolean;
  log?: Logger;
  /** Where the banner, Discord notices and alerts go (default: stdout). */
  write?: (line: string) => void;
}

export interface DevLinkServer {
  apiUrl: string;
  siteUrl: string;
  port: number;
  sitePort: number;
  token: string;
  otherToken: string;
  watches: Array<{ id: number; guildId: string; name: string; url: string; paused: boolean }>;
  /** Discord notices the API sent ("➕ … was added from …"), in order. */
  announced: Array<{ channelId: string; content: string }>;
  store: Store;
  monitor: Monitor;
  /** Makes the fixture site redeploy (new bundles), change /about and link a new page. */
  bump(): number;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Fake Discord
// ---------------------------------------------------------------------------

function devGuilds(): Record<string, GuildSnapshot> {
  return {
    [DEV_GUILD_ID]: {
      guild: { id: DEV_GUILD_ID, name: 'Dev Server' },
      channels: [
        { id: DEV_CHANNELS.scans, name: 'scans', type: 'text', category: 'MONITORING', canPost: true, missing: [] },
        { id: DEV_CHANNELS.alerts, name: 'alerts', type: 'text', category: 'MONITORING', canPost: true, missing: [] },
        { id: DEV_CHANNELS.announcements, name: 'announcements', type: 'announcement', category: null, canPost: false, missing: ['Send Messages'] },
      ],
      roles: [
        { id: DEV_ROLES.bots, name: 'Site Watcher', everyone: false, managed: true, color: 0 },
        { id: DEV_ROLES.alpha, name: 'Alpha', everyone: false, managed: false, color: 15844367 },
        { id: DEV_GUILD_ID, name: '@everyone', everyone: true, managed: false, color: 0 },
      ],
      otherChannels: [],
    },
    [DEV_OTHER_GUILD_ID]: {
      guild: { id: DEV_OTHER_GUILD_ID, name: 'Other Server' },
      channels: [{ id: DEV_CHANNELS.other, name: 'other-alerts', type: 'text', category: null, canPost: true, missing: [] }],
      roles: [
        { id: DEV_ROLES.other, name: 'Theirs', everyone: false, managed: false, color: 0 },
        { id: DEV_OTHER_GUILD_ID, name: '@everyone', everyone: true, managed: false, color: 0 },
      ],
    },
  };
}

function channelName(id: string): string {
  for (const g of Object.values(devGuilds())) {
    const c = g.channels.find((x) => x.id === id);
    if (c) return `#${c.name}`;
  }
  return id;
}

/** Subdomain lookups without the network (the fixture site is an IP / localhost anyway). */
const offlineCt: CtProvider = { certspotter: async (_domain, cursor) => ({ names: [], cursor }), crtsh: async () => [] };
const offlineDns: DnsProvider = { resolve: async () => null, wildcard: async () => null };

// ---------------------------------------------------------------------------
// Fixture website
// ---------------------------------------------------------------------------

function fixtureSite(): { server: http.Server; bump: () => number } {
  let version = 1;
  const html = (title: string, body: string) =>
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><meta name="generator" content="Fixture CMS 1.0">` +
    `<script src="/_next/static/chunks/main-v${version}.js" defer></script><link rel="stylesheet" href="/_next/static/css/app-v${version}.css">` +
    `</head><body><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/docs">Docs</a> <a href="/docs/intro">Intro</a> ` +
    `<a href="/pricing">Pricing</a> <a href="/whitepaper.pdf">Whitepaper</a>${version > 1 ? ` <a href="/changelog-v${version}">Changelog v${version}</a>` : ''}</nav>` +
    `<main>${body}</main><script id="__NEXT_DATA__" type="application/json">{"buildId":"fixture-v${version}","page":"/"}</script></body></html>`;
  const pages: Record<string, () => string> = {
    '/': () => html('Fixture Home', '<h1>Fixture</h1><p>A local site for the Site Watcher Link API tests.</p>'),
    '/about': () => html('About Fixture', `<h1>About</h1><p>Release ${version}: the team ships every day.</p>`),
    '/docs': () => html('Docs', '<h1>Docs</h1><p>Start with the <a href="/docs/intro">introduction</a>.</p>'),
    '/docs/intro': () => html('Introduction', '<h1>Introduction</h1><p>Install, configure, launch.</p>'),
    '/pricing': () => html('Pricing', '<h1>Pricing</h1><p>Free while in beta.</p>'),
  };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (path === '/__bump') {
      version++;
      send(200, 'application/json', JSON.stringify({ version }));
      return;
    }
    const page = pages[path] ?? (path === `/changelog-v${version}` && version > 1 ? () => html(`Changelog v${version}`, `<h1>v${version}</h1>`) : null);
    if (page) return send(200, 'text/html; charset=utf-8', page());
    if (path.startsWith('/_next/static/chunks/main-v')) {
      return send(200, 'application/javascript', `fetch("/api/status");const API="https://api.fixture.test/v1";console.log("fixture v${version}")`);
    }
    if (path.startsWith('/_next/static/css/app-v')) return send(200, 'text/css', 'body{font-family:sans-serif}');
    if (path === '/api/status') return send(200, 'application/json', JSON.stringify({ ok: true, version }));
    if (path === '/whitepaper.pdf') return send(200, 'application/pdf', Buffer.from(`%PDF-1.4\n% fixture whitepaper v1\n%%EOF\n`));
    if (path === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nAllow: /\n');
    send(404, 'text/plain', 'not found');
  });
  return { server, bump: () => ++version };
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

function pageRec(watchId: number, url: string, over: Partial<PageRecord> = {}): PageRecord {
  return {
    watchId,
    url,
    kind: 'page',
    tracked: true,
    title: null,
    text: '',
    textHash: null,
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
    firstSeen: Date.now() - 86_400_000,
    lastChecked: Date.now() - 60_000,
    lastChanged: null,
    ...over,
  };
}

/** A paused watch with the data of a long-running one (never fetched while paused). */
function seedHookedpad(store: Store): Watch {
  const now = Date.now();
  const w = store.createWatch({
    guildId: DEV_GUILD_ID,
    channelId: DEV_CHANNELS.scans,
    name: 'Hookedpad (seeded)',
    url: 'https://hookedpad.com/',
    host: 'hookedpad.com',
    rootDomain: 'hookedpad.com',
    createdBy: 'dev-seed',
    intervalSec: 2,
    sweepSec: 120,
    maxPages: 150,
    pingRoleId: DEV_ROLES.alpha,
    features: { subdomains: true },
    ignorePatterns: ['Last updated.*'],
    excludePatterns: ['/profile/*'],
    extraUrls: ['https://hookedpad.com/secret'],
  });
  const paths = ['/', '/launch', '/docs', '/docs/rules', '/pricing', '/faq', '/terms', '/privacy', '/blog', '/blog/v2', '/team', '/careers', '/status', '/api', '/changelog', '/secret', '/contact'];
  const pages = paths.map((p, i) =>
    pageRec(w.id, `https://hookedpad.com${p}`, { title: p === '/' ? 'Hookedpad' : p.slice(1), depth: p === '/' ? 0 : 1, source: p === '/' ? 'start' : 'link', firstSeen: now - 86_400_000 + i, dynamic: p === '/status' }),
  );
  pages.push(pageRec(w.id, 'https://hookedpad.com/old-launch', { tracked: false, depth: 2 }));
  store.upsertPages(pages);
  store.upsertSubdomains([
    {
      watchId: w.id,
      host: 'app.hookedpad.com',
      sources: ['ct', 'dns'],
      firstSeen: now - 3_600_000,
      lastSeen: now - 60_000,
      alive: true,
      lastProbe: now - 60_000,
      dns: { a: ['76.76.21.21'], aaaa: [], cname: [] },
      http: { status: 200, title: 'Hookedpad App', finalUrl: 'https://app.hookedpad.com/', server: 'Vercel' },
    },
    { watchId: w.id, host: 'docs.hookedpad.com', sources: ['link'], firstSeen: now - 7_200_000, lastSeen: now - 60_000, alive: true, lastProbe: 0, dns: null, http: null },
    { watchId: w.id, host: 'beta.hookedpad.com', sources: ['ct'], firstSeen: now - 7_200_000, lastSeen: now - 7_200_000, alive: false, lastProbe: 0, dns: null, http: null },
  ]);
  const st = store.getState(w.id);
  st.deploy = {
    assets: Array.from({ length: 51 }, (_, i) => `https://hookedpad.com/_next/static/chunks/${i}-abc.js`),
    buildId: null,
    generator: null,
    sig: 'seeded',
    seenAt: now - 3_600_000,
  } as DeployFingerprint;
  st.lastCheckAt = now - 2_000;
  st.lastChangeAt = now - 3_600_000;
  st.baselineAt = now - 86_400_000;
  store.saveState(w.id, st);
  const kinds = ['deploy', 'text', 'new_pages', 'subdomain', 'status'] as const;
  for (let i = 0; i < 30; i++) {
    const kind = kinds[i % kinds.length];
    store.addEvent(w.id, kind, `Hookedpad ${kind.replace('_', ' ')} #${i + 1}`, now - (30 - i) * 600_000);
  }
  return store.updateWatch(w.id, { baselineDone: true, paused: true });
}

function addLiveWatch(store: Store, guildId: string, rawUrl: string, name: string, extra: { intervalSec?: number } = {}): Watch {
  const parsed = parseWatchInput(rawUrl);
  if (!parsed) throw new Error(`not a website URL: ${rawUrl}`);
  return store.createWatch({
    guildId,
    channelId: DEV_CHANNELS.scans,
    name,
    url: parsed.url,
    host: parsed.host,
    rootDomain: parsed.rootDomain,
    createdBy: 'dev-seed',
    intervalSec: extra.intervalSec ?? 5,
    features: { subdomains: false },
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function listen(server: http.Server, port: number, host?: string): Promise<number> {
  if (!server.listening) {
    if (host) server.listen(port, host);
    await once(server, 'listening');
  }
  return (server.address() as AddressInfo).port;
}

export async function startDevLinkServer(opts: DevLinkServerOptions = {}): Promise<DevLinkServer> {
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const log = opts.log ?? silentLogger;
  const token = opts.token ?? DEFAULT_DEV_TOKEN;
  const otherToken = opts.otherToken ?? DEFAULT_DEV_OTHER_TOKEN;
  if (!/^swb_[A-Za-z0-9_-]{20,}$/.test(token) || !/^swb_[A-Za-z0-9_-]{20,}$/.test(otherToken) || token === otherToken) {
    throw new Error('Tokens must look like swb_<at least 20 URL-safe characters> and differ.');
  }

  const site = fixtureSite();
  const sitePort = await listen(site.server, opts.sitePort ?? 0, '127.0.0.1');
  const siteUrl = `http://127.0.0.1:${sitePort}/`;

  const config: Config = testConfig({
    port: opts.port ?? 0,
    minIntervalSec: 1,
    defaultIntervalSec: 2,
    defaultSweepSec: 120,
    maxWatchesPerGuild: 50,
    allowPrivateNetwork: Boolean(opts.allowPrivate),
    requestTimeoutMs: 10_000,
    confirmDelayMs: 500,
    logLevel: 'info',
  });
  const store = new Store(opts.db ?? ':memory:', { intervalSec: config.defaultIntervalSec, sweepSec: config.defaultSweepSec, maxPages: config.defaultMaxPages });
  const httpOptions = {
    userAgent: config.userAgent,
    globalConcurrency: config.globalConcurrency,
    perHostConcurrency: config.perHostConcurrency,
    timeoutMs: config.requestTimeoutMs,
    maxBytes: config.maxBodyBytes,
  };
  // The monitor may crawl the local fixture site; scans through the API follow the API's private-network rule.
  const monitorHttp = new HttpClient({ ...httpOptions, allowPrivate: true });
  const scanHttp = new HttpClient({ ...httpOptions, allowPrivate: config.allowPrivateNetwork });
  const ct = opts.realNet ? createCtProvider(scanHttp, { certspotterApiKey: null, queriesPerHour: config.certspotterQueriesPerHour }) : offlineCt;
  const dns = opts.realNet ? createDnsProvider() : offlineDns;
  const notifier: Notifier = new ConsoleNotifier((text) => write(`[alert] ${text}`));
  const monitor = new Monitor({ store, http: monitorHttp, notifier, config, log: log.child({ mod: 'monitor' }), providers: { ct, dns } });

  // Seeds (a persistent DEV_DB keeps its watches; tokens are re-imported idempotently).
  for (const [t, guildId, channelId, label] of [
    [token, DEV_GUILD_ID, DEV_CHANNELS.scans, 'Dev Chrome'],
    [otherToken, DEV_OTHER_GUILD_ID, DEV_CHANNELS.other, 'Other Chrome'],
  ] as const) {
    store.importLinkToken({ guildId, channelId, label, tokenHash: hashLinkToken(t), createdBy: 'dev-seed', createdAt: Date.now(), lastUsedAt: null });
  }
  if (store.listWatches().length === 0) {
    addLiveWatch(store, DEV_GUILD_ID, siteUrl, 'Fixture');
    addLiveWatch(store, DEV_GUILD_ID, `http://localhost:${sitePort}/docs`, 'Fixture docs', { intervalSec: 30 });
    seedHookedpad(store);
    for (const raw of opts.seedUrls ?? []) {
      const parsed = parseWatchInput(raw);
      if (parsed) addLiveWatch(store, DEV_GUILD_ID, parsed.url, parsed.suggestedName, { intervalSec: 30 });
      else write(`skipping DEV_SEED_URLS entry "${raw}": not a website URL`);
    }
    const other = store.createWatch({
      guildId: DEV_OTHER_GUILD_ID,
      channelId: DEV_CHANNELS.other,
      name: 'Other server site',
      url: 'https://secret.example/',
      host: 'secret.example',
      rootDomain: 'secret.example',
      createdBy: 'dev-seed',
    });
    store.updateWatch(other.id, { paused: true, baselineDone: true });
  }

  const announced: DevLinkServer['announced'] = [];
  const guilds = devGuilds();
  const linkApi = createLinkApi({
    store,
    config,
    log: log.child({ mod: 'link' }),
    getMonitor: () => monitor,
    scan: { http: scanHttp, dns, ct },
    isGuildActive: (guildId) => guildId in guilds,
    isRestoring: () => false,
    guildInfo: (guildId) => guilds[guildId] ?? null,
    announce: async (channelId, content) => {
      announced.push({ channelId, content });
      write(`[discord ${channelName(channelId)}] ${content}`);
    },
  });
  const health = startHealthServer(
    config.port,
    {
      discordReady: () => true,
      everReady: () => true,
      watches: () => store.listWatches().length,
      lastActivityAt: () => monitor.lastActivityAt(),
      httpStats: () => monitorHttp.stats(),
    },
    log,
    { linkApi, host: '127.0.0.1' }, // local only: the tokens are fixed and published
  );
  const port = await listen(health, config.port);

  monitor.start();
  // The fixture watches' first (silent) scans, so their cards are full from the first request.
  const fixtures = store.listWatches(DEV_GUILD_ID).filter((w) => !w.baselineDone && !w.paused);
  await Promise.all(
    fixtures.map((w) =>
      monitor.runBaseline(w.id).catch((err: unknown) => write(`first scan of ${w.name} failed: ${err instanceof Error ? err.message : String(err)}`)),
    ),
  );

  const watches = store.listWatches().map((w) => ({ id: w.id, guildId: w.guildId, name: w.name, url: w.url, paused: w.paused }));
  const apiUrl = `http://127.0.0.1:${port}${LINK_API_PREFIX}`;
  let closed = false;
  return {
    apiUrl,
    siteUrl,
    port,
    sitePort,
    token,
    otherToken,
    watches,
    announced,
    store,
    monitor,
    bump: site.bump,
    close: async () => {
      if (closed) return;
      closed = true;
      await monitor.stop();
      health.closeAllConnections?.();
      site.server.closeAllConnections?.();
      await Promise.all([new Promise<void>((r) => health.close(() => r())), new Promise<void>((r) => site.server.close(() => r()))]);
      store.close();
    },
  };
}

function banner(s: DevLinkServer): string {
  const rows = s.watches.map((w) => `    #${w.id}  ${w.guildId === DEV_GUILD_ID ? 'Dev Server  ' : 'Other Server'}  ${w.paused ? 'paused ' : 'running'}  ${w.name} — ${w.url}`);
  return [
    '',
    'Site Watcher — local Link API (no Discord)',
    `  API URL      ${s.apiUrl}`,
    `  token        ${s.token}    (Dev Server ${DEV_GUILD_ID}, alerts in #scans ${DEV_CHANNELS.scans})`,
    `  other token  ${s.otherToken}    (Other Server ${DEV_OTHER_GUILD_ID})`,
    `  health       http://127.0.0.1:${s.port}/health`,
    `  fixture site ${s.siteUrl}   (GET ${s.siteUrl}__bump → redeploy + text change + new page)`,
    '  channels     #scans 1290000000000000001 · #alerts 1290000000000000002 · #announcements 1290000000000000003 (bot cannot post)',
    '  roles        @Alpha 1280000000000000077 · @Site Watcher 1280000000000000078 (managed) · @everyone 1280000000000000000',
    '  watches',
    ...rows,
    '  Ctrl-C to stop.',
    '',
  ].join('\n');
}

function invokedDirectly(): boolean {
  try {
    const entry = process.argv[1];
    return Boolean(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const env = process.env;
  const port = Number.parseInt(env.PORT ?? '', 10);
  const apiPort = Number.isInteger(port) && port > 0 ? port : 8721;
  const sitePortEnv = Number.parseInt(env.DEV_SITE_PORT ?? '', 10);
  const level = (['debug', 'info', 'warn', 'error'] as const).find((l) => l === env.LOG_LEVEL?.trim().toLowerCase()) ?? 'info';
  startDevLinkServer({
    port: apiPort,
    sitePort: Number.isInteger(sitePortEnv) && sitePortEnv > 0 ? sitePortEnv : apiPort + 1,
    db: env.DEV_DB?.trim() || ':memory:',
    token: env.DEV_TOKEN?.trim() || undefined,
    otherToken: env.DEV_OTHER_TOKEN?.trim() || undefined,
    seedUrls: (env.DEV_SEED_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    allowPrivate: /^(1|true|yes|on)$/i.test(env.DEV_ALLOW_PRIVATE ?? ''),
    realNet: /^(1|true|yes|on)$/i.test(env.DEV_REAL_NET ?? ''),
    log: createLogger(level),
  }).then(
    (server) => {
      process.stdout.write(banner(server) + '\n');
      const stop = () => {
        void server.close().finally(() => process.exit(0));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    },
    (err) => {
      console.error('dev link server failed to start:', err);
      process.exit(1);
    },
  );
}
