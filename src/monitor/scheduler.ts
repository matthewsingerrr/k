/**
 * Orchestrates all watches: per-watch fast loop (homepage/status/deploy/pages/files) and slow loop (subdomains).
 *
 * Behaviour:
 * - `start()`: for every non-paused watch, start its loops. Watches with baselineDone=false first run a baseline pass
 *   (runBaseline) and then continue normally. Loops are staggered (initial delay = random 0..min(intervalSec, 10)s) so a restart
 *   doesn't burst every site at once.
 * - Fast loop per watch: runs `tick()` then schedules the next one at intervalSec*1000 ± 10% jitter (setTimeout, unref'd).
 *   Ticks for the same watch NEVER overlap (a per-watch lane; checkNow awaits the in-flight tick then runs one).
 *   Each tick is guarded by a timeout (max(120s, 4*intervalSec)) — on timeout the caller gets a "timed out" result right away,
 *   the run is told to stop starting new work (ctx.cancelled), and the lane stays busy until it has actually settled
 *   (at most another timeout), so an abandoned tick can never race the next one (duplicate alerts, lost writes).
 * - tick(watch, {full}):
 *     1. home = http.fetch(watch.url, {etag/lastModified NOT used — always a full GET}); parsed = 2xx && looksLikeHtml ? parseHtml : null.
 *     2. alerts += updateStatus(ctx, home.fetch).
 *     3. if features.deploy || features.codeIntel: d = checkDeploy(ctx, home); if d.changed → full = true.
 *     4. if features.text || features.pages || features.files: p = checkPages(ctx, {home, full, extraPaths: d.newCodePaths}).
 *     5. if features.files: alerts += checkFiles(ctx, {full}).
 *     6. localHosts from d.hosts ('code') and p.hosts ('link'); if any host under rootDomain is not yet in store.listSubdomains
 *        → trigger the slow loop now (non-blocking).
 *     7. Order alerts: deploy, text, new_pages, removed_pages, file, status, info. state.lastCheckAt = now; state.lastError = null.
 *        store.saveState. If alerts non-empty and not baseline: await notifier.notify(watch, alerts) (catch & log errors) and
 *        store.addEvent(watch.id, alert.kind, <one-line summary>, now) for each.
 *     Errors inside a tick are caught, logged, stored in state.lastError; the loop continues.
 * - Slow loop per watch (features.subdomains): every config.subdomainIntervalSec (± 10% jitter), also triggerable; never overlaps
 *   itself; runs checkSubdomains(ctx, {localHosts: pending hosts collected since the last run}); saves state; notifies alerts.
 * - runBaseline(watchId): ctx.baseline = true; one tick with full=true (all checkers record silently) + checkSubdomains with force;
 *   then state.baselineAt = now, store.updateWatch(id, {baselineDone: true}), saveState. Returns BaselineSummary. Never notifies.
 *   Concurrent calls for the same watch share one promise.
 * - onWatchAdded(watch): starts loops; if !baselineDone the first thing it does is runBaseline.
 * - onWatchRemoved(id): stop loops, drop in-memory state (DB rows are deleted by the caller).
 * - onWatchUpdated(watch): replace the in-memory Watch (keep state); if paused → stop loops; if unpaused → start;
 *   if intervalSec changed → reschedule. A settings change only re-baselines what it affects, as the first step of the
 *   next check on the fast lane (so it never races a page pass), while every other checker keeps alerting:
 *     ignore patterns / "ignore numbers" → stored page texts are re-hashed under the new rules (noise flags reset for
 *       ignore patterns) — no refetch, an edit elsewhere on a page is still reported;
 *     exclude patterns / scope / pages switched on → the next check crawls fully with new pages recorded silently;
 *     files switched on → the next check records linked files silently; subdomains switched on → the next subdomain run
 *     is a silent baseline; text switched on → pages are re-baselined silently on their next check; deploy (and code
 *     intel) switched on from both off → the next fingerprint is taken silently. Status/code intel alone need nothing.
 * - checkNow(watchId, {full}): run a tick right away (after any in-flight tick), and if features.subdomains also a forced slow run;
 *   return TickSummary.
 * - stop(): clear all timers, wait (max 10s) for in-flight ticks, then resolve.
 * - The in-memory WatchState object per watch is loaded once from store.getState and shared by both loops (see CheckContext).
 * - Constructor accepts optional `providers` (ct/dns) and `sleep`/`now` for tests; defaults: createCtProvider(http, config),
 *   createDnsProvider(), sleep from limiter, Date.now.
 *
 * Implementation notes:
 * - A FIRST baseline whose homepage fetch failed transiently (network error, 5xx, 429, bot challenge) does not set
 *   baselineDone: a site that comes up later would otherwise announce every page and linked subdomain as "new". Until then
 *   the fast loop only probes the homepage (one GET per interval) and re-runs the baseline once it answers. Re-baselines of
 *   an already-baselined watch complete regardless of the homepage.
 * - A timer that fires while checkNow's tick is in flight skips its own tick (it would be a back-to-back duplicate), and a
 *   manual tick pushes the next scheduled tick a full interval out.
 * - An abandoned (timed-out) tick starts no further checker stages; alerts it already produced are still delivered when it
 *   finishes (their state is already persisted, so dropping them would lose the change).
 * - stop() cancels in-flight runs: checkers stop starting fetches, a stage still waiting on the network is left behind,
 *   and the tick goes straight to saving state and delivering what it found (within STOP_WAIT_MS).
 * - A first baseline whose homepage redirects to another host of the same site (apex → www, docs.x → developers.x)
 *   adopts that host as the watch URL (the crawl scope is one host); a redirect to another domain is only reported.
 * - While a first baseline waits for a usable homepage, a bot challenge or HTTP 429 still runs the status logic, so the
 *   one-time "bot challenge" / "rate-limiting" info is sent. Subdomain checks do not wait for the page baseline once
 *   their own silent baseline has run (state.subdomainsBaselined).
 * - Hosts seen only where they cannot be news (backfill pages, re-baselined pages, back-filled code) are handed to the
 *   subdomain checker as quiet (recorded without alerting).
 * - Durations (TickSummary.durationMs, lastTickMs) use the monotonic clock; timestamps use `deps.now`.
 */

import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import type { FetchResult, HttpClient } from '../net/http.js';
import { createDnsProvider, type DnsProvider } from '../net/dns.js';
import { sleep as timerSleep } from '../net/limiter.js';
import { looksLikeHtml, parseHtml, type ParsedPage } from '../extract/html.js';
import { isUnderDomain, normalizeUrl, urlFilename, urlPath } from '../extract/url.js';
import type { Alert, AlertKind, Logger, Notifier, SubdomainSource, Watch, WatchFeatures, WatchState } from '../types.js';
import type { CheckContext, HomeSnapshot } from './context.js';
import { BLOCKED_PROBE_MS, isWalledOff, updateStatus } from './status.js';
import { probeApiEndpoints } from './api.js';
import { checkDeploy, type DeployCheckResult } from './deploy.js';
import { checkPages, clearPageHashes, rehashPages, type PagesCheckResult } from './pages.js';
import { checkFiles } from './files.js';
import { checkSubdomains, createCtProvider, normalizeSubdomain, type CtProvider } from './subdomains.js';

export interface MonitorDeps {
  store: Store;
  http: HttpClient;
  notifier: Notifier;
  config: Config;
  log: Logger;
  providers?: { ct?: CtProvider; dns?: DnsProvider };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface BaselineSummary {
  watchId: number;
  pagesTracked: number;
  pagesKnown: number;
  files: number;
  subdomains: number;
  buildId: string | null;
  assets: number;
  /** Homepage HTTP status (0 = unreachable). */
  homeStatus: number;
  homeBlocked: boolean;
  durationMs: number;
  /**
   * The start URL redirected to another host: `adopted` when that host (same site) became the watch URL, false when it
   * is another domain (only the start page can be checked then).
   */
  redirectedTo?: { from: string; to: string; adopted: boolean } | null;
}

export interface TickSummary {
  watchId: number;
  alerts: Alert[];
  durationMs: number;
  error: string | null;
}

export interface WatchRuntimeInfo {
  running: boolean;
  lastTickAt: number | null;
  lastTickMs: number | null;
  nextTickAt: number | null;
  baselineRunning: boolean;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Max initial stagger of a watch's first tick after start() (ms); also capped by its interval. */
export const STAGGER_MAX_MS = 10_000;
/** ± fraction applied to every loop delay. */
export const JITTER = 0.1;
/** Lower bound of the per-tick timeout guard (ms); the guard is max(this, 4 × interval). */
export const MIN_TICK_TIMEOUT_MS = 120_000;
/** Guard for a baseline pass (full sweep, up to 200 discovery fetches, all bundles). */
export const BASELINE_TIMEOUT_MS = 10 * 60_000;
/** Guard for one subdomain run (crt.sh alone may take a minute). */
export const SLOW_TIMEOUT_MS = 10 * 60_000;
/** stop() waits at most this long for in-flight work. */
export const STOP_WAIT_MS = 10_000;
/** Max extra delay before a watch's first slow-loop run (ms). */
const SLOW_START_MAX_MS = 30_000;
/** Delay before a slow run that was requested while another one was in flight. */
const SLOW_RETRIGGER_MS = 1_000;
/** Hosts handed to the slow loop are remembered so an unrecordable host can't re-trigger it on every tick. */
const MAX_HANDED_OFF = 5_000;
const MAX_PENDING_HOSTS = 2_000;
const MAX_TIMER_MS = 2_147_483_647;
const SUMMARY_MAX_CHARS = 300;

/** Delivery order of alerts produced by one tick. */
export const ALERT_ORDER: Readonly<Record<AlertKind, number>> = {
  deploy: 0,
  text: 1,
  new_pages: 2,
  removed_pages: 3,
  file: 4,
  status: 5,
  info: 6,
  subdomain: 7,
  subdomain_live: 8,
};

/** Stable sort of a tick's alerts into delivery order (deploy, text, new_pages, removed_pages, file, status, info). */
export function orderAlerts(alerts: Alert[]): Alert[] {
  const rank = (a: Alert) => ALERT_ORDER[a?.kind as AlertKind] ?? 99;
  return alerts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
    .map((x) => x.a);
}

/**
 * True when a homepage response is good enough to baseline against. Network errors, 5xx, 429 and bot challenges are
 * transient: a baseline taken then records nothing, and everything seen once the site answers would look "new".
 */
export function isUsableHome(res: FetchResult | null | undefined): boolean {
  if (!res || typeof res !== 'object') return false;
  const status = typeof res.status === 'number' && Number.isFinite(res.status) ? res.status : 0;
  return !(res.blocked || status <= 0 || status >= 500 || status === 429);
}

// ---------------------------------------------------------------------------
// Alert summaries
// ---------------------------------------------------------------------------

function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

function arr<T>(v: T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : [];
}

function oneLine(s: unknown): string {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "a, b, c (+4 more)". */
function listOf(items: string[], max = 3): string {
  const shown = items.slice(0, max).map((s) => clip(oneLine(s), 80));
  const rest = items.length - shown.length;
  return shown.join(', ') + (rest > 0 ? ` (+${rest} more)` : '');
}

/** "<head>: a, b" — or just "<head>" when there is nothing to list. */
function headed(head: string, items: string[]): string {
  return items.length ? `${head}: ${listOf(items)}` : head;
}

function shortBuild(id: string | null | undefined): string {
  const s = oneLine(id);
  if (!s) return '?';
  return s.length > 12 ? `${s.slice(0, 10)}…` : s;
}

function shortDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function summarize(alert: Alert): string {
  switch (alert.kind) {
    case 'deploy': {
      const parts: string[] = [];
      if (alert.buildIdOld !== alert.buildIdNew && (alert.buildIdOld || alert.buildIdNew)) {
        parts.push(`build ${shortBuild(alert.buildIdOld)} → ${shortBuild(alert.buildIdNew)}`);
      }
      parts.push(`+${arr(alert.assetsAdded).length}/−${arr(alert.assetsRemoved).length} assets`);
      const paths = arr(alert.newCodePaths);
      if (paths.length) parts.push(headed('new code paths', paths));
      const hosts = arr(alert.newCodeHosts);
      if (hosts.length) parts.push(headed('new hosts in code', hosts));
      return `redeployed: ${parts.join(', ')}`;
    }
    case 'text': {
      const urls = arr(alert.changes).map((c) => urlPath(c?.url));
      return headed(`text changed on ${plural(urls.length, 'page')}`, urls);
    }
    case 'new_pages': {
      const pages = arr(alert.pages).map((p) => urlPath(p?.url));
      return headed(plural(pages.length, 'new page'), pages);
    }
    case 'removed_pages': {
      const pages = arr(alert.pages).map((p) => `${urlPath(p?.url)} (${p?.status ?? '?'})`);
      return headed(`${plural(pages.length, 'page')} removed`, pages);
    }
    case 'subdomain': {
      const hosts = arr(alert.subdomains).map((s) => s?.host);
      return headed(plural(hosts.length, 'new subdomain'), hosts);
    }
    case 'subdomain_live': {
      const hosts = arr(alert.subdomains).map((s) => s?.host);
      return headed(`${plural(hosts.length, 'subdomain')} now live`, hosts);
    }
    case 'file': {
      const files = arr(alert.files).map((f) => `${f?.change ?? 'changed'} ${urlFilename(f?.url)}`);
      return headed(`${plural(files.length, 'file')} changed`, files);
    }
    case 'status': {
      if (alert.up) {
        const d = shortDuration(alert.downForMs);
        return `back UP${d ? ` after ${d}` : ''} (${oneLine(alert.detail) || 'ok'})`;
      }
      return `DOWN: ${oneLine(alert.detail) || 'unreachable'}`;
    }
    case 'info':
      return oneLine(alert.message) || 'info';
    default:
      return String((alert as { kind?: unknown })?.kind ?? 'alert');
  }
}

/** One-line summary of an alert for the events table & logs (e.g. "redeployed: build abc → def, +3/−2 assets"). */
export function summarizeAlert(alert: Alert): string {
  try {
    return clip(oneLine(summarize(alert)), SUMMARY_MAX_CHARS);
  } catch {
    const kind = (alert as { kind?: unknown } | null)?.kind;
    return typeof kind === 'string' ? kind : 'alert';
  }
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

type LocalHost = { host: string; source: Extract<SubdomainSource, 'link' | 'code'>; loud: boolean };

/** Serializes operations of one kind for one watch. `tail` settles when the last queued operation has settled. */
interface Lane {
  tail: Promise<void>;
  /** Operations queued or running (an abandoned operation counts until it has settled). */
  depth: number;
}

/** Handed to a guarded operation. */
interface RunToken {
  /** Its timeout fired (the caller moved on) or the monitor is stopping: start no new work. */
  abandoned: boolean;
  /** The monitor is stopping: do not even wait for work in progress, just save and deliver. */
  stopping: boolean;
  /** Resolves when stop() cancels the run. */
  stopped: Promise<void>;
  stop(): void;
}

function newToken(): RunToken {
  let fire!: () => void;
  const stopped = new Promise<void>((resolve) => {
    fire = resolve;
  });
  const token: RunToken = {
    abandoned: false,
    stopping: false,
    stopped,
    stop: () => {
      token.abandoned = true;
      if (!token.stopping) {
        token.stopping = true;
        fire();
      }
    },
  };
  return token;
}

/** What a settings change still has to (re-)baseline, applied on the fast lane before the next check. */
interface PendingSettings {
  /** Reset text-noise flags (ignore patterns changed). */
  resetNoise: boolean;
  /** Re-hash stored page texts under the current compare rules. */
  pageHashes: boolean;
  /** Forget page hashes: re-baseline texts silently on their next check (text checks switched on). */
  pageText: boolean;
  /** Next check: full crawl, new pages recorded silently. */
  discovery: boolean;
  /** Next check: linked files recorded silently. */
  files: boolean;
  /** Next subdomain run is a silent baseline. */
  subdomains: boolean;
  /** Forget the deploy fingerprint: the next one is taken silently. */
  deploy: boolean;
}

function noPending(): PendingSettings {
  return { resetNoise: false, pageHashes: false, pageText: false, discovery: false, files: false, subdomains: false, deploy: false };
}

/**
 * A lane is released at the latest this many timeouts after an operation started (i.e. one more timeout after it was
 * abandoned), even if it never settles.
 */
const HUNG_RELEASE_FACTOR = 2;

interface TickOutcome {
  alerts: Alert[];
  error: string | null;
  home: FetchResult | null;
  localHosts: LocalHost[];
  durationMs: number;
}

interface Entry {
  id: number;
  watch: Watch;
  /** Loaded once from the store; shared by both loops and every checker (they mutate it in place). */
  state: WatchState;
  /** Loops should be running (not paused, monitor started). */
  active: boolean;
  /** Bumped whenever loops start/stop, so stale timers and callbacks can tell they are obsolete. */
  gen: number;
  removed: boolean;
  fastTimer: NodeJS.Timeout | null;
  nextTickAt: number | null;
  slowTimer: NodeJS.Timeout | null;
  fast: Lane;
  slow: Lane;
  /** A slow run was requested while one was in flight. */
  slowAgain: boolean;
  baseline: Promise<BaselineSummary> | null;
  /** Settings changes still to be applied (see PendingSettings). */
  pending: PendingSettings;
  /** The last baseline attempt could not use the homepage (see isUsableHome). */
  homeUnusable: boolean;
  /** Completed normal ticks (used to skip a timer tick queued behind a manual one). */
  tickSeq: number;
  /** Runs in flight (so stop() can cancel them). */
  tokens: Set<RunToken>;
  pendingHosts: Map<string, { source: LocalHost['source']; loud: boolean }>;
  handedOff: Set<string>;
  /** Cached subdomain hosts from the store (null = reload on next use). */
  knownSubs: Set<string> | null;
  lastTickAt: number | null;
  lastTickMs: number | null;
}

function sameList(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const x = arr(a as string[]);
  const y = arr(b as string[]);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** What a settings change has to re-baseline (merged into `into`); true when anything is needed. */
function settingsImpact(prev: Watch, next: Watch, into: PendingSettings): boolean {
  const on = (k: keyof WatchFeatures) => !prev.features?.[k] && Boolean(next.features?.[k]);
  let any = false;
  const mark = (k: keyof PendingSettings) => {
    into[k] = true;
    any = true;
  };
  if (!sameList(prev.ignorePatterns, next.ignorePatterns)) {
    mark('resetNoise');
    mark('pageHashes');
  }
  if (Boolean(prev.maskNumbers) !== Boolean(next.maskNumbers)) mark('pageHashes');
  if (!sameList(prev.excludePatterns, next.excludePatterns) || (prev.scopePath ?? null) !== (next.scopePath ?? null)) mark('discovery');
  if (on('pages')) mark('discovery');
  if (on('files')) mark('files');
  if (on('subdomains')) mark('subdomains');
  if (on('text')) mark('pageText');
  if ((on('deploy') || on('codeIntel')) && !prev.features?.deploy && !prev.features?.codeIntel) mark('deploy');
  return any;
}

function hasPending(p: PendingSettings): boolean {
  return p.resetNoise || p.pageHashes || p.pageText || p.discovery || p.files || p.deploy;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === 'string' ? err : String(err);
}

function failedFetch(url: string, error: string): FetchResult {
  return {
    url,
    finalUrl: url,
    status: 0,
    ok: false,
    notModified: false,
    redirected: false,
    headers: {},
    contentType: null,
    body: null,
    bodyText: null,
    truncated: false,
    blocked: false,
    retryAfterMs: null,
    error,
    elapsedMs: 0,
  };
}

function jittered(ms: number): number {
  const base = Number.isFinite(ms) && ms > 0 ? ms : 1000;
  return Math.min(MAX_TIMER_MS, Math.max(0, Math.round(base * (1 - JITTER + Math.random() * 2 * JITTER))));
}

function intervalMs(watch: Watch): number {
  const s = Number.isFinite(watch.intervalSec) && watch.intervalSec > 0 ? watch.intervalSec : 30;
  return s * 1000;
}

const noop = () => {};

export class Monitor {
  private readonly store: Store;
  private readonly http: HttpClient;
  private readonly notifier: Notifier;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly providers: { ct: CtProvider; dns: DnsProvider };
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly entries = new Map<number, Entry>();
  private started = false;
  private stopped = false;
  private lastActivity: number | null = null;

  constructor(deps: MonitorDeps) {
    if (!deps || !deps.store || !deps.http || !deps.notifier || !deps.config || !deps.log) {
      throw new Error('Monitor requires store, http, notifier, config and log');
    }
    this.store = deps.store;
    this.http = deps.http;
    this.notifier = deps.notifier;
    this.config = deps.config;
    this.log = deps.log;
    this.now = typeof deps.now === 'function' ? deps.now : Date.now;
    this.sleep = typeof deps.sleep === 'function' ? deps.sleep : timerSleep;
    this.providers = {
      ct:
        deps.providers?.ct ??
        createCtProvider(deps.http, {
          certspotterApiKey: deps.config.certspotterApiKey,
          now: this.now,
          queriesPerHour: deps.config.certspotterQueriesPerHour,
        }),
      dns: deps.providers?.dns ?? createDnsProvider(),
    };
  }

  // --- lifecycle -----------------------------------------------------------------------------------------------------

  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    let watches: Watch[];
    try {
      watches = this.store.listWatches();
    } catch (err) {
      this.log.error('could not load watches', { err: errText(err) });
      return;
    }
    for (const watch of watches) {
      try {
        const existing = this.entries.get(watch.id);
        const entry = existing ?? this.entryFor(watch);
        if (existing) entry.watch = { ...watch, baselineDone: Boolean(watch.baselineDone || existing.watch.baselineDone) };
        if (!entry.watch.paused) this.startLoops(entry, Math.random() * Math.min(intervalMs(watch), STAGGER_MAX_MS));
      } catch (err) {
        this.log.error('could not start watch', { watchId: watch?.id, err: errText(err) });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const inflight: Array<Promise<unknown>> = [];
    for (const entry of this.entries.values()) {
      this.stopLoops(entry);
      // In-flight runs stop starting work and go straight to saving and delivering what they found.
      for (const token of entry.tokens) token.stop();
      if (entry.fast.depth > 0) inflight.push(entry.fast.tail);
      if (entry.slow.depth > 0) inflight.push(entry.slow.tail);
      if (entry.baseline) inflight.push(entry.baseline.catch(noop));
    }
    if (inflight.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STOP_WAIT_MS);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled(inflight), timeout]);
    if (timer) clearTimeout(timer);
  }

  onWatchAdded(watch: Watch): void {
    if (!watch || !Number.isSafeInteger(watch.id)) return;
    const existing = this.entries.get(watch.id);
    const entry = existing ?? this.entryFor(watch);
    if (existing) entry.watch = { ...watch, baselineDone: Boolean(watch.baselineDone || existing.watch.baselineDone) };
    if (this.stopped || entry.watch.paused) return;
    // A just-baselined watch was fetched moments ago; one that still needs its baseline starts right away.
    this.startLoops(entry, entry.watch.baselineDone ? jittered(intervalMs(entry.watch)) : 0);
  }

  onWatchRemoved(watchId: number): void {
    const entry = this.entries.get(watchId);
    if (!entry) return;
    entry.removed = true;
    this.stopLoops(entry);
    entry.pendingHosts.clear();
    this.entries.delete(watchId);
  }

  onWatchUpdated(watch: Watch): void {
    if (!watch || !Number.isSafeInteger(watch.id)) return;
    const entry = this.entries.get(watch.id);
    if (!entry) {
      this.onWatchAdded(watch);
      return;
    }
    const prev = entry.watch;
    const next: Watch = { ...watch, baselineDone: Boolean(watch.baselineDone || prev.baselineDone) };
    entry.watch = next;
    if (prev.baselineDone && settingsImpact(prev, next, entry.pending)) {
      this.log.info('settings changed; what they affect is re-baselined silently at the next check', { watchId: next.id });
    }
    if (this.stopped) return;
    if (next.paused) {
      this.stopLoops(entry);
      return;
    }
    if (!entry.active) {
      this.startLoops(entry, Math.random() * Math.min(intervalMs(next), STAGGER_MAX_MS));
      return;
    }
    if (prev.intervalSec !== next.intervalSec && entry.fastTimer) this.scheduleFast(entry, jittered(intervalMs(next)));
    if (!next.features.subdomains) this.clearSlow(entry);
    else if (!prev.features.subdomains && !entry.slowTimer) this.scheduleSlow(entry, jittered(intervalMs(next)));
  }

  // --- public operations -----------------------------------------------------------------------------------------------

  runBaseline(watchId: number): Promise<BaselineSummary> {
    let entry: Entry;
    try {
      entry = this.requireEntry(watchId);
    } catch (err) {
      return Promise.reject(err);
    }
    if (entry.baseline) return entry.baseline;
    const promise = this.baselinePass(entry).finally(() => {
      if (entry.baseline === promise) entry.baseline = null;
    });
    entry.baseline = promise;
    return promise;
  }

  async checkNow(watchId: number, opts?: { full?: boolean }): Promise<TickSummary> {
    const entry = this.requireEntry(watchId);
    const t0 = performance.now();
    const elapsed = () => Math.round(performance.now() - t0);

    if (!entry.watch.baselineDone) {
      let summary: BaselineSummary;
      try {
        summary = await this.runBaseline(watchId);
      } catch (err) {
        return { watchId, alerts: [], durationMs: elapsed(), error: `baseline failed: ${errText(err)}` };
      }
      if (!entry.watch.baselineDone) {
        const why = summary.homeBlocked
          ? `bot challenge (HTTP ${summary.homeStatus})`
          : summary.homeStatus
            ? `HTTP ${summary.homeStatus}`
            : 'unreachable';
        return {
          watchId,
          alerts: [],
          durationMs: elapsed(),
          error: `baseline incomplete: homepage ${why}; it is retried automatically`,
        };
      }
    }

    const tick = await this.runTick(entry, Boolean(opts?.full), null);
    let alerts = tick?.alerts ?? [];
    let error = tick?.error ?? null;
    // Push the next scheduled tick a full interval out; this one just ran.
    if (entry.fastTimer && this.isLive(entry, entry.gen)) this.scheduleFast(entry, jittered(intervalMs(entry.watch)));

    if (entry.watch.features.subdomains && !entry.removed) {
      const slow = await this.runSlow(entry, true);
      alerts = alerts.concat(slow.alerts);
      error = error ?? slow.error;
    }
    return { watchId, alerts, durationMs: elapsed(), error };
  }

  runtimeInfo(watchId: number): WatchRuntimeInfo {
    const e = this.entries.get(watchId);
    if (!e) return { running: false, lastTickAt: null, lastTickMs: null, nextTickAt: null, baselineRunning: false };
    return {
      running: e.active && !this.stopped,
      lastTickAt: e.lastTickAt,
      lastTickMs: e.lastTickMs,
      nextTickAt: e.active ? e.nextTickAt : null,
      baselineRunning: e.baseline !== null,
    };
  }

  /** Timestamp (ms) of the most recent completed tick across all watches (null if none) — for /health. */
  lastActivityAt(): number | null {
    return this.lastActivity;
  }

  // --- entries ---------------------------------------------------------------------------------------------------------

  private entryFor(watch: Watch): Entry {
    const existing = this.entries.get(watch.id);
    if (existing) return existing;
    const entry: Entry = {
      id: watch.id,
      watch,
      state: this.store.getState(watch.id),
      active: false,
      gen: 0,
      removed: false,
      fastTimer: null,
      nextTickAt: null,
      slowTimer: null,
      fast: { tail: Promise.resolve(), depth: 0 },
      slow: { tail: Promise.resolve(), depth: 0 },
      slowAgain: false,
      baseline: null,
      pending: noPending(),
      homeUnusable: false,
      tickSeq: 0,
      tokens: new Set(),
      pendingHosts: new Map(),
      handedOff: new Set(),
      knownSubs: null,
      lastTickAt: null,
      lastTickMs: null,
    };
    this.entries.set(watch.id, entry);
    return entry;
  }

  /** In-memory entry, or one created from the store (inactive) — for on-demand operations. Throws for unknown watches. */
  private requireEntry(watchId: number): Entry {
    const existing = this.entries.get(watchId);
    if (existing) return existing;
    const watch = Number.isSafeInteger(watchId) ? this.store.getWatch(watchId) : undefined;
    if (!watch) throw new Error(`unknown watch #${watchId}`);
    return this.entryFor(watch);
  }

  private isLive(entry: Entry, gen: number): boolean {
    return !this.stopped && entry.active && !entry.removed && entry.gen === gen && this.entries.get(entry.id) === entry;
  }

  private makeCtx(entry: Entry, baseline: boolean, token?: RunToken, silent?: CheckContext['silent']): CheckContext {
    const ctx: CheckContext = {
      watch: entry.watch,
      state: entry.state,
      store: this.store,
      http: this.http,
      config: this.config,
      log: this.log.child({ watchId: entry.id }),
      providers: this.providers,
      now: this.now,
      sleep: this.sleep,
      baseline,
    };
    if (token) ctx.cancelled = () => token.abandoned;
    if (silent && (silent.discovery || silent.files || silent.subdomains)) ctx.silent = silent;
    return ctx;
  }

  // --- loops -----------------------------------------------------------------------------------------------------------

  private startLoops(entry: Entry, delayMs: number): void {
    if (entry.active || this.stopped || entry.removed) return;
    entry.active = true;
    entry.gen++;
    this.scheduleFast(entry, delayMs);
    if (entry.watch.features.subdomains) this.scheduleSlow(entry, delayMs + Math.random() * SLOW_START_MAX_MS);
  }

  private stopLoops(entry: Entry): void {
    entry.active = false;
    entry.gen++;
    if (entry.fastTimer) clearTimeout(entry.fastTimer);
    entry.fastTimer = null;
    entry.nextTickAt = null;
    this.clearSlow(entry);
  }

  private scheduleFast(entry: Entry, delayMs: number): void {
    if (entry.fastTimer) clearTimeout(entry.fastTimer);
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, Math.round(delayMs)));
    const gen = entry.gen;
    entry.nextTickAt = this.now() + delay;
    const timer = setTimeout(() => void this.fastFire(entry, gen), delay);
    timer.unref?.();
    entry.fastTimer = timer;
  }

  private async fastFire(entry: Entry, gen: number): Promise<void> {
    entry.fastTimer = null;
    entry.nextTickAt = null;
    if (!this.isLive(entry, gen)) return;
    if (!this.stillStored(entry)) {
      this.log.warn('watch no longer exists; stopping its loops', { watchId: entry.id });
      this.onWatchRemoved(entry.id);
      return;
    }
    try {
      const watch = entry.watch;
      if (!watch.baselineDone) {
        // Until a baseline could see the homepage, only probe it (see isUsableHome).
        if (entry.homeUnusable && !(await this.probeHome(entry))) return;
        await this.runBaseline(entry.id);
      } else {
        await this.runTick(entry, false, entry.tickSeq);
      }
    } catch (err) {
      this.log.error('scheduled check failed', { watchId: entry.id, err: errText(err) });
    } finally {
      if (this.isLive(entry, gen) && !entry.fastTimer) {
        // While the site walls us off (bot challenge / 429), probe politely instead of every interval.
        const base = intervalMs(entry.watch);
        this.scheduleFast(entry, jittered(isWalledOff(entry.state) ? Math.max(base, BLOCKED_PROBE_MS) : base));
      }
    }
  }

  /** False only when the store positively says the watch is gone (a read error keeps it running). */
  private stillStored(entry: Entry): boolean {
    try {
      return this.store.getWatch(entry.id) !== undefined;
    } catch {
      return true;
    }
  }

  private async probeHome(entry: Entry): Promise<boolean> {
    const url = entry.watch.url;
    const res = await this.exclusive(
      entry,
      entry.fast,
      this.tickTimeoutMs(entry.watch),
      'homepage probe',
      () => this.fetchHome(url),
      () => null,
    );
    const ok = isUsableHome(res);
    if (!ok) {
      this.log.debug('homepage still unusable; baseline postponed', { watchId: entry.id, status: res?.status ?? 0 });
      // A challenge or rate limit that never lifts would otherwise go unnoticed: the one-time notes still apply.
      if (res && (res.blocked || res.status === 429) && !entry.removed) {
        let alerts: Alert[] = [];
        try {
          alerts = updateStatus(this.makeCtx(entry, false), res);
          this.store.saveState(entry.id, entry.state);
        } catch (err) {
          this.log.warn('status update failed', { watchId: entry.id, err: errText(err) });
        }
        if (alerts.length > 0) await this.deliver(entry, alerts);
      }
    }
    return ok;
  }

  private clearSlow(entry: Entry): void {
    if (entry.slowTimer) clearTimeout(entry.slowTimer);
    entry.slowTimer = null;
  }

  private scheduleSlow(entry: Entry, delayMs: number): void {
    this.clearSlow(entry);
    if (!entry.watch.features.subdomains) return;
    const gen = entry.gen;
    const timer = setTimeout(() => void this.slowFire(entry, gen), Math.min(MAX_TIMER_MS, Math.max(0, Math.round(delayMs))));
    timer.unref?.();
    entry.slowTimer = timer;
  }

  private async slowFire(entry: Entry, gen: number): Promise<void> {
    entry.slowTimer = null;
    if (!this.isLive(entry, gen)) return;
    try {
      // Never announce subdomains before (or while) the watch is baselined — the page baseline, or at least the silent
      // subdomain baseline (a site that keeps challenging the bot can still be watched for subdomains).
      const baselined = entry.watch.baselineDone || entry.state.subdomainsBaselined === true;
      if (entry.watch.features.subdomains && baselined && !entry.baseline) {
        await this.runSlow(entry, false);
      }
    } catch (err) {
      this.log.error('subdomain check failed', { watchId: entry.id, err: errText(err) });
    } finally {
      if (this.isLive(entry, gen) && !entry.slowTimer) {
        const again = entry.slowAgain;
        entry.slowAgain = false;
        this.scheduleSlow(entry, again ? SLOW_RETRIGGER_MS : jittered(Math.max(1, this.config.subdomainIntervalSec) * 1000));
      }
    }
  }

  /** Run the slow loop soon because a tick found hosts that are not yet known subdomains. */
  private triggerSlow(entry: Entry): void {
    if (!this.isLive(entry, entry.gen) || !entry.watch.features.subdomains) return;
    if (entry.slow.depth > 0 || entry.baseline) {
      entry.slowAgain = true;
      return;
    }
    this.clearSlow(entry);
    void this.slowFire(entry, entry.gen);
  }

  // --- serialized, timeout-guarded operations ------------------------------------------------------------------------

  private tickTimeoutMs(watch: Watch): number {
    return Math.min(MAX_TIMER_MS, Math.max(MIN_TICK_TIMEOUT_MS, 4 * intervalMs(watch)));
  }

  /**
   * Queue `fn` on a lane: it starts after every earlier operation on that lane settled. If it runs longer than
   * `timeoutMs` the caller gets onTimeout() and the run is told to stop starting new work (token.abandoned), but the lane
   * stays busy until the run has really settled — or at most another `timeoutMs` for a promise that never settles — so
   * two runs of one lane never overlap.
   */
  private exclusive<T>(
    entry: Entry,
    lane: Lane,
    timeoutMs: number,
    label: string,
    fn: (token: RunToken) => Promise<T>,
    onTimeout: () => T,
  ): Promise<T> {
    lane.depth++;
    const run = lane.tail.then(() => this.guarded(entry, timeoutMs, label, fn, onTimeout));
    const released = run.then(
      (r) => this.settledOrCap(r.settled, timeoutMs * HUNG_RELEASE_FACTOR),
      noop,
    );
    lane.tail = released.then(noop, noop).finally(() => {
      lane.depth--;
    });
    return run.then((r) => r.result);
  }

  /** Resolves when `settled` does, or after `capMs` (a hung promise must not block a lane forever). */
  private settledOrCap(settled: Promise<void>, capMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(MAX_TIMER_MS, Math.max(0, capMs)));
      timer.unref?.();
      settled.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private guarded<T>(
    entry: Entry,
    timeoutMs: number,
    label: string,
    fn: (token: RunToken) => Promise<T>,
    onTimeout: () => T,
  ): { result: Promise<T>; settled: Promise<void> } {
    const token = newToken();
    if (this.stopped) token.stop();
    entry.tokens.add(token);
    let work: Promise<T>;
    try {
      work = fn(token);
    } catch (err) {
      entry.tokens.delete(token);
      return { result: Promise.reject(err), settled: Promise.resolve() };
    }
    const settled = work.then(noop, noop).finally(() => {
      entry.tokens.delete(token);
    });
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        token.abandoned = true;
        this.log.error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s; abandoning it`, { watchId: entry.id });
        try {
          resolve(onTimeout());
        } catch (err) {
          reject(err);
        }
      }, timeoutMs);
      timer.unref?.();
      work.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
    return { result, settled };
  }

  /**
   * One normal tick on the fast lane. `seq` (scheduled ticks only): skip when another tick completed since the timer fired.
   * Returns null when skipped.
   */
  private async runTick(entry: Entry, full: boolean, seq: number | null): Promise<TickSummary | null> {
    const outcome = await this.exclusive<TickOutcome | null>(
      entry,
      entry.fast,
      this.tickTimeoutMs(entry.watch),
      'tick',
      (token) => (seq !== null && seq !== entry.tickSeq ? Promise.resolve(null) : this.tickBody(entry, { full, baseline: false }, token)),
      () => ({
        alerts: [],
        error: `check timed out after ${Math.round(this.tickTimeoutMs(entry.watch) / 1000)}s`,
        home: null,
        localHosts: [],
        durationMs: this.tickTimeoutMs(entry.watch),
      }),
    );
    if (!outcome) return null;
    entry.tickSeq++;
    entry.lastTickMs = outcome.durationMs;
    entry.lastTickAt = this.now();
    this.lastActivity = entry.lastTickAt;
    return { watchId: entry.id, alerts: outcome.alerts, durationMs: outcome.durationMs, error: outcome.error };
  }

  private async fetchHome(url: string): Promise<FetchResult> {
    try {
      // The one request per interval that goes out even while the host is backed off after a 429 (to notice recovery).
      const res = await this.http.fetch(url, { ignoreBackoff: true });
      return res && typeof res === 'object' ? res : failedFetch(url, 'no response');
    } catch (err) {
      return failedFetch(url, errText(err));
    }
  }

  private parseHome(res: FetchResult): ParsedPage | null {
    if (!res.ok || res.blocked || typeof res.bodyText !== 'string' || !looksLikeHtml(res.contentType, res.bodyText)) return null;
    try {
      return parseHtml(res.bodyText, res.finalUrl || res.url);
    } catch (err) {
      this.log.warn('homepage parse failed', { url: res.url, err: errText(err) });
      return null;
    }
  }

  /**
   * Apply pending settings changes (re-hash / reset page texts, forget a stale fingerprint). Runs as the first step of a
   * fast-lane run, so it never races a page pass that holds the same rows. Returns what the coming check must record
   * silently. Flags stay pending if applying them fails.
   */
  private applyPending(entry: Entry): { discovery: boolean; files: boolean } {
    const p = entry.pending;
    if (!hasPending(p)) return { discovery: false, files: false };
    try {
      if (p.resetNoise) this.store.resetPageNoise(entry.id);
      if (p.pageText) clearPageHashes(this.store, entry.id);
      else if (p.pageHashes || p.resetNoise) rehashPages(this.store, entry.watch, this.now(), this.log.child({ watchId: entry.id }));
      if (p.deploy) {
        entry.state.deploy = null;
        entry.state.deployHistory = [];
      }
    } catch (err) {
      this.log.error('applying settings change failed; retried at the next check', { watchId: entry.id, err: errText(err) });
      return { discovery: false, files: false };
    }
    const out = { discovery: p.discovery, files: p.files };
    entry.pending = { ...noPending(), subdomains: p.subdomains };
    return out;
  }

  /** The tick itself (steps 1–7 of the module doc). Never throws. */
  private async tickBody(entry: Entry, opts: { full: boolean; baseline: boolean }, token: RunToken): Promise<TickOutcome> {
    const t0 = performance.now();
    let full = opts.full;
    let silent: CheckContext['silent'];
    if (opts.baseline) {
      // A (first) baseline records everything silently anyway.
      entry.pending = { ...noPending(), subdomains: entry.pending.subdomains };
    } else {
      const quiet = this.applyPending(entry);
      if (quiet.discovery || quiet.files) {
        silent = { discovery: quiet.discovery, files: quiet.files };
        full = true;
      }
    }
    const watch = entry.watch;
    const f = watch.features;
    const ctx = this.makeCtx(entry, opts.baseline, token, silent);
    const alerts: Alert[] = [];
    let error: string | null = null;
    const STOPPED = Symbol('stopped');
    const stage = async <T>(name: string, fn: () => Promise<T> | T): Promise<T | null> => {
      if (token.abandoned) return null;
      try {
        // On shutdown a stage still waiting on the network is left behind: what was found so far is saved and delivered.
        const out = await Promise.race([Promise.resolve().then(fn), token.stopped.then(() => STOPPED)]);
        return out === STOPPED ? null : (out as T);
      } catch (err) {
        const msg = `${name}: ${errText(err)}`;
        error ??= msg;
        this.log.error('check stage failed', { watchId: entry.id, stage: name, err: errText(err) });
        return null;
      }
    };

    const home = await this.fetchHome(watch.url);
    const snapshot: HomeSnapshot = { fetch: home, parsed: this.parseHome(home) };
    const status = await stage('status', () => updateStatus(ctx, home));
    if (status) alerts.push(...status);
    // The site is challenging / rate-limiting us: every other request would be refused too, so don't send them.
    const walled = !opts.baseline && (home.blocked || home.status === 429);

    let deploy: DeployCheckResult | null = null;
    if ((f.deploy || f.codeIntel) && !walled) {
      deploy = await stage('deploy', () => checkDeploy(ctx, snapshot));
      if (deploy?.changed) full = true;
      if (deploy?.alert) alerts.push(deploy.alert);
    }
    let pages: PagesCheckResult | null = null;
    if ((f.text || f.pages || f.files) && !walled) {
      pages = await stage('pages', () => checkPages(ctx, { home: snapshot, full, extraPaths: deploy?.newCodePaths ?? [] }));
      if (pages) alerts.push(...pages.alerts);
    }
    if (f.files && !walled) {
      const files = await stage('files', () => checkFiles(ctx, { full }));
      if (files) alerts.push(...files);
    }
    if (f.text && !walled) {
      const api = await stage('api', () => probeApiEndpoints(ctx));
      if (api) alerts.push(...api);
    }
    const localHosts = f.subdomains ? this.localHostsOf(entry, deploy, pages) : [];

    const state = entry.state;
    state.lastCheckAt = this.now();
    state.lastError = error;
    try {
      this.store.saveState(entry.id, state);
    } catch (err) {
      this.log.error('saving state failed', { watchId: entry.id, err: errText(err) });
      error ??= `saving state: ${errText(err)}`;
    }

    const ordered = opts.baseline ? [] : orderAlerts(alerts);
    if (!opts.baseline) {
      if (this.queueLocalHosts(entry, localHosts)) this.triggerSlow(entry);
      await this.deliver(entry, ordered);
    }
    return { alerts: ordered, error, home, localHosts, durationMs: Math.round(performance.now() - t0) };
  }

  /**
   * Hosts under the watch's root domain seen in this tick's code ('code') and pages ('link'). Hosts only seen where they
   * cannot be news (backfill pages, back-filled bundles) are quiet; a host seen loud anywhere is loud.
   */
  private localHostsOf(entry: Entry, deploy: DeployCheckResult | null, pages: PagesCheckResult | null): LocalHost[] {
    const root = entry.watch.rootDomain;
    const out = new Map<string, LocalHost>();
    const add = (raw: unknown, source: LocalHost['source'], loud: boolean) => {
      if (typeof raw !== 'string') return;
      const host = normalizeSubdomain(raw, root);
      if (!host) return;
      const prev = out.get(host);
      if (prev) {
        if (loud && !prev.loud) out.set(host, { host, source, loud });
        return;
      }
      if (out.size >= MAX_PENDING_HOSTS) return;
      out.set(host, { host, source, loud });
    };
    for (const h of arr(pages?.hosts)) add(h, 'link', true);
    for (const h of arr(deploy?.hosts)) add(h, 'code', true);
    for (const h of arr(pages?.quietHosts)) add(h, 'link', false);
    for (const h of arr(deploy?.backfillHosts)) add(h, 'code', false);
    return [...out.values()];
  }

  /** Remember hosts that are not yet known subdomains for the next slow run. Returns true if any is new. */
  private queueLocalHosts(entry: Entry, hosts: LocalHost[]): boolean {
    if (hosts.length === 0) return false;
    let known = entry.knownSubs;
    if (!known) {
      try {
        known = new Set(this.store.listSubdomains(entry.id).map((r) => r.host));
      } catch (err) {
        this.log.warn('listing subdomains failed', { watchId: entry.id, err: errText(err) });
        return false;
      }
      entry.knownSubs = known;
    }
    let added = false;
    for (const { host, source, loud } of hosts) {
      if (known.has(host) || entry.handedOff.has(host)) continue;
      const pending = entry.pendingHosts.get(host);
      if (pending) {
        if (loud && !pending.loud) entry.pendingHosts.set(host, { source, loud });
        continue;
      }
      if (entry.pendingHosts.size >= MAX_PENDING_HOSTS) break;
      entry.pendingHosts.set(host, { source, loud });
      if (entry.handedOff.size < MAX_HANDED_OFF) entry.handedOff.add(host);
      added = true;
    }
    return added;
  }

  /** Record events and notify (errors are logged, never thrown). */
  private async deliver(entry: Entry, alerts: Alert[]): Promise<void> {
    if (alerts.length === 0 || entry.removed) return;
    const watch = entry.watch;
    const now = this.now();
    for (const alert of alerts) {
      const summary = summarizeAlert(alert);
      this.log.info(`alert: ${summary}`, { watchId: watch.id, kind: alert.kind });
      try {
        this.store.addEvent(watch.id, alert.kind, summary, now);
      } catch (err) {
        this.log.warn('recording event failed', { watchId: watch.id, err: errText(err) });
      }
    }
    try {
      await this.notifier.notify(watch, alerts);
    } catch (err) {
      this.log.error('notifier failed', { watchId: watch.id, err: errText(err) });
    }
  }

  /** One subdomain run on the slow lane. */
  private runSlow(entry: Entry, force: boolean): Promise<{ alerts: Alert[]; error: string | null }> {
    return this.exclusive(
      entry,
      entry.slow,
      SLOW_TIMEOUT_MS,
      'subdomain check',
      async (token) => {
        if (!entry.watch.features.subdomains || entry.removed) return { alerts: [], error: null };
        const localHosts = [...entry.pendingHosts].map(([host, v]) => ({ host, source: v.source, loud: v.loud }));
        entry.pendingHosts.clear();
        // Subdomain checks were just switched on: this run is their silent baseline.
        const silentBaseline = entry.pending.subdomains || !(entry.watch.baselineDone || entry.state.subdomainsBaselined);
        entry.pending.subdomains = false;
        let alerts: Alert[] = [];
        let error: string | null = null;
        try {
          alerts = await checkSubdomains(this.makeCtx(entry, silentBaseline, token), { localHosts, force });
          if (silentBaseline) {
            alerts = [];
            entry.state.subdomainsBaselined = true;
          }
        } catch (err) {
          error = `subdomains: ${errText(err)}`;
          this.log.error('subdomain check failed', { watchId: entry.id, err: errText(err) });
        }
        entry.knownSubs = null;
        try {
          this.store.saveState(entry.id, entry.state);
        } catch (err) {
          this.log.error('saving state failed', { watchId: entry.id, err: errText(err) });
        }
        await this.deliver(entry, alerts);
        return { alerts, error };
      },
      () => ({ alerts: [], error: 'subdomain check timed out' }),
    );
  }

  // --- baseline --------------------------------------------------------------------------------------------------------

  private async baselinePass(entry: Entry): Promise<BaselineSummary> {
    const t0 = performance.now();
    const wasRebaseline = entry.watch.baselineDone;
    let redirectedTo: BaselineSummary['redirectedTo'] = null;
    const outcome = await this.exclusive<TickOutcome>(
      entry,
      entry.fast,
      BASELINE_TIMEOUT_MS,
      'baseline',
      async (token) => {
        const first = await this.tickBody(entry, { full: true, baseline: true }, token);
        if (wasRebaseline || token.abandoned) return first;
        redirectedTo = this.adoptRedirect(entry, first.home);
        // Now watching the host the site really lives on: take its baseline (the first pass only saw one page of it).
        return redirectedTo?.adopted ? this.tickBody(entry, { full: true, baseline: true }, token) : first;
      },
      () => {
        throw new Error(`baseline timed out after ${Math.round(BASELINE_TIMEOUT_MS / 1000)}s`);
      },
    );
    if (this.stopped) throw new Error('monitor stopping; baseline incomplete');
    entry.lastTickMs = outcome.durationMs;
    entry.lastTickAt = this.now();
    this.lastActivity = entry.lastTickAt;

    const home = outcome.home;
    const homeOk = isUsableHome(home);
    entry.homeUnusable = !homeOk;

    if (entry.watch.features.subdomains && !entry.removed) {
      await this.exclusive(
        entry,
        entry.slow,
        SLOW_TIMEOUT_MS,
        'baseline subdomain scan',
        async (token) => {
          // Hosts from the baseline crawl are old news in any case.
          const localHosts = outcome.localHosts.map((h) => ({ ...h, loud: false }));
          const subBaseline = !entry.state.subdomainsBaselined;
          const alerts = await checkSubdomains(this.makeCtx(entry, subBaseline, token), { localHosts, force: true });
          entry.knownSubs = null;
          entry.state.subdomainsBaselined = true;
          entry.pending.subdomains = false;
          // A retried first baseline: subdomain checks already run on their own, so what they find now is news.
          if (!subBaseline && alerts.length > 0) await this.deliver(entry, alerts);
        },
        () => undefined,
      );
    }

    entry.state.baselineAt = this.now();
    if (!entry.removed && !entry.watch.baselineDone && homeOk) {
      this.store.updateWatch(entry.id, { baselineDone: true });
      entry.watch = { ...entry.watch, baselineDone: true };
    }
    this.store.saveState(entry.id, entry.state);
    if (!homeOk && !wasRebaseline) {
      this.log.warn('baseline could not use the homepage; it is retried once the site answers', {
        watchId: entry.id,
        status: home?.status ?? 0,
        blocked: Boolean(home?.blocked),
      });
    }

    const deploy = entry.state.deploy;
    const summary: BaselineSummary = {
      watchId: entry.id,
      pagesTracked: this.safeCount(() => this.store.countPages(entry.id, { kind: 'page', tracked: true })),
      pagesKnown: this.safeCount(() => this.store.countPages(entry.id, { kind: 'page' })),
      files: this.safeCount(() => this.store.countPages(entry.id, { kind: 'file' })),
      subdomains: this.safeCount(() => this.store.listSubdomains(entry.id).length),
      buildId: deploy?.buildId ?? null,
      assets: Array.isArray(deploy?.assets) ? deploy.assets.length : 0,
      homeStatus: typeof home?.status === 'number' ? home.status : 0,
      homeBlocked: Boolean(home?.blocked),
      durationMs: Math.round(performance.now() - t0),
      redirectedTo,
    };
    this.log.info('baseline complete', { ...summary });
    return summary;
  }

  /**
   * A first baseline whose start URL redirects to another host: adopt that host when it belongs to the same site (the
   * crawl scope is one host, so staying on the old one would track the start page only). Another domain is only reported.
   */
  private adoptRedirect(entry: Entry, res: FetchResult | null): BaselineSummary['redirectedTo'] {
    const watch = entry.watch;
    if (!res || !res.redirected || !res.ok) return null;
    const finalUrl = normalizeUrl(res.finalUrl);
    if (!finalUrl) return null;
    let finalHost: string;
    try {
      finalHost = new URL(finalUrl).hostname.toLowerCase();
    } catch {
      return null;
    }
    const from = watch.host;
    if (finalHost === from.toLowerCase()) return null;
    if (!isUnderDomain(finalHost, watch.rootDomain)) {
      this.log.info('start URL redirects to another domain; only the start page can be checked', { watchId: entry.id, to: finalHost });
      return { from, to: finalHost, adopted: false };
    }
    try {
      const other = this.store.findWatchByUrl(watch.guildId, finalUrl);
      if (other && other.id !== watch.id) return { from, to: finalHost, adopted: false };
      const updated = this.store.updateWatch(watch.id, { url: finalUrl, host: finalHost });
      entry.watch = { ...updated, baselineDone: entry.watch.baselineDone };
    } catch (err) {
      this.log.warn('adopting the redirect target failed', { watchId: entry.id, err: errText(err) });
      return { from, to: finalHost, adopted: false };
    }
    this.log.info('start URL redirects to another host of the site; watching that host', { watchId: entry.id, from, to: finalHost });
    return { from, to: finalHost, adopted: true };
  }

  private safeCount(fn: () => number): number {
    try {
      const n = fn();
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
}
