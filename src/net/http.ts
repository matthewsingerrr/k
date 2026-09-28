/**
 * Outbound HTTP client used by every monitor.
 *
 * Requirements:
 * - Uses Node's global `fetch` (undici). Sends `User-Agent: opts.userAgent`, a browser-like `Accept`
 *   (default "text/html,application/xhtml+xml,application/xml;q=0.9,*\/*;q=0.8"), `Accept-Language: en-US,en;q=0.9`.
 * - Concurrency: a global Semaphore(globalConcurrency) AND a per-hostname KeyedLimiter(perHostConcurrency).
 * - Timeout per request via AbortController (`timeoutMs`, default client-level). Timeouts → status 0, error "timeout after Ns".
 * - Redirects are followed MANUALLY (redirect: 'manual'), max 8 hops. Each hop's URL is validated with `assertAllowedUrl`
 *   (http/https only; unless allowPrivate, hostname must not be/resolve to a private, loopback, link-local, CGNAT,
 *   multicast, unspecified or *.internal / *.local / localhost address — use `isPrivateAddress` from ./dns.js).
 *   A blocked hop → status 0, error "blocked private address ...".
 *   A 303, or a 301/302 on POST, switches to GET (we only ever GET/HEAD anyway).
 * - Conditional requests: if opts.etag → If-None-Match; if opts.lastModified → If-Modified-Since. 304 → notModified=true, body null.
 * - Body is read as a stream and capped at `maxBytes` (default client-level); if exceeded, stop reading, `truncated=true`.
 *   HEAD requests never read a body.
 * - `bodyText` is decoded for textual content types (text/*, *json*, *xml*, *javascript*, *ecmascript*, or missing content-type):
 *   charset from Content-Type (fallback utf-8, use TextDecoder with fatal:false; unknown charset → utf-8). Otherwise null.
 * - Bot-challenge detection → `blocked=true`: header `cf-mitigated: challenge`, or status 403/429/503 whose body contains
 *   one of "Just a moment...", "cf-browser-verification", "challenge-platform", "Attention Required! | Cloudflare",
 *   "DDoS protection by", "Checking your browser", "px-captcha", "_Incapsula_Resource", "captcha-delivery.com".
 * - Retries: network errors and 502/503/504 (non-blocked) are retried up to `retries` times (default 1) with 500ms*2^n backoff.
 *   429 is NOT retried (caller backs off) — `retryAfterMs` parsed from Retry-After (seconds or HTTP date) when present.
 * - Never throws for HTTP/network failures — always resolves a FetchResult. Only programmer errors (invalid URL string) may throw.
 * - headers: lowercase keys; multiple values joined with ", ".
 *
 * Implementation notes:
 * - The timeout covers the whole attempt: SSRF DNS check, every redirect hop and the body stream.
 * - Timeouts are not retried (the full budget was already spent; the next tick is the retry). Invalid URLs, unsupported
 *   protocols, blocked addresses and redirect problems are not retried either. Invalid URL strings resolve to status 0
 *   ("invalid URL") instead of throwing.
 * - A connection that dies mid-body yields status 0 (never a silently partial body, which would look like a content change).
 * - The per-host slot is acquired before the global one so requests queued for one slow host never hold global slots.
 * - In addition to the markers above, `x-vercel-mitigated: challenge`, `x-amzn-waf-action: challenge|captcha` and the
 *   "Vercel Security Checkpoint" page count as challenges.
 * - For HTML/XML without a Content-Type charset, a BOM or <meta charset>/<?xml encoding?> in the first 1024 bytes is honoured.
 * - SSRF is checked twice: checkUrl() before each hop (fast, clear errors, literal IPs) and again at connect time by a
 *   custom DNS lookup in the connection agent, which refuses private answers — so a name that resolves to a public
 *   address for the check and to a private one for the connection (DNS rebinding) is still blocked.
 * - Per-host backoff: a 429 (or a 503 with Retry-After) makes further requests to that host return a synthetic 429
 *   ("rate limited (backing off)") without touching the network until Retry-After has passed (else 1, 2, 4 … 30 min);
 *   a 2xx from the host ends it. `ignoreBackoff` requests (the homepage check) still go out, so recovery is noticed.
 * - Permanent same-origin redirects (301/308, e.g. "/docs" → "/docs/") of GET requests are remembered for an hour:
 *   later requests go straight to the target and still report redirected=true and finalUrl=target.
 * - "challenge-platform" only counts as a challenge marker outside Cloudflare's JavaScript-detections script
 *   (/cdn-cgi/challenge-platform/…/scripts/jsd/…), which Cloudflare injects into ordinary pages, error pages included.
 */

import net from 'node:net';
import dns, { type LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { KeyedLimiter, Semaphore, sleep } from './limiter.js';
import { isInternalHostname, isPrivateAddress } from './dns.js';

/** Resolves a hostname to all of its addresses (like dns.promises.lookup(host, { all: true })). */
export type LookupAll = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

type FetchImpl = (url: string, init: Record<string, unknown>) => Promise<Response>;

export interface HttpClientOptions {
  userAgent: string;
  globalConcurrency: number;
  perHostConcurrency: number;
  timeoutMs: number;
  maxBytes: number;
  allowPrivate: boolean;
  /** Clock for backoff and redirect-cache expiry (tests). Default Date.now. */
  now?: () => number;
  /** DNS resolver for the SSRF checks (tests). Default: the system resolver (dns.lookup). */
  lookup?: LookupAll;
  /** fetch implementation (tests). Default: undici's fetch. */
  fetch?: FetchImpl;
}

export interface FetchOptions {
  method?: 'GET' | 'HEAD';
  etag?: string | null;
  lastModified?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  accept?: string;
  headers?: Record<string, string>;
  /** Retries for network errors / 502 / 503 / 504. Default 1. */
  retries?: number;
  /** Override client-level allowPrivate for this request. */
  allowPrivate?: boolean;
  /** Send the request even while the host is backed off after a 429 (used for the one homepage check per interval). */
  ignoreBackoff?: boolean;
}

export interface FetchResult {
  /** The URL requested. */
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  /** HTTP status; 0 for network error / timeout / blocked private address. */
  status: number;
  /** status 200-299. */
  ok: boolean;
  notModified: boolean;
  redirected: boolean;
  headers: Record<string, string>;
  /** Lowercased media type without parameters, e.g. "text/html"; null if absent. */
  contentType: string | null;
  body: Buffer | null;
  bodyText: string | null;
  truncated: boolean;
  /** Anti-bot challenge / captcha page detected. */
  blocked: boolean;
  /** Parsed Retry-After in ms, if present. */
  retryAfterMs: number | null;
  /** Human-readable error for status 0 ("timeout after 20s", "ECONNREFUSED", "ENOTFOUND", "blocked private address 10.0.0.1"). */
  error: string | null;
  elapsedMs: number;
}

export const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
export const MAX_REDIRECTS = 8;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRY_STATUSES = new Set([502, 503, 504]);
const CHALLENGE_STATUSES = new Set([403, 429, 503]);
const CHALLENGE_MARKERS = [
  'Just a moment...',
  'cf-browser-verification',
  'challenge-platform',
  'Attention Required! | Cloudflare',
  'DDoS protection by',
  'Checking your browser',
  'px-captcha',
  '_Incapsula_Resource',
  'captcha-delivery.com',
  'Vercel Security Checkpoint',
];
const MAX_RETRY_AFTER_MS = 24 * 3600_000;
/** Longest per-host backoff after a 429 (a longer Retry-After is capped: the homepage check keeps probing anyway). */
export const MAX_BACKOFF_MS = 30 * 60_000;
const BACKOFF_STEP_MS = 60_000;
const BACKOFF_HOSTS_MAX = 2000;
const REDIRECT_CACHE_TTL_MS = 60 * 60_000;
const REDIRECT_CACHE_MAX = 5000;
const BACKOFF_BASE_MS = 500;
const MAX_RETRIES = 10;
/** Bytes of a redirect/304 body we are willing to read so the keep-alive connection can be reused. */
const DRAIN_LIMIT = 64 * 1024;
const MAX_ERROR_LENGTH = 200;

/** Internal failure with a ready-made message and whether another attempt could help. */
class RequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

interface AttemptOutcome {
  result: FetchResult;
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

/** Short-lived cache of per-hostname SSRF verdicts (only definite answers), sparing a getaddrinfo per request. */
const hostVerdicts = new Map<string, { until: number; blockedAddress: string | null }>();
const HOST_VERDICT_TTL_MS = 60_000;
const HOST_VERDICT_MAX = 2000;

function rememberVerdict(host: string, blockedAddress: string | null): void {
  if (hostVerdicts.size >= HOST_VERDICT_MAX) {
    const now = Date.now();
    for (const [k, v] of hostVerdicts) if (v.until <= now) hostVerdicts.delete(k);
    for (const k of hostVerdicts.keys()) {
      if (hostVerdicts.size < HOST_VERDICT_MAX) break;
      hostVerdicts.delete(k);
    }
  }
  hostVerdicts.set(host, { until: Date.now() + HOST_VERDICT_TTL_MS, blockedAddress });
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason ?? new Error('aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Error code of a connection refused by the connect-time SSRF lookup. */
const BLOCKED_CODE = 'EBLOCKEDPRIVATE';

function blockedError(address: string): Error {
  return Object.assign(new Error(`blocked private address ${address}`), { code: BLOCKED_CODE });
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

/**
 * DNS lookup for the connection agent: resolves all addresses and refuses the connection if any is private, so the
 * addresses that were checked are the ones connected to. Handles both callback shapes (Node asks for `all: true` when
 * it races IPv4/IPv6 connections).
 */
function makeSafeLookup(resolveAll: LookupAll | null) {
  return (hostname: string, options: dns.LookupOptions | undefined, cb: LookupCallback): void => {
    const wantAll = Boolean(options && (options as { all?: boolean }).all);
    const finish = (err: NodeJS.ErrnoException | null, list: LookupAddress[]) => {
      if (err) return cb(err);
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad) return cb(blockedError(bad.address));
      if (list.length === 0) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
      if (wantAll) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    };
    if (net.isIP(hostname)) {
      finish(null, [{ address: hostname, family: net.isIP(hostname) }]);
      return;
    }
    if (resolveAll) {
      resolveAll(hostname).then(
        (list) => finish(null, list.map((a) => ({ address: a.address, family: a.family }))),
        (err: NodeJS.ErrnoException) => finish(err, []),
      );
      return;
    }
    dns.lookup(hostname, { ...(options ?? {}), all: true }, (err, addresses) => finish(err, (addresses ?? []) as LookupAddress[]));
  };
}

/** Connection agent for requests that must not reach private addresses (one per resolver). */
const defaultSafeAgent = new Agent({ connect: { lookup: makeSafeLookup(null) as never } });

async function checkUrl(u: URL, allowPrivate: boolean, signal?: AbortSignal, resolveAll?: LookupAll | null): Promise<void> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new RequestError(`unsupported protocol ${u.protocol}`, false);
  // fetch() refuses these anyway; fail clearly (and without a pointless retry).
  if (u.username || u.password) throw new RequestError('URLs with embedded credentials are not supported', false);
  if (allowPrivate) return;
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new RequestError(`blocked private address ${host}`, false);
    return;
  }
  if (isInternalHostname(host)) throw new RequestError(`blocked private address ${host}`, false);

  const cached = hostVerdicts.get(host);
  if (cached && cached.until > Date.now()) {
    if (cached.blockedAddress) throw new RequestError(`blocked private address ${cached.blockedAddress}`, false);
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await abortable(resolveAll ? resolveAll(host) : dnsLookup(host, { all: true, verbatim: true }), signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new RequestError(describeNetworkError(err), true);
  }
  const bad = addresses.find((a) => isPrivateAddress(a.address));
  rememberVerdict(host, bad ? bad.address : null);
  if (bad) throw new RequestError(`blocked private address ${bad.address}`, false);
}

/**
 * Throws an Error if `url` is not http(s) or (when !allowPrivate) its host is private/loopback/internal
 * (literal IP check + DNS lookup of all addresses via dns.lookup(host, {all:true})).
 * A hostname that fails to resolve also throws (with the DNS error code as message).
 */
export async function assertAllowedUrl(url: string, allowPrivate: boolean): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${String(url).slice(0, 200)}`);
  }
  await checkUrl(u, allowPrivate);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function collectHeaders(h: Headers): Record<string, string> {
  // A Map + fromEntries keeps hostile names like "__proto__" as plain own properties.
  const map = new Map<string, string>();
  h.forEach((value, name) => {
    const key = name.toLowerCase();
    const prev = map.get(key);
    map.set(key, prev === undefined ? value : `${prev}, ${value}`);
  });
  return Object.fromEntries(map);
}

function mediaType(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const t = contentType.split(';')[0].trim().toLowerCase();
  return t || null;
}

function isTextual(type: string | null): boolean {
  if (type === null) return true;
  return type.startsWith('text/') || /json|xml|javascript|ecmascript/.test(type);
}

function charsetParam(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const m = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(contentType);
  const label = (m?.[1] ?? m?.[2] ?? '').trim();
  return label || null;
}

function bomCharset(body: Buffer): string | null {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';
  return null;
}

function sniffDeclaredCharset(body: Buffer, type: string | null): string | null {
  if (type !== null && !type.includes('html') && !type.includes('xml')) return null;
  const head = body.subarray(0, 1024).toString('latin1');
  const xml = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:+-]+)["']/i.exec(head);
  const meta = /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([\w.:+-]+)/i.exec(head);
  const label = (xml?.[1] ?? meta?.[1] ?? '').toLowerCase();
  if (!label) return null;
  // A document can't really declare UTF-16 in ASCII-compatible bytes; browsers treat that as UTF-8.
  return label.startsWith('utf-16') ? 'utf-8' : label;
}

/** WHATWG windows-1252 mapping for bytes 0x80–0x9F (the rest equals ISO-8859-1). */
const WINDOWS_1252_HIGH =
  '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f' +
  '\u0090‘’“”•–—˜™š›œ\u009džŸ';

function decodeText(label: string, body: Buffer): string {
  let decoder: InstanceType<typeof TextDecoder>;
  try {
    decoder = new TextDecoder(label, { fatal: false });
  } catch {
    decoder = new TextDecoder('utf-8', { fatal: false });
  }
  // Node 20's windows-1252 decoder (also behind the latin1/iso-8859-1/ascii labels) is really ISO-8859-1,
  // turning “smart quotes” and € into C1 control characters; apply the WHATWG table ourselves.
  if (decoder.encoding === 'windows-1252') {
    // eslint-disable-next-line no-control-regex
    return body.toString('latin1').replace(/[\x80-\x9f]/g, (c) => WINDOWS_1252_HIGH[c.charCodeAt(0) - 0x80]);
  }
  return decoder.decode(body);
}

/** Decodes a body using BOM > Content-Type charset > in-document declaration > utf-8. */
export function decodeBody(body: Buffer, contentTypeHeader: string | undefined): string {
  const type = mediaType(contentTypeHeader);
  const label = bomCharset(body) ?? charsetParam(contentTypeHeader) ?? sniffDeclaredCharset(body, type) ?? 'utf-8';
  return decodeText(label, body);
}

/**
 * Cloudflare "JavaScript detections": a script Cloudflare injects into ordinary proxied pages (error and maintenance
 * pages included). It lives under /cdn-cgi/challenge-platform/ but says nothing about a challenge.
 */
const JSD_SCRIPT_RE = /\/cdn-cgi\/challenge-platform\/(?:h\/[a-z0-9]+\/)?scripts\/jsd\/[^"'\s)<>]*/gi;

/** True if the response looks like an anti-bot challenge / captcha interstitial. */
export function detectChallenge(status: number, headers: Record<string, string>, text: string | null): boolean {
  if (/challenge/i.test(headers['cf-mitigated'] ?? '')) return true;
  if (/challenge/i.test(headers['x-vercel-mitigated'] ?? '')) return true;
  if (/^\s*(challenge|captcha)\s*$/i.test(headers['x-amzn-waf-action'] ?? '')) return true;
  if (!CHALLENGE_STATUSES.has(status) || !text) return false;
  const body = text.includes('challenge-platform') ? text.replace(JSD_SCRIPT_RE, '') : text;
  return CHALLENGE_MARKERS.some((m) => body.includes(m));
}

/** Parses Retry-After (delta seconds or HTTP date) into ms from `now`, clamped to [0, 24h]; null if absent/invalid. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.min(Math.round(Number.parseFloat(s) * 1000), MAX_RETRY_AFTER_MS);
  // HTTP-dates always contain a month name; this keeps V8's lenient Date.parse from accepting "-5" etc.
  if (!/[a-z]{3}/i.test(s)) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.min(Math.max(0, t - now), MAX_RETRY_AFTER_MS);
}

function truncateMessage(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX_ERROR_LENGTH ? `${one.slice(0, MAX_ERROR_LENGTH - 1)}…` : one;
}

/** Turns undici / node errors ("fetch failed" wrapping a cause chain) into a short label like "ECONNREFUSED". */
export function describeNetworkError(err: unknown): string {
  let fallback: string | null = null;
  const seen = new Set<unknown>();
  let e: unknown = err;
  for (let depth = 0; e && typeof e === 'object' && depth < 6 && !seen.has(e); depth++) {
    seen.add(e);
    const obj = e as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    const code = typeof obj.code === 'string' ? obj.code : null;
    const message = typeof obj.message === 'string' ? obj.message : '';
    if (code) {
      switch (code) {
        case BLOCKED_CODE:
          return truncateMessage(message || 'blocked private address');
        case 'UND_ERR_CONNECT_TIMEOUT':
          return 'connect timeout';
        case 'UND_ERR_HEADERS_TIMEOUT':
          return 'headers timeout';
        case 'UND_ERR_BODY_TIMEOUT':
          return 'body timeout';
        case 'UND_ERR_SOCKET':
          return truncateMessage(message ? `socket error: ${message}` : 'socket error');
        default:
          return truncateMessage(code.startsWith('UND_ERR_') && message ? message : code);
      }
    }
    if (message && message !== 'fetch failed' && fallback === null) fallback = message;
    // AggregateError (e.g. every address of a dual-stack host refused) → look at the first member.
    e = obj.cause ?? (Array.isArray(obj.errors) && obj.errors.length > 0 ? obj.errors[0] : undefined);
  }
  if (fallback === null && typeof err === 'string' && err) fallback = err;
  return truncateMessage(fallback ?? 'network error');
}

function formatSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(2))}s`;
}

/** Header values must be ByteStrings without CR/LF/NUL (undici rejects anything else). */
function isSafeHeaderValue(v: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\r\n\0]/.test(v) && !/[^\x00-\xff]/.test(v);
}

function stripCredentials(headers: Record<string, string>): Record<string, string> {
  const out = { ...headers };
  delete out.authorization;
  delete out['proxy-authorization'];
  delete out.cookie;
  return out;
}

/** Location headers arrive latin1-decoded; re-decode raw UTF-8 bytes the way browsers do. */
function fixLocation(location: string): string {
  const s = location.trim();
  // eslint-disable-next-line no-control-regex
  if (!/[\x80-\xff]/.test(s) || /[^\x00-\xff]/.test(s)) return s;
  const utf8 = Buffer.from(s, 'latin1').toString('utf8');
  return utf8.includes('�') ? s : utf8;
}

/** Reads (and discards) a small body so the connection can be reused; cancels anything bigger. Never throws. */
async function discardBody(resp: Response): Promise<void> {
  if (!resp.body) return;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    reader = resp.body.getReader();
    let total = 0;
    while (total <= DRAIN_LIMIT) {
      const r = await reader.read();
      if (r.done) return;
      total += r.value.byteLength;
    }
    reader.cancel().catch(() => {});
  } catch {
    reader?.cancel().catch(() => {});
  }
}

/** Streams the body up to `maxBytes`; cancels the stream (releasing the socket) when truncating or on error. */
async function readBody(resp: Response, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  if (!resp.body) return { body: Buffer.alloc(0), truncated: false };
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  let finished = false;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) {
        finished = true;
        break;
      }
      const chunk = r.value;
      const room = maxBytes - total;
      if (chunk.byteLength > room) {
        if (room > 0) {
          chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, room));
          total += room;
        }
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      total += chunk.byteLength;
    }
  } finally {
    if (!finished) reader.cancel().catch(() => {});
  }
  return { body: Buffer.concat(chunks, total), truncated };
}

function failureResult(url: string, finalUrl: string, error: string, redirected = false): FetchResult {
  return {
    url,
    finalUrl,
    status: 0,
    ok: false,
    notModified: false,
    redirected,
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

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Non-negative byte cap (Infinity = unlimited); invalid values fall back. */
function byteLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) return fallback;
  return value === Infinity ? Infinity : Math.floor(value);
}

/** Largest delay setTimeout honours (anything above fires immediately). */
const MAX_TIMER_MS = 2_147_483_647;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

interface AttemptParams {
  url: string;
  target: URL;
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  allowPrivate: boolean;
  /** The target came from the permanent-redirect cache: the result is a redirect even without a live hop. */
  viaCache: boolean;
}

export class HttpClient {
  readonly #global: Semaphore;
  readonly #perHost: KeyedLimiter;
  readonly #now: () => number;
  readonly #fetch: FetchImpl;
  readonly #resolveAll: LookupAll | null;
  readonly #safeAgent: Agent;
  /** Host → backoff after a 429 (until = no requests before this time). */
  readonly #backoff = new Map<string, { until: number; level: number }>();
  /** GET URL → same-origin target of a permanent redirect. */
  readonly #redirects = new Map<string, { target: string; until: number }>();

  constructor(public readonly opts: HttpClientOptions) {
    this.#global = new Semaphore(opts.globalConcurrency);
    this.#perHost = new KeyedLimiter(opts.perHostConcurrency);
    this.#now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.#fetch = typeof opts.fetch === 'function' ? opts.fetch : (undiciFetch as unknown as FetchImpl);
    this.#resolveAll = typeof opts.lookup === 'function' ? opts.lookup : null;
    this.#safeAgent = this.#resolveAll ? new Agent({ connect: { lookup: makeSafeLookup(this.#resolveAll) as never } }) : defaultSafeAgent;
  }

  async fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
    const calledAt = Date.now();
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return failureResult(String(url), String(url), 'invalid URL');
    }

    const headers = this.#buildHeaders(opts);
    if (typeof headers === 'string') return failureResult(url, url, headers);

    const hostKey = target.hostname.toLowerCase();
    if (!opts.ignoreBackoff) {
      const backedOff = this.#backedOff(url, hostKey);
      if (backedOff) return backedOff;
    }

    const method = opts.method === 'HEAD' ? 'HEAD' : 'GET';
    let viaCache = false;
    if (method === 'GET') {
      const cached = this.#redirects.get(url);
      if (cached && cached.until > this.#now()) {
        try {
          target = new URL(cached.target);
          viaCache = true;
        } catch {
          this.#redirects.delete(url);
        }
      } else if (cached) this.#redirects.delete(url);
    }

    const params: AttemptParams = {
      url,
      target,
      method,
      headers,
      timeoutMs: Math.min(MAX_TIMER_MS, positiveOr(opts.timeoutMs, positiveOr(this.opts.timeoutMs, 20_000))),
      maxBytes: byteLimit(opts.maxBytes, byteLimit(this.opts.maxBytes, 5 * 1024 * 1024)),
      allowPrivate: opts.allowPrivate ?? this.opts.allowPrivate,
      viaCache,
    };
    const retries = Math.min(MAX_RETRIES, Math.max(0, Math.floor(Number.isFinite(opts.retries) ? (opts.retries as number) : 1)));

    let startedAt = 0;
    for (let attempt = 0; ; attempt++) {
      let outcome: AttemptOutcome;
      try {
        outcome = await this.#perHost.run(hostKey, () =>
          this.#global.run(() => {
            if (startedAt === 0) startedAt = Date.now();
            return this.#attempt(params);
          }),
        );
      } catch (err) {
        // #attempt never throws; this is purely defensive.
        outcome = { result: failureResult(url, url, describeNetworkError(err)), retryable: false };
      }
      if (!outcome.retryable || attempt >= retries) {
        outcome.result.elapsedMs = Date.now() - (startedAt || calledAt);
        this.#noteOutcome(hostKey, outcome.result);
        if (viaCache && !outcome.result.ok && !outcome.result.notModified) this.#redirects.delete(url);
        return outcome.result;
      }
      // Slots are released while backing off.
      await sleep(BACKOFF_BASE_MS * 2 ** attempt);
    }
  }

  /** Until when requests to `host` are held back after a 429 (ms epoch), or null. */
  backoffUntil(host: string): number | null {
    const b = this.#backoff.get(String(host).toLowerCase());
    return b && b.until > this.#now() ? b.until : null;
  }

  /** A synthetic 429 while the host is backed off; null to go ahead. */
  #backedOff(url: string, host: string): FetchResult | null {
    const b = this.#backoff.get(host);
    if (!b) return null;
    const now = this.#now();
    if (b.until <= now) return null;
    const res = failureResult(url, url, 'rate limited (backing off)');
    res.status = 429;
    res.retryAfterMs = b.until - now;
    return res;
  }

  #noteOutcome(host: string, res: FetchResult): void {
    const now = this.#now();
    if (res.status === 429 || (res.status === 503 && res.retryAfterMs !== null)) {
      if (res.error === 'rate limited (backing off)') return;
      const prev = this.#backoff.get(host);
      const level = prev ? prev.level + 1 : 0;
      const wait =
        res.retryAfterMs !== null && res.retryAfterMs > 0
          ? Math.min(res.retryAfterMs, MAX_BACKOFF_MS)
          : Math.min(MAX_BACKOFF_MS, BACKOFF_STEP_MS * 2 ** Math.min(level, 10));
      if (!prev && this.#backoff.size >= BACKOFF_HOSTS_MAX) {
        for (const [k, v] of this.#backoff) if (v.until <= now) this.#backoff.delete(k);
        if (this.#backoff.size >= BACKOFF_HOSTS_MAX) return;
      }
      this.#backoff.set(host, { until: Math.max(prev?.until ?? 0, now + wait), level });
      return;
    }
    if (res.ok && this.#backoff.has(host)) this.#backoff.delete(host);
  }

  #rememberRedirect(from: string, to: string): void {
    if (this.#redirects.size >= REDIRECT_CACHE_MAX) {
      const now = this.#now();
      for (const [k, v] of this.#redirects) if (v.until <= now) this.#redirects.delete(k);
      for (const k of this.#redirects.keys()) {
        if (this.#redirects.size < REDIRECT_CACHE_MAX) break;
        this.#redirects.delete(k);
      }
    }
    this.#redirects.set(from, { target: to, until: this.#now() + REDIRECT_CACHE_TTL_MS });
  }

  /** In-flight + queued request counts (for /health). */
  stats(): { active: number; pending: number } {
    return { active: this.#global.active, pending: this.#global.pending + this.#perHost.pending };
  }

  /** Request headers (lowercase names), or an error message for invalid caller-supplied headers. */
  #buildHeaders(opts: FetchOptions): Record<string, string> | string {
    const h: Record<string, string> = {
      'user-agent': this.opts.userAgent,
      accept: opts.accept ?? DEFAULT_ACCEPT,
      'accept-language': ACCEPT_LANGUAGE,
    };
    // Stored validators come from remote servers; silently drop unusable ones rather than failing the check.
    if (opts.etag && isSafeHeaderValue(opts.etag)) h['if-none-match'] = opts.etag;
    if (opts.lastModified && isSafeHeaderValue(opts.lastModified)) h['if-modified-since'] = opts.lastModified;
    for (const [name, value] of Object.entries(opts.headers ?? {})) {
      if (typeof value !== 'string') continue;
      h[name.toLowerCase()] = value;
    }
    try {
      new Headers(h);
    } catch (err) {
      return truncateMessage(`invalid request headers: ${(err as Error).message}`);
    }
    for (const [name, value] of Object.entries(h)) {
      if (!isSafeHeaderValue(value)) return `invalid request header ${name}`;
    }
    return h;
  }

  /** One attempt: SSRF check + redirects + body, all under one timeout. Never throws. */
  async #attempt(p: AttemptParams): Promise<AttemptOutcome> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('timeout'));
    }, p.timeoutMs);
    timer.unref();

    let current = p.target;
    let redirected = p.viaCache;
    let hops = 0;
    let headers = p.headers;
    try {
      for (;;) {
        await checkUrl(current, p.allowPrivate, controller.signal, this.#resolveAll);
        const init: Record<string, unknown> = {
          method: p.method,
          headers,
          redirect: 'manual',
          signal: controller.signal,
        };
        // The connect-time lookup re-checks the addresses actually connected to (DNS rebinding).
        if (!p.allowPrivate) init.dispatcher = this.#safeAgent;
        const resp = await this.#fetch(current.href, init);

        const location = REDIRECT_STATUSES.has(resp.status) ? resp.headers.get('location') : null;
        if (location !== null && location.trim() !== '') {
          await discardBody(resp);
          if (controller.signal.aborted) throw controller.signal.reason;
          if (hops >= MAX_REDIRECTS) {
            return { result: failureResult(p.url, current.href, `too many redirects (>${MAX_REDIRECTS})`, true), retryable: false };
          }
          let next: URL;
          try {
            next = new URL(fixLocation(location), current);
          } catch {
            return { result: failureResult(p.url, current.href, 'invalid redirect location', true), retryable: false };
          }
          if (next.origin !== current.origin) headers = stripCredentials(headers);
          else if (hops === 0 && !p.viaCache && p.method === 'GET' && (resp.status === 301 || resp.status === 308)) {
            // A permanent same-origin redirect ("/docs" → "/docs/"): skip the extra round trip next time.
            this.#rememberRedirect(p.url, next.href);
          }
          // 303 (and 301/302 after POST) would switch to GET; we only send GET/HEAD and HEAD stays HEAD per the fetch spec.
          hops++;
          redirected = true;
          current = next;
          continue;
        }

        const result = await this.#finish(resp, p, current.href, redirected);
        return { result, retryable: RETRY_STATUSES.has(result.status) && !result.blocked };
      }
    } catch (err) {
      if (timedOut) {
        return { result: failureResult(p.url, current.href, `timeout after ${formatSeconds(p.timeoutMs)}`, redirected), retryable: false };
      }
      if (err instanceof RequestError) {
        return { result: failureResult(p.url, current.href, err.message, redirected), retryable: err.retryable };
      }
      const message = describeNetworkError(err);
      return { result: failureResult(p.url, current.href, message, redirected), retryable: !message.startsWith('blocked private address') };
    } finally {
      clearTimeout(timer);
    }
  }

  async #finish(resp: Response, p: AttemptParams, finalUrl: string, redirected: boolean): Promise<FetchResult> {
    const status = resp.status;
    const headers = collectHeaders(resp.headers);
    const rawType = headers['content-type'];
    const contentType = mediaType(rawType);

    let body: Buffer | null = null;
    let truncated = false;
    if (p.method === 'HEAD' || status === 304) {
      await discardBody(resp);
    } else {
      ({ body, truncated } = await readBody(resp, p.maxBytes));
    }

    const bodyText = body !== null && isTextual(contentType) ? decodeBody(body, rawType) : null;
    const challengeText = bodyText ?? (body !== null && CHALLENGE_STATUSES.has(status) ? body.subarray(0, 64 * 1024).toString('latin1') : null);

    return {
      url: p.url,
      finalUrl,
      status,
      ok: status >= 200 && status <= 299,
      notModified: status === 304,
      redirected,
      headers,
      contentType,
      body,
      bodyText,
      truncated,
      blocked: detectChallenge(status, headers, challengeText),
      retryAfterMs: parseRetryAfter(headers['retry-after']),
      error: null,
      elapsedMs: 0,
    };
  }
}

// Type-only re-exports so consumers can import limiter types from here if convenient.
export type { Semaphore, KeyedLimiter };
