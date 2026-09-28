/**
 * Page discovery (links + sitemap), text-change detection with diffs, new/removed pages.
 *
 * One call = one bounded pass:
 *   seed start/extra URLs → keep the tracked set within maxPages/scope → sweep due tracked pages (the homepage comes free from
 *   the scheduler's snapshot) → confirm suspected text changes with a second fetch → discover new URLs breadth-first within
 *   a fetch budget → persist every touched record in one batched write.
 *
 * Noise is the main enemy, so a text change is only reported when two fetches agree on it; number-only changes are held
 * back until the numbers stay put for a whole check (numbers that keep moving are masked instead), a switch back to a
 * recently seen version (A/B rotation, revert) is recorded silently, pages that change too often or differ on every load
 * are muted (and trusted again once they settle), blank renders are treated as inconclusive, and cache validators are
 * only stored for content we accepted (a 304 must never hide an unreported change).
 */

import type { FetchResult } from '../net/http.js';
import { mapLimit } from '../net/limiter.js';
import { looksLikeHtml, parseHtml, type ParsedPage } from '../extract/html.js';
import { discoverSitemap } from '../extract/sitemap.js';
import { classifyUrl, inScope, isUnderDomain, MAX_SCOPED_URL_CHARS, normalizeUrl } from '../extract/url.js';
import { maskNumbers, PatternTimeoutError } from '../diff/text.js';
import type { Store } from '../db/store.js';
import type {
  InfoAlert,
  Logger,
  NewPagesAlert,
  PageKind,
  PageRecord,
  PageSource,
  RemovedPagesAlert,
  TextAlert,
  TextChange,
  Watch,
} from '../types.js';
import type { CheckContext, HomeSnapshot } from './context.js';
import { isFlipFlop } from './deploy.js';
import {
  compareHash,
  groupChanges,
  noiseInfo,
  pageDiff,
  pageLabel,
  snapshotOf,
  tickingLines,
  titleChange,
  type CompareSettings,
  type NoiseKind,
} from './pages-text.js';

/** How many consecutive unstable (non-numeric) checks before a page is marked dynamic. */
export const DYNAMIC_AFTER_FLAPS = 3;
/**
 * Number-only observations (a new set of numbers held back, or numbers that moved again before being reported) within
 * NUMERIC_WINDOW_MS that trigger auto-masking of the page's numbers.
 */
export const NUMERIC_CHANGES_TO_MASK = 3;
export const NUMERIC_WINDOW_MS = 6 * 60 * 60 * 1000;
/**
 * Held numbers are reported only after staying the same this long (and at least one sweep): longer than a clock with
 * minute granularity takes to move on.
 */
export const NUMERIC_HOLD_MIN_MS = 120_000;
/** Alerted text changes within CHURN_WINDOW_MS (the triggering one included) that mute a page as "changes too often". */
export const CHURN_LIMIT = 4;
export const CHURN_WINDOW_MS = 60 * 60_000;
/** A muted (dynamic) page whose text has not changed for this long is trusted again. */
export const DYNAMIC_RESET_MS = 24 * 3600_000;
/** Accepted compare hashes remembered per page (flip-flop suppression). */
export const TEXT_HISTORY_MAX = 10;
/** Only history entries this recent count for text flip-flops (a revert of a revert weeks later is news). */
export const TEXT_FLIP_FLOP_HISTORY_MS = 6 * 3600_000;
/** Ticking lines remembered per page (masked forms), newest kept. */
export const MAX_MASKED_LINES = 200;
/** Misses (404/410) closer together than this count once (a full sweep right after a normal check must not confirm a removal). */
export const REMOVAL_MIN_GAP_MS = 60_000;
/** Removed (gone) tracked pages are re-checked this often instead of on every sweep. */
export const GONE_RECHECK_MS = 60 * 60_000;
/** Max new pages reported individually in one alert (rest summarized by count). */
export const MAX_NEW_PAGES_LISTED = 25;
/** BFS depth limit for link discovery from the start URL. */
export const MAX_CRAWL_DEPTH = 4;

/** New-candidate fetches per normal pass. */
export const DISCOVERY_FETCHES_NORMAL = 40;
/** New-candidate fetches per baseline / full pass. */
export const DISCOVERY_FETCHES_FULL = 200;
/** Silent backfill re-probes (known URLs never fetched or failed, first seen before the baseline) per normal pass. */
export const STALE_BACKFILL_PER_PASS = 10;
/** Page fetches in flight per pass (the HttpClient also enforces global/per-host limits). */
export const PAGE_FETCH_CONCURRENCY = 4;
/**
 * No new fetch starts after this much wall time in one pass (the scheduler abandons ticks after ~120s). Unchecked pages
 * stay due and unfetched candidates are recorded for later passes, so nothing is lost.
 */
export const PASS_TIME_BUDGET_MS = 90_000;
/** Share of config.maxKnownUrls the sitemap may fill; the rest stays free for pages found through links. */
export const SITEMAP_SHARE_OF_KNOWN = 0.8;

/** Candidates fetched per BFS step, so links found by one step are fetched before older re-probes. */
const DISCOVERY_STEP = 16;
/** Known-but-unfetched URLs whose last fetch failed transiently (0 / 429 / 5xx) are retried after this long. */
const RETRY_FAILED_MS = 10 * 60_000;
/** Known URLs that returned 404/410 are re-probed this often, to catch linked "coming soon" pages going live. */
const RECHECK_MISSING_MS = 15 * 60_000;
/** Other non-2xx known URLs (401/403, redirects elsewhere, ...) are re-probed this often. */
const RECHECK_OTHER_MS = 6 * 60 * 60_000;
/** Status stored for a known URL that redirects to another URL (the client only reports the final hop's status). */
const REDIRECT_STATUS = 301;
/** Code-intel paths considered per pass (a deploy normally adds a handful). */
const MAX_CODE_CANDIDATES = 500;
/** A single non-baseline sitemap read with more unknown pages than this is a backfill (e.g. the baseline read failed), not news. */
const SITEMAP_BACKFILL_THRESHOLD = 50;
const SITEMAP_MAX_URLS = 5000;
const MAX_RESULT_HOSTS = 2000;
const FLUSH_CHUNK = 500;
/** Repeated operational warnings (cap reached, slow ignore pattern, storage failing) are logged/alerted at most this often. */
const WARN_EVERY_MS = 60 * 60_000;

/** Last time a throttled warning was emitted, per `<kind>:<watchId>`. */
const warnedAt = new Map<string, number>();

function throttled(kind: string, watchId: number, now: number): boolean {
  const key = `${kind}:${watchId}`;
  const last = warnedAt.get(key);
  if (last !== undefined && now >= last && now - last < WARN_EVERY_MS) return true;
  if (warnedAt.size > 10_000) warnedAt.clear();
  warnedAt.set(key, now);
  return false;
}

/** Forget throttled-warning timestamps (tests). */
export function resetPagesWarnings(): void {
  warnedAt.clear();
}

export interface PagesCheckResult {
  alerts: Array<TextAlert | NewPagesAlert | RemovedPagesAlert | InfoAlert>;
  /** Hostnames (lowercase) of every absolute link/asset host seen on fetched pages (for subdomain discovery). */
  hosts: string[];
  /**
   * Hosts seen only on pages whose links say nothing about what is new: backfill pages fetched for the first time after
   * the baseline, and tracked pages whose text is being (re-)baselined. Subdomains found there are recorded silently.
   * A host that is also in `hosts` is not repeated here.
   */
  quietHosts: string[];
  /** Number of page fetches performed. */
  fetched: number;
}

/**
 * One pass of page checking for a watch. Behaviour:
 *
 * SEEDING: the start URL (watch.url, source 'start', depth 0) and watch.extraUrls (source 'extra', depth 0) always exist as tracked pages.
 * If `home` is given (the scheduler already fetched watch.url this tick), use it for the start page instead of re-fetching.
 *
 * DISCOVERY (only when features.pages || features.text):
 * - Links from every page fetched this pass (parsed.links), normalized. In-scope (inScope(url, watch)) 'page' URLs become candidates
 *   with depth = parent.depth + 1 (skip if > MAX_CRAWL_DEPTH). Same-site 'file' URLs (host under rootDomain) → file records
 *   (kind 'file', tracked, textHash null) when features.files — never alert here, files.ts handles them.
 * - Sitemap: when ctx.baseline, or opts.full, or now - state.sitemapLastScan >= config.sitemapIntervalSec*1000 → discoverSitemapUrls
 *   (filter inScope with allowQuery=true for sitemap URLs), source 'sitemap', depth 1. Update state.sitemapLastScan.
 * - opts.extraPaths (e.g. new code paths from deploy intel): build absolute URLs on watch origin; they are candidates with source 'code'
 *   BUT only become records if the fetch returns 2xx HTML (never record 404s from code paths).
 * - A candidate URL not in store.knownUrls() is NEW. Fetch it (this pass) to get status/title/text:
 *     2xx HTML → record (tracked if count(tracked pages) < watch.maxPages, else tracked=false, text null) and, unless ctx.baseline,
 *       add to NewPagesAlert (title, source). Its links are processed too (BFS continues within this pass, bounded by a per-pass budget
 *       of 200 fetches when ctx.baseline, 40 otherwise; leftover candidates are just recorded as known untracked with lastChecked 0
 *       and fetched in later passes).
 *     redirect to a different in-scope URL → record the FINAL url instead (source 'redirect' if it's new) — do not alert the original.
 *     404/410/other → record as known untracked (status saved) with no alert (unless source 'code' → do not record at all).
 *   Respect config.maxKnownUrls (stop recording beyond it).
 *
 * TEXT CHECK (features.text), for tracked kind='page' records that are due:
 * - Due if opts.full, or record.lastChecked === 0, or now - lastChecked >= sweepSec*1000. Additionally, per pass, check at most
 *   max(5, ceil(trackedCount * intervalSec / sweepSec)) records (oldest lastChecked first) unless opts.full/ctx.baseline (then all).
 * - Fetch with etag/lastModified conditional headers. 304 → unchanged. Non-HTML 2xx → skip text.
 * - 404/410 → failCount++; at 2 (and !gone) → gone=true, add to RemovedPagesAlert (not in baseline). A later 2xx clears gone/failCount silently.
 * - blocked / 5xx / status 0 → skip (no state change except lastChecked, status).
 * - 2xx HTML: snapshot = pageTextSnapshot(parseHtml(...)); cmp = compareText(snapshot, {ignorePatterns: watch.ignorePatterns,
 *   maskNumbers: watch.maskNumbers || record.maskNumbers}); hash = sha1(cmp).
 *   * record.textHash null → store (baseline for this page), no alert.
 *   * hash == record.textHash → unchanged (still refresh stored `text` if it differs only in masked/ignored parts? NO: keep old text).
 *   * hash != record.textHash → CONFIRM: sleep(config.confirmDelayMs), refetch (no conditional headers), compute hash2.
 *       - hash2 == hash → confirmed change.
 *       - hash2 == record.textHash → transient, ignore.
 *       - else unstable: if maskNumbers(cmp) === maskNumbers(cmp2) → numbers are live: set record.maskNumbers=true, recompute the
 *         stored textHash with masking, and emit no alert (log). Otherwise flapCount++; if flapCount >= DYNAMIC_AFTER_FLAPS →
 *         record.dynamic=true and emit an InfoAlert once ("ℹ️ <path> changes on every load; ignoring its text. Use /watch ignore to
 *         filter the changing part."). Dynamic pages are still fetched for link discovery but never produce text alerts.
 *     On confirmed change: flapCount=0; diff = diffText(record.text ?? '', snapshot); if diff.numericOnly → push now into
 *     numericChangeTimes (drop entries older than NUMERIC_WINDOW_MS); if length >= NUMERIC_CHANGES_TO_MASK → maskNumbers=true
 *     (still alert this one, and include an InfoAlert "ℹ️ <path> looks like it shows live numbers; ignoring number-only changes there.").
 *     Add TextChange {url, title, diff, titleChange (if parsed.title differs from record.title)} unless ctx.baseline.
 *     Update record.text/textHash/title/lastChanged; state.lastChangeAt = now.
 * - Always persist lastChecked/status/etag/lastModified.
 * - TextAlert.groups: group changes by diff.hash; groups sorted by urls.length desc.
 *
 * All per-page network work goes through ctx.http (it enforces concurrency); run page fetches with mapLimit(…, 4).
 * In baseline mode return alerts: [] but still record everything.
 *
 * Implementation notes (refinements of the above):
 * - Never throws. An unexpected internal error is logged; records touched so far are still persisted and the alerts
 *   gathered so far are returned (they describe state that was just saved). If saving the records fails, no change alert
 *   is returned (the store still holds the old state, so the change is reported once storage works again) — only a
 *   throttled "saving page data failed" info.
 * - Diffs are computed on the ignore-pattern-filtered text (ignored parts are not changes), and with number masking on the
 *   old side is re-aligned to current numbers, so the diff shows the real edit.
 * - A 2xx page whose text is suddenly empty (blank render / CDN hiccup) is inconclusive, not "everything was removed".
 * - Validators (etag/last-modified) are only stored alongside accepted content.
 * - Number-only changes are held: the first one is only remembered (pendingHash, pendingSince); it is reported when the
 *   same numbers are still there one sweep later (at least NUMERIC_HOLD_MIN_MS; the start page is checked every tick, and
 *   a clock ticking every minute must move on before that), and numbers that moved again count towards auto-masking
 *   instead (NUMERIC_CHANGES_TO_MASK observations → mask silently, one info). The delay is the price of not reporting every
 *   tick of a counter.
 * - Auto-masking is per line (maskedLines): digits are ignored only on the lines seen ticking, so a fee or date edit
 *   elsewhere on a page with a live ticker is still reported.
 * - Flip-flops: a confirmed change back to a version accepted in the last TEXT_FLIP_FLOP_HISTORY_MS (see deploy's
 *   isFlipFlop: current within 15 min, or current twice) is recorded silently — rotating testimonials, A/B edges, reverts.
 * - Churn: the CHURN_LIMIT-th alerted change within CHURN_WINDOW_MS mutes the page (dynamic + one info) instead of
 *   alerting. Muted pages are still fetched for links and their text is tracked silently; once it has not changed for
 *   DYNAMIC_RESET_MS the page is trusted again.
 * - Relative times ("5 minutes ago") never count as changes (see compareText); a stored hash that only differs because the
 *   compare rules changed is re-hashed silently.
 * - Unfetched known URLs are re-probed later: never-fetched and transiently failed ones announce as new if first seen after
 *   the baseline (state.baselineAt); a known 404/410 link that starts serving a page is announced (it just went live).
 *   Links (and hosts) found on a page whose own discovery was silent (a baseline-era backfill page) or whose text is being
 *   (re-)baselined are silent too: they are old, just seen for the first time. Backfill re-probes are limited to
 *   STALE_BACKFILL_PER_PASS per normal pass.
 * - maxPages is enforced both ways: extra tracked pages (lowered cap / now out of scope / excluded / opaque ids) are
 *   demoted, and known live pages are promoted (silently re-baselined) when there is room. Removal alerts need
 *   features.pages or features.text; new-page alerts need features.pages. With features.pages off and no room to track
 *   more pages, nothing is crawled.
 * - Removals: misses less than REMOVAL_MIN_GAP_MS apart count once; a page never seen live (an extra URL added before its
 *   launch) is marked gone silently, and such a page announces as new when it starts serving. The start URL is never
 *   reported removed, and while it answers 404/410 (a site-wide outage) no other page is either. Gone pages are re-checked
 *   every GONE_RECHECK_MS instead of every sweep.
 * - A non-baseline sitemap read that suddenly lists > SITEMAP_BACKFILL_THRESHOLD unknown pages, or the first complete read
 *   after reads that failed transiently, is recorded silently (a backfill, not news). An incomplete read is retried after
 *   RETRY_FAILED_MS. The sitemap fills at most SITEMAP_SHARE_OF_KNOWN of maxKnownUrls; locale copies (/de/…) rank last.
 * - Links and sitemap URLs whose path holds an opaque id (tx hash, address, UUID, token — see isOpaqueIdUrl) are not
 *   crawled or tracked: activity feeds and item pages would otherwise produce "new pages" and price noise on every pass.
 * - At the known-URL cap, a live page found through a link, code or redirect evicts a low-value row (never-fetched sitemap
 *   URL, then dead/redirecting URLs); candidates that could not be stored are not fetched at all.
 * - ctx.silent.discovery / .files (a settings change): new pages/files found in this pass are recorded like at a baseline.
 * - ctx.cancelled(): no new fetch starts (the scheduler gave up on the run).
 */
export async function checkPages(
  ctx: CheckContext,
  opts: { home: HomeSnapshot | null; full: boolean; extraPaths?: string[] },
): Promise<PagesCheckResult> {
  try {
    return await new PagesPass(ctx, opts ?? { home: null, full: false }).run();
  } catch (err) {
    // Only reachable if even the pass setup failed (e.g. a broken watch object).
    safeLog(ctx, 'error', 'pages check failed', { err: errText(err) });
    return { alerts: [], hosts: [], quietHosts: [], fetched: 0 };
  }
}

/**
 * Re-hash the stored text of every tracked page under the watch's current compare settings (after ignore patterns or
 * "ignore numbers" changed), so pages are compared again right away under the new rules without a re-fetch — an edit
 * elsewhere on the page is still reported, while what the new rule hides is not. Held changes and hash histories are
 * dropped (hashes under different rules are not comparable). A page whose text cannot be hashed (slow pattern) is
 * re-baselined silently on its next check instead. Returns the number of pages updated.
 */
export function rehashPages(store: Store, watch: Watch, now: number, log?: Logger): number {
  const pages = store.listPages(watch.id, { kind: 'page', tracked: true });
  const ignorePatterns = Array.isArray(watch.ignorePatterns) ? watch.ignorePatterns : [];
  for (const rec of pages) {
    rec.pendingHash = null;
    rec.pendingSince = null;
    rec.hashHistory = [];
    if (rec.text === null) {
      rec.textHash = null;
      continue;
    }
    try {
      const lines = Array.isArray(rec.maskedLines) ? rec.maskedLines : [];
      rec.textHash = compareHash(rec.text, {
        ignorePatterns,
        maskNumbers: Boolean(watch.maskNumbers || rec.maskNumbers),
        ...(lines.length ? { maskedLines: new Set(lines) } : {}),
      }).hash;
      rec.hashHistory = [{ hash: rec.textHash, at: now }];
    } catch (err) {
      rec.textHash = null;
      try {
        log?.warn('re-hashing page text failed; it is re-baselined on its next check', { url: rec.url, err: errText(err) });
      } catch {
        // ignore logger failures
      }
    }
  }
  for (let i = 0; i < pages.length; i += FLUSH_CHUNK) store.upsertPages(pages.slice(i, i + FLUSH_CHUNK));
  return pages.length;
}

/** Forget the compared text hash of every tracked page, so each is re-baselined silently on its next check. */
export function clearPageHashes(store: Store, watchId: number): number {
  const pages = store.listPages(watchId, { kind: 'page', tracked: true });
  for (const rec of pages) {
    rec.textHash = null;
    rec.pendingHash = null;
    rec.pendingSince = null;
    rec.hashHistory = [];
    rec.etag = null;
    rec.lastModified = null;
  }
  for (let i = 0; i < pages.length; i += FLUSH_CHUNK) store.upsertPages(pages.slice(i, i + FLUSH_CHUNK));
  return pages.length;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Candidate {
  url: string;
  depth: number;
  source: PageSource;
  /** Existing (untracked) record being re-probed; absent for URLs first seen this pass. */
  rec?: PageRecord;
  /** Report as a new page when it turns out to be a live HTML page (and pass that on to the links found on it). */
  announce: boolean;
}

interface ConfirmJob {
  rec: PageRecord;
  /** Compare hash of the first fetch. */
  hash: string;
  cmp: string;
  settings: CompareSettings;
}

/** FIFO without O(n) shifts. */
class Queue<T> {
  private items: T[] = [];
  private head = 0;
  push(item: T): void {
    this.items.push(item);
  }
  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head];
    this.head++;
    return item;
  }
  rest(): T[] {
    return this.items.slice(this.head);
  }
  replace(items: T[]): void {
    this.items = items;
    this.head = 0;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeLog(ctx: CheckContext, level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) {
  try {
    ctx.log?.[level](msg, meta);
  } catch {
    // a broken logger must not break the check
  }
}

function isHtmlResponse(res: FetchResult): boolean {
  return typeof res.bodyText === 'string' && looksLikeHtml(res.contentType, res.bodyText);
}

function isLiveHtml(res: FetchResult | null): res is FetchResult & { bodyText: string } {
  return !!res && res.ok && !res.blocked && !res.notModified && isHtmlResponse(res);
}

function isHtmlType(contentType: string | null): boolean {
  return contentType === 'text/html' || contentType === 'application/xhtml+xml';
}

function isTransientStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

/** Last status says the page exists (a 304 revalidated a stored 2xx). */
function isLiveStatus(status: number | null): boolean {
  return status !== null && ((status >= 200 && status < 300) || status === 304);
}

function isMissingStatus(status: number | null): boolean {
  return status === 404 || status === 410;
}

const HEX_ID_RE = /^(?:0x)?[0-9a-f]{24,}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9]{32,}$/;

/**
 * True when a path segment is an opaque identifier (tx hash, wallet address, UUID, session/base58 token). Links like
 * "/tx/0x…" or "/address/<base58>" on activity feeds churn on every load; each would be a "new page". Slugs are unaffected
 * (they contain separators), and so are ordinary ids ("/post/123").
 */
export function isOpaqueIdUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  for (const raw of path.split('/')) {
    if (raw.length < 24) continue;
    let seg = raw;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      // keep raw
    }
    if (HEX_ID_RE.test(seg) || UUID_RE.test(seg)) return true;
    if (TOKEN_RE.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return true;
  }
  return false;
}

/** First path segment looks like a locale ("/de", "/pt-br", "/zh_CN"). */
const LOCALE_SEGMENT_RE = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i;

function firstSegment(url: string): string {
  try {
    return new URL(url).pathname.split('/')[1] ?? '';
  } catch {
    return '';
  }
}

/** llms.txt / llms-full.txt: machine-readable dumps of the whole docs site that change whenever any page does. */
function isLlmsDump(url: string): boolean {
  try {
    return /\/llms(?:-full)?\.txt$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function finiteNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function capLines(lines: Iterable<string>): string[] {
  const list = [...new Set(lines)];
  return list.length > MAX_MASKED_LINES ? list.slice(-MAX_MASKED_LINES) : list;
}

class PagesPass {
  private readonly watch: Watch;
  private readonly now: number;
  private readonly baseline: boolean;
  private readonly full: boolean;
  private readonly startUrl: string;
  private readonly maxPages: number;
  private readonly deadline: number;
  private readonly excludeRes: RegExp[];
  /** New pages found in this pass may be announced (not a baseline, not a silent re-scope pass). */
  private readonly announceNew: boolean;
  /** New file rows are "known since the baseline" (a baseline, or a silent pass after a settings change). */
  private readonly quietFiles: boolean;
  private readonly knownCap: number;
  private readonly sitemapCap: number;
  /** start / extra URLs → their source. */
  private readonly seeds = new Map<string, PageSource>();

  private known = new Set<string>();
  /** Page records (tracked + untracked) loaded for this pass, by URL. */
  private readonly pages = new Map<string, PageRecord>();
  private trackedPages: PageRecord[] = [];
  private untrackedPages: PageRecord[] = [];
  /** Tracked, not-gone pages (the maxPages budget). */
  private liveTracked = 0;
  private discovery = false;

  private readonly dirty = new Map<string, PageRecord>();
  private readonly deleted = new Set<string>();
  private readonly hosts = new Set<string>();
  private readonly quietHosts = new Set<string>();
  private fetched = 0;
  private flushFailed: string | null = null;
  /** Low-value rows that may be dropped to make room at the known-URL cap (lazily built, best first). */
  private evictable: PageRecord[] | null = null;
  /** The start URL answered 404/410 in this pass (site-wide trouble: no removal alerts). */
  private startMissing = false;

  private readonly queued = new Set<string>();
  private queuedSitemap = 0;
  private readonly codeQ = new Queue<Candidate>();
  private readonly freshQ = new Queue<Candidate>();
  private readonly staleQ = new Queue<Candidate>();
  private readonly deferred: Candidate[] = [];

  private readonly changes: TextChange[] = [];
  private readonly newPages: NewPagesAlert['pages'] = [];
  private readonly announced = new Set<string>();
  private readonly removed: RemovedPagesAlert['pages'] = [];
  private readonly noise: Array<{ kind: NoiseKind; label: string }> = [];

  constructor(
    private readonly ctx: CheckContext,
    private readonly opts: { home: HomeSnapshot | null; full: boolean; extraPaths?: string[] },
  ) {
    this.watch = ctx.watch;
    this.now = finiteNumber(ctx.now(), Date.now());
    this.baseline = Boolean(ctx.baseline);
    this.full = Boolean(opts.full);
    const silent = ctx.silent ?? {};
    this.announceNew = !this.baseline && !silent.discovery;
    this.quietFiles = this.baseline || Boolean(silent.discovery || silent.files);
    this.startUrl = normalizeUrl(this.watch.url) ?? this.watch.url;
    this.maxPages = Math.max(1, Math.floor(finiteNumber(this.watch.maxPages, 1)));
    this.knownCap = Math.max(0, finiteNumber(ctx.config.maxKnownUrls, 5000));
    this.sitemapCap = Math.floor(this.knownCap * SITEMAP_SHARE_OF_KNOWN);
    this.deadline = performance.now() + PASS_TIME_BUDGET_MS;
    this.excludeRes = [];
    for (const src of Array.isArray(this.watch.excludePatterns) ? this.watch.excludePatterns : []) {
      if (typeof src !== 'string' || !src) continue;
      try {
        this.excludeRes.push(new RegExp(src, 'i'));
      } catch {
        // invalid user regex: ignored (inScope does the same)
      }
    }
  }

  private get features() {
    return this.watch.features;
  }

  async run(): Promise<PagesCheckResult> {
    try {
      await this.execute();
    } catch (err) {
      safeLog(this.ctx, 'error', 'pages pass failed', { url: this.watch.url, err: errText(err) });
    }
    this.flush();
    return this.result();
  }

  private async execute(): Promise<void> {
    const f = this.features;
    if (!f || !(f.text || f.pages || f.files)) return;

    this.load();
    this.seed();
    this.rebalance();
    this.discovery = Boolean(f.pages || (f.text && this.liveTracked < this.maxPages));

    const sitemap = this.startSitemap();
    const jobs: ConfirmJob[] = [];

    const home = this.opts.home;
    const startRec = this.pages.get(this.startUrl);
    if (home && home.fetch && startRec && startRec.tracked) {
      const job = this.guard(startRec.url, () => this.processTracked(startRec, home.fetch, home.parsed ?? null));
      if (job) jobs.push(job);
    }

    const due = this.selectDue(Boolean(home && home.fetch));
    const swept = await mapLimit(due, PAGE_FETCH_CONCURRENCY, async (rec) => {
      if (this.pastDeadline()) return null;
      const res = await this.get(rec.url, this.conditionalFor(rec));
      return this.guard(rec.url, () => this.processTracked(rec, res, null));
    });
    for (const job of swept) if (job) jobs.push(job);

    await this.confirm(jobs);

    const sitemapRead = await sitemap;
    if (!this.discovery) return;
    if (sitemapRead) this.addSitemap(sitemapRead.urls, sitemapRead.complete);
    this.addCodePaths();
    this.queueStale();
    await this.discover();
    this.recordLeftovers();
  }

  /** Run a per-page step; an unexpected error only skips that page. */
  private guard<T>(url: string, fn: () => T): T | null {
    try {
      return fn();
    } catch (err) {
      if (err instanceof PatternTimeoutError) {
        if (!throttled('pattern', this.watch.id, this.now)) {
          safeLog(this.ctx, 'warn', 'ignore patterns are too slow on a page; it is skipped until they are changed', {
            watchId: this.watch.id,
            url,
          });
        }
        return null;
      }
      safeLog(this.ctx, 'warn', 'page processing failed', { url, err: errText(err) });
      return null;
    }
  }

  private pastDeadline(): boolean {
    if (performance.now() > this.deadline) return true;
    try {
      return this.ctx.cancelled?.() === true;
    } catch {
      return false;
    }
  }

  /** firstSeen for URLs recorded as "known since the baseline" (never announced later). */
  private quietFirstSeen(): number {
    if (this.baseline) return this.now;
    return Math.min(this.now, finiteNumber(this.ctx.state.baselineAt, 0));
  }

  // --- loading & tracked-set maintenance -----------------------------------

  private load(): void {
    const { store } = this.ctx;
    const id = this.watch.id;
    this.known = store.knownUrls(id);
    this.trackedPages = store.listPages(id, { kind: 'page', tracked: true });
    this.untrackedPages = store.listPages(id, { kind: 'page', tracked: false });
    for (const rec of this.trackedPages) this.pages.set(rec.url, rec);
    for (const rec of this.untrackedPages) this.pages.set(rec.url, rec);
  }

  private seed(): void {
    this.seeds.set(this.startUrl, 'start');
    for (const raw of Array.isArray(this.watch.extraUrls) ? this.watch.extraUrls : []) {
      if (typeof raw !== 'string') continue;
      const url = normalizeUrl(raw);
      if (url && !this.seeds.has(url)) this.seeds.set(url, 'extra');
    }
    for (const [url, source] of this.seeds) {
      const page = this.pages.get(url);
      if (page) {
        if (!page.tracked) this.promote(page);
        continue;
      }
      const kind: PageKind = url !== this.startUrl && classifyUrl(url) === 'file' ? 'file' : 'page';
      if (this.known.has(url)) {
        // Known but not a page row → a file row.
        const rec = this.ctx.store.getPage(this.watch.id, url);
        if (rec && !rec.tracked) {
          rec.tracked = true;
          this.touch(rec);
        }
        continue;
      }
      const rec = this.newRecord(url, kind, source, 0);
      rec.tracked = true;
      this.known.add(url);
      this.touch(rec);
      if (kind === 'page') {
        this.pages.set(url, rec);
        this.trackedPages.push(rec);
      }
    }
  }

  /** Enforce scope/exclusions and maxPages on the tracked set; promote known live pages when there is room. */
  private rebalance(): void {
    for (const rec of this.trackedPages) {
      if (this.seeds.has(rec.url)) continue;
      if (!inScope(rec.url, this.watch, true) || isOpaqueIdUrl(rec.url)) this.demote(rec);
    }
    let live = this.trackedPages.filter((r) => r.tracked && !r.gone);
    if (live.length > this.maxPages) {
      const removable = live
        .filter((r) => !this.seeds.has(r.url))
        .sort((a, b) => b.depth - a.depth || b.firstSeen - a.firstSeen || (a.url < b.url ? 1 : -1));
      let excess = live.length - this.maxPages;
      for (const rec of removable) {
        if (excess <= 0) break;
        this.demote(rec);
        excess--;
      }
      live = this.trackedPages.filter((r) => r.tracked && !r.gone);
    }
    let room = this.maxPages - live.length;
    if (room > 0) {
      const promotable = this.untrackedPages
        .filter(
          (r) =>
            r.tracked === false &&
            !r.gone &&
            isLiveStatus(r.status) &&
            isHtmlType(r.contentType) &&
            inScope(r.url, this.watch, true) &&
            !isOpaqueIdUrl(r.url),
        )
        .sort((a, b) => a.depth - b.depth || a.firstSeen - b.firstSeen || (a.url < b.url ? -1 : 1));
      for (const rec of promotable) {
        if (room <= 0) break;
        this.promote(rec);
        room--;
      }
    }
    this.trackedPages = this.trackedPages.filter((r) => r.tracked);
    this.untrackedPages = this.untrackedPages.filter((r) => !r.tracked);
    this.liveTracked = this.trackedPages.filter((r) => !r.gone).length;

    if (this.features.files) {
      for (const rec of this.ctx.store.listPages(this.watch.id, { kind: 'file', tracked: true })) {
        if (this.seeds.has(rec.url)) continue;
        // Excluded files, and twins of pages (".md" alternates, llms.txt dumps) that would only repeat text alerts.
        if (this.isExcluded(rec.url) || this.isPageTwin(rec.url)) {
          rec.tracked = false;
          this.touch(rec);
        }
      }
    }
  }

  private demote(rec: PageRecord): void {
    rec.tracked = false;
    rec.text = null;
    rec.textHash = null;
    rec.etag = null;
    rec.lastModified = null;
    rec.pendingHash = null;
    rec.pendingSince = null;
    rec.hashHistory = [];
    this.touch(rec);
    this.untrackedPages.push(rec);
  }

  /** Start tracking a known page; its text is re-baselined silently on its next (immediate) check. */
  private promote(rec: PageRecord): void {
    rec.tracked = true;
    rec.text = null;
    rec.textHash = null;
    rec.etag = null;
    rec.lastModified = null;
    rec.pendingHash = null;
    rec.pendingSince = null;
    rec.hashHistory = [];
    rec.lastChecked = 0;
    this.touch(rec);
    if (!this.trackedPages.includes(rec)) this.trackedPages.push(rec);
  }

  // --- sweep of tracked pages ----------------------------------------------

  private selectDue(homeGiven: boolean): PageRecord[] {
    const sweepSec = Math.max(1, finiteNumber(this.watch.sweepSec, 120));
    const intervalSec = Math.max(1, finiteNumber(this.watch.intervalSec, 30));
    const sweepMs = sweepSec * 1000;
    const candidates = this.trackedPages.filter((r) => r.kind === 'page' && !(homeGiven && r.url === this.startUrl));
    const due = candidates.filter((r) => {
      if (this.full || r.lastChecked === 0 || r.lastChecked > this.now) return true;
      // Removed pages come back rarely: re-check them hourly instead of on every sweep.
      const every = r.gone && !this.baseline ? Math.max(sweepMs, GONE_RECHECK_MS) : sweepMs;
      return this.now - r.lastChecked >= every;
    });
    due.sort((a, b) => a.lastChecked - b.lastChecked || a.depth - b.depth || (a.url < b.url ? -1 : 1));
    if (this.full || this.baseline) return due;
    const liveCount = this.trackedPages.filter((r) => !r.gone).length;
    const limit = Math.max(5, Math.ceil((liveCount * intervalSec) / sweepSec));
    return due.slice(0, limit);
  }

  private conditionalFor(rec: PageRecord): { etag: string | null; lastModified: string | null } | null {
    if (this.baseline || rec.textHash === null || rec.text === null) return null;
    if (!rec.etag && !rec.lastModified) return null;
    return { etag: rec.etag, lastModified: rec.lastModified };
  }

  private async get(
    url: string,
    conditional: { etag: string | null; lastModified: string | null } | null = null,
  ): Promise<FetchResult | null> {
    this.fetched++;
    try {
      return await this.ctx.http.fetch(url, conditional ? { etag: conditional.etag, lastModified: conditional.lastModified } : {});
    } catch (err) {
      safeLog(this.ctx, 'warn', 'page fetch failed', { url, err: errText(err) });
      return null;
    }
  }

  /** Handle one tracked page response. Returns a confirm job when its text seems to have changed. */
  private processTracked(rec: PageRecord, res: FetchResult | null, parsedIn: ParsedPage | null): ConfirmJob | null {
    const prevStatus = rec.status;
    const prevChecked = finiteNumber(rec.lastChecked, 0);
    const wasMissing = rec.gone || rec.failCount > 0 || isMissingStatus(prevStatus);
    // Content was seen at some point: only then is a 404 a "removal" (an extra URL added before its launch is not), and
    // only a page never seen live can "go live".
    const seenLive = rec.text !== null || rec.textHash !== null || isLiveStatus(prevStatus);
    rec.lastChecked = this.now;
    this.touch(rec);
    if (!res) {
      rec.status = 0;
      return null;
    }
    rec.status = finiteNumber(res.status, 0);
    if (res.notModified) {
      this.markLive(rec);
      if (rec.flapCount) rec.flapCount = 0;
      if (rec.dynamic) this.maybeTrustAgain(rec);
      return null;
    }
    if (res.blocked) return null;
    if (res.status === 404 || res.status === 410) {
      if (rec.url === this.startUrl) this.startMissing = true;
      this.markMissing(rec, res.status, prevChecked, seenLive);
      return null;
    }
    if (!res.ok) return null;
    this.markLive(rec);
    if (res.contentType) rec.contentType = res.contentType;
    if (!isHtmlResponse(res)) return null;

    const parsed = parsedIn ?? parseHtml(res.bodyText as string, res.finalUrl || rec.url);
    // A page seen for the first time (just seeded or promoted, or never served content yet — e.g. blocked at the baseline)
    // has no "before" to compare its links against: they are old news. (Not the stored text hash: with text checks off,
    // or after an ignore-pattern change, pages have none but their links were collected all along.)
    const firstLook = rec.kind === 'page' && (prevChecked <= 0 || (rec.text === null && !isLiveStatus(prevStatus)));
    this.collect(parsed, rec.depth, !firstLook);
    this.noteRedirect(rec, res, !firstLook);
    if (rec.kind !== 'page') return null;
    if (firstLook && wasMissing && !seenLive && this.announceNew && this.features.pages && !this.announced.has(rec.url)) {
      // A tracked URL that did not exist yet (e.g. an extra URL added before its launch) just went live.
      this.announced.add(rec.url);
      this.newPages.push({ url: rec.url, title: parsed.title ?? null, source: rec.source });
      this.ctx.state.lastChangeAt = this.now;
    }
    if (!this.features.text) return null;
    if (rec.dynamic) {
      this.trackDynamic(rec, res, parsed);
      return null;
    }
    return this.compareTracked(rec, res, parsed);
  }

  private markLive(rec: PageRecord): void {
    if (rec.gone || rec.failCount) {
      rec.gone = false;
      rec.failCount = 0;
    }
  }

  private markMissing(rec: PageRecord, status: number, prevChecked: number, seenLive: boolean): void {
    const failCount = finiteNumber(rec.failCount, 0);
    // Two misses in quick succession (a full sweep right after a normal check) are one observation.
    if (failCount > 0 && prevChecked > 0 && prevChecked <= this.now && this.now - prevChecked < REMOVAL_MIN_GAP_MS) return;
    rec.failCount = failCount + 1;
    if (rec.failCount >= 2 && !rec.gone) {
      rec.gone = true;
      const reportable = seenLive && rec.url !== this.startUrl;
      if (reportable && !this.baseline && (this.features.pages || this.features.text)) {
        this.removed.push({ url: rec.url, status });
        this.ctx.state.lastChangeAt = this.now;
      }
    }
  }

  /** A tracked page that now redirects to an unknown in-scope URL: that URL is a discovery candidate. */
  private noteRedirect(rec: PageRecord, res: FetchResult, announce: boolean): void {
    if (!this.discovery || !res.redirected) return;
    const final = normalizeUrl(res.finalUrl);
    if (!final || final === rec.url || this.known.has(final) || this.queued.has(final)) return;
    if (classifyUrl(final) !== 'page' || !inScope(final, this.watch, true) || isOpaqueIdUrl(final)) return;
    if (!this.canQueue()) return;
    this.queued.add(final);
    this.freshQ.push({ url: final, depth: rec.depth, source: 'redirect', announce });
  }

  /** How long held numbers must stay put before they are reported: one sweep, and at least NUMERIC_HOLD_MIN_MS. */
  private holdMs(): number {
    return Math.max(NUMERIC_HOLD_MIN_MS, Math.max(1, finiteNumber(this.watch.sweepSec, 120)) * 1000);
  }

  /** The held change has stayed the same long enough to be a real edit. */
  private holdOver(rec: PageRecord): boolean {
    const since = finiteNumber(rec.pendingSince, 0);
    return since <= 0 || since > this.now || this.now - since >= this.holdMs();
  }

  private settingsFor(rec: PageRecord | undefined): CompareSettings {
    const lines = Array.isArray(rec?.maskedLines) ? rec.maskedLines : [];
    return {
      ignorePatterns: Array.isArray(this.watch.ignorePatterns) ? this.watch.ignorePatterns : [],
      maskNumbers: Boolean(this.watch.maskNumbers || rec?.maskNumbers),
      ...(lines.length ? { maskedLines: new Set(lines) } : {}),
    };
  }

  private compareTracked(rec: PageRecord, res: FetchResult, parsed: ParsedPage): ConfirmJob | null {
    const snapshot = snapshotOf(parsed);
    const settings = this.settingsFor(rec);
    if (rec.textHash === null || rec.text === null) {
      this.accept(rec, snapshot, parsed, res, compareHash(snapshot, settings).hash);
      return null;
    }
    if (snapshot === '' && rec.text !== '') {
      safeLog(this.ctx, 'debug', 'blank page render ignored', { url: rec.url });
      return null;
    }
    const { cmp, hash } = compareHash(snapshot, settings);
    // Still the held numbers, still inside the hold period: nothing to decide yet (no confirm fetch needed).
    if (hash === rec.pendingHash && !this.baseline && !this.holdOver(rec)) return null;
    if (hash === rec.textHash) {
      this.setValidators(rec, res);
      if (rec.flapCount) rec.flapCount = 0;
      rec.pendingHash = null; // held numbers went back to the stored ones
      rec.pendingSince = null;
      return null;
    }
    // The stored text itself hashes to this under today's rules (the compare rules changed, e.g. relative times are
    // normalized now): nothing changed on the page.
    const storedHash = compareHash(rec.text, settings).hash;
    if (storedHash === hash) {
      rec.textHash = hash;
      rec.pendingHash = null;
      rec.pendingSince = null;
      this.setValidators(rec, res);
      return null;
    }
    if (this.baseline) {
      this.accept(rec, snapshot, parsed, res, hash);
      return null;
    }
    return { rec, hash, cmp, settings };
  }

  /** Store content as the page's reference version (no alert). `hash` is its compare hash under the page's settings. */
  private accept(rec: PageRecord, snapshot: string, parsed: ParsedPage, res: FetchResult, hash: string): void {
    rec.text = snapshot;
    rec.textHash = hash;
    rec.title = parsed.title ?? null;
    rec.pendingHash = null;
    rec.pendingSince = null;
    this.pushHistory(rec, hash);
    this.setValidators(rec, res);
  }

  private setValidators(rec: PageRecord, res: FetchResult): void {
    const h = res.headers ?? {};
    rec.etag = typeof h['etag'] === 'string' && h['etag'] ? h['etag'] : null;
    rec.lastModified = typeof h['last-modified'] === 'string' && h['last-modified'] ? h['last-modified'] : null;
    if (res.body) rec.contentLength = res.body.length;
    else {
      const cl = Number.parseInt(h['content-length'] ?? '', 10);
      if (Number.isFinite(cl) && cl >= 0) rec.contentLength = cl;
    }
    if (res.contentType) rec.contentType = res.contentType;
  }

  private pushHistory(rec: PageRecord, hash: string, at: number = this.now): void {
    const h = Array.isArray(rec.hashHistory) ? rec.hashHistory : [];
    if (h.length > 0 && h[h.length - 1].hash === hash) {
      rec.hashHistory = h;
      return;
    }
    h.push({ hash, at });
    rec.hashHistory = h.slice(-TEXT_HISTORY_MAX);
  }

  /**
   * A muted page's text is still followed silently (so the stored version stays current), and a page that has not
   * changed for DYNAMIC_RESET_MS is trusted again.
   */
  private trackDynamic(rec: PageRecord, res: FetchResult, parsed: ParsedPage): void {
    const snapshot = snapshotOf(parsed);
    if (snapshot === '' && rec.text) return;
    const { hash } = compareHash(snapshot, this.settingsFor(rec));
    if (rec.textHash === null || rec.text === null || hash !== rec.textHash) {
      rec.text = snapshot;
      rec.textHash = hash;
      rec.title = parsed.title ?? null;
      rec.lastChanged = this.now;
      this.setValidators(rec, res);
      return;
    }
    this.setValidators(rec, res);
    this.maybeTrustAgain(rec);
  }

  private maybeTrustAgain(rec: PageRecord): void {
    const since = finiteNumber(rec.lastChanged ?? rec.firstSeen, 0);
    if (this.now - since < DYNAMIC_RESET_MS) return;
    rec.dynamic = false;
    rec.flapCount = 0;
    rec.changeTimes = [];
    rec.pendingHash = null;
    rec.pendingSince = null;
    rec.hashHistory = rec.textHash ? [{ hash: rec.textHash, at: this.now }] : [];
    safeLog(this.ctx, 'info', 'page settled down; its text is compared again', { url: rec.url });
  }

  private markDynamic(rec: PageRecord, why: 'dynamic' | 'churn'): void {
    rec.dynamic = true;
    rec.lastChanged = this.now;
    rec.pendingHash = null;
    rec.pendingSince = null;
    safeLog(this.ctx, 'info', why === 'churn' ? 'page changes too often; muted' : 'page marked dynamic', { url: rec.url });
    this.noteNoise(rec, why);
  }

  private noteNoise(rec: PageRecord, kind: NoiseKind): void {
    if (!this.baseline) this.noise.push({ kind, label: pageLabel(rec.url, this.watch) });
  }

  // --- confirmation ----------------------------------------------------------

  private async confirm(jobs: ConfirmJob[]): Promise<void> {
    if (jobs.length === 0 || this.pastDeadline()) return;
    try {
      await this.ctx.sleep(Math.max(0, finiteNumber(this.ctx.config.confirmDelayMs, 0)));
    } catch {
      // a failing sleep just means no delay
    }
    await mapLimit(jobs, PAGE_FETCH_CONCURRENCY, async (job) => {
      // Not confirmed now = the stored hash stays old, so the change is simply seen again on the next check.
      if (this.pastDeadline()) return;
      const res = await this.get(job.rec.url);
      this.guard(job.rec.url, () => this.resolveConfirm(job, res));
    });
  }

  private resolveConfirm(job: ConfirmJob, res: FetchResult | null): void {
    const { rec } = job;
    if (!isLiveHtml(res)) {
      safeLog(this.ctx, 'debug', 'confirm fetch inconclusive', { url: rec.url, status: res?.status ?? 0 });
      return;
    }
    const parsed = parseHtml(res.bodyText, res.finalUrl || rec.url);
    const snapshot = snapshotOf(parsed);
    if (snapshot === '' && rec.text) return;
    const { cmp, hash } = compareHash(snapshot, job.settings);

    if (hash === job.hash) {
      this.confirmedChange(rec, snapshot, parsed, res, job.settings, hash);
      return;
    }
    if (hash === rec.textHash) {
      safeLog(this.ctx, 'debug', 'transient text change ignored', { url: rec.url });
      return;
    }
    // The two fetches disagree with each other and with the stored version.
    if (!job.settings.maskNumbers && maskNumbers(job.cmp) === maskNumbers(cmp)) {
      // Only numbers moved between two loads seconds apart: those lines tick. Ignore digits on them from now on.
      const had = Array.isArray(rec.maskedLines) ? rec.maskedLines : [];
      const lines = new Set([...had, ...tickingLines(job.cmp, cmp)]);
      const masked = compareHash(rec.text ?? '', { ...job.settings, maskedLines: lines }).hash;
      rec.maskedLines = capLines(lines);
      rec.textHash = masked;
      rec.pendingHash = null;
      rec.pendingSince = null;
      rec.hashHistory = [{ hash: masked, at: this.now }];
      safeLog(this.ctx, 'info', 'live numbers detected; masking digits on the lines that tick', { url: rec.url, lines: lines.size });
      if (had.length === 0) this.noteNoise(rec, 'live');
      return;
    }
    rec.flapCount = finiteNumber(rec.flapCount, 0) + 1;
    if (rec.flapCount >= DYNAMIC_AFTER_FLAPS && !rec.dynamic) this.markDynamic(rec, 'dynamic');
  }

  /** Record a new version without alerting (flip-flop, masking switch, muting). */
  private acceptSilently(rec: PageRecord, snapshot: string, parsed: ParsedPage, res: FetchResult, hash: string): void {
    rec.text = snapshot;
    rec.textHash = hash;
    rec.title = parsed.title ?? null;
    rec.lastChanged = this.now;
    rec.pendingHash = null;
    rec.pendingSince = null;
    this.pushHistory(rec, hash);
    this.setValidators(rec, res);
  }

  private confirmedChange(
    rec: PageRecord,
    snapshot: string,
    parsed: ParsedPage,
    res: FetchResult,
    settings: CompareSettings,
    hash: string,
  ): void {
    // Everything that can fail (user patterns) is computed before the record is touched.
    const diff = pageDiff(rec.text ?? '', snapshot, settings);
    const tChange = titleChange(rec.title, parsed.title ?? null, settings);
    // The lines whose numbers moved: if they keep moving, digits are ignored on those lines (and only those).
    const learned = diff.numericOnly && !settings.maskNumbers ? new Set([...diff.removed, ...diff.added].map(maskNumbers)) : null;
    const learnedLines = learned ? new Set([...(settings.maskedLines ?? []), ...learned]) : null;
    const maskedHash = learnedLines ? compareHash(snapshot, { ...settings, maskedLines: learnedLines }).hash : null;
    rec.flapCount = 0;

    if (diff.added.length === 0 && diff.removed.length === 0) {
      // Only reachable when compare settings drifted since the hash was stored: silently re-baselined.
      this.acceptSilently(rec, snapshot, parsed, res, hash);
      return;
    }

    // Make sure the version we are leaving is in the history (at = when it became current).
    if (rec.textHash) this.pushHistory(rec, rec.textHash, finiteNumber(rec.lastChanged ?? rec.firstSeen, this.now));

    if (maskedHash !== null) {
      if (rec.pendingHash !== hash) {
        // A new set of numbers: hold it until the next check shows whether it stays put or keeps moving.
        const times = (Array.isArray(rec.numericChangeTimes) ? rec.numericChangeTimes : []).filter(
          (t) => Number.isFinite(t) && t <= this.now && this.now - t < NUMERIC_WINDOW_MS,
        );
        times.push(this.now);
        rec.numericChangeTimes = times.slice(-NUMERIC_CHANGES_TO_MASK * 2);
        if (times.length >= NUMERIC_CHANGES_TO_MASK && learnedLines) {
          // The numbers keep moving: they are live. Ignore digits on those lines from now on (hashes change meaning).
          const first = !(Array.isArray(rec.maskedLines) && rec.maskedLines.length > 0);
          rec.maskedLines = capLines(learnedLines);
          rec.numericChangeTimes = [];
          rec.hashHistory = [];
          this.acceptSilently(rec, snapshot, parsed, res, maskedHash);
          safeLog(this.ctx, 'info', 'live numbers detected; masking digits on the lines that tick', { url: rec.url, lines: learnedLines.size });
          if (first) this.noteNoise(rec, 'live');
          return;
        }
        rec.pendingHash = hash;
        rec.pendingSince = this.now;
        return;
      }
      // The same numbers again: a real number edit once they stayed put for a whole hold period (a clock that ticks every
      // minute on a page checked every 30 seconds moves on before that).
      if (!this.holdOver(rec)) return;
    }
    rec.pendingHash = null;
    rec.pendingSince = null;

    const history = (Array.isArray(rec.hashHistory) ? rec.hashHistory : [])
      .filter((h) => h.at <= this.now && this.now - h.at <= TEXT_FLIP_FLOP_HISTORY_MS)
      .map((h) => ({ sig: h.hash, at: h.at }));
    if (isFlipFlop(history, hash, this.now)) {
      this.acceptSilently(rec, snapshot, parsed, res, hash);
      safeLog(this.ctx, 'info', 'page text flipped back to a recent version; not alerting', { url: rec.url });
      return;
    }

    const recent = (Array.isArray(rec.changeTimes) ? rec.changeTimes : []).filter(
      (t) => Number.isFinite(t) && t <= this.now && this.now - t < CHURN_WINDOW_MS,
    );
    recent.push(this.now);
    rec.changeTimes = recent.slice(-CHURN_LIMIT * 2);
    if (recent.length >= CHURN_LIMIT) {
      this.acceptSilently(rec, snapshot, parsed, res, hash);
      this.markDynamic(rec, 'churn');
      return;
    }

    rec.text = snapshot;
    rec.textHash = hash;
    rec.title = parsed.title ?? null;
    rec.lastChanged = this.now;
    this.pushHistory(rec, hash);
    this.setValidators(rec, res);
    this.ctx.state.lastChangeAt = this.now;
    if (!this.baseline && this.features.text) {
      this.changes.push({ url: rec.url, title: rec.title, diff, titleChange: tChange });
    }
  }

  // --- discovery -------------------------------------------------------------

  /** Room to record one more URL (possibly by evicting a low-value row). Candidates that could not be stored are not fetched. */
  private canQueue(): boolean {
    return this.known.size < this.knownCap || this.hasEvictable();
  }

  /**
   * Links, files and hosts of a fetched page. `announce` = links newly found here may be news (false for pages whose own
   * discovery was silent, and for pages seen for the first time: their links existed before we looked).
   */
  private collect(parsed: ParsedPage, parentDepth: number, announce = true): void {
    const loud = announce || this.baseline;
    for (const h of Array.isArray(parsed.hosts) ? parsed.hosts : []) this.addHost(h, loud);
    const assets = parsed.assets;
    if (assets) {
      for (const list of [assets.scripts, assets.styles, assets.preloads]) {
        if (Array.isArray(list)) for (const u of list) this.addHostOf(u, loud);
      }
    }
    const childDepth = finiteNumber(parentDepth, 0) + 1;
    for (const link of Array.isArray(parsed.links) ? parsed.links : []) {
      if (typeof link !== 'string') continue;
      this.addHostOf(link, loud);
      if (this.known.has(link) || this.queued.has(link)) continue;
      const cls = classifyUrl(link);
      if (cls === 'file') {
        this.addFile(link, 'link', childDepth);
        continue;
      }
      if (cls !== 'page' || !this.discovery || childDepth > MAX_CRAWL_DEPTH) continue;
      if (!inScope(link, this.watch) || isOpaqueIdUrl(link)) continue;
      if (!this.canQueue()) continue;
      this.queued.add(link);
      this.freshQ.push({ url: link, depth: childDepth, source: 'link', announce });
    }
  }

  private addHost(host: string, loud: boolean): void {
    if (typeof host !== 'string') return;
    const h = host.trim().toLowerCase().replace(/\.+$/, '');
    if (!h || h.startsWith('[')) return;
    if (loud) {
      if (this.hosts.size >= MAX_RESULT_HOSTS) return;
      this.hosts.add(h);
      this.quietHosts.delete(h);
    } else if (!this.hosts.has(h) && this.quietHosts.size < MAX_RESULT_HOSTS) {
      this.quietHosts.add(h);
    }
  }

  private addHostOf(url: string, loud: boolean): void {
    if (typeof url !== 'string') return;
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') this.addHost(u.hostname, loud);
    } catch {
      // unparseable: ignore
    }
  }

  private isExcluded(url: string): boolean {
    if (this.excludeRes.length === 0) return false;
    // Absurdly long URLs are junk crawl targets; never run user regexes over them.
    if (url.length > MAX_SCOPED_URL_CHARS) return true;
    for (const re of this.excludeRes) {
      re.lastIndex = 0;
      if (re.test(url)) return true;
    }
    return false;
  }

  /** A file URL that just mirrors a page: "<page>.md" alternates and llms.txt / llms-full.txt dumps. */
  private isPageTwin(url: string): boolean {
    if (isLlmsDump(url)) return true;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (!/\.md$/i.test(u.pathname)) return false;
    const base = normalizeUrl(`${u.origin}${u.pathname.replace(/\.md$/i, '')}`);
    if (!base) return false;
    if (this.known.has(base) || this.queued.has(base)) return true;
    // "/docs/index.md" mirrors "/docs".
    const index = /\/index$/i.test(base) ? normalizeUrl(base.replace(/\/index$/i, '/')) : null;
    return Boolean(index && this.known.has(index));
  }

  /** Same-site linked document → file row for files.ts (never alerts here). */
  private addFile(url: string, source: PageSource, depth: number): void {
    if (!this.features.files || this.known.has(url)) return;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    if (!isUnderDomain(host, this.watch.rootDomain) || this.isExcluded(url) || this.isPageTwin(url) || !this.canRecord()) return;
    const rec = this.newRecord(url, 'file', source, depth);
    rec.tracked = true;
    // Files found during a silent pass existed before we looked: files.ts must not report them as "added".
    if (this.quietFiles) rec.firstSeen = this.quietFirstSeen();
    this.known.add(url);
    this.touch(rec);
  }

  private sitemapDue(): boolean {
    if (this.baseline || this.full) return true;
    const last = finiteNumber(this.ctx.state.sitemapLastScan, 0);
    return last > this.now || this.now - last >= this.sitemapIntervalMs();
  }

  private sitemapIntervalMs(): number {
    return Math.max(1, finiteNumber(this.ctx.config.sitemapIntervalSec, 600)) * 1000;
  }

  private startSitemap(): Promise<{ urls: string[]; complete: boolean } | null> {
    if (!this.discovery || !this.sitemapDue()) return Promise.resolve(null);
    this.ctx.state.sitemapLastScan = this.now;
    const maxUrls = Math.max(0, Math.min(SITEMAP_MAX_URLS, this.sitemapCap));
    return discoverSitemap(this.ctx.http, this.startUrl, { maxUrls }).catch((err: unknown) => {
      safeLog(this.ctx, 'warn', 'sitemap discovery failed', { err: errText(err) });
      return { urls: [] as string[], complete: false };
    });
  }

  private addSitemap(urls: string[], complete: boolean): void {
    const state = this.ctx.state;
    if (!complete) {
      // A read that failed part-way (429/5xx/timeout) is retried soon instead of after a full interval.
      const interval = this.sitemapIntervalMs();
      if (interval > RETRY_FAILED_MS) state.sitemapLastScan = this.now - interval + RETRY_FAILED_MS;
      safeLog(this.ctx, 'debug', 'sitemap read incomplete; retrying soon', { url: this.watch.url });
    }
    const startLocale = LOCALE_SEGMENT_RE.test(firstSegment(this.startUrl));
    const unknown: Array<{ url: string; depth: number }> = [];
    const seen = new Set<string>();
    for (const raw of urls) {
      if (typeof raw !== 'string') continue;
      const url = normalizeUrl(raw);
      if (!url || seen.has(url) || this.known.has(url) || this.queued.has(url)) continue;
      seen.add(url);
      const cls = classifyUrl(url);
      if (cls === 'file') {
        this.addFile(url, 'sitemap', 1);
        continue;
      }
      if (cls !== 'page' || !inScope(url, this.watch, true) || isOpaqueIdUrl(url)) continue;
      // Translations of the site ("/de/…") rank after the original pages when the watch is not itself on a locale path.
      const locale = !startLocale && LOCALE_SEGMENT_RE.test(firstSegment(url));
      unknown.push({ url, depth: locale ? 2 : 1 });
    }
    unknown.sort((a, b) => a.depth - b.depth);

    const firstRead = !state.sitemapComplete;
    if (complete) state.sitemapComplete = true;
    if (!this.baseline && (unknown.length > SITEMAP_BACKFILL_THRESHOLD || firstRead || !this.announceNew)) {
      if (unknown.length > 0) {
        safeLog(this.ctx, 'info', 'sitemap backfill recorded silently', { url: this.watch.url, count: unknown.length });
      }
      // First seen "at baseline" so later probes don't announce them either.
      const firstSeen = this.quietFirstSeen();
      for (const u of unknown) {
        if (this.known.size >= this.sitemapCap) break;
        this.createPending(u.url, 'sitemap', u.depth, firstSeen);
      }
      return;
    }
    for (const u of unknown) {
      if (this.known.size + this.queuedSitemap >= this.sitemapCap) break;
      this.queued.add(u.url);
      this.queuedSitemap++;
      this.freshQ.push({ url: u.url, depth: u.depth, source: 'sitemap', announce: true });
    }
  }

  private addCodePaths(): void {
    const paths = Array.isArray(this.opts.extraPaths) ? this.opts.extraPaths : [];
    let n = 0;
    for (const p of paths) {
      if (n >= MAX_CODE_CANDIDATES) {
        safeLog(this.ctx, 'debug', 'too many code paths; rest skipped', { count: paths.length });
        break;
      }
      if (typeof p !== 'string' || !p.trim()) continue;
      const url = normalizeUrl(p.trim(), this.startUrl);
      if (!url || this.known.has(url) || this.queued.has(url)) continue;
      if (classifyUrl(url) !== 'page' || !inScope(url, this.watch) || isOpaqueIdUrl(url)) continue;
      if (!this.canQueue()) break;
      this.queued.add(url);
      this.codeQ.push({ url, depth: 1, source: 'code', announce: true });
      n++;
    }
  }

  /** Known page URLs worth (re-)probing: never fetched, failed transiently, or missing (to catch them going live). */
  private queueStale(): void {
    const baselineAt = finiteNumber(this.ctx.state.baselineAt, 0);
    const items: Array<{ c: Candidate; tier: number; lastChecked: number }> = [];
    for (const rec of this.untrackedPages) {
      if (rec.kind !== 'page' || rec.tracked || rec.gone || this.queued.has(rec.url)) continue;
      if (isOpaqueIdUrl(rec.url)) {
        // Item/activity pages (tx hashes, token addresses) are never crawled; free their slot.
        this.drop(rec);
        continue;
      }
      if (!inScope(rec.url, this.watch, true)) continue;
      const status = rec.status;
      const age = rec.lastChecked > this.now ? Number.POSITIVE_INFINITY : this.now - rec.lastChecked;
      const afterBaseline = rec.firstSeen > baselineAt;
      let tier: number;
      let announce: boolean;
      if (status === null) {
        tier = 0;
        announce = afterBaseline;
      } else if (isLiveStatus(status)) {
        continue; // live page, untracked only because of the cap
      } else if (isTransientStatus(status)) {
        if (age < RETRY_FAILED_MS) continue;
        tier = 1;
        announce = afterBaseline;
      } else if (status === 404 || status === 410) {
        if (age < RECHECK_MISSING_MS) continue;
        tier = 2;
        announce = true;
      } else {
        if (age < RECHECK_OTHER_MS) continue;
        tier = 3;
        announce = afterBaseline;
      }
      items.push({ c: { url: rec.url, depth: rec.depth, source: rec.source, rec, announce }, tier, lastChecked: rec.lastChecked });
    }
    items.sort((a, b) => a.tier - b.tier || a.c.depth - b.c.depth || a.lastChecked - b.lastChecked);
    let list = items.map((i) => i.c);
    if (!this.baseline && !this.full) {
      // Silent backfill (URLs known since the baseline) is slow, background work: a few per pass.
      let backfill = 0;
      list = list.filter((c) => c.announce || backfill++ < STALE_BACKFILL_PER_PASS);
    }
    this.staleQ.replace(list);
  }

  private nextCandidate(): Candidate | undefined {
    for (const q of [this.codeQ, this.freshQ, this.staleQ]) {
      for (let c = q.shift(); c; c = q.shift()) {
        if (!c.rec && this.known.has(c.url)) continue;
        if (c.rec && !this.pages.has(c.url)) continue; // evicted meanwhile
        return c;
      }
    }
    return undefined;
  }

  private async discover(): Promise<void> {
    let budget = this.baseline || this.full ? DISCOVERY_FETCHES_FULL : DISCOVERY_FETCHES_NORMAL;
    while (budget > 0 && !this.pastDeadline()) {
      const batch: Candidate[] = [];
      const size = Math.min(budget, DISCOVERY_STEP);
      while (batch.length < size) {
        const c = this.nextCandidate();
        if (!c) break;
        batch.push(c);
      }
      if (batch.length === 0) break;
      budget -= batch.length;
      await mapLimit(batch, PAGE_FETCH_CONCURRENCY, async (c) => {
        if (this.pastDeadline()) {
          this.deferred.push(c);
          return;
        }
        const res = await this.get(c.url);
        // Recorded meanwhile (e.g. as another candidate's redirect target).
        if (!c.rec && this.known.has(c.url)) return;
        this.guard(c.url, () => this.handleCandidate(c, res));
      });
    }
  }

  private handleCandidate(c: Candidate, res: FetchResult | null): void {
    const code = c.source === 'code';
    if (!res) {
      if (code && c.rec) this.drop(c.rec);
      else if (!code) this.saveKnown(c, 0, null);
      return;
    }
    const live = isLiveHtml(res);

    const final = res.redirected ? normalizeUrl(res.finalUrl) : null;
    if (final && final !== c.url) {
      const finalInScope = classifyUrl(final) === 'page' && inScope(final, this.watch, true) && !isOpaqueIdUrl(final);
      if (live && finalInScope) {
        if (code) {
          if (c.rec) this.drop(c.rec);
        } else {
          this.saveKnown(c, REDIRECT_STATUS, res);
        }
        if (!this.known.has(final)) {
          const parsed = parseHtml(res.bodyText as string, res.finalUrl);
          this.recordLive(final, { url: final, depth: c.depth, source: 'redirect', announce: c.announce }, res, parsed);
        }
        return;
      }
      // Redirected out of scope (login wall, other host, a file, ...).
      if (code) {
        if (c.rec) this.drop(c.rec);
        return;
      }
      this.saveKnown(c, res.status === 0 ? 0 : REDIRECT_STATUS, res);
      return;
    }

    if (live) {
      const parsed = parseHtml(res.bodyText as string, res.finalUrl || c.url);
      this.recordLive(c.url, c, res, parsed);
      return;
    }
    const status = finiteNumber(res.status, 0);
    if (code) {
      // Code paths are only kept while unresolved (transient failure); definitive non-pages are never recorded.
      if (isTransientStatus(status) || res.blocked) this.saveKnown(c, status, res);
      else if (c.rec) this.drop(c.rec);
      return;
    }
    this.saveKnown(c, status, res);
  }

  /** A candidate that turned out to be a live HTML page. */
  private recordLive(url: string, c: Candidate, res: FetchResult, parsed: ParsedPage): void {
    let rec = c.rec;
    const track = rec?.tracked === true || (this.liveTracked < this.maxPages && inScope(url, this.watch, true));
    // Hash first: a slow ignore pattern must leave nothing half-recorded.
    const text = track ? snapshotOf(parsed) : null;
    const hash = text !== null ? compareHash(text, this.settingsFor(rec)).hash : null;
    if (!rec) {
      // A real page found through a link/code/redirect may take the slot of a low-value row at the cap.
      if (!this.canRecord(c.source !== 'sitemap')) return;
      rec = this.newRecord(url, 'page', c.source, c.depth);
      this.known.add(url);
      this.pages.set(url, rec);
    }
    rec.status = finiteNumber(res.status, 200);
    rec.lastChecked = this.now;
    rec.title = parsed.title ?? null;
    rec.contentType = res.contentType ?? 'text/html';
    rec.gone = false;
    rec.failCount = 0;
    if (!rec.tracked && track) {
      rec.tracked = true;
      this.liveTracked++;
    }
    if (rec.tracked && text !== null && hash !== null) {
      rec.text = text;
      rec.textHash = hash;
      rec.pendingHash = null;
      rec.pendingSince = null;
      this.pushHistory(rec, hash);
      this.setValidators(rec, res);
    }
    this.touch(rec);
    if (c.announce && this.announceNew && this.features.pages && !this.announced.has(url)) {
      this.announced.add(url);
      this.newPages.push({ url, title: rec.title, source: rec.source });
      this.ctx.state.lastChangeAt = this.now;
    }
    this.collect(parsed, rec.depth, c.announce && this.announceNew);
  }

  /** Record (or update) a URL as known-but-untracked with the given status. */
  private saveKnown(c: Candidate, status: number, res: FetchResult | null): void {
    let rec = c.rec;
    if (!rec) {
      if (this.known.has(c.url) || !this.canRecord()) return;
      rec = this.newRecord(c.url, 'page', c.source, c.depth);
      if (!c.announce || !this.announceNew) rec.firstSeen = this.quietFirstSeen();
      this.known.add(c.url);
      this.pages.set(c.url, rec);
    }
    rec.status = status;
    rec.lastChecked = this.now;
    if (res?.contentType) rec.contentType = res.contentType;
    this.touch(rec);
  }

  /** Candidates that did not fit this pass's budget/time are remembered for later passes. */
  private recordLeftovers(): void {
    for (const c of [...this.codeQ.rest(), ...this.freshQ.rest(), ...this.deferred]) {
      if (c.rec || this.known.has(c.url)) continue;
      // Leftovers of a silent candidate stay silent when they are finally fetched.
      const quiet = !c.announce || !this.announceNew;
      this.createPending(c.url, c.source, c.depth, quiet ? this.quietFirstSeen() : undefined);
    }
  }

  private createPending(url: string, source: PageSource, depth: number, firstSeen?: number): void {
    if (this.known.has(url) || !this.canRecord()) return;
    if (source === 'sitemap' && this.known.size >= this.sitemapCap) return;
    const rec = this.newRecord(url, 'page', source, depth);
    if (firstSeen !== undefined) rec.firstSeen = firstSeen;
    this.known.add(url);
    this.pages.set(url, rec);
    this.touch(rec);
  }

  /** Room for one more known URL; with `evict`, a low-value row may be dropped to make it. */
  private canRecord(evict = false): boolean {
    if (this.known.size < this.knownCap) return true;
    if (evict && this.evictOne()) return true;
    if (!throttled('cap', this.watch.id, this.now)) {
      safeLog(this.ctx, 'warn', 'known URL cap reached; not recording more URLs', { url: this.watch.url, cap: this.knownCap });
    }
    return false;
  }

  /**
   * Untracked rows worth least, best eviction candidates last (popped first): never-fetched sitemap URLs (deepest, then
   * newest first), then dead or redirecting URLs (least recently checked first).
   */
  private buildEvictable(): PageRecord[] {
    const never: PageRecord[] = [];
    const dead: PageRecord[] = [];
    for (const rec of this.untrackedPages) {
      if (rec.tracked || rec.kind !== 'page' || this.seeds.has(rec.url)) continue;
      if (rec.status === null && rec.source === 'sitemap') never.push(rec);
      else if (rec.gone || isMissingStatus(rec.status) || rec.status === REDIRECT_STATUS) dead.push(rec);
    }
    never.sort((a, b) => a.depth - b.depth || a.firstSeen - b.firstSeen); // pop() → deepest, newest
    dead.sort((a, b) => b.lastChecked - a.lastChecked); // pop() → oldest check
    return [...dead, ...never];
  }

  private hasEvictable(): boolean {
    this.evictable ??= this.buildEvictable();
    while (this.evictable.length > 0) {
      const rec = this.evictable[this.evictable.length - 1];
      if (this.pages.get(rec.url) === rec && !rec.tracked && !this.queued.has(rec.url)) return true;
      this.evictable.pop();
    }
    return false;
  }

  private evictOne(): boolean {
    if (!this.hasEvictable()) return false;
    const rec = (this.evictable as PageRecord[]).pop() as PageRecord;
    safeLog(this.ctx, 'info', 'known URL cap reached; forgetting a low-value URL to record a new page', { dropped: rec.url });
    this.drop(rec);
    return true;
  }

  // --- records & persistence -------------------------------------------------

  private newRecord(url: string, kind: PageKind, source: PageSource, depth: number): PageRecord {
    return {
      watchId: this.watch.id,
      url,
      kind,
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
      source,
      depth,
      firstSeen: this.now,
      lastChecked: 0,
      lastChanged: null,
    };
  }

  private touch(rec: PageRecord): void {
    this.dirty.set(rec.url, rec);
    this.deleted.delete(rec.url);
  }

  private drop(rec: PageRecord): void {
    this.known.delete(rec.url);
    this.pages.delete(rec.url);
    this.dirty.delete(rec.url);
    this.deleted.add(rec.url);
  }

  private flush(): void {
    const { store } = this.ctx;
    try {
      const recs = [...this.dirty.values()];
      for (let i = 0; i < recs.length; i += FLUSH_CHUNK) store.upsertPages(recs.slice(i, i + FLUSH_CHUNK));
      for (const url of this.deleted) store.deletePage(this.watch.id, url);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      this.flushFailed = typeof code === 'string' && code ? code : errText(err);
      safeLog(this.ctx, 'error', 'saving page records failed', { url: this.watch.url, err: errText(err) });
    }
  }

  private result(): PagesCheckResult {
    const alerts: PagesCheckResult['alerts'] = [];
    const hosts = [...this.hosts].sort();
    const quietHosts = [...this.quietHosts].filter((h) => !this.hosts.has(h)).sort();
    if (this.baseline) return { alerts, hosts, quietHosts, fetched: this.fetched };
    if (this.flushFailed !== null) {
      // The store still holds the old state: every change found now is found again once saving works. Reporting it now
      // would repeat it on every check until then.
      if (!throttled('storage', this.watch.id, this.now)) {
        alerts.push({
          kind: 'info',
          message: `⚠️ Saving page data failed (${this.flushFailed}); change alerts for pages are paused until storage works again.`,
        });
      }
      return { alerts, hosts, quietHosts, fetched: this.fetched };
    }
    if (this.changes.length > 0) alerts.push({ kind: 'text', changes: this.changes, groups: groupChanges(this.changes) });
    if (this.newPages.length > 0) alerts.push({ kind: 'new_pages', pages: this.newPages });
    // While the start URL itself is missing, the whole site is in trouble: pages are marked gone silently.
    if (this.removed.length > 0 && !this.startMissing) alerts.push({ kind: 'removed_pages', pages: this.removed });
    const info = noiseInfo(this.noise);
    if (info) alerts.push(info);
    return { alerts, hosts, quietHosts, fetched: this.fetched };
  }
}
