/**
 * Redeploy detection + code intel.
 *
 * A "deploy fingerprint" is the set of same-site script/style/preload URLs on the homepage plus the framework build id.
 * Bundlers put content hashes in those URLs, so a new build changes the fingerprint while ordinary page loads do not.
 *
 * Noise control (a false "redeployed" ping every 30s would make the bot useless):
 * - every candidate change is confirmed by a second fetch; a confirm that shows the OLD fingerprint means mixed CDN edges /
 *   a rolling deploy and is ignored;
 * - asset query strings that differ between two back-to-back fetches (per-request cache busters) are detected per asset
 *   path and from then on ignored for those paths only (persisted in state.unstableQueryPaths), so other assets that are
 *   versioned by query (WordPress "?ver=") still reveal deploys;
 * - a confirmed switch back to a recently seen fingerprint (rolling deploy / A-B builds) updates state silently, and so does
 *   a switch to asset URLs that only differ in their query strings from before and were all seen within the last day
 *   (backend nodes serving "?ver=<mtime>" variants of the same files; state.seenAssets survives restarts);
 * - code and build ids of hosted docs platforms (Mintlify, GitBook) belong to the platform, not the site: they are left
 *   out of the fingerprint (a platform release is not the site's redeploy);
 * - a page without any same-site assets or build id says nothing about the deploy and never replaces a real fingerprint.
 */

import type { DeployAlert, DeployFingerprint, JsAnalysis, WatchState } from '../types.js';
import { looksLikeHtml, parseHtml, type ParsedPage } from '../extract/html.js';
import { analyzeJs } from '../extract/js.js';
import { displayUrl, isUnderDomain, urlPath } from '../extract/url.js';
import { sha1 } from '../diff/text.js';
import { mapLimit } from '../net/limiter.js';
import type { FetchResult } from '../net/http.js';
import type { CheckContext, HomeSnapshot } from './context.js';

/** Query keys whose values are per-request cache busters; stripped from asset URLs before fingerprinting. */
export const VOLATILE_QUERY_KEYS: ReadonlySet<string> = new Set(['t', 'ts', 'timestamp', '_', 'nocache', 'cb', 'rand', 'r']);
/** A confirmed change back to a fingerprint that was current within this window is a flip-flop, not a deploy. */
export const FLIP_FLOP_WINDOW_MS = 15 * 60_000;
/** Entries kept in state.deployHistory. */
export const DEPLOY_HISTORY_MAX = 10;
/** Max JS bundles fetched for code intel in one check. */
export const MAX_BUNDLES_PER_CHECK = 60;
/** Max bytes read per JS bundle. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export const MAX_CODE_PATHS = 5000;
export const MAX_CODE_HOSTS = 1000;
/** Max new code paths / hosts listed in one alert. */
export const MAX_REPORTED_CODE_ITEMS = 40;

/** Asset URLs remembered in state.seenAssets (per-node query variants) and for how long. */
export const SEEN_ASSETS_MAX = 500;
export const SEEN_ASSETS_TTL_MS = 24 * 3600_000;
const UNSTABLE_QUERY_PATHS_MAX = 200;

const BUNDLE_CONCURRENCY = 4;
/** A bundle whose fetch failed is not retried before this delay. */
const BUNDLE_RETRY_MS = 10 * 60_000;
/** Wall-clock budget for starting bundle fetches in one check (keeps a tick bounded on slow sites). */
const CODE_INTEL_BUDGET_MS = 45_000;
const RETRY_MAP_MAX = 500;

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/** Keeps the raw `a=b` pairs whose key is not a cache buster, in their original order and encoding. */
function stripVolatileParams(search: string): string {
  if (!search || search === '?') return '';
  const kept: string[] = [];
  for (const pair of search.slice(1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    let key: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch {
      key = rawKey;
    }
    if (!VOLATILE_QUERY_KEYS.has(key.toLowerCase())) kept.push(pair);
  }
  return kept.length ? `?${kept.join('&')}` : '';
}

/** Same-site asset URL without fragment/credentials/cache busters (or without any query), or null if it doesn't count. */
function cleanAssetUrl(raw: unknown, rootDomain: string, dropQuery: boolean): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!isUnderDomain(u.hostname, rootDomain)) return null;
  if (u.pathname.toLowerCase().includes('/cdn-cgi/')) return null;
  const query = dropQuery ? '' : stripVolatileParams(u.search);
  return `${u.origin}${u.pathname}${query}`;
}

/** Hosted docs platforms whose own app code/build id is served on every customer site. */
const PLATFORM_GENERATOR_RE = /^\s*(?:mintlify|gitbook)\b/i;
const PLATFORM_HOST_RE = /^static[\w-]*\.gitbook\.com$/i;

/** An asset that belongs to a hosting platform (its releases are not the site's deploys). */
export function isPlatformAsset(url: string): boolean {
  try {
    const u = new URL(url);
    if (PLATFORM_HOST_RE.test(u.hostname)) return true;
    return /^\/(?:mintlify-assets|~gitbook)\//i.test(u.pathname);
  } catch {
    return false;
  }
}

function isPlatformGenerator(generator: string | null | undefined): boolean {
  return typeof generator === 'string' && PLATFORM_GENERATOR_RE.test(generator);
}

function signature(buildId: string | null, assets: string[]): string {
  if (assets.length === 0 && buildId === null) return '';
  return sha1(`${buildId ?? ''}\n${assets.join('\n')}`);
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function buildFingerprint(parsed: ParsedPage, rootDomain: string, now: number, dropQuery: boolean): DeployFingerprint {
  const set = new Set<string>();
  const a = parsed?.assets;
  for (const list of [a?.scripts, a?.styles, a?.preloads]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const u = cleanAssetUrl(raw, rootDomain, dropQuery);
      if (u && !isPlatformAsset(u)) set.add(u);
    }
  }
  const assets = [...set].sort();
  const generator = nonEmptyString(parsed?.generator);
  const buildId = isPlatformGenerator(generator) ? null : nonEmptyString(parsed?.buildId);
  return { assets, buildId, generator, sig: signature(buildId, assets), seenAt: now };
}

/** A stored fingerprint under today's rules (platform code left out), so older stored fingerprints compare equal. */
function withoutPlatform(fp: DeployFingerprint): DeployFingerprint {
  const assets = fp.assets.filter((u) => !isPlatformAsset(u));
  const buildId = isPlatformGenerator(fp.generator) ? null : fp.buildId;
  if (assets.length === fp.assets.length && buildId === fp.buildId) return fp;
  return { ...fp, assets, buildId, sig: signature(buildId, assets) };
}

/**
 * Build a fingerprint from a parsed homepage:
 * - assets = union of parsed.assets.scripts/styles/preloads that are same-site (host under rootDomain), excluding URLs whose path
 *   contains "/cdn-cgi/" and excluding query params that look volatile (keys: t, ts, timestamp, _, nocache, cb, rand, r) — strip those
 *   params but keep other params (like ?v=abc123, ?dpl=...). Sorted & deduped.
 * - buildId = parsed.buildId; generator = parsed.generator.
 * - sig = "" when assets is empty AND buildId is null (deploy detection not possible); else sha1(buildId + "\n" + assets.join("\n")).
 * - seenAt = now.
 */
export function fingerprintFromPage(parsed: ParsedPage, rootDomain: string, now: number): DeployFingerprint {
  return buildFingerprint(parsed, rootDomain, now, false);
}

/** Same as fingerprintFromPage but with ALL query strings stripped from asset URLs (fallback when query strings are unstable). */
export function fingerprintNoQuery(parsed: ParsedPage, rootDomain: string, now: number): DeployFingerprint {
  return buildFingerprint(parsed, rootDomain, now, true);
}

function basePath(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** The fingerprint with query strings stripped only from assets whose query is known to change per request. */
function withoutUnstableQueries(fp: DeployFingerprint, paths: ReadonlySet<string>): DeployFingerprint {
  if (paths.size === 0) return fp;
  let changed = false;
  const out = new Set<string>();
  for (const u of fp.assets) {
    const base = basePath(u);
    if (base !== u && paths.has(base)) {
      out.add(base);
      changed = true;
    } else out.add(u);
  }
  if (!changed) return fp;
  const assets = [...out].sort();
  return { ...fp, assets, sig: signature(fp.buildId, assets) };
}

/** Asset paths present in both fingerprints whose query strings differ (per-request cache busters). */
function queryVaryingPaths(a: DeployFingerprint, b: DeployFingerprint): string[] {
  const byPath = (fp: DeployFingerprint) => {
    const m = new Map<string, Set<string>>();
    for (const u of fp.assets) {
      const base = basePath(u);
      let set = m.get(base);
      if (!set) m.set(base, (set = new Set()));
      set.add(u);
    }
    return m;
  };
  const ma = byPath(a);
  const mb = byPath(b);
  const out: string[] = [];
  for (const [base, ua] of ma) {
    const ub = mb.get(base);
    if (!ub) continue;
    if (ua.size !== ub.size || [...ua].some((u) => !ub.has(u))) out.push(base);
  }
  return out;
}

function unstablePaths(state: WatchState): Set<string> {
  return new Set(Array.isArray(state.unstableQueryPaths) ? state.unstableQueryPaths : []);
}

/** Asset URLs seen within SEEN_ASSETS_TTL_MS (per-node "?ver=" variants of the same files). */
function recentlySeen(state: WatchState, now: number): Set<string> {
  const out = new Set<string>();
  for (const a of Array.isArray(state.seenAssets) ? state.seenAssets : []) {
    if (a && typeof a.url === 'string' && a.at <= now && now - a.at < SEEN_ASSETS_TTL_MS) out.add(a.url);
  }
  return out;
}

function rememberAssets(state: WatchState, now: number, ...fps: Array<DeployFingerprint | null | undefined>): void {
  const map = new Map<string, number>();
  for (const a of Array.isArray(state.seenAssets) ? state.seenAssets : []) {
    if (a && typeof a.url === 'string' && a.at <= now && now - a.at < SEEN_ASSETS_TTL_MS) map.set(a.url, a.at);
  }
  for (const fp of fps) {
    for (const u of fp?.assets ?? []) {
      map.delete(u); // re-insert: most recently seen last
      map.set(u, now);
    }
  }
  const list = [...map].map(([url, at]) => ({ url, at }));
  state.seenAssets = list.slice(-SEEN_ASSETS_MAX);
}

// ---------------------------------------------------------------------------
// Per-watch runtime memory (not persisted; keyed by the scheduler's long-lived WatchState object)
// ---------------------------------------------------------------------------

interface DeployRuntime {
  /** Comparison sig whose bundles are all in the js_cache (no backfill needed until it changes). */
  intelCompleteSig: string | null;
  /** Bundle URL → earliest time of the next fetch attempt after a failure. */
  retryAt: Map<string, number>;
}

const runtimes = new WeakMap<WatchState, DeployRuntime>();

function runtimeFor(state: WatchState): DeployRuntime {
  let rt = runtimes.get(state);
  if (!rt) {
    rt = { intelCompleteSig: null, retryAt: new Map() };
    runtimes.set(state, rt);
  }
  return rt;
}

// ---------------------------------------------------------------------------
// Deploy history (flip-flop suppression)
// ---------------------------------------------------------------------------

/**
 * True when switching to `sig` is a flip-flop rather than a new deploy: the fingerprint was current within the last
 * FLIP_FLOP_WINDOW_MS (it was left at the time of the entry that follows its last occurrence), or it has already become
 * current twice within the history (A/B builds or edges that alternate for longer than the window).
 */
export function isFlipFlop(history: ReadonlyArray<{ sig: string; at: number }>, sig: string, now: number): boolean {
  if (!sig) return false;
  let last = -1;
  let count = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].sig === sig) {
      last = i;
      count++;
    }
  }
  if (last === -1) return false;
  if (count >= 2) return true;
  const leftAt = last + 1 < history.length ? history[last + 1].at : now;
  return now - leftAt <= FLIP_FLOP_WINDOW_MS;
}

function pushHistory(state: WatchState, sig: string, at: number): void {
  if (!sig) return;
  if (!Array.isArray(state.deployHistory)) state.deployHistory = [];
  const h = state.deployHistory;
  if (h.length > 0 && h[h.length - 1].sig === sig) return;
  h.push({ sig, at });
  if (h.length > DEPLOY_HISTORY_MAX) h.splice(0, h.length - DEPLOY_HISTORY_MAX);
}

// ---------------------------------------------------------------------------
// Code intel
// ---------------------------------------------------------------------------

interface CodeIntel {
  paths: Set<string>;
  hosts: Set<string>;
  /** Every bundle was analyzed (none failed, skipped, or deferred). */
  complete: boolean;
}

/**
 * Same-site JS bundle URLs: every script plus .js/.mjs preloads (cleaned like fingerprint assets; per-request query
 * strings of `unstable` paths dropped). Hosting-platform bundles are skipped: their routes/hosts are not the site's.
 */
function bundleUrls(parsed: ParsedPage, rootDomain: string, unstable: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  const a = parsed?.assets;
  const clean = (raw: unknown): string | null => {
    const u = cleanAssetUrl(raw, rootDomain, false);
    if (!u || isPlatformAsset(u)) return null;
    const base = basePath(u);
    return base !== u && unstable.has(base) ? base : u;
  };
  for (const raw of Array.isArray(a?.scripts) ? a.scripts : []) {
    const u = clean(raw);
    if (u) out.add(u);
  }
  for (const raw of Array.isArray(a?.preloads) ? a.preloads : []) {
    const u = clean(raw);
    if (u && /\.m?js$/i.test(basePath(u))) out.add(u);
  }
  return [...out];
}

const NON_SCRIPT_TYPE_RE = /^(?:image|font|video|audio)\//;

/** Fetch + analyze one bundle. null = try again later (network error, non-2xx, challenge, HTML fallback page). */
async function fetchBundle(ctx: CheckContext, url: string): Promise<JsAnalysis | null> {
  const res = await ctx.http.fetch(url, { maxBytes: MAX_BUNDLE_BYTES, accept: '*/*' });
  if (!res.ok || res.blocked) return null;
  if (res.contentType && NON_SCRIPT_TYPE_RE.test(res.contentType)) return { paths: [], hosts: [] };
  const text = res.bodyText ?? (res.body ? res.body.toString('utf8') : null);
  if (text === null) return null;
  // SPA hosts answer unknown paths with index.html (200): never mine an HTML page as code.
  if (looksLikeHtml(res.contentType, text)) return null;
  return analyzeJs(text);
}

async function runCodeIntel(
  ctx: CheckContext,
  rt: DeployRuntime,
  urls: string[],
  pageHosts: string[],
  now: number,
): Promise<CodeIntel> {
  const paths = new Set<string>();
  const hosts = new Set<string>(pageHosts);
  const add = (a: JsAnalysis) => {
    for (const p of a.paths) paths.add(p);
    for (const h of a.hosts) hosts.add(h.toLowerCase());
  };
  let complete = true;
  const pending: string[] = [];
  for (const url of urls) {
    let cached: JsAnalysis | undefined;
    try {
      cached = ctx.store.getJsAnalysis(url);
    } catch {
      cached = undefined;
    }
    if (cached) {
      add(cached);
      continue;
    }
    const retryAt = rt.retryAt.get(url);
    if (retryAt !== undefined && retryAt > now) {
      complete = false;
      continue;
    }
    pending.push(url);
  }
  if (pending.length > MAX_BUNDLES_PER_CHECK) {
    complete = false;
    pending.length = MAX_BUNDLES_PER_CHECK;
  }

  const deadline = Date.now() + CODE_INTEL_BUDGET_MS;
  await mapLimit(pending, BUNDLE_CONCURRENCY, async (url) => {
    if (Date.now() > deadline || isCancelled(ctx)) {
      complete = false;
      return;
    }
    let analysis: JsAnalysis | null = null;
    try {
      analysis = await fetchBundle(ctx, url);
    } catch (err) {
      ctx.log.debug('bundle analysis failed', { url, err: err instanceof Error ? err.message : String(err) });
      analysis = null;
    }
    if (!analysis) {
      complete = false;
      rt.retryAt.set(url, now + BUNDLE_RETRY_MS);
      return;
    }
    rt.retryAt.delete(url);
    try {
      ctx.store.putJsAnalysis(url, analysis, now);
    } catch (err) {
      ctx.log.warn('js cache write failed', { url, err: err instanceof Error ? err.message : String(err) });
    }
    add(analysis);
  });

  if (rt.retryAt.size > RETRY_MAP_MAX) {
    for (const [url, at] of rt.retryAt) if (at <= now) rt.retryAt.delete(url);
  }
  return { paths, hosts, complete };
}

/** `current` first (it wins when the cap is hit), then previously known items; sorted for stable storage. */
function mergeCapped(current: Iterable<string>, previous: readonly string[], cap: number): string[] {
  const out = new Set<string>();
  for (const v of current) {
    if (out.size >= cap) break;
    out.add(v);
  }
  for (const v of previous) {
    if (out.size >= cap) break;
    out.add(v);
  }
  return [...out].sort();
}

/**
 * Remember everything referenced by this deploy's code. Previously seen items are kept (up to the caps) so a path that moves
 * between code-split chunks, or is dropped and later restored, is not reported as new again.
 */
function mergeCode(state: WatchState, intel: CodeIntel): void {
  state.codePaths = mergeCapped(intel.paths, Array.isArray(state.codePaths) ? state.codePaths : [], MAX_CODE_PATHS);
  state.codeHosts = mergeCapped(intel.hosts, Array.isArray(state.codeHosts) ? state.codeHosts : [], MAX_CODE_HOSTS);
}

/** Pathnames of every known URL on the watch's own host. */
function knownPagePaths(ctx: CheckContext): Set<string> {
  const out = new Set<string>();
  let urls: Set<string>;
  try {
    urls = ctx.store.knownUrls(ctx.watch.id);
  } catch {
    return out;
  }
  const host = ctx.watch.host.toLowerCase();
  for (const url of urls) {
    try {
      const u = new URL(url);
      if (u.hostname.toLowerCase() !== host) continue;
      const p = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
      out.add(p);
      try {
        out.add(decodeURI(p));
      } catch {
        // keep the raw form only
      }
    } catch {
      // ignore unparseable stored URLs
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lowerHosts(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const h of list) if (typeof h === 'string' && h) out.add(h.toLowerCase());
  return [...out];
}

function sortedUnion(...lists: Iterable<string>[]): string[] {
  const out = new Set<string>();
  for (const l of lists) for (const v of l) out.add(v);
  return [...out].sort();
}

/** Path (+query) for assets on the watch's own host, host+path for other same-site hosts. */
function assetLabel(url: string, watchUrl: string): string {
  try {
    if (new URL(url).host === new URL(watchUrl).host) return urlPath(url);
  } catch {
    // fall through
  }
  return displayUrl(url);
}

function poweredBy(fetch: FetchResult | undefined): string | null {
  const v = fetch?.headers?.['x-powered-by'];
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null;
}

/** Waits the confirm delay, then re-fetches and parses the homepage; null if it isn't a usable 2xx HTML page. */
async function refetchHome(ctx: CheckContext): Promise<ParsedPage | null> {
  await ctx.sleep(Math.max(0, ctx.config.confirmDelayMs));
  const res = await ctx.http.fetch(ctx.watch.url);
  if (!res.ok || res.blocked || res.bodyText === null) return null;
  if (!looksLikeHtml(res.contentType, res.bodyText)) return null;
  return parseHtml(res.bodyText, res.finalUrl || ctx.watch.url);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isCancelled(ctx: CheckContext): boolean {
  try {
    return ctx.cancelled?.() === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

export interface DeployCheckResult {
  /** A confirmed redeploy happened (callers trigger a full page sweep). Always false in baseline mode. */
  changed: boolean;
  alert: DeployAlert | null;
  /** Hostnames seen in site code/HTML this check (for subdomain discovery), lowercase. */
  hosts: string[];
  /**
   * Hostnames first seen while back-filling code intel of bundles that could not be analyzed earlier (or on a first
   * fingerprint after the baseline): they were in the site's code all along, so they are recorded without alerting.
   */
  backfillHosts: string[];
  /** New route-like paths referenced in code (already included in the alert); useful to seed page discovery. */
  newCodePaths: string[];
}

/**
 * Compare the homepage against ctx.state.deploy.
 * - If home.parsed is null (non-2xx/non-HTML/blocked) → no-op result (changed=false).
 * - First fingerprint ever (state.deploy null) or baseline → store it, run code intel to populate state.codePaths/codeHosts
 *   (if features.codeIntel), no alert.
 * - If new sig === "" → no deploy detection (store fingerprint, no alert).
 * - If sig differs from state.deploy.sig: CONFIRM by waiting ctx.config.confirmDelayMs (ctx.sleep) and re-fetching watch.url
 *   (ctx.http.fetch, no conditional headers) and re-fingerprinting:
 *     * confirm sig == new sig → confirmed.
 *     * confirm sig == old sig → transient (rolling deploy / mixed CDN edges) → no alert, keep old.
 *     * otherwise unstable → the asset paths whose query differs between the two fetches are learned as per-request cache
 *       busters (state.unstableQueryPaths); if both fetches then match each other and differ from the old fingerprint →
 *       confirmed; else → no alert this tick.
 * - Flip-flop suppression: if the confirmed sig appears in state.deployHistory within the last 15 minutes, update state.deploy
 *   silently (no alert). Always push confirmed sigs to deployHistory (keep last 10).
 * - On confirmed change: alert with assetsAdded/assetsRemoved (URL diff of assets; show paths), buildIdOld/New; set
 *   state.deploy; state.lastChangeAt = now.
 * - Code intel (features.codeIntel): for each same-site script asset (scripts + preloads ending in .js/.mjs) not in the js_cache
 *   (store.getJsAnalysis), fetch it (maxBytes 8MB, max 60 bundles per check, via ctx.http) and analyzeJs(); putJsAnalysis.
 *   Union all bundles' paths/hosts (+ home.parsed.hosts). newCodePaths = union.paths − state.codePaths (filtered: not already a known
 *   page URL path in store.knownUrls), newCodeHosts = union.hosts − state.codeHosts. Then state.codePaths/codeHosts = union
 *   (cap 5000 / 1000). Only include newCode* in alerts when a previous union existed (state.codePaths non-empty before) — otherwise
 *   it's a baseline. Report at most 40 of each in the alert (sorted).
 * - `hosts` = union.hosts ∪ home.parsed.hosts (lowercase), regardless of change.
 *
 * Implementation notes:
 * - A sig-"" page (no same-site assets, no build id: error/maintenance page) never replaces a real stored fingerprint.
 * - Flip-flops also cover a fingerprint that has already become current twice in the history (alternating A/B builds).
 * - A confirmed change whose assets keep the same paths and whose new URLs (queries) were all seen within
 *   SEEN_ASSETS_TTL_MS is a per-node variant, not a deploy: recorded silently. Only never-seen asset URLs or a build id
 *   change count as a deploy.
 * - Hosted docs platforms: assets under /mintlify-assets/ or /~gitbook/ (and static*.gitbook.com) and the build id of a
 *   page whose generator is Mintlify/GitBook are left out of the fingerprint and of code intel. Stored fingerprints are
 *   compared under the same rule, so upgrading does not look like a deploy.
 * - state.codePaths/codeHosts accumulate across deploys (capped), so a path moving between code-split chunks is not "new" again.
 * - Bundles that could not be analyzed during a deploy check are back-filled silently on later ticks (failed fetches are retried
 *   after 10 minutes), so they never surface as "new" code on the next deploy; hosts first seen that way are returned in
 *   `backfillHosts` (not `hosts`) so subdomain discovery records them silently.
 * - With features.deploy off (code intel only), a deploy alert is emitted only when it carries new code paths/hosts.
 * - Never throws: unexpected errors are logged and yield a no-op result. ctx.cancelled() stops starting bundle fetches.
 */
export async function checkDeploy(ctx: CheckContext, home: HomeSnapshot): Promise<DeployCheckResult> {
  const parsed = home?.parsed ?? null;
  if (!parsed) return { changed: false, alert: null, hosts: [], backfillHosts: [], newCodePaths: [] };
  const pageHosts = lowerHosts(parsed.hosts);
  try {
    return await check(ctx, home, parsed, pageHosts);
  } catch (err) {
    ctx.log.error('deploy check failed', { watch: ctx.watch.id, err: errText(err) });
    return { changed: false, alert: null, hosts: pageHosts.sort(), backfillHosts: [], newCodePaths: [] };
  }
}

async function check(ctx: CheckContext, home: HomeSnapshot, parsed: ParsedPage, pageHosts: string[]): Promise<DeployCheckResult> {
  const { watch, state } = ctx;
  const now = ctx.now();
  const rt = runtimeFor(state);
  const intelOn = watch.features.codeIntel;
  const root = watch.rootDomain;
  const unstable = unstablePaths(state);
  const seenBefore = recentlySeen(state, now);

  const cur = fingerprintFromPage(parsed, root, now);
  cur.generator ??= poweredBy(home.fetch);
  const stored = state.deploy;
  const prev = stored ? withoutPlatform(stored) : null;
  if (stored && prev && prev !== stored) state.deploy = prev; // silently migrate to today's fingerprint rules

  // --- baseline / first fingerprint -----------------------------------------------------------
  if (ctx.baseline || !prev) {
    if (!(prev && prev.sig !== '' && cur.sig === '')) {
      if (prev && prev.sig === cur.sig) cur.seenAt = prev.seenAt;
      state.deploy = cur;
      pushHistory(state, cur.sig, now);
    }
    rememberAssets(state, now, prev, cur);
    let hosts = pageHosts;
    let backfillHosts: string[] = [];
    if (intelOn) {
      const intel = await runCodeIntel(ctx, rt, bundleUrls(parsed, root, unstable), pageHosts, now);
      mergeCode(state, intel);
      rt.intelCompleteSig = intel.complete ? withoutUnstableQueries(cur, unstable).sig : null;
      if (ctx.baseline) hosts = [...intel.hosts];
      else {
        // A first fingerprint after the baseline (deploy detection just switched on): the code is not news.
        const page = new Set(pageHosts);
        backfillHosts = [...intel.hosts].filter((h) => !page.has(h)).sort();
      }
    }
    return { changed: false, alert: null, hosts: sortedUnion(hosts), backfillHosts, newCodePaths: [] };
  }

  const noChange = (backfillHosts: string[] = []): DeployCheckResult => {
    const quiet = new Set(backfillHosts);
    const hosts = intelOn ? sortedUnion(state.codeHosts ?? [], pageHosts) : sortedUnion(pageHosts);
    return { changed: false, alert: null, hosts: hosts.filter((h) => !quiet.has(h)), backfillHosts, newCodePaths: [] };
  };

  if (cur.sig === '') {
    // Nothing to compare. Keep a real fingerprint; refresh an equally empty one.
    if (prev.sig === '') state.deploy = cur;
    return noChange();
  }

  const prevCmp = withoutUnstableQueries(prev, unstable);
  const curCmp = withoutUnstableQueries(cur, unstable);

  if (curCmp.sig === prevCmp.sig) {
    rememberAssets(state, now, cur);
    if (intelOn && rt.intelCompleteSig !== prevCmp.sig) {
      // Back-fill bundles that could not be analyzed earlier (or after a restart / cache prune), silently.
      const before = new Set(state.codeHosts ?? []);
      const page = new Set(pageHosts);
      const intel = await runCodeIntel(ctx, rt, bundleUrls(parsed, root, unstable), pageHosts, now);
      mergeCode(state, intel);
      if (intel.complete) rt.intelCompleteSig = prevCmp.sig;
      return noChange([...intel.hosts].filter((h) => !before.has(h) && !page.has(h)).sort());
    }
    return noChange();
  }

  // --- candidate change: confirm with a second fetch -------------------------------------------
  const confirmParsed = await refetchHome(ctx);
  if (!confirmParsed) {
    ctx.log.debug('deploy change not confirmed: confirm fetch unusable', { watch: watch.id });
    return noChange();
  }
  const conf = fingerprintFromPage(confirmParsed, root, now);
  conf.generator ??= cur.generator;
  let confCmp = withoutUnstableQueries(conf, unstable);
  let curStable = curCmp;
  let paths = unstable;

  if (confCmp.sig !== curStable.sig && confCmp.sig !== prevCmp.sig) {
    // The two fetches disagree: learn the asset paths whose query changes per request, then compare without those.
    const varying = queryVaryingPaths(cur, conf).filter((p) => !unstable.has(p));
    if (varying.length > 0) {
      paths = new Set([...unstable, ...varying]);
      const learnedCur = withoutUnstableQueries(cur, paths);
      const learnedConf = withoutUnstableQueries(conf, paths);
      if (learnedCur.sig === learnedConf.sig) {
        ctx.log.info('asset query strings vary per request; comparing without them', { watch: watch.id, paths: varying.slice(0, 5) });
        state.unstableQueryPaths = [...paths].slice(-UNSTABLE_QUERY_PATHS_MAX);
        curStable = learnedCur;
        confCmp = learnedConf;
        if (confCmp.sig === withoutUnstableQueries(prev, paths).sig) {
          rememberAssets(state, now, cur, conf);
          return noChange();
        }
      }
    }
  }

  const base = withoutUnstableQueries(prev, paths);
  if (confCmp.sig !== curStable.sig) {
    if (confCmp.sig === base.sig) {
      ctx.log.debug('deploy change transient (confirm fetch saw the old build)', { watch: watch.id });
    } else {
      ctx.log.debug('deploy fingerprint unstable; no alert this tick', { watch: watch.id });
    }
    rememberAssets(state, now, cur, conf);
    return noChange();
  }
  const accepted = confCmp;

  // --- confirmed ---------------------------------------------------------------------------------
  const suppressed = isFlipFlop(state.deployHistory ?? [], accepted.sig, now);
  // Same files, only query values differ, and every new URL was served before: per-node "?ver=" variants.
  const before = new Set(base.assets);
  const after = new Set(accepted.assets);
  const added = accepted.assets.filter((u) => !before.has(u));
  const removed = base.assets.filter((u) => !after.has(u));
  const basePaths = new Set(base.assets.map(basePath));
  const acceptedPaths = new Set(accepted.assets.map(basePath));
  const samePaths =
    accepted.buildId === base.buildId && basePaths.size === acceptedPaths.size && [...acceptedPaths].every((p) => basePaths.has(p));
  const knownVariant = samePaths && added.length > 0 && added.every((u) => seenBefore.has(u));
  // Make sure the build we are leaving is in the history (its successor's `at` is when it stopped being current).
  pushHistory(state, base.sig, prev.seenAt || now);
  pushHistory(state, accepted.sig, now);
  state.deploy = accepted;
  rememberAssets(state, now, cur, conf);

  if (suppressed || knownVariant) {
    ctx.log.info(
      suppressed
        ? 'deploy fingerprint flipped back to a recent build; not alerting'
        : 'asset query variants seen before (per-node versions); not alerting',
      { watch: watch.id, sig: accepted.sig },
    );
    return noChange();
  }

  state.lastChangeAt = now;
  let newCodePaths: string[] = [];
  let newCodeHosts: string[] = [];
  let hosts: string[] = sortedUnion(pageHosts, lowerHosts(confirmParsed.hosts));
  if (intelOn) {
    try {
      const hadUnion = (state.codePaths?.length ?? 0) > 0 || (state.codeHosts?.length ?? 0) > 0;
      const intel = await runCodeIntel(ctx, rt, bundleUrls(confirmParsed, root, paths), hosts, now);
      if (hadUnion) {
        const oldPaths = new Set(state.codePaths);
        const oldHosts = new Set(state.codeHosts);
        const fresh = [...intel.paths].filter((p) => !oldPaths.has(p));
        const known = fresh.length ? knownPagePaths(ctx) : new Set<string>();
        newCodePaths = fresh.filter((p) => !known.has(p)).sort().slice(0, MAX_REPORTED_CODE_ITEMS);
        newCodeHosts = [...intel.hosts].filter((h) => !oldHosts.has(h)).sort().slice(0, MAX_REPORTED_CODE_ITEMS);
      }
      mergeCode(state, intel);
      rt.intelCompleteSig = intel.complete ? accepted.sig : null;
      hosts = [...intel.hosts].sort();
    } catch (err) {
      ctx.log.warn('code intel failed', { watch: watch.id, err: errText(err) });
    }
  }

  const alert: DeployAlert = {
    kind: 'deploy',
    url: watch.url,
    host: watch.host,
    buildIdOld: base.buildId,
    buildIdNew: accepted.buildId,
    assetsAdded: added.map((u) => assetLabel(u, watch.url)),
    assetsRemoved: removed.map((u) => assetLabel(u, watch.url)),
    newCodePaths,
    newCodeHosts,
  };
  ctx.log.info('redeploy detected', {
    watch: watch.id,
    buildOld: alert.buildIdOld,
    buildNew: alert.buildIdNew,
    added: alert.assetsAdded.length,
    removed: alert.assetsRemoved.length,
    newCodePaths: newCodePaths.length,
  });
  const emit = watch.features.deploy || newCodePaths.length > 0 || newCodeHosts.length > 0;
  return { changed: true, alert: emit ? alert : null, hosts, backfillHosts: [], newCodePaths };
}
