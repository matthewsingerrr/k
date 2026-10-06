/**
 * Link API HTTP routes (served by the same HTTP server as /health).
 *
 * ENDPOINT CONTRACT (single source of truth — INTEGRATION.md documents exactly this):
 * Base: <PUBLIC_URL>/api/v1. Every response is JSON (`content-type: application/json; charset=utf-8`).
 * Errors: `{ "error": { "code": "<snake_case>", "message": "<human text>", "field"?: "<JSON path into the body>" } }` with a
 *   fitting status (`field` only on some validation errors).
 *
 * Auth: `Authorization: Bearer swb_…` (also accepted: `X-Link-Token: swb_…`). Tokens come from Discord `/link create`
 *   and are bound to one guild + one alert channel (store.findLinkToken). Missing/unknown → 401 `unauthorized`
 *   (also when the bot is no longer in the token's guild, or the bot is locked to another guild by DISCORD_GUILD_ID).
 *   Successful auth → store.touchLinkToken (at most once a minute per token).
 *   A token was created by a member with Manage Server, so it has the dashboard's rights over every watch of ITS server
 *   (also ones added in Discord or posting elsewhere) and none over other servers: another server's watch id is 404, its
 *   channels and roles are 400 invalid_channel / invalid_role.
 * CORS (for the extension's background worker / pages): every /api/v1 response carries
 *   Access-Control-Allow-Origin: *, Access-Control-Allow-Headers: Authorization, Content-Type, X-Link-Token,
 *   Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS, Access-Control-Max-Age: 600. OPTIONS → 204, no auth.
 * Limits per token (in-memory token buckets): 120 requests/min overall; POST /scan 20 per 10 min; POST /watches and
 *   POST /watches/:id/subdomains/watch 30/hour; management writes (PATCH /watches/:id, POST /watches/:id/pause|resume,
 *   PATCH /watches/:id/rules, PATCH /watches/:id/subdomains) 60 per 10 min.
 *   Exceeded → 429 `rate_limited` + Retry-After (seconds). Request bodies (POST, PATCH): JSON, ≤ 32 KB (413 `too_large`);
 *   invalid JSON → 400 `bad_request`. Unknown route → 404 `not_found`; wrong method → 405 `method_not_allowed`.
 *
 * GET    /api/v1/ping                → 200 { ok: true, bot: "site-watcher", version, apiVersion: 1,
 *                                            guild: { id }, channelId, label, watches: <count in guild>, limits: ApiLimits }
 * POST   /api/v1/scan                  body { url, subdomains?: "none"|"quick"|"full" }
 *                                     → 200 ScanResult (src/link/types.ts); bad url, or a private / internal host
 *                                       (localhost, 10.x, *.internal, … unless ALLOW_PRIVATE_NETWORK) → 400 `invalid_url`;
 *                                       scan failure → 502 `scan_failed`.
 * GET    /api/v1/watches[?url=<u>]     → 200 { watches: ApiWatch[], summary: ApiServerSummary } (guild's watches; with ?url=
 *                                       only those whose normalized url or host matches, plus `watched: boolean`; the
 *                                       summary always covers every watch of the guild).
 * POST   /api/v1/watches               body { url, name?, intervalSec?, features?: { deploy?, text?, pages?, subdomains?,
 *                                       files?, status?, codeIntel? }, channelId?, pingRoleId? }
 *                                     → 201 { created: true, watch } — the site is added to the token's guild (alerts in
 *                                       `channelId`, default the token's channel; `pingRoleId` default none), its silent
 *                                       first scan (monitor.runBaseline, then monitor.onWatchAdded) runs in the
 *                                       background (status "scanning" until done), and Discord gets
 *                                       "➕ **<name>** (<url>) was added from **<label>** — first scan running…"
 *                                       (via deps.announce) and, when the scan finishes, "✅ Now watching **<name>** …".
 *                                     → 200 { created: false, watch } if the guild already watches that URL.
 *                                     → 400 `invalid_url` (also private / internal hosts, as for /scan) / `invalid_interval` /
 *                                       `invalid_channel` / `invalid_role`; 409 `limit_reached` (MAX_WATCHES_PER_GUILD).
 *                                       Name defaults like /watch add (parseWatchInput().suggestedName, made unique);
 *                                       interval defaults to config.defaultIntervalSec, clamped to [minIntervalSec, 3600].
 * GET    /api/v1/watches/:id           → 200 { watch: ApiWatch, card: ApiCard, events: ApiEvent[] (newest 20), limits };
 *                                       other guild/unknown → 404.
 * PATCH  /api/v1/watches/:id           body { name?, intervalSec?, sweepSec?, channelId?, pingRoleId?, paused?,
 *                                       checks?: { <ToggleKey>: boolean } } (⚙️ Settings + 🧩 Features + Pause)
 *                                     → 200 ApiManageResult; 409 `name_taken`.
 * DELETE /api/v1/watches/:id           → 200 { deleted: true } (store.deleteWatch + monitor.onWatchRemoved; Discord gets
 *                                       "➖ **<name>** was removed from **<label>**").
 * POST   /api/v1/watches/:id/check     body { full?: boolean } → 200 { alerts: <n>, kinds: string[], error: string|null }
 *                                       (monitor.checkNow, max 60 s → 504 `timeout`).
 * POST   /api/v1/watches/:id/pause     → 200 ApiManageResult (desired state: a second call changes nothing).
 * POST   /api/v1/watches/:id/resume    → 200 ApiManageResult.
 * GET    /api/v1/watches/:id/rules     → 200 { rules: ApiRules, limits }
 * PATCH  /api/v1/watches/:id/rules     body { ignorePatterns?, excludePatterns?, extraUrls? (each a replacement array or
 *                                       { add?, remove? }), scopePath?, maxPages? } (🚫 Rules)
 *                                     → 200 ApiManageResult & { rules }; 400 `invalid_pattern` / `invalid_url`.
 * GET    /api/v1/watches/:id/pages?list=tracked|untracked|files&limit=<1..500, 100>&offset=<n>
 *                                     → 200 { counts, list, total, pages: ApiPage[], nextOffset }
 * GET    /api/v1/watches/:id/subdomains?limit=<1..1000, 200>&offset=<n>
 *                                     → 200 { enabled, rootDomain, known, live, total, subdomains: ApiSubdomain[], nextOffset }
 * PATCH  /api/v1/watches/:id/subdomains body { enabled: boolean } → 200 ApiManageResult.
 * POST   /api/v1/watches/:id/subdomains/watch body { host } → 201 { created: true, watch } (inherits the parent's settings,
 *                                       subdomains off; first scan + Discord notices as for POST /watches) / 200
 *                                       { created: false, watch } when already watched; 400 `invalid_url`; 409 `limit_reached`.
 * GET    /api/v1/watches/:id/history?limit=<1..100, 25>&before=<event id>
 *                                     → 200 { events: ApiEvent[] (newest first), nextBefore }
 * GET    /api/v1/guild                 → 200 ApiGuildInfo (alert channels and roles of the token's server, from the gateway
 *                                       cache); 503 `unavailable` while Discord isn't ready.
 * GET    /api/v1/events?since=<id>&limit=<1..200, default 50>
 *                                     → 200 { events: ApiEvent[] (oldest first, id > since), nextSince: <last id or since> }
 *                                       — clients poll this to mirror alerts.
 *
 * Implementation notes (beyond the contract):
 * - Route → method → auth → rate limit → body. 405 answers carry `Allow`; 429 answers carry `Retry-After`, which is also
 *   exposed to browser callers (Access-Control-Expose-Headers).
 * - 503 `unavailable` + Retry-After: 5 while the monitor has not started yet (every route that writes or checks needs it),
 *   and when a request needs Discord's guild cache (channel / role checks, /guild) before it is ready.
 * - 408 `timeout` when a request body does not arrive within BODY_TIMEOUT_MS.
 * - At most MAX_CONCURRENT_SCANS scans run at once across all tokens (they share the bot's outbound HTTP budget with the
 *   monitor); beyond that → 429 `rate_limited` with a short Retry-After.
 * - Concurrent /check calls for the same watch share one run.
 * - 500 `internal_error` for anything unexpected. Internal error text (stack traces, SQLite, scanner bugs) is logged, never
 *   sent: a scan that crashes answers 502 with a generic message, a check that crashes answers 200 with a generic `error`.
 * - The add path reuses the /watch add helpers (prepareAdd: synchronous duplicate check + insert, so a double-click can
 *   never create two watches).
 * - Management writes reuse the dashboard's rules (cleanName / nameTaken, validatePattern via validateNewPatterns,
 *   resolveExtraPages, parseScope, the FEATURE_TOGGLES switches, addSubdomainWatch). A request is validated completely
 *   before anything is written (no await in between), then the watch is written once (store.updateWatch, preceded by
 *   store.resetPageNoise when ignore patterns change) and monitor.onWatchUpdated re-baselines what changed silently.
 *   A request that changes nothing writes nothing. Management routes never start a check.
 */
import type http from 'node:http';
import type { Config } from '../config.js';
import type { LinkToken, PageSummary, Store } from '../db/store.js';
import type { Monitor, TickSummary, BaselineSummary } from '../monitor/scheduler.js';
import {
  DEFAULT_FEATURES,
  type EventRecord,
  type Logger,
  type SubdomainRecord,
  type Watch,
  type WatchFeatures,
  type WatchPatch,
  type WatchState,
} from '../types.js';
import { compileUrlPattern, parseWatchInput, urlPath } from '../extract/url.js';
import { isWalledOff } from '../monitor/status.js';
import {
  FEATURE_TOGGLES,
  ListEntryError,
  MAX_EXTRA_URLS,
  MAX_INTERVAL_SEC,
  MAX_NAME_CHARS,
  MAX_PAGES_LIMIT,
  MAX_PATTERN_CHARS,
  MAX_PATTERNS,
  MAX_SCOPE_CHARS,
  SWEEP_MAX_SEC,
  SWEEP_MIN_SEC,
  UserError,
  WatchLimitError,
  addSubdomainWatch,
  channelMention,
  cleanName,
  ctNote,
  defaultInterval,
  errMessage,
  minInterval,
  nameOf,
  nameTaken,
  notifyUpdated,
  parseScope,
  prepareAdd,
  resolveExtraPages,
  resolvePageUrl,
  safeState,
  siteStatus,
  startWatch,
  subdomainTarget,
  toggleValue,
  validateNewPatterns,
  withDeadline,
  type CommandDeps,
  type ToggleKey as PanelToggleKey,
} from '../discord/commands.js';
import { escapeMarkdown, truncate } from '../discord/format.js';
import { APP_VERSION } from '../version.js';
import { ScanInputError, isPrivateTarget, privateTargetMessage, scanSite, type ScanDeps } from './scan.js';
import {
  LINK_API_PREFIX,
  type ApiCard,
  type ApiEvent,
  type ApiGuildInfo,
  type ApiLimits,
  type ApiManageResult,
  type ApiPage,
  type ApiRules,
  type ApiServerSummary,
  type ApiSubdomain,
  type ApiWatch,
  type ScanResult,
  type ToggleKey,
} from './types.js';

/** Discord's view of one server for the Link API: from the gateway cache only, never REST. */
export interface GuildSnapshot {
  guild: { id: string; name: string };
  /** Text and announcement channels (what can be picked as an alert channel), in Discord's display order. */
  channels: ApiGuildInfo['channels'];
  /** Highest first, @everyone (id = the guild id) last. */
  roles: ApiGuildInfo['roles'];
  /** Other cached channels alerts may already go to (threads, chats of voice channels); never offered as a new choice. */
  otherChannels?: Array<{ id: string; name: string; missing: string[] }>;
}

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
  /**
   * The server's channels and roles (synchronous, gateway cache only). null, a throw or an absent dep mean "unknown":
   * channel / role changes and GET /guild then answer 503, and cards show channelName: null, canPost: null.
   */
  guildInfo?: (guildId: string) => GuildSnapshot | null;
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
const PAGES_DEFAULT_LIMIT = 100;
const PAGES_MAX_LIMIT = 500;
const SUBDOMAINS_DEFAULT_LIMIT = 200;
const SUBDOMAINS_MAX_LIMIT = 1000;
const HISTORY_DEFAULT_LIMIT = 25;
const HISTORY_MAX_LIMIT = 100;
/** One extra page entry, as sent. */
const MAX_EXTRA_URL_CHARS = 2000;
/** Retry-After for "not ready yet" 503s. */
const NOT_READY_RETRY_SEC = '5';

type LimitClass = 'all' | 'scan' | 'add' | 'manage';
const LIMITS: Record<LimitClass, { capacity: number; windowMs: number }> = {
  all: { capacity: 120, windowMs: 60_000 },
  scan: { capacity: 20, windowMs: 10 * 60_000 },
  add: { capacity: 30, windowMs: 3600_000 },
  manage: { capacity: 60, windowMs: 10 * 60_000 },
};

const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, X-Link-Token',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-max-age': '600',
  'access-control-expose-headers': 'Retry-After',
};

const SUBDOMAIN_MODES = new Set(['none', 'quick', 'full']);
const FEATURE_KEYS = Object.keys(DEFAULT_FEATURES) as Array<keyof WatchFeatures>;
const TOGGLE_KEYS: ReadonlySet<string> = new Set(FEATURE_TOGGLES.map((t) => t.key));
const SETTINGS_FIELDS = ['name', 'intervalSec', 'sweepSec', 'channelId', 'pingRoleId', 'paused', 'checks'] as const;
const RULES_FIELDS = ['ignorePatterns', 'excludePatterns', 'extraUrls', 'scopePath', 'maxPages'] as const;
const PAGE_LISTS = {
  tracked: { kind: 'page', tracked: true },
  untracked: { kind: 'page', tracked: false },
  files: { kind: 'file' },
} as const;
const STATUS_ORDER = ['up', 'down', 'blocked', 'paused', 'scanning'] as const;
type StatusKey = (typeof STATUS_ORDER)[number];

/** The API's ToggleKey (types.ts) must stay the dashboard's: this fails to compile when they drift apart. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const TOGGLE_KEYS_IN_SYNC: Same<ToggleKey, PanelToggleKey> = true;
void TOGGLE_KEYS_IN_SYNC;

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
    /** JSON path into the request body of the value that failed validation. */
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 400 with a `field`. */
function bad(code: string, message: string, field?: string): ApiError {
  return new ApiError(400, code, message, {}, field);
}

/** A UserError from the shared validators → 400 `code` with its message as plain text; anything else is rethrown. */
function userError(err: unknown, code: string, field?: string): ApiError {
  if (err instanceof UserError) return bad(code, plain(err.message), field);
  throw err;
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

function sendError(res: http.ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}, field?: string): void {
  sendJson(res, status, { error: { code, message, ...(field ? { field } : {}) } }, headers);
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

/** Strict bodies: a key outside `allowed` → 400 bad_request naming it. */
function strictKeys(body: Record<string, unknown>, allowed: readonly string[], prefix = ''): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw bad('bad_request', `Unknown field ${prefix}${key}.`, `${prefix}${key}`);
  }
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

/** `limit` query value clamped to 1..max (default when absent). */
function limitParam(params: URLSearchParams, def: number, max: number): number {
  const raw = intParam(params, 'limit');
  return raw === null ? def : Math.min(max, Math.max(1, raw));
}

/** A JSON number of seconds (finite, > 0), rounded and clamped to [min, max]; null when it isn't one. */
function seconds(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return Math.min(max, Math.max(min, Math.round(v)));
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

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, n) => v === b[n]);

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Same precedence as the dashboard's siteStatus(): paused > first scan pending > down > blocked > up. */
function apiStatus(w: Watch, state: Pick<WatchState, 'status'> | null): StatusKey {
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

function toApiPage(p: PageSummary): ApiPage {
  return {
    url: p.url,
    path: urlPath(p.url),
    title: p.title ?? null,
    kind: p.kind,
    tracked: p.tracked,
    gone: p.gone,
    dynamic: p.dynamic,
    status: p.status ?? null,
    source: p.source,
    depth: p.depth,
    firstSeen: p.firstSeen,
    lastChecked: p.lastChecked > 0 ? p.lastChecked : null,
    lastChanged: p.lastChanged ?? null,
    contentType: p.contentType ?? null,
    contentLength: p.contentLength ?? null,
  };
}

function toApiSubdomain(s: SubdomainRecord, watchedAs: { id: number; name: string } | null): ApiSubdomain {
  return {
    host: s.host,
    sources: [...s.sources],
    alive: s.alive,
    firstSeen: s.firstSeen,
    lastSeen: s.lastSeen,
    dns: s.dns ? { a: [...s.dns.a], aaaa: [...s.dns.aaaa], cname: [...s.dns.cname] } : null,
    http: s.http ? { status: s.http.status, title: s.http.title, finalUrl: s.http.finalUrl, server: s.http.server } : null,
    watchedAs,
  };
}

function rulesOf(w: Watch): ApiRules {
  return {
    ignorePatterns: [...w.ignorePatterns],
    excludePatterns: [...w.excludePatterns],
    extraUrls: [...w.extraUrls],
    scopePath: w.scopePath ?? null,
    maxPages: w.maxPages,
  };
}

/** A channel the bot knows in this server (name + missing permissions); null when the cache doesn't know it. */
function channelIn(g: GuildSnapshot | null, id: string): { name: string; missing: string[] } | null {
  if (!g) return null;
  const c = g.channels.find((x) => x.id === id) ?? g.otherChannels?.find((x) => x.id === id);
  return c ? { name: c.name, missing: [...c.missing] } : null;
}

/** "#name" for plain-text messages, the raw id when the name is unknown. */
function channelLabel(g: GuildSnapshot | null, id: string): string {
  const c = channelIn(g, id);
  return c ? `#${c.name}` : id;
}

/** Can alerts reach `channelId`? Unknown (null) without Discord's cache. */
function delivery(g: GuildSnapshot | null, channelId: string): { name: string | null; canPost: boolean | null; missing: string[] } {
  if (!g) return { name: null, canPost: null, missing: [] };
  const c = channelIn(g, channelId);
  if (c) return { name: c.name, canPost: c.missing.length === 0, missing: c.missing };
  // The gateway caches every channel: one missing from a populated cache was deleted (as missingChannelPerms judges it).
  const populated = g.channels.length + (g.otherChannels?.length ?? 0) > 0;
  return populated ? { name: null, canPost: false, missing: ['channel not found'] } : { name: null, canPost: null, missing: [] };
}

/** Plain-text twin of permsWarning(). */
function deliveryWarning(label: string, missing: string[]): string | null {
  if (missing.includes('channel not found')) {
    return `The alert channel ${label} no longer exists — alerts can't be delivered. Pick another channel in Settings.`;
  }
  return missing.length ? `I'm missing ${missing.join(', ')} in ${label} — alerts can't be delivered until that's fixed.` : null;
}

function pingOf(w: Watch, g: GuildSnapshot | null): Pick<ApiCard['alerts'], 'ping' | 'pingRoleId' | 'pingRoleName'> {
  if (!w.pingRoleId) return { ping: 'none', pingRoleId: null, pingRoleName: null };
  if (w.pingRoleId === w.guildId) return { ping: 'everyone', pingRoleId: w.pingRoleId, pingRoleName: '@everyone' };
  return { ping: 'role', pingRoleId: w.pingRoleId, pingRoleName: g?.roles.find((r) => r.id === w.pingRoleId)?.name ?? null };
}

/** Root-URL watches of a guild by host (what store.findWatchByUrl(guild, "<host>/") would find), https preferred. */
function rootWatches(watches: Watch[]): Map<string, Watch> {
  const out = new Map<string, Watch>();
  for (const w of watches) {
    let u: URL;
    try {
      u = new URL(w.url);
    } catch {
      continue;
    }
    if (u.pathname.replace(/\/{2,}/g, '/') !== '/' || u.search) continue;
    const key = u.host.toLowerCase().replace(/\.$/, '');
    const seen = out.get(key);
    if (!seen || (!seen.url.toLowerCase().startsWith('https:') && w.url.toLowerCase().startsWith('https:'))) out.set(key, w);
  }
  return out;
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

type RouteName =
  | 'ping'
  | 'scan'
  | 'watches'
  | 'watch'
  | 'check'
  | 'events'
  | 'guild'
  | 'pause'
  | 'resume'
  | 'rules'
  | 'pages'
  | 'subdomains'
  | 'watchSubdomain'
  | 'history';
interface Route {
  name: RouteName;
  methods: string[];
  id?: string;
}

const WATCH_SUBROUTES: Record<string, { name: RouteName; methods: string[] }> = {
  check: { name: 'check', methods: ['POST'] },
  pause: { name: 'pause', methods: ['POST'] },
  resume: { name: 'resume', methods: ['POST'] },
  rules: { name: 'rules', methods: ['GET', 'PATCH'] },
  pages: { name: 'pages', methods: ['GET'] },
  subdomains: { name: 'subdomains', methods: ['GET', 'PATCH'] },
  'subdomains/watch': { name: 'watchSubdomain', methods: ['POST'] },
  history: { name: 'history', methods: ['GET'] },
};

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
    case '/guild':
      return { name: 'guild', methods: ['GET'] };
  }
  let m = /^\/watches\/([^/]+)$/.exec(sub);
  if (m) return { name: 'watch', methods: ['GET', 'PATCH', 'DELETE'], id: m[1] };
  m = /^\/watches\/([^/]+)\/(check|pause|resume|rules|pages|subdomains|subdomains\/watch|history)$/.exec(sub);
  if (m) return { ...WATCH_SUBROUTES[m[2]], id: m[1] };
  return null;
}

/** "GET", "GET or POST", "GET, PATCH or DELETE". */
function methodList(methods: string[]): string {
  return methods.length > 1 ? `${methods.slice(0, -1).join(', ')} or ${methods[methods.length - 1]}` : methods.join('');
}

/** The extra rate-limit classes of a request (every request also takes from `all`). */
function limitClasses(route: Route, method: string): LimitClass[] {
  if (route.name === 'scan') return ['scan'];
  if ((route.name === 'watches' && method === 'POST') || route.name === 'watchSubdomain') return ['add'];
  if (route.name === 'pause' || route.name === 'resume') return ['manage'];
  if (method === 'PATCH' && (route.name === 'watch' || route.name === 'rules' || route.name === 'subdomains')) return ['manage'];
  return [];
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

/** A validated change to a watch: what to write and how to describe it. */
interface Plan {
  patch: WatchPatch;
  changed: string[];
  parts: string[];
  warnings: string[];
}

type ListField = 'ignorePatterns' | 'excludePatterns' | 'extraUrls';
/** One entry of an edited list and where it came from in the request (null = kept from the current list). */
interface ListEntry {
  value: string;
  field: string | null;
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
    if (!monitor) {
      throw new ApiError(503, 'unavailable', 'The bot is still starting — try again in a few seconds.', { 'retry-after': NOT_READY_RETRY_SEC });
    }
    return monitor;
  };

  /** SSRF guard for outside callers: no localhost / private IPs / *.internal (Railway's private network) targets. */
  const refusePrivate = (host: string, field?: string): void => {
    if (config.allowPrivateNetwork !== true && isPrivateTarget(host)) {
      throw new ApiError(400, 'invalid_url', privateTargetMessage(host), {}, field);
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

  /** Discord's view of the token's server; null when unknown (no dep, not ready, not cached, or it threw). */
  const guildOf = (guildId: string): GuildSnapshot | null => {
    if (!deps.guildInfo) return null;
    try {
      const g = deps.guildInfo(guildId);
      return g && g.guild?.id === guildId && Array.isArray(g.channels) && Array.isArray(g.roles) ? g : null;
    } catch (err) {
      log.debug('link: guild info unavailable', { guild: guildId, err: errMessage(err) });
      return null;
    }
  };

  const requireGuild = (guildId: string): GuildSnapshot => {
    const g = guildOf(guildId);
    if (!g) throw new ApiError(503, 'unavailable', "Discord isn't ready yet — try again in a few seconds.", { 'retry-after': NOT_READY_RETRY_SEC });
    return g;
  };

  /** A text or announcement channel of the server (what Settings' channel select offers), else 400 invalid_channel. */
  const alertChannel = (guildId: string, raw: unknown, field: string): ApiGuildInfo['channels'][number] => {
    if (typeof raw !== 'string') throw bad('bad_request', `${field} must be a channel id.`, field);
    const c = requireGuild(guildId).channels.find((x) => x.id === raw);
    if (!c) throw bad('invalid_channel', 'That is not a text or announcement channel of this Discord server.', field);
    return c;
  };

  /** A role of the server (the guild id = @everyone), else 400 invalid_role. Returns its display name. */
  const pingRole = (guildId: string, raw: string, field: string): string => {
    if (raw === guildId) return '@everyone';
    const r = requireGuild(guildId).roles.find((x) => x.id === raw);
    if (!r) throw bad('invalid_role', 'That is not a role of this Discord server.', field);
    return `@${r.name}`;
  };

  const ownWatch = (route: Route, token: LinkToken): Watch => {
    const id = parseId(route.id ?? '');
    const w = id === null ? undefined : store.getWatch(id);
    if (!w || w.guildId !== token.guildId) throw new ApiError(404, 'not_found', 'Unknown watch.');
    return w;
  };

  const audit = (token: LinkToken, action: string, meta: Record<string, unknown> = {}) =>
    log.info(`link: ${action}`, { label: token.label, guild: token.guildId, action, ...meta });

  const limits = (): ApiLimits => {
    const max = config.maxWatchesPerGuild;
    return {
      minIntervalSec: minInterval(config),
      maxIntervalSec: MAX_INTERVAL_SEC,
      sweepMinSec: SWEEP_MIN_SEC,
      sweepMaxSec: SWEEP_MAX_SEC,
      maxPagesLimit: MAX_PAGES_LIMIT,
      maxPatterns: MAX_PATTERNS,
      maxPatternChars: MAX_PATTERN_CHARS,
      maxExtraUrls: MAX_EXTRA_URLS,
      maxScopeChars: MAX_SCOPE_CHARS,
      maxNameChars: MAX_NAME_CHARS,
      maxWatches: typeof max === 'number' && max > 0 ? max : 0,
    };
  };

  /** The Discord site card (renderSiteInfo) as data; reads counts with aggregate queries, never page text. */
  const cardOf = (w: Watch, g: GuildSnapshot | null): ApiCard => {
    const state = safeState(store, w.id);
    const down = Boolean(state && !w.paused && !state.status.up);
    let pages = { tracked: 0, known: 0, files: 0, gone: 0, dynamic: 0 };
    let subs = { known: 0, live: 0 };
    try {
      pages = store.pageStats(w.id);
      subs = store.subdomainStats(w.id);
    } catch (err) {
      log.debug('link: card counts failed', { watchId: w.id, err: errMessage(err) });
    }
    const deploy = state?.deploy ?? null;
    const d = delivery(g, w.channelId);
    const warnings: string[] = [];
    const dw = deliveryWarning(d.name ? `#${d.name}` : w.channelId, d.missing);
    if (dw) warnings.push(dw);
    if (w.features.subdomains) {
      const ct = ctNote({ store, config }).replace(/^\s*⚠️\s*/, '').trim();
      if (ct) warnings.push(ct);
    }
    let runtime: ApiCard['runtime'] = null;
    const monitor = deps.getMonitor();
    if (monitor) {
      try {
        const rt = monitor.runtimeInfo(w.id);
        runtime = {
          running: Boolean(rt.running),
          baselineRunning: Boolean(rt.baselineRunning),
          lastTickAt: rt.lastTickAt ?? null,
          lastTickMs: rt.lastTickMs ?? null,
          nextTickAt: rt.nextTickAt ?? null,
        };
      } catch (err) {
        log.debug('link: runtimeInfo failed', { watchId: w.id, err: errMessage(err) });
      }
    }
    return {
      id: w.id,
      name: w.name,
      url: w.url,
      host: w.host,
      rootDomain: w.rootDomain,
      status: apiStatus(w, state),
      statusLabel: siteStatus(w, state).label,
      downSince: down ? (state?.status.downSince ?? null) : null,
      downError: down ? (state?.status.lastError ?? null) : null,
      lastCheckAt: state && state.lastCheckAt > 0 ? state.lastCheckAt : null,
      lastChangeAt: state && state.lastChangeAt > 0 ? state.lastChangeAt : null,
      schedule: { intervalSec: w.intervalSec, sweepSec: w.sweepSec },
      alerts: { channelId: w.channelId, channelName: d.name, canPost: d.canPost, missing: d.missing, ...pingOf(w, g) },
      build: deploy ? { id: deploy.buildId ?? null, bundles: deploy.assets.length, generator: deploy.generator ?? null } : null,
      pages: { tracked: pages.tracked, maxPages: w.maxPages, known: pages.known, files: pages.files, gone: pages.gone, dynamic: pages.dynamic },
      subdomains: { enabled: Boolean(w.features.subdomains), known: subs.known, live: subs.live },
      rules: {
        ignorePatterns: w.ignorePatterns.length,
        excludePatterns: w.excludePatterns.length,
        extraUrls: w.extraUrls.length,
        scopePath: w.scopePath ?? null,
      },
      checks: FEATURE_TOGGLES.map((t) => ({ key: t.key, label: t.label, emoji: t.emoji, hint: t.hint, on: toggleValue(w, t.key) })),
      runtime,
      lastError: state?.lastError ?? null,
      warnings,
      createdAt: w.createdAt,
    };
  };

  /** The dashboard's head line and counts, over every watch of the guild. */
  const summaryOf = (all: Watch[], g: GuildSnapshot | null): ApiServerSummary => {
    const counts: ApiServerSummary['counts'] = { up: 0, down: 0, blocked: 0, paused: 0, scanning: 0 };
    for (const w of all) counts[apiStatus(w, safeState(store, w.id))]++;
    const perChannel = new Map<string, number>();
    for (const w of all) perChannel.set(w.channelId, (perChannel.get(w.channelId) ?? 0) + 1);
    const channels = [...perChannel]
      .map(([id, watches]) => ({ id, name: channelIn(g, id)?.name ?? null, watches }))
      .sort((a, b) => b.watches - a.watches);
    let text = 'No sites yet.';
    if (all.length) {
      const where = channels.length === 1 ? `alerts in ${channelLabel(g, channels[0].id)}` : `alerts in ${channels.length} channels`;
      const tally = STATUS_ORDER.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`);
      text = [`Watching ${plural(all.length, 'site')}`, where, ...tally].join(' · ');
    }
    return { total: all.length, limit: limits().maxWatches, counts, channels, text };
  };

  const manageResult = (w: Watch, changed: string[], message: string, warnings: string[]): ApiManageResult => ({
    changed,
    message,
    warnings,
    watch: toApiWatch(store, w),
    card: cardOf(w, guildOf(w.guildId)),
  });

  /** The one write of a management request: store.updateWatch, then the monitor re-baselines what changed silently. */
  const commit = (w: Watch, patch: WatchPatch, monitor: Monitor): Watch => {
    const updated = store.updateWatch(w.id, patch);
    notifyUpdated({ store, config, log, monitor }, updated);
    return updated;
  };

  /** Discord notices for a pause / resume and for moved alerts (other changes are quiet, like the dashboard's). */
  const announceChanges = (before: Watch, after: Watch, token: LinkToken): void => {
    const by = escapeMarkdown(token.label);
    void (async () => {
      if (after.channelId !== before.channelId) {
        await announce(
          after.channelId,
          `📢 Alerts for **${nameOf(after)}** (<${after.url}>) now post here — moved from ${channelMention(before.channelId)} by **${by}**.`,
        );
      }
      if (after.paused !== before.paused) {
        await announce(after.channelId, after.paused ? `⏸️ **${nameOf(after)}** was paused from **${by}**.` : `▶️ **${nameOf(after)}** was resumed from **${by}**.`);
      }
    })();
  };

  /** Validates a ⚙️ Settings / 🧩 Features / pause body against `w`; writes nothing. */
  const planSettings = (w: Watch, body: Record<string, unknown>): Plan => {
    strictKeys(body, SETTINGS_FIELDS);
    const plan: Plan = { patch: {}, changed: [], parts: [], warnings: [] };
    const { patch, changed, parts, warnings } = plan;

    if (body.name !== undefined) {
      if (typeof body.name !== 'string') throw bad('bad_request', 'name must be a string.', 'name');
      let name: string;
      try {
        name = cleanName(body.name) as string;
      } catch (err) {
        throw userError(err, 'bad_request', 'name');
      }
      if (name !== w.name) {
        if (nameTaken({ store }, w.guildId, name, w.id)) {
          throw new ApiError(409, 'name_taken', `A site named ${name} already exists in this server. Pick another name.`, {}, 'name');
        }
        patch.name = name;
        changed.push('name');
        parts.push(`name → ${name}`);
      }
    }
    if (body.intervalSec !== undefined) {
      const min = minInterval(config);
      const v = seconds(body.intervalSec, min, MAX_INTERVAL_SEC);
      if (v === null) throw bad('invalid_interval', `intervalSec must be a number of seconds (${min}–${MAX_INTERVAL_SEC}).`, 'intervalSec');
      if (v !== w.intervalSec) {
        patch.intervalSec = v;
        changed.push('intervalSec');
        parts.push(`interval ${w.intervalSec}s → ${v}s`);
      }
    }
    if (body.sweepSec !== undefined) {
      const v = seconds(body.sweepSec, SWEEP_MIN_SEC, SWEEP_MAX_SEC);
      if (v === null) throw bad('invalid_interval', `sweepSec must be a number of seconds (${SWEEP_MIN_SEC}–${SWEEP_MAX_SEC}).`, 'sweepSec');
      if (v !== w.sweepSec) {
        patch.sweepSec = v;
        changed.push('sweepSec');
        parts.push(`full sweep ${w.sweepSec}s → ${v}s`);
      }
    }
    if (body.channelId !== undefined && body.channelId !== w.channelId) {
      const c = alertChannel(w.guildId, body.channelId, 'channelId');
      patch.channelId = c.id;
      changed.push('channelId');
      parts.push(`channel → #${c.name}`);
      const dw = deliveryWarning(`#${c.name}`, c.missing);
      if (dw) warnings.push(dw);
    }
    if (body.pingRoleId !== undefined) {
      const raw = body.pingRoleId;
      if (raw !== null && typeof raw !== 'string') throw bad('bad_request', 'pingRoleId must be a role id, or null for no ping.', 'pingRoleId');
      if (raw !== w.pingRoleId) {
        const label = raw === null ? 'none' : pingRole(w.guildId, raw, 'pingRoleId');
        patch.pingRoleId = raw;
        changed.push('pingRoleId');
        parts.push(`ping → ${label}`);
      }
    }
    if (body.paused !== undefined) {
      if (typeof body.paused !== 'boolean') throw bad('bad_request', 'paused must be true or false.', 'paused');
      if (body.paused !== w.paused) {
        patch.paused = body.paused;
        changed.push('paused');
        parts.push(body.paused ? 'paused' : 'resumed');
      }
    }
    if (body.checks !== undefined) {
      const checks = body.checks;
      if (!isPlainObject(checks)) throw bad('bad_request', 'checks must be an object of true/false switches.', 'checks');
      for (const [key, v] of Object.entries(checks)) {
        if (!TOGGLE_KEYS.has(key)) throw bad('bad_request', `Unknown check ${key}.`, `checks.${key}`);
        if (typeof v !== 'boolean') throw bad('bad_request', `checks.${key} must be true or false.`, `checks.${key}`);
      }
      for (const t of FEATURE_TOGGLES) {
        const on = checks[t.key];
        if (typeof on !== 'boolean' || on === toggleValue(w, t.key)) continue;
        // "Ignore numbers" is watch.maskNumbers; the rest are features (merged by store.updateWatch).
        if (t.key === 'maskNumbers') patch.maskNumbers = on;
        else patch.features = { ...patch.features, [t.key as keyof WatchFeatures]: on };
        changed.push(`checks.${t.key}`);
        parts.push(`${t.label} ${on ? 'on' : 'off'}`);
        if (t.key === 'subdomains' && on) {
          const owner = store.listWatches(w.guildId).find((o) => o.id !== w.id && o.rootDomain === w.rootDomain && o.features.subdomains);
          if (owner) {
            warnings.push(`Subdomains of ${w.rootDomain} are already tracked by #${owner.id} ${owner.name} — new subdomains will be announced twice.`);
          }
        }
      }
    }
    return plan;
  };

  /** Writes a settings plan (or nothing) and describes the outcome. */
  const applySettings = (w: Watch, plan: Plan, token: LinkToken, monitor: Monitor, action: string): ApiManageResult => {
    if (!plan.changed.length) return manageResult(w, [], 'Nothing changed.', []);
    const updated = commit(w, plan.patch, monitor);
    audit(token, action, { watchId: w.id, changes: plan.changed });
    announceChanges(w, updated, token);
    return manageResult(updated, plan.changed, `Saved — ${plan.parts.join(' · ')}`, plan.warnings);
  };

  /**
   * An edited list from a PATCH body: a replacement array (trimmed, empties dropped, duplicates removed keeping the first)
   * or { add?, remove? } applied to `current` (remove first, by `removeKeys` of each trimmed entry; then add, skipping
   * duplicates).
   */
  const listFrom = (key: ListField, raw: unknown, current: string[], removeKeys: (entry: string) => Array<string | null>): ListEntry[] => {
    const strings = (v: unknown, path: string): string[] => {
      if (!Array.isArray(v)) throw bad('bad_request', `${path} must be a list of strings.`, path);
      v.forEach((s, n) => {
        if (typeof s !== 'string') throw bad('bad_request', `${path}[${n}] must be a string.`, `${path}[${n}]`);
      });
      return v as string[];
    };
    const append = (out: ListEntry[], list: string[], path: string) =>
      list.forEach((s, n) => {
        const value = s.trim();
        if (value && !out.some((e) => e.value === value)) out.push({ value, field: `${path}[${n}]` });
      });
    if (Array.isArray(raw)) {
      const out: ListEntry[] = [];
      append(out, strings(raw, key), key);
      return out;
    }
    if (!isPlainObject(raw)) throw bad('bad_request', `${key} must be a list of strings, or { add, remove }.`, key);
    strictKeys(raw, ['add', 'remove'], `${key}.`);
    const remove = raw.remove === undefined ? [] : strings(raw.remove, `${key}.remove`);
    const add = raw.add === undefined ? [] : strings(raw.add, `${key}.add`);
    const drop = new Set<string>();
    for (const r of remove) for (const k of removeKeys(r.trim())) if (k) drop.add(k);
    const out: ListEntry[] = current.filter((v) => !drop.has(v)).map((value) => ({ value, field: null }));
    append(out, add, `${key}.add`);
    return out;
  };

  /** Validates a 🚫 Rules body against `w` exactly like the Rules modal; writes nothing. */
  const planRules = (w: Watch, body: Record<string, unknown>): Plan => {
    strictKeys(body, RULES_FIELDS);
    const plan: Plan = { patch: {}, changed: [], parts: [], warnings: [] };
    const { patch, changed, parts, warnings } = plan;

    for (const [key, kind] of [
      ['ignorePatterns', 'ignore'],
      ['excludePatterns', 'exclude'],
    ] as const) {
      if (body[key] === undefined) continue;
      const current = w[key];
      const entries = listFrom(key, body[key], current, (r) => [r]);
      const values = entries.map((e) => e.value);
      try {
        validateNewPatterns(values, current, kind);
      } catch (err) {
        if (err instanceof ListEntryError) throw bad('invalid_pattern', plain(err.message), err.index === null ? key : (entries[err.index]?.field ?? key));
        throw err;
      }
      if (sameList(values, current)) continue;
      patch[key] = values;
      changed.push(key);
      parts.push(kind === 'ignore' ? plural(values.length, 'ignore pattern') : plural(values.length, 'skipped URL pattern'));
      if (kind === 'exclude') {
        for (const p of values) {
          if (current.includes(p)) continue;
          try {
            if (compileUrlPattern(p)?.test(w.url)) warnings.push(`${p} also matches the start URL.`);
          } catch {
            // validated above
          }
        }
      }
    }
    if (body.extraUrls !== undefined) {
      const current = w.extraUrls;
      const entries = listFrom('extraUrls', body.extraUrls, current, (r) => [r, resolvePageUrl(r, w)]);
      for (const e of entries) {
        if (e.field && e.value.length > MAX_EXTRA_URL_CHARS) {
          throw bad('invalid_url', `An extra page can be at most ${MAX_EXTRA_URL_CHARS} characters long.`, e.field);
        }
      }
      let extra: string[];
      try {
        // New entries only: a private target added in Discord before stays (the bot's HTTP client still refuses it).
        extra = resolveExtraPages(
          entries.map((e) => e.value),
          w,
          (url, n) => {
            if (!current.includes(url)) refusePrivate(new URL(url).hostname, entries[n].field ?? 'extraUrls');
          },
        );
      } catch (err) {
        if (err instanceof ListEntryError) {
          throw err.index === null
            ? bad('bad_request', plain(err.message), 'extraUrls')
            : bad('invalid_url', plain(err.message), entries[err.index]?.field ?? 'extraUrls');
        }
        throw err;
      }
      if (!sameList(extra, current)) {
        patch.extraUrls = extra;
        changed.push('extraUrls');
        parts.push(plural(extra.length, 'extra page'));
      }
    }
    if (body.scopePath !== undefined) {
      const raw = body.scopePath;
      let scope: string | null = null;
      if (raw !== null) {
        if (typeof raw !== 'string') throw bad('bad_request', 'scopePath must be a path prefix like /docs, or null for the whole site.', 'scopePath');
        try {
          scope = parseScope(raw) ?? null;
        } catch (err) {
          throw userError(err, 'bad_request', 'scopePath');
        }
      }
      if (scope !== (w.scopePath ?? null)) {
        patch.scopePath = scope;
        changed.push('scopePath');
        parts.push(`scope ${scope ?? 'whole site'}`);
      }
    }
    if (body.maxPages !== undefined) {
      const v = body.maxPages;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_PAGES_LIMIT) {
        throw bad('bad_request', `maxPages must be a whole number between 1 and ${MAX_PAGES_LIMIT}.`, 'maxPages');
      }
      if (v !== w.maxPages) {
        patch.maxPages = v;
        changed.push('maxPages');
        parts.push(`max ${v} pages`);
      }
    }
    return plan;
  };

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
      limits: limits(),
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
    const all = store.listWatches(token.guildId);
    const rawUrl = query.get('url');
    let list = all;
    if (rawUrl !== null) {
      const parsed = parseWatchInput(rawUrl);
      if (!parsed) throw new ApiError(400, 'invalid_url', "That doesn't look like a website URL.");
      const key = stripScheme(parsed.url);
      const host = bareHost(parsed.host);
      list = all.filter((w) => stripScheme(w.url) === key || bareHost(w.host) === host);
    }
    const summary = summaryOf(all, guildOf(token.guildId));
    const watches = list.map((w) => toApiWatch(store, w));
    sendJson(res, 200, rawUrl === null ? { watches, summary } : { watches, watched: list.length > 0, summary });
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
      const v = seconds(body.intervalSec, minInterval(config), MAX_INTERVAL_SEC);
      if (v === null) {
        throw new ApiError(400, 'invalid_interval', `\`intervalSec\` must be a number of seconds (${minInterval(config)}–${MAX_INTERVAL_SEC}).`);
      }
      intervalSec = v;
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
    // Alert channel and ping role: from the token's server only (default: the token's channel, no ping).
    let channelId = token.channelId;
    if (body.channelId !== undefined && body.channelId !== null && body.channelId !== token.channelId) {
      channelId = alertChannel(token.guildId, body.channelId, 'channelId').id;
    }
    let pingRoleId: string | null = null;
    if (body.pingRoleId !== undefined && body.pingRoleId !== null) {
      if (typeof body.pingRoleId !== 'string') throw bad('bad_request', 'pingRoleId must be a role id, or null for no ping.', 'pingRoleId');
      pingRole(token.guildId, body.pingRoleId, 'pingRoleId');
      pingRoleId = body.pingRoleId;
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
        channelId,
        userId: `link:${token.label}`,
        url: parsed.url,
        name,
        intervalSec,
        pingRoleId,
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
    sendJson(res, 200, { watch: toApiWatch(store, w), card: cardOf(w, guildOf(w.guildId)), events, limits: limits() });
  };

  const patchWatch = ({ res, token, route, body }: Ctx) => {
    const w = ownWatch(route, token);
    const monitor = requireMonitor();
    sendJson(res, 200, applySettings(w, planSettings(w, body), token, monitor, 'update'));
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

  const check = async ({ res, token, route, body }: Ctx) => {
    const w = ownWatch(route, token);
    const monitor = requireMonitor();
    let full = false;
    if (body.full !== undefined && body.full !== null) {
      if (typeof body.full !== 'boolean') throw bad('bad_request', 'full must be true or false.', 'full');
      full = body.full;
    }
    audit(token, 'check', { watchId: w.id, url: w.url, full });
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
        started = monitor.checkNow(w.id, { full });
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

  /** POST /watches/:id/pause | resume: an explicit desired state, so a stale UI can't flip it the wrong way. */
  const setPaused = (paused: boolean) => ({ res, token, route, body }: Ctx) => {
    const w = ownWatch(route, token);
    const monitor = requireMonitor();
    strictKeys(body, []);
    if (w.paused === paused) {
      sendJson(res, 200, manageResult(w, [], `${w.name} is already ${paused ? 'paused' : 'running'}.`, []));
      return;
    }
    const updated = commit(w, { paused }, monitor);
    audit(token, paused ? 'pause' : 'resume', { watchId: w.id, changes: ['paused'] });
    announceChanges(w, updated, token);
    const message = paused ? `Paused ${w.name} — no checks until you resume it.` : `Resumed ${w.name}.`;
    sendJson(res, 200, manageResult(updated, ['paused'], message, []));
  };

  const getRules = ({ res, token, route }: Ctx) => {
    const w = ownWatch(route, token);
    sendJson(res, 200, { rules: rulesOf(w), limits: limits() });
  };

  const patchRules = ({ res, token, route, body }: Ctx) => {
    const w = ownWatch(route, token);
    const monitor = requireMonitor();
    const plan = planRules(w, body);
    if (!plan.changed.length) {
      sendJson(res, 200, { ...manageResult(w, [], 'Nothing changed.', []), rules: rulesOf(w) });
      return;
    }
    // Ignore patterns change the compared text: clear the noise heuristics so pages are re-judged under the new rules.
    if (plan.patch.ignorePatterns) store.resetPageNoise(w.id);
    const updated = commit(w, plan.patch, monitor);
    audit(token, 'rules', { watchId: w.id, changes: plan.changed });
    const message = `Rules saved — ${plan.parts.join(' · ')}. Affected pages are re-baselined silently.`;
    sendJson(res, 200, { ...manageResult(updated, plan.changed, message, plan.warnings), rules: rulesOf(updated) });
  };

  const listPages = ({ res, token, route, query }: Ctx) => {
    const w = ownWatch(route, token);
    const list = query.get('list') ?? 'tracked';
    if (!Object.hasOwn(PAGE_LISTS, list)) throw new ApiError(400, 'bad_request', '`list` must be "tracked", "untracked" or "files".');
    const filter = PAGE_LISTS[list as keyof typeof PAGE_LISTS];
    const limit = limitParam(query, PAGES_DEFAULT_LIMIT, PAGES_MAX_LIMIT);
    const offset = intParam(query, 'offset') ?? 0;
    const stats = store.pageStats(w.id);
    const total = list === 'tracked' ? stats.tracked : list === 'untracked' ? Math.max(0, stats.known - stats.tracked) : stats.files;
    const pages = store.listPageSummaries(w.id, { ...filter, limit, offset }).map(toApiPage);
    const end = offset + pages.length;
    sendJson(res, 200, {
      counts: { tracked: stats.tracked, maxPages: w.maxPages, known: stats.known, files: stats.files, gone: stats.gone, dynamic: stats.dynamic },
      list,
      total,
      pages,
      nextOffset: pages.length > 0 && end < total ? end : null,
    });
  };

  const listSubdomains = ({ res, token, route, query }: Ctx) => {
    const w = ownWatch(route, token);
    const limit = limitParam(query, SUBDOMAINS_DEFAULT_LIMIT, SUBDOMAINS_MAX_LIMIT);
    const offset = intParam(query, 'offset') ?? 0;
    // renderSubdomains' order: live first, then by host.
    const all = store.listSubdomains(w.id).sort((a, b) => Number(b.alive) - Number(a.alive) || a.host.localeCompare(b.host));
    const slice = all.slice(offset, offset + limit);
    const watched = rootWatches(store.listWatches(w.guildId));
    const end = offset + slice.length;
    sendJson(res, 200, {
      enabled: Boolean(w.features.subdomains),
      rootDomain: w.rootDomain,
      known: all.length,
      live: all.filter((s) => s.alive).length,
      total: all.length,
      subdomains: slice.map((s) => {
        const owner = watched.get(s.host.toLowerCase());
        return toApiSubdomain(s, owner ? { id: owner.id, name: owner.name } : null);
      }),
      nextOffset: slice.length > 0 && end < all.length ? end : null,
    });
  };

  const patchSubdomains = ({ res, token, route, body }: Ctx) => {
    const w = ownWatch(route, token);
    const monitor = requireMonitor();
    strictKeys(body, ['enabled']);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw bad('bad_request', 'enabled must be true or false.', 'enabled');
    const plan = planSettings(w, body.enabled === undefined ? {} : { checks: { subdomains: body.enabled } });
    sendJson(res, 200, applySettings(w, plan, token, monitor, 'subdomains'));
  };

  /** "Watch this subdomain" (the watchsub: alert button) as its own site. */
  const watchSubdomain = ({ res, token, route, body }: Ctx) => {
    const parent = ownWatch(route, token);
    const monitor = requireMonitor();
    strictKeys(body, ['host']);
    const target = typeof body.host === 'string' ? subdomainTarget(parent, body.host) : null;
    if (!target) throw bad('invalid_url', `That isn't a host name under ${parent.rootDomain}.`, 'host');
    refusePrivate(target.host, 'host');
    const cdeps: CommandDeps = { store, config, log, monitor };
    let added: { created: boolean; watch: Watch };
    try {
      added = addSubdomainWatch(cdeps, parent, target, `link:${token.label}`);
    } catch (err) {
      if (err instanceof WatchLimitError) throw new ApiError(409, 'limit_reached', plain(err.message));
      throw err;
    }
    if (!added.created) {
      sendJson(res, 200, { created: false, watch: toApiWatch(store, added.watch) });
      return;
    }
    const watch = added.watch;
    audit(token, 'add', { watchId: watch.id, url: watch.url, parent: parent.id });
    sendJson(res, 201, { created: true, watch: toApiWatch(store, watch) });
    const announced = announce(
      watch.channelId,
      `➕ **${nameOf(watch)}** (<${watch.url}>) was added from **${escapeMarkdown(token.label)}** — first scan running…`,
    );
    void firstScan(cdeps, watch, announced);
  };

  const history = ({ res, token, route, query }: Ctx) => {
    const w = ownWatch(route, token);
    const limit = limitParam(query, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);
    const before = intParam(query, 'before');
    const events = store.listEvents(w.id, limit, before).map((e) => toApiEvent(e, w));
    sendJson(res, 200, { events, nextBefore: events.length === limit ? events[events.length - 1].id : null });
  };

  const guild = ({ res, token }: Ctx) => {
    const g = requireGuild(token.guildId);
    const info: ApiGuildInfo = {
      guild: { id: g.guild.id, name: g.guild.name },
      tokenChannelId: token.channelId,
      channels: g.channels.map((c) => ({ id: c.id, name: c.name, type: c.type, category: c.category ?? null, canPost: c.canPost, missing: [...c.missing] })),
      roles: g.roles.map((r) => ({ id: r.id, name: r.name, everyone: r.everyone, managed: r.managed, color: r.color })),
    };
    sendJson(res, 200, info);
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

  const pause = setPaused(true);
  const resume = setPaused(false);

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
        return method === 'DELETE' ? deleteWatch(ctx) : method === 'PATCH' ? patchWatch(ctx) : getWatch(ctx);
      case 'check':
        return check(ctx);
      case 'pause':
        return pause(ctx);
      case 'resume':
        return resume(ctx);
      case 'rules':
        return method === 'PATCH' ? patchRules(ctx) : getRules(ctx);
      case 'pages':
        return listPages(ctx);
      case 'subdomains':
        return method === 'PATCH' ? patchSubdomains(ctx) : listSubdomains(ctx);
      case 'watchSubdomain':
        return watchSubdomain(ctx);
      case 'history':
        return history(ctx);
      case 'guild':
        return guild(ctx);
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
      throw new ApiError(405, 'method_not_allowed', `Use ${methodList(route.methods)} for this endpoint.`, {
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
    const retryAfter = limiter.take(token.id, ['all', ...limitClasses(route, method)], t);
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
    if (method === 'POST' || method === 'PATCH') {
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
      sendError(res, err.status, err.code, err.message, err.headers, err.field);
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
