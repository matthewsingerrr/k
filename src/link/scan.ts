/**
 * One-off site scan for the Link API (the extension's "Scan" button). Nothing is persisted.
 *
 * Steps (all bounded by one time budget; whatever is not ready when it runs out is left out):
 * 1. parseWatchInput → normalized URL (invalid input throws a ScanInputError with a user-facing message).
 * 2. Homepage GET through the SSRF-safe HttpClient (redirects followed; `finalUrl` noted). A bot challenge, an error status
 *    or an unreachable host is reported in `status` / `blocked` / `error`, never thrown.
 * 3. parseHtml → title, description, og:image, links, assets; fingerprintFromPage → build id and same-site asset count.
 * 4. Up to 25 same-site JS bundles (≤ 3 MB each, ≤ 12 MB in total, 4 at a time; skipped for blocked sites) → analyzeJs
 *    (route paths → apiEndpoints, hostnames → codeHosts) and the concatenated source → detectTech.
 * 5. Socials from the homepage links (+ twitter:site), link counts, Server / X-Powered-By headers and the host's IPs.
 * 6. Subdomains: 'quick' resolves 40 common labels (wildcard answers dropped) plus names under the root domain seen in the
 *    code and links; 'full' also asks Cert Spotter (errors / rate limits just skip it); 'none' skips discovery.
 * 7. `watched`: the guild's watch with the same normalized URL or host.
 *
 * Safety: unless config.allowPrivateNetwork, a URL whose host is an internal name (localhost, *.internal — e.g. Railway's
 * private network — *.local, single labels) or a private / loopback / link-local IP literal is refused up front with a
 * ScanInputError (nothing is fetched or even resolved, so no internal address can leak through `server.ips`); a public name
 * that resolves to a private address is never fetched (the HttpClient refuses it) and says so in `error`. Every string in
 * the result is length-capped (titles and links come from third-party pages and the result is cached), and `ogImage` /
 * social URLs are http(s) only.
 *
 * Results are cached per (normalized url, subdomains mode) for 60 s in a bounded LRU; concurrent scans of the same key
 * share one run. `watched` is filled per call (it depends on the guild).
 */
import net from 'node:net';
import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import type { FetchResult, HttpClient } from '../net/http.js';
import { isInternalHostname, isPrivateAddress, matchesWildcard, type DnsProvider } from '../net/dns.js';
import { mapLimit } from '../net/limiter.js';
import { normalizeSubdomain, type CtProvider } from '../monitor/subdomains.js';
import { fingerprintFromPage, isPlatformAsset } from '../monitor/deploy.js';
import { looksLikeHtml, parseHtml, type ParsedPage } from '../extract/html.js';
import { analyzeJs } from '../extract/js.js';
import { getRootDomain, isUnderDomain, parseWatchInput, type ParsedWatchInput } from '../extract/url.js';
import type { DnsInfo, Logger } from '../types.js';
import { detectTech } from './tech.js';
import type { ScanResult, ScanSubdomain } from './types.js';

export interface ScanDeps {
  http: HttpClient;
  store: Store;
  config: Config;
  dns: DnsProvider;
  ct: CtProvider;
  log: Logger;
  now?: () => number;
}

export interface ScanOptions {
  /** Guild asking (to fill `watched`). */
  guildId: string;
  /** 'quick' (default): DNS check of ~40 common labels + hosts seen in code. 'full': also Cert Spotter (rate-limited, cached). 'none'. */
  subdomains?: 'none' | 'quick' | 'full';
  /** Overall time budget (default 25s); partial results are returned when it runs out. */
  budgetMs?: number;
}

/** Thrown for input that is not a website URL (the Link API answers 400 `invalid_url`). */
export class ScanInputError extends Error {
  readonly code = 'invalid_url';
  constructor(message: string) {
    super(message);
    this.name = 'ScanInputError';
  }
}

export const DEFAULT_SCAN_BUDGET_MS = 25_000;
const MIN_BUDGET_MS = 500;
const MAX_BUDGET_MS = 120_000;
export const SCAN_CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;

const HOME_MAX_BYTES = 3 * 1024 * 1024;
const HOME_TIMEOUT_MS = 15_000;
export const MAX_SCAN_BUNDLES = 25;
const BUNDLE_MAX_BYTES = 3 * 1024 * 1024;
const BUNDLE_TOTAL_MAX_BYTES = 12 * 1024 * 1024;
const BUNDLE_CONCURRENCY = 4;
const BUNDLE_TIMEOUT_MS = 10_000;
/** JS handed to detectTech (its own limit is larger; this keeps the scan's CPU time small). */
const TECH_JS_MAX_CHARS = 6 * 1024 * 1024;

/** ~40 labels for the 'quick' DNS check: the usual surfaces of web apps and crypto projects. */
export const QUICK_SUBDOMAIN_LABELS: readonly string[] = [
  'www', 'app', 'api', 'docs', 'beta', 'staging', 'dev', 'test', 'testnet', 'devnet', 'admin', 'dashboard', 'blog',
  'status', 'cdn', 'static', 'auth', 'wallet', 'swap', 'trade', 'stake', 'staking', 'bridge', 'launch', 'launchpad',
  'presale', 'airdrop', 'claim', 'points', 'rewards', 'mint', 'nft', 'explorer', 'rpc', 'ws', 'v2', 'preview', 'demo',
  'gov', 'data',
];
const DNS_CONCURRENCY = 16;
/** Names (CT / code / link) resolved per scan to fill `alive`; the rest are listed unresolved. */
const MAX_RESOLVES = 150;
const MAX_SUBDOMAINS = 200;
const MAX_CT_NAMES = 1000;
const CT_MAX_PAGES = 2;
/** Fresh Cert Spotter calls all scans together may make per hour (the rest of the quota stays with the monitor). */
export const CT_SCAN_CALLS_PER_HOUR = 3;
const CT_CACHE_MS = 3600_000;
const ctNameCache = new Map<string, { names: string[]; until: number }>();
const ctCalls: number[] = [];

function takeCtCall(nowMs: number): boolean {
  while (ctCalls.length && nowMs - ctCalls[0] >= 3600_000) ctCalls.shift();
  if (ctCalls.length >= CT_SCAN_CALLS_PER_HOUR) return false;
  ctCalls.push(nowMs);
  return true;
}

/** Strip code samples (<pre>, <code>, <textarea>, <xmp>) so docs that *mention* an SDK don't count as using it. */
function withoutCodeSamples(html: string): string {
  return html.replace(/<(pre|code|textarea|xmp)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
}

const MAX_API_ENDPOINTS = 200;
const MAX_CODE_HOSTS = 300;
const MAX_SOCIALS = 40;
const MAX_SOCIALS_PER_KIND = 3;
/** Caps on page-provided strings (they are cached and sent to every caller). */
export const MAX_TITLE_CHARS = 300;
export const MAX_DESCRIPTION_CHARS = 500;
const MAX_RESULT_URL_CHARS = 2048;
const MAX_SOCIAL_URL_CHARS = 300;
const MAX_HOSTNAME_CHARS = 253;
const PRIVATE_FETCH_ERROR = 'The site resolves to a private or internal network address, so the bot did not fetch it.';
const NON_SCRIPT_TYPE_RE = /^(?:image|font|video|audio)\//;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; result: ScanResult }>();
const inflight = new Map<string, Promise<ScanResult>>();

/** Forget cached scans (tests). */
export function resetScanCache(): void {
  cache.clear();
  inflight.clear();
  ctNameCache.clear();
  ctCalls.length = 0;
}

function cacheGet(key: string, now: number): ScanResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at >= SCAN_CACHE_TTL_MS || now < hit.at) {
    cache.delete(key);
    return null;
  }
  // LRU: most recently used last.
  cache.delete(key);
  cache.set(key, hit);
  return hit.result;
}

function cachePut(key: string, result: ScanResult, now: number): void {
  cache.delete(key);
  cache.set(key, { at: now, result });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * True for hosts the bot must never scan or watch on behalf of an outside client (unless ALLOW_PRIVATE_NETWORK): internal
 * names (localhost, *.localhost, *.local, *.internal, single labels) and private / loopback / link-local / CGNAT / multicast
 * IP literals (v4 and v6, bracketed or not).
 */
export function isPrivateTarget(host: string): boolean {
  if (typeof host !== 'string') return true;
  const h = host.trim().toLowerCase().replace(/\.+$/, '');
  return isPrivateAddress(h) || isInternalHostname(h);
}

/** User-facing refusal for isPrivateTarget hosts (shared with the Link API's add path). */
export function privateTargetMessage(host: string): string {
  return `${host.slice(0, 100)} is a private or internal address — only public websites can be scanned or tracked.`;
}

/**
 * Scan `rawUrl` (user input like "unpeg.io" or a full URL; invalid → throws an Error with a user-facing message):
 * fetch the homepage (SSRF-protected HttpClient), parse it, fingerprint the build (deploy fingerprint), fetch up to
 * 25 same-site JS bundles (≤ 3MB each, total ≤ 12MB) for code intel (analyzeJs) and tech detection, collect socials,
 * resolve subdomains per `subdomains`, detect tech, and report whether the guild watches this site.
 * Results are cached per (url, subdomains mode) for 60s. Blocked sites return what could be learned (headers, CT/DNS).
 *
 * The thrown error for bad input is a ScanInputError (`code: 'invalid_url'`). Once the input is valid the scan never
 * throws: network failures, challenges and an exhausted budget all yield a (partial) ScanResult.
 */
export async function scanSite(deps: ScanDeps, rawUrl: string, opts: ScanOptions): Promise<ScanResult> {
  const input = typeof rawUrl === 'string' ? parseWatchInput(rawUrl) : null;
  if (!input) {
    const shown = typeof rawUrl === 'string' ? rawUrl.trim().slice(0, 100) : '';
    throw new ScanInputError(
      `${shown ? `"${shown}"` : 'That'} doesn't look like a website URL — try something like unpeg.io or https://unpeg.io/docs.`,
    );
  }
  if (deps.config?.allowPrivateNetwork !== true && isPrivateTarget(input.host)) {
    throw new ScanInputError(privateTargetMessage(input.host));
  }
  const mode = opts?.subdomains === 'none' || opts?.subdomains === 'full' ? opts.subdomains : 'quick';
  const budget = clampInt(opts?.budgetMs, MIN_BUDGET_MS, MAX_BUDGET_MS, DEFAULT_SCAN_BUDGET_MS);
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const key = `${input.url}\n${mode}`;

  let result = cacheGet(key, now());
  if (!result) {
    let running = inflight.get(key);
    if (!running) {
      running = runScan(deps, input, mode, budget, now)
        .then((r) => {
          cachePut(key, r, now());
          return r;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, running);
    }
    result = await running;
  }
  const out = structuredClone(result);
  out.watched = findWatched(deps.store, opts?.guildId, out);
  return out;
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

interface SubEntry {
  sources: Set<string>;
  info: DnsInfo | null;
  resolved: boolean;
}

async function runScan(
  deps: ScanDeps,
  input: ParsedWatchInput,
  mode: 'none' | 'quick' | 'full',
  budget: number,
  now: () => number,
): Promise<ScanResult> {
  const started = Date.now();
  const deadline = started + budget;
  const left = () => deadline - Date.now();
  const log = deps.log;

  const result: ScanResult = {
    url: input.url,
    finalUrl: input.url,
    host: input.host,
    rootDomain: input.rootDomain,
    status: 0,
    blocked: false,
    error: null,
    title: null,
    description: null,
    ogImage: null,
    tech: [],
    build: { id: null, assets: 0, generator: null },
    server: { server: null, poweredBy: null, ips: [] },
    apiEndpoints: [],
    codeHosts: [],
    subdomains: [],
    socials: [],
    links: { internal: 0, external: 0 },
    watched: null,
    scannedAt: new Date(safeNow(now)).toISOString(),
    elapsedMs: 0,
  };

  // --- started right away, in parallel with the homepage ---------------------------------------------------------
  const root = discoveryRoot(input.rootDomain);
  const subs = new Map<string, SubEntry>();
  let wildcard: Set<string> | null = null;
  const addSub = (host: string, source: string, info?: DnsInfo | null) => {
    if (subs.size >= MAX_SUBDOMAINS * 4 && !subs.has(host)) return;
    let e = subs.get(host);
    if (!e) subs.set(host, (e = { sources: new Set(), info: null, resolved: false }));
    e.sources.add(source);
    if (info !== undefined) {
      e.info = info;
      e.resolved = true;
    }
  };

  const hostIps = resolveIps(deps, input.host, left);
  const sweep =
    root && mode !== 'none'
      ? (async () => {
          wildcard = await within(safe(() => deps.dns.wildcard(root)), left() - 200, null);
          await mapLimit(QUICK_SUBDOMAIN_LABELS, DNS_CONCURRENCY, async (label) => {
            if (left() < 300) return;
            const host = `${label}.${root}`;
            if (host === input.host) return;
            const info = await within(safe(() => deps.dns.resolve(host)), left() - 100, null);
            if (info && !matchesWildcard(info, wildcard)) addSub(host, 'dns', info);
          });
        })().catch((err) => log.debug('scan: dns sweep failed', { root, err: errText(err) }))
      : Promise.resolve();
  const ct =
    root && mode === 'full'
      ? (async () => {
          // Cert Spotter's quota is shared with the 24/7 monitor: scans get at most CT_SCAN_CALLS_PER_HOUR fresh
          // calls, and a domain's names are reused for an hour.
          const cached = ctNameCache.get(root);
          let names: string[] | null = cached && cached.until > now() ? cached.names : null;
          if (!names && takeCtCall(now())) {
            const res = await within(safe(() => deps.ct.certspotter(root, null, CT_MAX_PAGES)), left() - 500, null);
            if (res) {
              names = res.names ?? [];
              ctNameCache.set(root, { names, until: now() + CT_CACHE_MS });
              if (ctNameCache.size > 500) ctNameCache.delete(ctNameCache.keys().next().value as string);
            }
          }
          let n = 0;
          for (const name of names ?? []) {
            const host = normalizeSubdomain(name, root);
            if (!host || host === input.host) continue;
            addSub(host, 'ct');
            if (++n >= MAX_CT_NAMES) break;
          }
        })().catch((err) => log.debug('scan: cert spotter failed', { root, err: errText(err) }))
      : Promise.resolve();

  // --- homepage ------------------------------------------------------------------------------------------------
  let home: FetchResult | null = null;
  try {
    home = await deps.http.fetch(input.url, {
      timeoutMs: Math.max(1000, Math.min(HOME_TIMEOUT_MS, left() - 1500)),
      maxBytes: HOME_MAX_BYTES,
      retries: 0,
    });
  } catch (err) {
    result.error = `could not fetch the homepage: ${errText(err)}`;
  }

  let parsed: ParsedPage | null = null;
  let html = '';
  let headers: Record<string, string> = {};
  let finalHost = input.host;
  if (home) {
    headers = home.headers ?? {};
    result.status = home.status;
    result.blocked = home.blocked === true;
    if (home.finalUrl && home.status !== 0) {
      result.finalUrl = home.finalUrl;
      finalHost = hostnameOf(home.finalUrl) ?? input.host;
    }
    result.server.server = headerValue(headers, 'server');
    result.server.poweredBy = headerValue(headers, 'x-powered-by');
    html = typeof home.bodyText === 'string' && looksLikeHtml(home.contentType, home.bodyText) ? home.bodyText : '';
    if (home.status === 0) {
      result.error = home.error?.startsWith('blocked private address') ? PRIVATE_FETCH_ERROR : (home.error ?? 'unreachable');
    }
    else if (result.blocked) result.error = 'The site answered with a bot-protection challenge, so only headers, DNS and subdomains were checked.';
    else if (home.status === 429) result.error = home.error ?? 'HTTP 429 (rate limited)';
    else if (home.status >= 400) result.error = `HTTP ${home.status}`;
    if (html && !result.blocked) {
      try {
        parsed = parseHtml(html, result.finalUrl);
      } catch (err) {
        log.debug('scan: parse failed', { url: result.finalUrl, err: errText(err) });
      }
    }
  }
  const siteRoot = getRootDomain(finalHost) || input.rootDomain;

  // --- page facts ----------------------------------------------------------------------------------------------
  const linkHosts = new Set<string>();
  const htmlHosts = new Set<string>();
  if (parsed) {
    result.title = capText(parsed.title, MAX_TITLE_CHARS);
    result.description = capText(parsed.description, MAX_DESCRIPTION_CHARS);
    result.ogImage = httpUrl(parsed.ogImage, MAX_RESULT_URL_CHARS);
    try {
      const fp = fingerprintFromPage(parsed, siteRoot, safeNow(now));
      result.build = { id: fp.buildId, assets: fp.assets.length, generator: parsed.generator };
    } catch {
      result.build = { id: parsed.buildId, assets: 0, generator: parsed.generator };
    }
    for (const link of parsed.links) {
      const h = hostnameOf(link);
      if (!h) continue;
      linkHosts.add(h);
      if (isUnderDomain(h, siteRoot)) result.links.internal++;
      else result.links.external++;
    }
    for (const h of parsed.hosts) if (!linkHosts.has(h)) htmlHosts.add(h);
    result.socials = collectSocials(parsed.links, html, siteRoot);
  }

  // --- JS bundles ----------------------------------------------------------------------------------------------
  const codePaths = new Set<string>();
  const jsHosts = new Set<string>();
  const jsParts: string[] = [];
  if (parsed) {
    for (const p of safeAnalyze(html).paths) codePaths.add(p);
    const urls = bundleUrls(parsed, siteRoot).slice(0, MAX_SCAN_BUNDLES);
    let totalBytes = 0;
    let reserved = 0;
    let jsChars = 0;
    let stop = false;
    await mapLimit(urls, BUNDLE_CONCURRENCY, async (url) => {
      // Bytes promised to fetches still in flight count against the total cap too.
      let mine = 0;
      try {
        if (stop || left() < 1500 || totalBytes + reserved >= BUNDLE_TOTAL_MAX_BYTES) return;
        mine = Math.max(1024, Math.min(BUNDLE_MAX_BYTES, BUNDLE_TOTAL_MAX_BYTES - totalBytes - reserved));
        reserved += mine;
        const res = await deps.http.fetch(url, {
          accept: '*/*',
          retries: 0,
          maxBytes: mine,
          timeoutMs: Math.max(1000, Math.min(BUNDLE_TIMEOUT_MS, left() - 1000)),
        });
        reserved -= mine;
        mine = 0;
        if (res.blocked) {
          stop = true;
          return;
        }
        if (!res.ok || (res.contentType && NON_SCRIPT_TYPE_RE.test(res.contentType))) return;
        const text = res.bodyText ?? (res.body ? res.body.toString('utf8') : null);
        // SPA hosts answer unknown paths with index.html: never mine an HTML page as code.
        if (!text || looksLikeHtml(res.contentType, text)) return;
        totalBytes += res.body?.length ?? text.length;
        const a = safeAnalyze(text);
        for (const p of a.paths) codePaths.add(p);
        for (const h of a.hosts) jsHosts.add(h);
        if (jsChars < TECH_JS_MAX_CHARS) {
          const piece = text.length > TECH_JS_MAX_CHARS - jsChars ? text.slice(0, TECH_JS_MAX_CHARS - jsChars) : text;
          jsParts.push(piece);
          jsChars += piece.length;
        }
      } catch (err) {
        log.debug('scan: bundle failed', { url, err: errText(err) });
      } finally {
        if (mine) reserved -= mine;
      }
    });
  }
  result.apiEndpoints = apiPaths(codePaths);
  const ownHosts = new Set([input.host, finalHost]);
  result.codeHosts = [...new Set([...jsHosts, ...htmlHosts])]
    .filter((h) => !ownHosts.has(h) && h.length <= MAX_HOSTNAME_CHARS)
    .sort()
    .slice(0, MAX_CODE_HOSTS);

  // --- tech ------------------------------------------------------------------------------------------------------
  try {
    const assets = parsed?.assets;
    result.tech = detectTech({
      url: result.finalUrl,
      headers,
      html: withoutCodeSamples(html),
      scripts: assets ? [...assets.scripts, ...assets.preloads] : [],
      styles: assets ? assets.styles : [],
      generator: parsed?.generator ?? null,
      js: jsParts.join('\n;\n'),
      hosts: [...new Set([...jsHosts, ...htmlHosts])],
      linkHosts: [...linkHosts],
      cookies: cookieNames(headers['set-cookie']),
    });
  } catch (err) {
    log.debug('scan: tech detection failed', { err: errText(err) });
  }

  // --- DNS / subdomains --------------------------------------------------------------------------------------------
  let ips = await within(hostIps, left(), [] as string[]);
  if (finalHost !== input.host && left() > 300) {
    // Headers came from the final host (e.g. after unpeg.io → www.unpeg.io): report its addresses when it resolves.
    const finalIps = await resolveIps(deps, finalHost, left);
    if (finalIps.length > 0) ips = finalIps;
  }
  result.server.ips = ips;

  await within(Promise.all([sweep, ct]), left(), undefined);
  if (root && mode !== 'none') {
    for (const h of [...jsHosts, ...htmlHosts]) {
      const sub = normalizeSubdomain(h, root);
      if (sub && sub !== input.host) addSub(sub, 'code');
    }
    for (const h of linkHosts) {
      const sub = normalizeSubdomain(h, root);
      if (sub && sub !== input.host) addSub(sub, 'link');
    }
    const pending = [...subs].filter(([, e]) => !e.resolved).map(([h]) => h).slice(0, MAX_RESOLVES);
    await within(
      mapLimit(pending, DNS_CONCURRENCY, async (host) => {
        if (left() < 200) return;
        const info = await within(safe(() => deps.dns.resolve(host)), left() - 100, null);
        const e = subs.get(host);
        if (e && !e.resolved) {
          e.info = info;
          e.resolved = true;
        }
      }).catch(() => undefined),
      left(),
      undefined,
    );
    result.subdomains = toSubdomainList(subs);
  }

  result.elapsedMs = Date.now() - started;
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function safeNow(now: () => number): number {
  try {
    const t = now();
    return Number.isFinite(t) ? t : Date.now();
  } catch {
    return Date.now();
  }
}

/** Single-line text of at most `max` characters, or null. */
function capText(v: string | null | undefined, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** `v` when it is an absolute http(s) URL of at most `max` characters, else null (no javascript:/data: URLs). */
function httpUrl(v: string | null | undefined, max: number): string | null {
  if (typeof v !== 'string' || !v || v.length > max) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Calls fn, turning a synchronous throw into a rejection. */
function safe<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

/** `p`'s value, or `fallback` if it rejects or takes longer than `ms`. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (!(ms > 0)) {
    p.catch(() => undefined);
    return Promise.resolve(fallback);
  }
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function safeAnalyze(text: string): { paths: string[]; hosts: string[] } {
  try {
    return analyzeJs(text);
  } catch {
    return { paths: [], hosts: [] };
  }
}

function hostnameOf(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
    return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h || null;
  } catch {
    return null;
  }
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const v = headers[name];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, 200) : null;
}

/** Cookie names from a (", "-joined) Set-Cookie header; commas inside Expires dates are not separators. */
function cookieNames(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  const out = new Set<string>();
  for (const part of raw.split(/,\s*(?=[^;,=\s]+=)/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name && name.length <= 128) out.add(name);
    if (out.size >= 100) break;
  }
  return [...out];
}

/** The root domain to discover subdomains under, or null for IPs / localhost / internal names. */
function discoveryRoot(rootDomain: string): string | null {
  const r = rootDomain.toLowerCase().replace(/\.+$/, '');
  if (!r || !r.includes('.') || net.isIP(r) || isInternalHostname(r)) return null;
  return r;
}

async function resolveIps(deps: ScanDeps, host: string, left: () => number): Promise<string[]> {
  const info = await within(safe(() => deps.dns.resolve(host)), left() - 100, null);
  if (!info) return [];
  return [...new Set([...(info.a ?? []), ...(info.aaaa ?? [])])].sort();
}

/** Same-site JS bundles: every script plus .js/.mjs preloads, minus hosting-platform code and /cdn-cgi/. */
function bundleUrls(parsed: ParsedPage, siteRoot: string): string[] {
  const out = new Set<string>();
  const consider = (raw: string, requireJs: boolean) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (!isUnderDomain(u.hostname, siteRoot)) return;
    if (u.pathname.toLowerCase().includes('/cdn-cgi/')) return;
    if (requireJs && !/\.m?js$/i.test(u.pathname)) return;
    u.hash = '';
    const href = u.href;
    if (isPlatformAsset(href)) return;
    out.add(href);
  };
  for (const s of parsed.assets.scripts) consider(s, false);
  for (const s of parsed.assets.preloads) consider(s, true);
  return [...out];
}

const API_SEGMENT_RE = /(?:^|\/)(?:api|trpc|rpc|gql|graphql)(?:\/|$)/i;
const SINGLE_API_RE = /^\/(?:graphql|gql|rpc|trpc)$/i;
const VERSIONED_RE = /^\/v\d{1,2}\/[A-Za-z]/;

/** Route-like code paths that look like API endpoints ("/api/launches/count", "/v1/tokens", "/graphql"). */
function apiPaths(paths: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (typeof p !== 'string' || p.length < 2 || p.length > 120) continue;
    const segs = p.split('/').filter(Boolean);
    const ok = (segs.length >= 2 && (API_SEGMENT_RE.test(p) || VERSIONED_RE.test(p))) || SINGLE_API_RE.test(p);
    if (ok) out.add(p);
  }
  return [...out].sort().slice(0, MAX_API_ENDPOINTS);
}

function toSubdomainList(subs: Map<string, SubEntry>): ScanSubdomain[] {
  const order = ['dns', 'ct', 'code', 'link'];
  const list: ScanSubdomain[] = [];
  for (const [host, e] of subs) {
    list.push({
      host,
      sources: [...e.sources].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
      alive: e.info !== null,
    });
  }
  list.sort((a, b) => (a.alive === b.alive ? (a.host < b.host ? -1 : a.host > b.host ? 1 : 0) : a.alive ? -1 : 1));
  return list.slice(0, MAX_SUBDOMAINS);
}

function findWatched(store: Store, guildId: string | undefined, r: ScanResult): ScanResult['watched'] {
  if (typeof guildId !== 'string' || !guildId) return null;
  try {
    const byUrl = store.findWatchByUrl(guildId, r.url) ?? (r.finalUrl !== r.url ? store.findWatchByUrl(guildId, r.finalUrl) : undefined);
    if (byUrl) return { id: byUrl.id, name: byUrl.name, url: byUrl.url };
    const bare = (h: string) => h.toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
    const hosts = new Set([bare(r.host)]);
    const fh = hostnameOf(r.finalUrl);
    if (fh) hosts.add(bare(fh));
    const w = store.listWatches(guildId).find((x) => hosts.has(bare(x.host)));
    return w ? { id: w.id, name: w.name, url: w.url } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Socials
// ---------------------------------------------------------------------------

const X_RESERVED = new Set([
  'intent', 'share', 'home', 'i', 'search', 'hashtag', 'explore', 'settings', 'login', 'signup', 'tos', 'privacy',
  'messages', 'notifications', 'compose', 'about',
]);
const GITHUB_RESERVED = new Set([
  'features', 'pricing', 'login', 'join', 'about', 'marketplace', 'topics', 'explore', 'site', 'security', 'enterprise',
  'contact', 'collections', 'trending', 'sponsors', 'settings', 'notifications',
]);
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const EXPLORERS: Record<string, string> = {
  'etherscan.io': 'etherscan',
  'basescan.org': 'basescan',
  'bscscan.com': 'bscscan',
  'arbiscan.io': 'arbiscan',
  'polygonscan.com': 'polygonscan',
  'solscan.io': 'solscan',
};
const DOCS_PLATFORM_RE = /\.(?:gitbook\.io|mintlify\.app|readme\.io|readthedocs\.io)$/;

/** Social / community link kind and canonical URL, or null. */
function classifySocial(raw: string, siteRoot: string): { kind: string; url: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/\.+$/, '').replace(/^(?:www|mobile|m)\./, '');
  const segs = u.pathname.split('/').filter(Boolean);
  const first = segs[0] ?? '';
  const firstLower = first.toLowerCase();
  // Segments come from WHATWG URL parsing, so they are already percent-encoded where needed.
  const path = (n: number) => segs.slice(0, n).join('/');

  switch (host) {
    case 'x.com':
    case 'twitter.com':
      return HANDLE_RE.test(first) && !X_RESERVED.has(firstLower) ? { kind: 'x', url: `https://x.com/${first}` } : null;
    case 't.me':
    case 'telegram.me':
    case 'telegram.dog':
      if (!first || firstLower === 'share' || firstLower === 'iv') return null;
      return { kind: 'telegram', url: `https://t.me/${path(firstLower === 'joinchat' || firstLower === 's' || firstLower === 'c' ? 2 : 1)}` };
    case 'discord.gg':
      return first ? { kind: 'discord', url: `https://discord.gg/${first}` } : null;
    case 'discord.com':
    case 'discordapp.com':
      return firstLower === 'invite' && segs[1] ? { kind: 'discord', url: `https://discord.gg/${segs[1]}` } : null;
    case 'github.com':
      return first && !GITHUB_RESERVED.has(firstLower) ? { kind: 'github', url: `https://github.com/${path(2)}` } : null;
    case 'medium.com':
      return first.startsWith('@') || (first && segs.length === 1) ? { kind: 'medium', url: `https://medium.com/${path(1)}` } : null;
    case 'mirror.xyz':
      return first ? { kind: 'mirror', url: `https://mirror.xyz/${path(1)}` } : null;
    case 'youtube.com':
      if (first.startsWith('@')) return { kind: 'youtube', url: `https://www.youtube.com/${path(1)}` };
      if (['channel', 'c', 'user'].includes(firstLower) && segs[1]) return { kind: 'youtube', url: `https://www.youtube.com/${path(2)}` };
      return null;
    case 'instagram.com':
      return first && !['p', 'reel', 'explore', 'accounts'].includes(firstLower) ? { kind: 'instagram', url: `https://instagram.com/${path(1)}` } : null;
    case 'tiktok.com':
      return first.startsWith('@') ? { kind: 'tiktok', url: `https://www.tiktok.com/${path(1)}` } : null;
    case 'linktr.ee':
      return first ? { kind: 'linktree', url: `https://linktr.ee/${path(1)}` } : null;
    case 'reddit.com':
      return (firstLower === 'r' || firstLower === 'user' || firstLower === 'u') && segs[1] ? { kind: 'reddit', url: `https://www.reddit.com/${path(2)}` } : null;
    case 'linkedin.com':
      return (firstLower === 'company' || firstLower === 'in') && segs[1] ? { kind: 'linkedin', url: `https://www.linkedin.com/${path(2)}` } : null;
    case 'facebook.com':
      return first && !['sharer', 'sharer.php', 'share', 'dialog', 'plugins'].includes(firstLower) ? { kind: 'facebook', url: `https://www.facebook.com/${path(1)}` } : null;
    case 'warpcast.com':
    case 'farcaster.xyz':
      return first ? { kind: 'farcaster', url: `https://${host}/${path(1)}` } : null;
    case 'dexscreener.com':
      return segs.length >= 2 ? { kind: 'dexscreener', url: `https://dexscreener.com/${path(2)}` } : null;
    case 'birdeye.so': {
      const t = segs.indexOf('token');
      return t !== -1 && segs[t + 1] ? { kind: 'birdeye', url: `https://birdeye.so/${path(t + 2)}` } : null;
    }
    case 'pump.fun':
      if (firstLower === 'coin' && segs[1]) return { kind: 'pumpfun', url: `https://pump.fun/${path(2)}` };
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(first) ? { kind: 'pumpfun', url: `https://pump.fun/coin/${first}` } : null;
    case 'gmgn.ai': {
      const t = segs.indexOf('token');
      return t !== -1 && segs[t + 1] ? { kind: 'gmgn', url: `https://gmgn.ai/${path(t + 2)}` } : null;
    }
    case 'coingecko.com': {
      const c = segs.indexOf('coins');
      return c !== -1 && segs[c + 1] ? { kind: 'coingecko', url: `https://www.coingecko.com/${path(c + 2)}` } : null;
    }
    case 'coinmarketcap.com':
      return firstLower === 'currencies' && segs[1] ? { kind: 'coinmarketcap', url: `https://coinmarketcap.com/${path(2)}` } : null;
    default:
      break;
  }

  const explorer = EXPLORERS[host];
  if (explorer) {
    return ['token', 'address', 'account'].includes(firstLower) && segs[1] ? { kind: explorer, url: `https://${host}/${path(2)}` } : null;
  }
  if (host.endsWith('.medium.com')) return { kind: 'medium', url: `https://${host}/` };
  if (host.endsWith('.mirror.xyz')) return { kind: 'mirror', url: `https://${host}/` };
  if (host.endsWith('.substack.com')) return { kind: 'substack', url: `https://${host}/` };

  // Docs: docs.* / developers.* hosts, hosted docs platforms, or the site's own /docs.
  if (/^(?:docs?|developers?|wiki)\./.test(host) && host !== 'docs.google.com') return { kind: 'docs', url: `${u.protocol}//${u.host}/` };
  if (DOCS_PLATFORM_RE.test(host) || (host.endsWith('.gitbook.com') && host !== 'app.gitbook.com')) {
    return { kind: 'docs', url: `${u.protocol}//${u.host}/${path(1)}` };
  }
  if (isUnderDomain(host, siteRoot) && segs.length === 1 && (firstLower === 'docs' || firstLower === 'documentation')) {
    return { kind: 'docs', url: `${u.protocol}//${u.host}/${path(1)}` };
  }
  if (/(?:white|lite)paper/i.test(u.pathname)) return { kind: 'whitepaper', url: `${u.protocol}//${u.host}${u.pathname}` };
  return null;
}

const TWITTER_META_RES = [
  /<meta\b[^>]{0,200}?\bname=["']twitter:(?:site|creator)["'][^>]{0,200}?\bcontent=["']@?([A-Za-z0-9_]{1,15})["']/i,
  /<meta\b[^>]{0,200}?\bcontent=["']@([A-Za-z0-9_]{1,15})["'][^>]{0,200}?\bname=["']twitter:(?:site|creator)["']/i,
];

function collectSocials(links: string[], html: string, siteRoot: string): ScanResult['socials'] {
  const out: ScanResult['socials'] = [];
  const seen = new Set<string>();
  const perKind = new Map<string, number>();
  const push = (s: { kind: string; url: string } | null) => {
    if (!s || out.length >= MAX_SOCIALS || s.url.length > MAX_SOCIAL_URL_CHARS) return;
    const key = s.url.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key)) return;
    const n = perKind.get(s.kind) ?? 0;
    if (n >= MAX_SOCIALS_PER_KIND) return;
    seen.add(key);
    perKind.set(s.kind, n + 1);
    out.push(s);
  };
  for (const link of links) push(classifySocial(link, siteRoot));
  if (!perKind.has('x') && html) {
    const head = html.slice(0, 200_000);
    for (const re of TWITTER_META_RES) {
      const m = re.exec(head);
      if (m && !X_RESERVED.has(m[1].toLowerCase())) {
        push({ kind: 'x', url: `https://x.com/${m[1]}` });
        break;
      }
    }
  }
  return out;
}
