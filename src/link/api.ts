/**
 * Link API HTTP routes (served by the same HTTP server as /health).
 *
 * ENDPOINT CONTRACT (single source of truth — INTEGRATION.md documents exactly this):
 * Base: <PUBLIC_URL>/api/v1. Every response is JSON (`content-type: application/json; charset=utf-8`).
 * Errors: `{ "error": { "code": "<snake_case>", "message": "<human text>" } }` with a fitting status.
 *
 * Auth: `Authorization: Bearer swb_…` (also accepted: `X-Link-Token: swb_…`). Tokens come from Discord `/link create`
 *   and are bound to one guild + one alert channel (store.findLinkToken). Missing/unknown → 401 `unauthorized`
 *   (also when the bot is no longer in the token's guild, or the bot is locked to another guild by DISCORD_GUILD_ID).
 *   Successful auth → store.touchLinkToken (at most once a minute per token).
 * CORS (for the extension's background worker / pages): every /api/v1 response carries
 *   Access-Control-Allow-Origin: *, Access-Control-Allow-Headers: Authorization, Content-Type, X-Link-Token,
 *   Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS, Access-Control-Max-Age: 600. OPTIONS → 204, no auth.
 * Limits per token (in-memory token buckets): 120 requests/min overall; POST /scan 20 per 10 min; POST /watches 30/hour.
 *   Exceeded → 429 `rate_limited` + Retry-After (seconds). Request bodies: JSON, ≤ 32 KB (413 `too_large`);
 *   invalid JSON → 400 `bad_request`. Unknown route → 404 `not_found`; wrong method → 405 `method_not_allowed`.
 *
 * GET    /api/v1/ping                → 200 { ok: true, bot: "site-watcher", version, apiVersion: 1,
 *                                            guild: { id }, channelId, label, watches: <count in guild> }
 * POST   /api/v1/scan                  body { url, subdomains?: "none"|"quick"|"full" }
 *                                     → 200 ScanResult (src/link/types.ts); bad url, or a private / internal host
 *                                       (localhost, 10.x, *.internal, … unless ALLOW_PRIVATE_NETWORK) → 400 `invalid_url`;
 *                                       scan failure → 502 `scan_failed`.
 * GET    /api/v1/watches[?url=<u>]     → 200 { watches: ApiWatch[] } (guild's watches; with ?url= only those whose
 *                                       normalized url or host matches, plus `watched: boolean`).
 * POST   /api/v1/watches               body { url, name?, intervalSec?, features?: { deploy?, text?, pages?, subdomains?,
 *                                       files?, status?, codeIntel? } }
 *                                     → 201 { created: true, watch } — the site is added to the token's guild/channel,
 *                                       its silent first scan (monitor.runBaseline, then monitor.onWatchAdded) runs in the
 *                                       background (status "scanning" until done), and Discord gets
 *                                       "➕ **<name>** (<url>) was added from **<label>** — first scan running…"
 *                                       (via deps.announce) and, when the scan finishes, "✅ Now watching **<name>** …".
 *                                     → 200 { created: false, watch } if the guild already watches that URL.
 *                                     → 400 `invalid_url` (also private / internal hosts, as for /scan) / `invalid_interval`;
 *                                       409 `limit_reached` (MAX_WATCHES_PER_GUILD).
 *                                       Name defaults like /watch add (parseWatchInput().suggestedName, made unique);
 *                                       interval defaults to config.defaultIntervalSec, clamped to [minIntervalSec, 3600].
 * GET    /api/v1/watches/:id           → 200 { watch: ApiWatch, events: ApiEvent[] (newest 20) }; other guild/unknown → 404.
 * DELETE /api/v1/watches/:id           → 200 { deleted: true } (store.deleteWatch + monitor.onWatchRemoved; Discord gets
 *                                       "➖ **<name>** was removed from **<label>**").
 * POST   /api/v1/watches/:id/check     → 200 { alerts: <n>, kinds: string[], error: string|null } (monitor.checkNow,
 *                                       max 60 s → 504 `timeout`).
 * GET    /api/v1/events?since=<id>&limit=<1..200, default 50>
 *                                     → 200 { events: ApiEvent[] (oldest first, id > since), nextSince: <last id or since> }
 *                                       — clients poll this to mirror alerts.
 *
 * Implementation notes (beyond the contract):
 * - Route → method → auth → rate limit → body. 405 answers carry `Allow`; 429 answers carry `Retry-After`, which is also
 *   exposed to browser callers (Access-Control-Expose-Headers).
 * - 503 `unavailable` while the monitor has not started yet (adding / checking need it).
 * - 408 `timeout` when a request body does not arrive within BODY_TIMEOUT_MS.
 * - At most MAX_CONCURRENT_SCANS scans run at once across all tokens (they share the bot's outbound HTTP budget with the
 *   monitor); beyond that → 429 `rate_limited` with a short Retry-After.
 * - Concurrent /check calls for the same watch share one run.
 * - 500 `internal_error` for anything unexpected. Internal error text (stack traces, SQLite, scanner bugs) is logged, never
 *   sent: a scan that crashes answers 502 with a generic message, a check that crashes answers 200 with a generic `error`.
 * - The add path reuses the /watch add helpers (prepareAdd: synchronous duplicate check + insert, so a double-click can
 *   never create two watches).
 */
import type http from 'node:http';
import type { Config } from '../config.js';
import type { LinkToken, Store } from '../db/store.js';
import type { Monitor, TickSummary, BaselineSummary } from '../monitor/scheduler.js';
import { DEFAULT_FEATURES, type EventRecord, type Logger, type Watch, type WatchFeatures, type WatchState } from '../types.js';
import { parseWatchInput } from '../extract/url.js';
import { isWalledOff } from '../monitor/status.js';
import {
  MAX_INTERVAL_SEC,
  UserError,
  cleanName,
  defaultInterval,
  errMessage,
  minInterval,
  nameOf,
  nameTaken,
  prepareAdd,
  safeState,
  startWatch,
  withDeadline,
  type CommandDeps,
} from '../discord/commands.js';
import { escapeMarkdown, truncate } from '../discord/format.js';
import { APP_VERSION } from '../version.js';
import { ScanInputError, isPrivateTarget, privateTargetMessage, scanSite, type ScanDeps } from './scan.js';
import { LINK_API_PREFIX, type ApiEvent, type ApiWatch, type ScanResult } from './types.js';

export interface LinkApiDeps {
  store: Store;
  config: Config;
  log: Logger;
  getMonitor: () => Monitor | null;
  scan: Omit<ScanDeps, 'store' | 'config' | 'log'>;
  /** Posts a one-line notice in Discord (e.g. "➕ Unpeg added from the extension"); resolves even if Discord is down. */
  announce?: (channelId: string, content: string) => Promise<void>;
  /** Test seam: replaces scanSite. */
  scanFn?: typeof import('./scan.js').scanSite;
  /**
   * Whether the bot is (still) in this guild. Tokens of a guild that removed the bot get 401, so they can't keep adding
   * watches (and running scans) for a server the bot has left. Absent → every guild counts as active.
   */
  isGuildActive?: (guildId: string) => boolean;
  /**
   * True while the bot is still restoring the watch list / link tokens from its Discord backup after a fresh start.
   * Unknown tokens then get 503 `unavailable` + Retry-After instead of 401, so clients don't treat a redeploy as a revoke.
   */
  isRestoring?: () => boolean;
  now?: () => number;
}

/** Minimum seconds between two manual checks of the same site through the API. */
export const CHECK_COOLDOWN_SEC = 30;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const API_VERSION = 1;
/** Max request body (bytes). */
export const MAX_BODY_BYTES = 32 * 1024;
/** A request body must arrive within this long. */
const BODY_TIMEOUT_MS = 15_000;
/** /check answers 504 after this long (the check keeps running and still posts its alerts). */
const CHECK_TIMEOUT_MS = 60_000;
/** /scan answers 502 after this long (scanSite has its own, shorter budget; this is the backstop). */
const SCAN_TIMEOUT_MS = 50_000;
/** Scans running at the same time across all tokens. */
const MAX_CONCURRENT_SCANS = 3;
/** last_used_at is written at most this often per token. */
const TOUCH_EVERY_MS = 60_000;
/** Idle (full) rate-limit buckets are dropped this often. */
const BUCKET_GC_EVERY_MS = 60_000;
/** Discord message limit. */
const DISCORD_MAX_CHARS = 2000;
const WATCH_EVENTS = 20;
const EVENTS_DEFAULT_LIMIT = 50;
const EVENTS_MAX_LIMIT = 200;

type LimitClass = 'all' | 'scan' | 'add';
const LIMITS: Record<LimitClass, { capacity: number; windowMs: number }> = {
  all: { capacity: 120, windowMs: 60_000 },
  scan: { capacity: 20, windowMs: 10 * 60_000 },
  add: { capacity: 30, windowMs: 3600_000 },
};

const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, X-Link-Token',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-max-age': '600',
  'access-control-expose-headers': 'Retry-After',
};

const SUBDOMAIN_MODES = new Set(['none', 'quick', 'full']);
const FEATURE_KEYS = Object.keys(DEFAULT_FEATURES) as Array<keyof WatchFeatures>;

// ---------------------------------------------------------------------------
// Rate limiting (token buckets per token id + class; idle buckets are garbage-collected)
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number;
  at: number;
  capacity: number;
  perMs: number;
}

class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastGc = 0;

  /** Takes one token from every class, or none if any is empty: returns 0 when allowed, else Retry-After seconds. */
  take(tokenId: number, classes: LimitClass[], now: number): number {
    this.gc(now);
    const list = classes.map((c) => this.bucket(`${tokenId}:${c}`, c, now));
    let waitMs = 0;
    for (const b of list) {
      this.refill(b, now);
      if (b.tokens < 1) waitMs = Math.max(waitMs, (1 - b.tokens) / b.perMs);
    }
    if (waitMs > 0) return Math.max(1, Math.ceil(waitMs / 1000));
    for (const b of list) b.tokens -= 1;
    return 0;
  }

  size(): number {
    return this.buckets.size;
  }

  private bucket(key: string, cls: LimitClass, now: number): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      const { capacity, windowMs } = LIMITS[cls];
      b = { tokens: capacity, at: now, capacity, perMs: capacity / windowMs };
      this.buckets.set(key, b);
    }
    return b;
  }

  private refill(b: Bucket, now: number): void {
    if (now > b.at) {
      b.tokens = Math.min(b.capacity, b.tokens + (now - b.at) * b.perMs);
      b.at = now;
    }
  }

  /** A bucket that has refilled completely is indistinguishable from a fresh one: drop it. */
  private gc(now: number): void {
    if (now - this.lastGc < BUCKET_GC_EVERY_MS) return;
    this.lastGc = now;
    for (const [key, b] of this.buckets) {
      this.refill(b, now);
      if (b.tokens >= b.capacity) this.buckets.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(json)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(json);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { code, message } }, headers);
}

type BodyResult = { ok: true; value: unknown } | { ok: false; error: ApiError | null };

/** Reads a JSON request body (≤ MAX_BODY_BYTES, within BODY_TIMEOUT_MS). `error: null` = the client went away. */
function readJsonBody(req: http.IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    const tooLarge = () => new ApiError(413, 'too_large', `Request body too large (max ${MAX_BODY_BYTES / 1024} KB).`, { connection: 'close' });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      resolve({ ok: false, error: tooLarge() });
      return;
    }
    const encoding = String(req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding && encoding !== 'identity') {
      resolve({ ok: false, error: new ApiError(400, 'bad_request', 'Compressed request bodies are not supported.', { connection: 'close' }) });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: BodyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onGone);
      req.off('close', onClose);
      // Discard whatever else arrives (the server's requestTimeout bounds a body that never ends).
      if (!req.complete) req.resume();
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, error: tooLarge() });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      let text = Buffer.concat(chunks).toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (!text.trim()) {
        finish({ ok: true, value: undefined });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(text) as unknown });
      } catch {
        finish({ ok: false, error: new ApiError(400, 'bad_request', 'The request body is not valid JSON.') });
      }
    };
    const onGone = () => finish({ ok: false, error: null });
    const onClose = () => {
      if (!req.complete) onGone();
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: new ApiError(408, 'timeout', 'The request body took too long to arrive.', { connection: 'close' }) }),
      BODY_TIMEOUT_MS,
    );
    timer.unref?.();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onGone);
    req.on('close', onClose);
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** "Bearer swb_…" or X-Link-Token. */
function presentedToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(auth);
    if (m) return m[1];
  }
  const x = req.headers['x-link-token'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  return null;
}

/** Watch ids are positive integers written plainly ("12"; not "012", "1e3", "12abc"). */
function parseId(raw: string): number | null {
  return /^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : null;
}

/** Non-negative integer query value; null when absent; throws on junk. */
function intParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return null;
  if (!/^\d{1,15}$/.test(raw.trim())) throw new ApiError(400, 'bad_request', `\`${name}\` must be a non-negative integer.`);
  return Number(raw.trim());
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, '');
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/** UserError messages are Discord markdown; the API speaks plain text. */
function plain(message: string): string {
  return message.replace(/\*\*|`/g, '').replace(/\\([\\*_`[\]<|~#>+.\-])/g, '$1');
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Same precedence as the dashboard's siteStatus(): paused > first scan pending > down > blocked > up. */
function apiStatus(w: Watch, state: Pick<WatchState, 'status'> | null): string {
  if (w.paused) return 'paused';
  if (!w.baselineDone) return 'scanning';
  if (state?.status && !state.status.up) return 'down';
  if (isWalledOff(state)) return 'blocked';
  return 'up';
}

function toApiWatch(store: Store, w: Watch): ApiWatch {
  const state = safeState(store, w.id);
  let pagesTracked = 0;
  let subdomains = 0;
  try {
    pagesTracked = store.countPages(w.id, { kind: 'page', tracked: true });
    subdomains = store.countSubdomains(w.id);
  } catch {
    // counts are informational
  }
  const features: Record<string, boolean> = {};
  for (const k of FEATURE_KEYS) features[k] = Boolean(w.features[k]);
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    host: w.host,
    channelId: w.channelId,
    intervalSec: w.intervalSec,
    paused: w.paused,
    status: apiStatus(w, state),
    features,
    createdAt: w.createdAt,
    lastCheckAt: state && state.lastCheckAt > 0 ? state.lastCheckAt : null,
    lastChangeAt: state && state.lastChangeAt > 0 ? state.lastChangeAt : null,
    pagesTracked,
    subdomains,
  };
}

function toApiEvent(e: EventRecord, w: Pick<Watch, 'name' | 'url'>): ApiEvent {
  return { id: e.id, watchId: e.watchId, watchName: w.name, watchUrl: w.url, kind: e.kind, summary: e.summary, createdAt: e.createdAt };
}

function shortBuild(id: string | null): string | null {
  if (!id) return null;
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "✅ Now watching **Unpeg** (<https://unpeg.io/>) — 12 pages, 5 subdomains, build `KU79abcd…` · every 2s." */
function nowWatchingMessage(w: Watch, summary: BaselineSummary | null, error: string | null): string {
  const head = `✅ Now watching **${nameOf(w)}** (<${w.url}>)`;
  if (!summary) {
    return `${head} — ⚠️ the first scan failed (${escapeMarkdown(truncate(error ?? 'unknown error', 200))}); it is retried automatically.`;
  }
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const parts = [plural(n(summary.pagesTracked), 'page')];
  if (n(summary.files)) parts.push(plural(n(summary.files), 'file'));
  if (w.features.subdomains) parts.push(plural(n(summary.subdomains), 'subdomain'));
  const build = shortBuild(summary.buildId);
  if (build) parts.push(`build \`${build.replace(/`/g, 'ˋ')}\``);
  let tail = `${parts.join(', ')} · every ${w.intervalSec}s.`;
  if (summary.homeBlocked) tail += ' ⚠️ The site shows a bot challenge to the watcher — checks resume when it stops.';
  else if (summary.homeStatus === 0) tail += " ⚠️ The homepage was unreachable — I'll alert when it comes up.";
  else if (summary.homeStatus >= 400) tail += ` ⚠️ The homepage returned HTTP ${summary.homeStatus}.`;
  return `${head} — ${tail}`;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type RouteName = 'ping' | 'scan' | 'watches' | 'watch' | 'check' | 'events';
interface Route {
  name: RouteName;
  methods: string[];
  id?: string;
}

function matchRoute(sub: string): Route | null {
  switch (sub) {
    case '/ping':
      return { name: 'ping', methods: ['GET'] };
    case '/scan':
      return { name: 'scan', methods: ['POST'] };
    case '/watches':
      return { name: 'watches', methods: ['GET', 'POST'] };
    case '/events':
      return { name: 'events', methods: ['GET'] };
  }
  let m = /^\/watches\/([^/]+)$/.exec(sub);
  if (m) return { name: 'watch', methods: ['GET', 'DELETE'], id: m[1] };
  m = /^\/watches\/([^/]+)\/check$/.exec(sub);
  if (m) return { name: 'check', methods: ['POST'], id: m[1] };
  return null;
}

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  route: Route;
  query: URLSearchParams;
  token: LinkToken;
  body: Record<string, unknown>;
}

/**
 * Returns a request handler for everything under LINK_API_PREFIX; it returns false for other paths so the caller can
 * fall through (to /health). See INTEGRATION.md for the endpoint contract.
 */
export function createLinkApi(deps: LinkApiDeps): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
  const { store, config, log } = deps;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const scanFn = deps.scanFn ?? scanSite;
  const limiter = new RateLimiter();
  const checks = new Map<number, Promise<TickSummary>>();
  /** Last API-triggered check start per watch (bounded: one entry per watch). */
  const lastCheckStart = new Map<number, number>();
  let activeScans = 0;

  const announce = async (channelId: string, content: string): Promise<void> => {
    if (!deps.announce) return;
    try {
      await deps.announce(channelId, truncate(content, DISCORD_MAX_CHARS));
    } catch (err) {
      log.warn('link: Discord notice failed', { channelId, err: errMessage(err) });
    }
  };

  const requireMonitor = (): Monitor => {
    const monitor = deps.getMonitor();
    if (!monitor) throw new ApiError(503, 'unavailable', 'The bot is still starting — try again in a few seconds.');
    return monitor;
  };

  /** SSRF guard for outside callers: no localhost / private IPs / *.internal (Railway's private network) targets. */
  const refusePrivate = (host: string): void => {
    if (config.allowPrivateNetwork !== true && isPrivateTarget(host)) {
      throw new ApiError(400, 'invalid_url', privateTargetMessage(host));
    }
  };

  const guildActive = (guildId: string): boolean => {
    if (config.discordGuildId && guildId !== config.discordGuildId) return false;
    if (!deps.isGuildActive) return true;
    try {
      return deps.isGuildActive(guildId) !== false;
    } catch {
      return true; // can't tell (Discord not connected yet): don't lock people out
    }
  };

  const ownWatch = (route: Route, token: LinkToken): Watch => {
    const id = parseId(route.id ?? '');
    const w = id === null ? undefined : store.getWatch(id);
    if (!w || w.guildId !== token.guildId) throw new ApiError(404, 'not_found', 'Unknown watch.');
    return w;
  };

  const audit = (token: LinkToken, action: string, meta: Record<string, unknown> = {}) =>
    log.info(`link: ${action}`, { label: token.label, guild: token.guildId, action, ...meta });

  // --- endpoints ---------------------------------------------------------------------------------------------------

  const ping = ({ res, token }: Ctx) => {
    sendJson(res, 200, {
      ok: true,
      bot: 'site-watcher',
      version: APP_VERSION,
      apiVersion: API_VERSION,
      guild: { id: token.guildId },
      channelId: token.channelId,
      label: token.label,
      watches: store.listWatches(token.guildId).length,
    });
  };

  const scan = async ({ res, token, body }: Ctx) => {
    const raw = body.url;
    const parsed = typeof raw === 'string' ? parseWatchInput(raw) : null;
    if (typeof raw !== 'string' || !parsed) {
      throw new ApiError(400, 'invalid_url', "That doesn't look like a website URL (try `unpeg.io` or `https://unpeg.io/docs`).");
    }
    refusePrivate(parsed.host);
    const mode = body.subdomains ?? 'quick';
    if (typeof mode !== 'string' || !SUBDOMAIN_MODES.has(mode)) {
      throw new ApiError(400, 'bad_request', '`subdomains` must be "none", "quick" or "full".');
    }
    if (activeScans >= MAX_CONCURRENT_SCANS) {
      throw new ApiError(429, 'rate_limited', 'Too many scans are running right now — try again in a few seconds.', { 'retry-after': '5' });
    }
    log.debug('link: scan', { label: token.label, guild: token.guildId, url: raw });
    let running: Promise<ScanResult>;
    try {
      running = scanFn({ ...deps.scan, store, config, log, now }, raw.trim(), {
        guildId: token.guildId,
        subdomains: mode as 'none' | 'quick' | 'full',
      });
    } catch (err) {
      running = Promise.reject(err);
    }
    activeScans++;
    const tracked = running.finally(() => {
      activeScans--;
    });
    tracked.catch(() => {}); // the outcome is handled below (or ignored after a timeout)
    let result: { done: true; value: ScanResult } | { done: false };
    try {
      result = await withDeadline(tracked, SCAN_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof ScanInputError) throw new ApiError(400, 'invalid_url', truncate(err.message, 300));
      // scanSite reports network trouble inside the result; a throw is a bug — log it, don't hand internals out.
      log.warn('link: scan crashed', { guild: token.guildId, host: parsed.host, err: errMessage(err) });
      throw new ApiError(502, 'scan_failed', 'The scan failed unexpectedly — try again in a minute.');
    }
    if (!result.done) throw new ApiError(502, 'scan_failed', 'The scan took too long — try again with `subdomains: "none"`.');
    sendJson(res, 200, result.value);
  };

  const listWatches = ({ res, token, query }: Ctx) => {
    let list = store.listWatches(token.guildId);
    const rawUrl = query.get('url');
    if (rawUrl === null) {
      sendJson(res, 200, { watches: list.map((w) => toApiWatch(store, w)) });
      return;
    }
    const parsed = parseWatchInput(rawUrl);
    if (!parsed) throw new ApiError(400, 'invalid_url', "That doesn't look like a website URL.");
    const key = stripScheme(parsed.url);
    const host = bareHost(parsed.host);
    list = list.filter((w) => stripScheme(w.url) === key || bareHost(w.host) === host);
    sendJson(res, 200, { watches: list.map((w) => toApiWatch(store, w)), watched: list.length > 0 });
  };

  const addWatch = async ({ res, token, body }: Ctx) => {
    const raw = body.url;
    const parsed = typeof raw === 'string' ? parseWatchInput(raw) : null;
    if (!parsed) {
      throw new ApiError(400, 'invalid_url', "That doesn't look like a website URL (try `unpeg.io` or `https://unpeg.io/docs`).");
    }
    refusePrivate(parsed.host);

    // Validate everything before touching the store.
    let name: string | null = null;
    if (body.name !== undefined && body.name !== null && body.name !== '') {
      if (typeof body.name !== 'string') throw new ApiError(400, 'bad_request', '`name` must be a string.');
      try {
        name = cleanName(body.name);
      } catch (err) {
        throw new ApiError(400, 'bad_request', plain(errMessage(err)));
      }
    }
    let intervalSec = defaultInterval(config);
    if (body.intervalSec !== undefined && body.intervalSec !== null) {
      const v = body.intervalSec;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new ApiError(400, 'invalid_interval', `\`intervalSec\` must be a number of seconds (${minInterval(config)}–${MAX_INTERVAL_SEC}).`);
      }
      intervalSec = Math.min(MAX_INTERVAL_SEC, Math.max(minInterval(config), Math.round(v)));
    }
    const features: Partial<WatchFeatures> = {};
    if (body.features !== undefined && body.features !== null) {
      if (!isPlainObject(body.features)) throw new ApiError(400, 'bad_request', '`features` must be an object of booleans.');
      for (const k of FEATURE_KEYS) {
        const v = body.features[k];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'boolean') throw new ApiError(400, 'bad_request', `\`features.${k}\` must be true or false.`);
        features[k] = v;
      }
    }

    // Already watched (scheme-less: the http:// and https:// versions of one URL are the same site) → 200.
    // Also the same site when only "www." differs and both are the site root (matches ?url= and scan.watched).
    const isRoot = (u: string) => {
      try {
        return new URL(u).pathname === '/';
      } catch {
        return false;
      }
    };
    const existing =
      store.findWatchByUrl(token.guildId, stripScheme(parsed.url)) ??
      (isRoot(parsed.url)
        ? store.listWatches(token.guildId).find((w) => bareHost(w.host) === bareHost(parsed.host) && isRoot(w.url))
        : undefined);
    if (existing) {
      sendJson(res, 200, { created: false, watch: toApiWatch(store, existing) });
      return;
    }
    const max = config.maxWatchesPerGuild;
    if (typeof max === 'number' && max > 0 && store.listWatches(token.guildId).length >= max) {
      throw new ApiError(409, 'limit_reached', `This server already watches ${max} sites (the limit). Remove one first.`);
    }
    const monitor = requireMonitor();
    if (name !== null && nameTaken({ store }, token.guildId, name)) name = uniqueName(store, token.guildId, name);

    // Synchronous from the duplicate check to the insert: two concurrent requests can't both add the site.
    const cdeps: CommandDeps = { store, config, log, monitor };
    let watch: Watch;
    try {
      watch = prepareAdd(cdeps, {
        guildId: token.guildId,
        channelId: token.channelId,
        userId: `link:${token.label}`,
        url: parsed.url,
        name,
        intervalSec,
        subdomains: features.subdomains ?? null,
      }).watch;
    } catch (err) {
      if (err instanceof UserError) throw new ApiError(400, 'bad_request', plain(err.message));
      throw err;
    }
    const { subdomains: _subdomains, ...rest } = features;
    if (Object.keys(rest).length > 0) watch = store.updateWatch(watch.id, { features: rest });
    audit(token, 'add', { watchId: watch.id, url: watch.url });

    sendJson(res, 201, { created: true, watch: toApiWatch(store, watch) });

    const added = announce(
      watch.channelId,
      `➕ **${nameOf(watch)}** (<${watch.url}>) was added from **${escapeMarkdown(token.label)}** — first scan running…`,
    );
    void firstScan(cdeps, watch, added);
  };

  /** Silent baseline, then start the watch and say so in Discord (after the "added" notice). Never rejects. */
  const firstScan = async (cdeps: CommandDeps, watch: Watch, added: Promise<void>): Promise<void> => {
    let summary: BaselineSummary | null = null;
    let error: string | null = null;
    try {
      summary = await cdeps.monitor.runBaseline(watch.id);
    } catch (err) {
      error = errMessage(err);
      log.warn('link: first scan failed', { watchId: watch.id, err: error });
    }
    try {
      const fresh = startWatch(cdeps, watch.id);
      await added;
      if (!fresh) return; // removed while its first scan was running
      await announce(fresh.channelId, nowWatchingMessage(fresh, summary, error));
    } catch (err) {
      log.error('link: starting a watch failed', { watchId: watch.id, err: errMessage(err) });
    }
  };

  const getWatch = ({ res, token, route }: Ctx) => {
    const w = ownWatch(route, token);
    const events = store.listEvents(w.id, WATCH_EVENTS).map((e) => toApiEvent(e, w));
    sendJson(res, 200, { watch: toApiWatch(store, w), events });
  };

  const deleteWatch = ({ res, token, route }: Ctx) => {
    const w = ownWatch(route, token);
    store.deleteWatch(w.id);
    try {
      deps.getMonitor()?.onWatchRemoved(w.id);
    } catch (err) {
      log.error('monitor.onWatchRemoved failed', { watchId: w.id, err: errMessage(err) });
    }
    audit(token, 'remove', { watchId: w.id, url: w.url });
    sendJson(res, 200, { deleted: true });
    void announce(w.channelId, `➖ **${nameOf(w)}** was removed from **${escapeMarkdown(token.label)}**`);
  };

  const check = async ({ res, token, route }: Ctx) => {
    const w = ownWatch(route, token);
    const monitor = requireMonitor();
    audit(token, 'check', { watchId: w.id, url: w.url });
    let run = checks.get(w.id);
    if (!run) {
      const since = (now() - (lastCheckStart.get(w.id) ?? 0)) / 1000;
      if (since < CHECK_COOLDOWN_SEC) {
        const wait = Math.max(1, Math.ceil(CHECK_COOLDOWN_SEC - since));
        throw new ApiError(429, 'rate_limited', `This site was just checked — try again in ${wait}s.`, { 'retry-after': String(wait) });
      }
      lastCheckStart.set(w.id, now());
      if (lastCheckStart.size > 10_000) lastCheckStart.clear();
      let started: Promise<TickSummary>;
      try {
        started = monitor.checkNow(w.id, { full: false });
      } catch (err) {
        started = Promise.reject(err);
      }
      const shared = started
        .catch((err: unknown): TickSummary => {
          log.warn('link: check failed', { watchId: w.id, err: errMessage(err) });
          return { watchId: w.id, alerts: [], durationMs: 0, error: 'The check could not run — try again in a minute.' };
        })
        .finally(() => {
          if (checks.get(w.id) === shared) checks.delete(w.id);
        });
      checks.set(w.id, shared);
      run = shared;
    }
    const timely = await withDeadline(run, CHECK_TIMEOUT_MS);
    if (!timely.done) {
      throw new ApiError(504, 'timeout', 'The check is still running — any alerts will be posted to Discord.');
    }
    const r = timely.value;
    sendJson(res, 200, { alerts: r.alerts.length, kinds: [...new Set(r.alerts.map((a) => a.kind))], error: r.error ?? null });
  };

  const events = ({ res, token, query }: Ctx) => {
    const since = intParam(query, 'since') ?? 0;
    const limitRaw = intParam(query, 'limit');
    const limit = limitRaw === null ? EVENTS_DEFAULT_LIMIT : Math.min(EVENTS_MAX_LIMIT, Math.max(1, limitRaw));
    const rows = store.listGuildEvents(token.guildId, since, limit);
    const list: ApiEvent[] = rows.map((r) => ({
      id: r.id,
      watchId: r.watchId,
      watchName: r.watchName,
      watchUrl: r.watchUrl,
      kind: r.kind,
      summary: r.summary,
      createdAt: r.createdAt,
    }));
    sendJson(res, 200, { events: list, nextSince: list.length ? list[list.length - 1].id : since });
  };

  const dispatch = async (ctx: Ctx): Promise<void> => {
    const { route, method } = ctx;
    switch (route.name) {
      case 'ping':
        return ping(ctx);
      case 'scan':
        return scan(ctx);
      case 'watches':
        return method === 'POST' ? addWatch(ctx) : listWatches(ctx);
      case 'watch':
        return method === 'DELETE' ? deleteWatch(ctx) : getWatch(ctx);
      case 'check':
        return check(ctx);
      case 'events':
        return events(ctx);
    }
  };

  // --- request pipeline --------------------------------------------------------------------------------------------

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse, sub: string, query: URLSearchParams): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      const headers: Record<string, string> = { ...CORS_HEADERS, 'content-length': '0' };
      if (String(req.headers['access-control-request-private-network'] ?? '').toLowerCase() === 'true') {
        headers['access-control-allow-private-network'] = 'true';
      }
      res.writeHead(204, headers).end();
      return;
    }
    const route = matchRoute(sub);
    if (!route) throw new ApiError(404, 'not_found', `Unknown endpoint. See ${LINK_API_PREFIX}/ping.`);
    if (!route.methods.includes(method)) {
      throw new ApiError(405, 'method_not_allowed', `Use ${route.methods.join(' or ')} for this endpoint.`, {
        allow: [...route.methods, 'OPTIONS'].join(', '),
      });
    }

    const presented = presentedToken(req);
    if (!presented) {
      throw new ApiError(401, 'unauthorized', 'Missing API token. Create one in Discord with /link create and send it as "Authorization: Bearer swb_…".');
    }
    const token = store.findLinkToken(presented);
    if (!token) {
      let restoring = false;
      try {
        restoring = Boolean(deps.isRestoring?.());
      } catch {
        restoring = false;
      }
      if (restoring) {
        throw new ApiError(503, 'unavailable', 'The bot just restarted and is still restoring its links — try again in a few seconds.', {
          'retry-after': '15',
        });
      }
      throw new ApiError(401, 'unauthorized', 'Invalid or revoked API token.');
    }
    if (!guildActive(token.guildId)) {
      throw new ApiError(401, 'unauthorized', "The bot is no longer in this token's Discord server. Re-add the bot, then /link create a new token.");
    }

    const t = now();
    const classes: LimitClass[] = ['all'];
    if (route.name === 'scan') classes.push('scan');
    if (route.name === 'watches' && method === 'POST') classes.push('add');
    const retryAfter = limiter.take(token.id, classes, t);
    if (retryAfter > 0) {
      throw new ApiError(429, 'rate_limited', `Too many requests — try again in ${retryAfter}s.`, { 'retry-after': String(retryAfter) });
    }
    if (token.lastUsedAt === null || t - token.lastUsedAt >= TOUCH_EVERY_MS) {
      try {
        store.touchLinkToken(token.id, t);
      } catch (err) {
        log.warn('link: could not record token use', { tokenId: token.id, err: errMessage(err) });
      }
    }

    let body: Record<string, unknown> = {};
    if (method === 'POST') {
      const read = await readJsonBody(req);
      if (!read.ok) {
        if (read.error) throw read.error;
        return; // client went away
      }
      if (read.value !== undefined) {
        if (!isPlainObject(read.value)) throw new ApiError(400, 'bad_request', 'The request body must be a JSON object.');
        body = read.value;
      }
    }
    await dispatch({ req, res, method, route, query, token, body });
  };

  const fail = (res: http.ServerResponse, err: unknown) => {
    if (err instanceof ApiError) {
      sendError(res, err.status, err.code, err.message, err.headers);
      return;
    }
    log.error('link: request failed', { err: err instanceof Error ? err : String(err) });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(res, 500, 'internal_error', 'Something went wrong on the bot. Try again later.');
  };

  return (req, res) => {
    if (config.linkApi === false) return false;
    const rawUrl = typeof req.url === 'string' ? req.url : '/';
    const q = rawUrl.indexOf('?');
    let path = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
    if (path !== LINK_API_PREFIX && !path.startsWith(`${LINK_API_PREFIX}/`)) return false;
    const safeFail = (err: unknown) => {
      try {
        fail(res, err);
      } catch {
        res.destroy();
      }
    };
    try {
      if (path.length > LINK_API_PREFIX.length + 1 && path.endsWith('/')) path = path.slice(0, -1);
      const query = new URLSearchParams(q >= 0 ? rawUrl.slice(q + 1) : '');
      handle(req, res, path.slice(LINK_API_PREFIX.length), query).catch(safeFail);
    } catch (err) {
      safeFail(err);
    }
    return true;
  };
}

/** "Unpeg" → "Unpeg 2" → "Unpeg 3"… (same rule as /watch add). */
function uniqueName(store: Store, guildId: string, base: string): string {
  const clean = truncate(base, 96);
  if (!nameTaken({ store }, guildId, clean)) return clean;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${clean} ${n}`;
    if (!nameTaken({ store }, guildId, candidate)) return candidate;
  }
  return `${clean} ${Date.now()}`;
}
