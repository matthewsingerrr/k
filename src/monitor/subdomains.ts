/**
 * Subdomain discovery: Certificate Transparency (Cert Spotter incremental + crt.sh), DNS wordlist, hostnames seen in site code/links.
 *
 * Noise guards (false "new subdomain" alerts are worse than a late alert):
 * - Backfills are silent. The first Cert Spotter poll that succeeds after a failed/rate-limited baseline, a CT backlog that
 *   needs more than one call to page through, the first crt.sh success, and the first DNS sweep that ever completes all
 *   return long-existing names; they are recorded without alerting.
 * - Wildcard DNS: answers equal to the zone's wildcard answer are ignored. The wildcard answer set is remembered per root
 *   for 24h (in state.wildcard too, so a restart does not re-learn it; a flaky wildcard probe must not turn 250 wordlist
 *   labels into "new subdomains"), re-verified with fresh random labels when a sweep suddenly hits many labels, and inferred
 *   when many new labels share one answer. A wildcard that ROTATES its answers (Vercel DNS pools, CloudFront aliases:
 *   random labels get different addresses) is detected with extra random labels; in such a zone an answer counts as the
 *   wildcard when its addresses share the wildcard's /24 (IPv6 /48) prefixes, and when the pool is too spread out for
 *   that, DNS answers say nothing at all: wordlist hits are dropped and names never "go live" from DNS alone (CT, crt.sh,
 *   link and code names are still reported by their own sources).
 * - Cert Spotter's quota is per client IP / API key (10 full-domain queries an hour on the free tier), so it is budgeted
 *   globally: a token bucket in the provider, one shared rate-limit deadline for every watch, polls of several roots
 *   spaced out so they take turns, and paging stops at the first partial page.
 * - A DNS sweep only runs when the watched host itself resolves (otherwise resolver trouble would look like "everything
 *   vanished", and the next working sweep like "everything is new").
 * - "subdomain_live" needs an observed transition: the name must have been probed as dead before. Records whose probe was
 *   skipped (caps) or inconclusive (resolver down) stay "unprobed" and turn alive silently.
 * - Alive is sticky: a live name that stops resolving is not flipped back (DNS negatives are flaky; there is no "removed" alert).
 */

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import type { FetchResult, HttpClient } from '../net/http.js';
import { addressPrefix, isInternalHostname, matchesWildcard, type DnsProvider } from '../net/dns.js';
import { mapLimit } from '../net/limiter.js';
import { looksLikeHtml, parseHtml } from '../extract/html.js';
import type {
  DnsInfo,
  HttpProbe,
  Logger,
  SubdomainAlert,
  SubdomainInfo,
  SubdomainRecord,
  SubdomainSource,
  WatchState,
} from '../types.js';
import type { CheckContext } from './context.js';
import { SUBDOMAIN_WORDLIST } from './subdomain-wordlist.js';

/** Issuances per Cert Spotter page; a shorter page is the last one (no terminating empty request needed). */
export const CT_PAGE_SIZE = 100;
/** Default Cert Spotter budget (full-domain queries per hour). */
export const DEFAULT_CT_QUERIES_PER_HOUR = 10;
/** The local bucket refills a little slower than the server's, so it runs dry first (no 429s). */
const CT_BUCKET_MARGIN = 1.05;

export interface CtProvider {
  /**
   * Cert Spotter: GET https://api.certspotter.com/v1/issuances?domain=<d>&include_subdomains=true&expand=dns_names[&after=<cursor>]
   * (Authorization: Bearer <key> when configured). Follow pagination: while a page returns results, set after = last result id and
   * fetch again, up to `maxPages` (default 10) pages per call. Returns all dns_names seen + the new cursor (last id, or the input
   * cursor if no results). On 429 → { names: [...so far], cursor: <last good>, rateLimitedUntil: now + retryAfter (default 1h) }.
   * On other errors → throw an Error with the status.
   *
   * `more` (optional extension): true when pagination stopped because `maxPages` was reached while pages were still
   * returning results, i.e. there is (probably) a backlog left for the next call.
   */
  certspotter(
    domain: string,
    cursor: string | null,
    maxPages?: number,
  ): Promise<{ names: string[]; cursor: string | null; rateLimitedUntil?: number; more?: boolean; localLimit?: boolean }>;
  /**
   * crt.sh: GET https://crt.sh/?q=%25.<d>&output=json (timeout 60s). Parse JSON array; each entry's name_value (newline-separated)
   * and common_name. Returns unique names. On non-200/invalid JSON → throw.
   * (A body cut off at the size cap is salvaged entry by entry instead of failing.)
   */
  crtsh(domain: string): Promise<string[]>;
}

const CERTSPOTTER_ENDPOINT = 'https://api.certspotter.com/v1/issuances';
const CRTSH_ENDPOINT = 'https://crt.sh/';
const DEFAULT_CT_MAX_PAGES = 10;
const MAX_CT_PAGES = 100;
const DEFAULT_RATE_LIMIT_MS = 3600_000;
const CT_TIMEOUT_MS = 30_000;
const CT_MAX_BYTES = 16 * 1024 * 1024;
const CRTSH_TIMEOUT_MS = 60_000;
const CRTSH_MAX_BYTES = 32 * 1024 * 1024;
/** Unique names returned by one provider call (huge domains). */
const MAX_PROVIDER_NAMES = 50_000;
const JSON_ACCEPT = 'application/json';

/**
 * `queriesPerHour`: the Cert Spotter budget shared by every call of this provider (one per Monitor, i.e. per process):
 * a request is only sent when the local token bucket has a token; otherwise the call returns what it has with
 * `rateLimitedUntil` = when the next token is due and `localLimit: true` (no request was refused by the server).
 * `pageSize`: a page with fewer issuances is the last one.
 */
export function createCtProvider(
  http: HttpClient,
  opts: { certspotterApiKey: string | null; now?: () => number; queriesPerHour?: number; pageSize?: number },
): CtProvider {
  const now = typeof opts?.now === 'function' ? opts.now : Date.now;
  const apiKey = typeof opts?.certspotterApiKey === 'string' && opts.certspotterApiKey.trim() ? opts.certspotterApiKey.trim() : null;
  const qph = typeof opts?.queriesPerHour === 'number' && opts.queriesPerHour > 0 ? opts.queriesPerHour : DEFAULT_CT_QUERIES_PER_HOUR;
  const pageSize = typeof opts?.pageSize === 'number' && opts.pageSize >= 1 ? Math.floor(opts.pageSize) : CT_PAGE_SIZE;
  const refillMs = (3600_000 / qph) * CT_BUCKET_MARGIN;
  const capacity = Math.max(1, qph);
  const bucket = { tokens: capacity, at: now(), until: 0 };
  const refill = (t: number) => {
    if (t > bucket.at) {
      bucket.tokens = Math.min(capacity, bucket.tokens + (t - bucket.at) / refillMs);
      bucket.at = t;
    }
  };
  /** When a request may be sent (ms epoch), or 0 = now (a token is taken). */
  const take = (): number => {
    const t = now();
    refill(t);
    if (bucket.until > t) return bucket.until;
    if (bucket.tokens < 1) return t + Math.ceil((1 - bucket.tokens) * refillMs);
    bucket.tokens -= 1;
    return 0;
  };

  return {
    async certspotter(domain, cursor, maxPages = DEFAULT_CT_MAX_PAGES) {
      const pages = clampInt(maxPages, 1, MAX_CT_PAGES, DEFAULT_CT_MAX_PAGES);
      const names = new Set<string>();
      let after = typeof cursor === 'string' && cursor.trim() ? cursor.trim() : null;
      const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
      let more = false;

      for (let page = 0; page < pages; page++) {
        const wait = take();
        if (wait > 0) {
          // Out of budget: stop here; the caller resumes from the cursor later. More pages may be left.
          return { names: [...names], cursor: after, rateLimitedUntil: wait, localLimit: true, ...(page > 0 ? { more: true } : {}) };
        }
        let url = `${CERTSPOTTER_ENDPOINT}?domain=${encodeURIComponent(domain)}&include_subdomains=true&expand=dns_names`;
        if (after) url += `&after=${encodeURIComponent(after)}`;
        const res = await http.fetch(url, { accept: JSON_ACCEPT, headers, timeoutMs: CT_TIMEOUT_MS, maxBytes: CT_MAX_BYTES });

        if (res.status === 429) {
          const wait = res.retryAfterMs !== null && res.retryAfterMs > 0 ? res.retryAfterMs : DEFAULT_RATE_LIMIT_MS;
          const until = now() + wait;
          // The quota is shared by every domain: nothing more until the server says so, then one token to start again.
          bucket.until = Math.max(bucket.until, until);
          bucket.tokens = 1;
          bucket.at = bucket.until;
          return { names: [...names], cursor: after, rateLimitedUntil: until };
        }
        if (!res.ok) throw new Error(`certspotter: ${describeFailure(res)}`);
        if (res.truncated) throw new Error('certspotter: response exceeded size limit');

        const data = parseJson(responseText(res));
        if (!Array.isArray(data)) throw new Error('certspotter: invalid JSON response (expected an array)');
        if (data.length === 0) break;

        let lastId: string | null = null;
        for (const item of data) {
          if (!item || typeof item !== 'object') continue;
          const { id, dns_names: dnsNames } = item as { id?: unknown; dns_names?: unknown };
          const idStr = typeof id === 'string' ? id.trim() : typeof id === 'number' && Number.isFinite(id) ? String(id) : '';
          if (idStr && idStr.length <= 64) lastId = idStr;
          if (Array.isArray(dnsNames)) {
            for (const n of dnsNames) if (typeof n === 'string' && names.size < MAX_PROVIDER_NAMES) names.add(n);
          }
        }
        // Without a usable id we cannot advance; stop rather than refetch the same page forever.
        if (!lastId || lastId === after) break;
        after = lastId;
        // A partial page is the last one: the next poll resumes from the cursor (no terminating empty request).
        if (data.length < pageSize) break;
        if (page === pages - 1) more = true;
      }
      return { names: [...names], cursor: after, more };
    },

    async crtsh(domain) {
      const url = `${CRTSH_ENDPOINT}?q=%25.${encodeURIComponent(domain)}&output=json`;
      const res = await http.fetch(url, { accept: JSON_ACCEPT, timeoutMs: CRTSH_TIMEOUT_MS, maxBytes: CRTSH_MAX_BYTES, retries: 0 });
      if (!res.ok) throw new Error(`crt.sh: ${describeFailure(res)}`);
      const text = responseText(res);
      const names = new Set<string>();
      const addName = (v: unknown) => {
        if (typeof v !== 'string' || names.size >= MAX_PROVIDER_NAMES) return;
        for (const part of v.split(/\s+/)) if (part) names.add(part);
      };

      if (res.truncated) {
        // A complete string value is still trustworthy even though the document is cut off.
        const re = /"(?:name_value|common_name)"\s*:\s*"((?:[^"\\]|\\.){0,4096})"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const decoded = parseJson(`"${m[1]}"`);
          addName(decoded);
        }
        if (names.size === 0) throw new Error('crt.sh: response exceeded size limit');
        return [...names];
      }

      const data = parseJson(text);
      if (!Array.isArray(data)) throw new Error('crt.sh: invalid JSON response (expected an array)');
      for (const entry of data) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as { name_value?: unknown; common_name?: unknown };
        addName(e.name_value);
        addName(e.common_name);
      }
      return [...names];
    },
  };
}

function responseText(res: FetchResult): string {
  if (typeof res.bodyText === 'string') return res.bodyText;
  return res.body ? res.body.toString('utf8') : '';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describeFailure(res: FetchResult): string {
  if (res.status === 0) return res.error ? `request failed (${res.error})` : 'request failed';
  return `HTTP ${res.status}`;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// Wordlist & name normalization
// ---------------------------------------------------------------------------

const LABEL_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/**
 * ~250 common & web3-flavoured subdomain labels for the DNS sweep, e.g.:
 * www, app, api, docs, doc, beta, alpha, staging, stage, dev, test, testnet, devnet, mainnet, preview, demo, sandbox, admin, dashboard,
 * portal, blog, status, cdn, static, assets, media, img, images, mail, auth, login, id, account, accounts, pay, wallet, bridge, swap,
 * trade, exchange, stake, staking, earn, vault, vaults, farm, pool, pools, lend, borrow, points, rewards, airdrop, claim, mint, nft,
 * launch, launchpad, presale, sale, ido, token, governance, gov, vote, dao, forum, explorer, scan, analytics, stats, data, rpc, node,
 * ws, graph, subgraph, indexer, oracle, faucet, v1, v2, v3, v4, old, new, next, legacy, m, mobile, help, support, faq, careers, jobs,
 * about, press, brand, shop, store, community, discord, events, partners, invest, investors, ir, labs, research, learn, academy,
 * whitepaper, litepaper, roadmap, ... (fill to ~250, lowercase, unique).
 */
export const COMMON_SUBDOMAINS: string[] = [
  ...new Set(SUBDOMAIN_WORDLIST.map((l) => l.trim().toLowerCase()).filter((l) => LABEL_RE.test(l))),
];

/** Lowercase ASCII (punycode) hostname without trailing dots and with valid labels, or null. */
function toAsciiHost(raw: string): string | null {
  let h = raw.trim().toLowerCase();
  while (h.endsWith('.')) h = h.slice(0, -1);
  if (!h || h.length > 1024) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(h)) return null;
  if (/[^\x21-\x7e]/.test(h)) {
    h = domainToASCII(h);
    if (!h) return null;
  }
  if (h.length > 253) return null;
  for (const label of h.split('.')) if (!LABEL_RE.test(label)) return null;
  return h;
}

/**
 * Normalize a raw certificate / DNS name for `rootDomain`:
 * lowercase, trim, strip trailing ".", strip a leading "*." (wildcard → its base), reject names with invalid chars, spaces, "@",
 * or not strictly under rootDomain (the root itself → null; "www.<root>" is allowed). Returns null when rejected.
 */
export function normalizeSubdomain(name: string, rootDomain: string): string | null {
  try {
    if (typeof name !== 'string' || typeof rootDomain !== 'string') return null;
    const root = toAsciiHost(stripBrackets(rootDomain));
    if (!root || net.isIP(root)) return null;
    let raw = name.trim();
    if (raw.startsWith('*.')) raw = raw.slice(2);
    const host = toAsciiHost(raw);
    if (!host || host === root || !host.endsWith(`.${root}`)) return null;
    return host;
  } catch {
    return null;
  }
}

function stripBrackets(s: string): string {
  const t = s.trim();
  return t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
}

/** The root domain to discover under, or null for IPs / localhost / internal names (nothing public to discover). */
function discoveryRoot(rootDomain: unknown): string | null {
  if (typeof rootDomain !== 'string') return null;
  const bare = stripBrackets(rootDomain).toLowerCase().replace(/\.+$/, '');
  if (!bare || net.isIP(bare) || isInternalHostname(bare)) return null;
  const root = toAsciiHost(bare);
  if (!root || isInternalHostname(root)) return null;
  return root;
}

// ---------------------------------------------------------------------------
// HTTP probe
// ---------------------------------------------------------------------------

const PROBE_MAX_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 8000;
const MAX_TITLE_CHARS = 300;
const MAX_SERVER_CHARS = 120;

function clip(s: string | null | undefined, max: number): string | null {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function probeTitle(res: FetchResult): string | null {
  if (!res.bodyText || !looksLikeHtml(res.contentType, res.bodyText)) return null;
  try {
    return clip(parseHtml(res.bodyText, res.finalUrl || res.url).title, MAX_TITLE_CHARS);
  } catch {
    return null;
  }
}

/** HTTP probe https://host/ (fallback http://host/ when status 0): GET, maxBytes 256KB, timeout 8s, retries 0 → status, <title>, finalUrl, server header. */
export async function probeHttp(http: HttpClient, host: string): Promise<HttpProbe> {
  const unreachable: HttpProbe = { status: 0, title: null, finalUrl: null, server: null };
  if (typeof host !== 'string' || !host.trim()) return unreachable;
  const h = host.trim().toLowerCase();
  for (const scheme of ['https', 'http'] as const) {
    let res: FetchResult;
    try {
      res = await http.fetch(`${scheme}://${h}/`, { method: 'GET', maxBytes: PROBE_MAX_BYTES, timeoutMs: PROBE_TIMEOUT_MS, retries: 0 });
    } catch {
      continue;
    }
    if (!res || res.status === 0) continue;
    return {
      status: res.status,
      title: probeTitle(res),
      finalUrl: res.finalUrl || null,
      server: clip(res.headers?.['server'], MAX_SERVER_CHARS),
    };
  }
  return unreachable;
}

// ---------------------------------------------------------------------------
// Discovery run
// ---------------------------------------------------------------------------

const SOURCE_ORDER: readonly SubdomainSource[] = ['ct', 'crtsh', 'dns', 'link', 'code'];
const DNS_SWEEP_CONCURRENCY = 16;
const RESOLVE_CONCURRENCY = 16;
const PROBE_CONCURRENCY = 6;
/** Hosts listed per alert kind per run; the rest are recorded and counted in the logs. */
const MAX_ALERT_HOSTS = 50;
/** Candidate names considered per run (crt.sh on a huge domain). */
const MAX_CANDIDATES = 5000;
/** New names resolved per run; the rest are stored "unprobed" and picked up by later re-probes. */
const MAX_NEW_RESOLVES = 1000;
/** Known dead names re-resolved per run (oldest probe first). */
const MAX_REPROBES = 200;
/** HTTP probes during a (silent) baseline — only for display in listings, so kept small. */
const BASELINE_HTTP_PROBES = 30;
/** Cert Spotter calls per baseline run while the provider reports a backlog. */
const CT_BASELINE_MAX_CALLS = 5;
/** A source counts as due slightly early so the scheduler's ±10% jitter doesn't skip every other run. */
const DUE_SLACK = 0.15;
const WILDCARD_MEMORY_MS = 24 * 3600_000;
const WILDCARD_MEMORY_MAX_ANSWERS = 64;
const WILDCARD_MEMORY_MAX_ROOTS = 1000;
/** A sweep with this many hits while no wildcard is known re-verifies the wildcard with fresh random labels. */
const BURST_VERIFY_MIN_HITS = 8;
/** This many NEW wordlist hits sharing one identical answer is treated as an (undetected) wildcard. */
const WILDCARD_SIGNATURE_MIN = 25;
const DAY_MS = 24 * 3600_000;

/**
 * Cert Spotter's rate limit: its quota is per client IP (or API key), shared by every watch — one deadline for all
 * (module-level: shared by every watch in the process).
 */
const ctLimit = { until: 0 };
/** Roots polled recently (root → time), so polls of several roots are spaced out to fit the hourly budget. */
const ctActiveRoots = new Map<string, number>();
const CT_ACTIVE_WINDOW_MS = 2 * 3600_000;
/** Watch ids with a successful crt.sh poll in this process. */
const crtshPolled = new Set<number>();
/** Recently seen wildcard answers per root domain (a cross-watch cache; state.wildcard is the persisted copy). */
const wildcardMemory = new Map<string, { answers: Set<string>; rotating: boolean; spread: boolean; at: number }>();

/** Clear module-level caches (rate limits, wildcard memory, …). For tests; a restart starts from these too. */
export function resetSubdomainCaches(): void {
  ctLimit.until = 0;
  ctActiveRoots.clear();
  crtshPolled.clear();
  wildcardMemory.clear();
}

/** When Cert Spotter polling resumes (ms epoch), or null if it is not rate-limited. The limit is global (per IP/key). */
export function ctRateLimitedUntil(_rootDomain?: string, now: number = Date.now()): number | null {
  return ctLimit.until > now ? ctLimit.until : null;
}

/** Roots polled within CT_ACTIVE_WINDOW_MS (the root being polled included). */
function activeCtRoots(root: string, now: number): number {
  for (const [r, at] of ctActiveRoots) if (at > now || now - at > CT_ACTIVE_WINDOW_MS) ctActiveRoots.delete(r);
  return new Set([...ctActiveRoots.keys(), root]).size;
}

function rememberWildcard(
  root: string,
  answers: Iterable<string>,
  now: number,
  state: WatchState | null,
  rotating = false,
  spread = false,
): Set<string> {
  const prev = wildcardMemory.get(root);
  const fresh = prev && now - prev.at < WILDCARD_MEMORY_MS ? prev : null;
  const stored = state?.wildcard && now - state.wildcard.at < WILDCARD_MEMORY_MS && now >= state.wildcard.at ? state.wildcard : null;
  const merged = new Set<string>([...(stored?.answers ?? []), ...(fresh?.answers ?? [])]);
  for (const a of answers) {
    merged.delete(a); // re-insert so the newest answers survive the cap
    merged.add(a);
  }
  const capped = merged.size > WILDCARD_MEMORY_MAX_ANSWERS ? new Set([...merged].slice(-WILDCARD_MEMORY_MAX_ANSWERS)) : merged;
  const rot = rotating || Boolean(fresh?.rotating) || Boolean(stored?.rotating);
  const spr = spread || Boolean(fresh?.spread) || Boolean(stored?.spread);
  wildcardMemory.delete(root);
  wildcardMemory.set(root, { answers: capped, rotating: rot, spread: spr, at: now });
  for (const k of wildcardMemory.keys()) {
    if (wildcardMemory.size <= WILDCARD_MEMORY_MAX_ROOTS) break;
    wildcardMemory.delete(k);
  }
  if (state) state.wildcard = { answers: [...capped], rotating: rot, ...(spr ? { spread: true } : {}), at: now };
  return new Set(capped);
}

function recalledWildcard(
  root: string,
  now: number,
  state: WatchState | null,
): { answers: Set<string>; rotating: boolean; spread: boolean } | null {
  const mm = wildcardMemory.get(root);
  const m = mm && now - mm.at < WILDCARD_MEMORY_MS ? mm : null;
  const stored = state?.wildcard && now - state.wildcard.at < WILDCARD_MEMORY_MS && now >= state.wildcard.at ? state.wildcard : null;
  if (!m && !stored) return null;
  const answers = new Set<string>([...(stored?.answers ?? []), ...(m?.answers ?? [])]);
  if (answers.size === 0) return null;
  return {
    answers,
    rotating: Boolean(stored?.rotating) || Boolean(m?.rotating),
    spread: Boolean(stored?.spread) || Boolean(m?.spread),
  };
}

/** "A:1.2.3" (/24) or "AAAA:2001:db8:1" (/48) prefix of a wildcard answer entry, null for CNAMEs. */
function answerPrefix(entry: string): string | null {
  if (entry.startsWith('A:')) {
    const p = addressPrefix(entry.slice(2));
    return p ? `A:${p}` : null;
  }
  if (entry.startsWith('AAAA:')) {
    const p = addressPrefix(entry.slice(5));
    return p ? `AAAA:${p}` : null;
  }
  return null;
}

/** More distinct /24 (/48) prefixes than this in a rotating wildcard: the pool is too spread out to match by prefix. */
const WILDCARD_MAX_PREFIXES = 4;
/** Random labels resolved to check whether a wildcard rotates. */
const ROTATION_PROBE_LABELS = 4;

function answersOf(info: DnsInfo): string[] {
  return [...info.a.map((x) => `A:${x}`), ...info.aaaa.map((x) => `AAAA:${x}`), ...info.cname.map((x) => `CNAME:${x}`)];
}

/** Defensive copy of a provider answer; null when it carries no records. */
function sanitizeDns(info: unknown): DnsInfo | null {
  if (!info || typeof info !== 'object') return null;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))].sort() : [];
  const o = info as Partial<DnsInfo>;
  const out: DnsInfo = {
    a: list(o.a),
    aaaa: list(o.aaaa).map((x) => x.toLowerCase()),
    cname: list(o.cname).map((x) => x.toLowerCase().replace(/\.+$/, '')),
  };
  return out.a.length || out.aaaa.length || out.cname.length ? out : null;
}

function isDue(last: number, intervalSec: number, now: number): boolean {
  if (!Number.isFinite(last) || last <= 0 || last > now) return true;
  const ms = Math.max(0, Number.isFinite(intervalSec) ? intervalSec : 0) * 1000;
  return now - last >= ms * (1 - DUE_SLACK);
}

/** Dead names are re-resolved every interval while young; long-dead ones back off (most CT names never go live). */
function reprobeDue(rec: SubdomainRecord, now: number, intervalMs: number): boolean {
  if (!Number.isFinite(rec.lastProbe) || rec.lastProbe <= 0 || rec.lastProbe > now) return true;
  const age = now - rec.firstSeen;
  const every = age >= 30 * DAY_MS ? Math.max(intervalMs, 3 * 3600_000) : age >= 7 * DAY_MS ? Math.max(intervalMs, 1800_000) : intervalMs;
  return now - rec.lastProbe >= every * (1 - DUE_SLACK);
}

function sortSources(sources: Iterable<SubdomainSource>): SubdomainSource[] {
  const set = new Set(sources);
  return SOURCE_ORDER.filter((s) => set.has(s));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function byHost(a: { host: string }, b: { host: string }): number {
  return a.host < b.host ? -1 : a.host > b.host ? 1 : 0;
}

interface Candidate {
  host: string;
  sources: Set<SubdomainSource>;
  /** Non-wildcard answer already obtained by the wordlist sweep. */
  dns: DnsInfo | null;
  /** At least one contributing source is not a silent backfill. */
  loud: boolean;
}

type AddCandidate = (raw: unknown, source: SubdomainSource, loud: boolean, dns?: DnsInfo | null) => void;

/** Per-run DNS helpers: lazy (memoized) wildcard set, wildcard rotation check and resolver health canary. */
class RunDns {
  #wildcard: Promise<Set<string> | null> | null = null;
  #healthy: Promise<boolean> | null = null;
  #rotating: Promise<boolean> | null = null;
  /** The wildcard was seen rotating (answers outside the known set) — remembered for a day. */
  #rotatingKnown = false;
  /** …and its pool is too scattered to match answers by address prefix: DNS says nothing in this zone. */
  #spread = false;

  constructor(
    private readonly dns: DnsProvider,
    private readonly root: string,
    private readonly watchHost: string,
    private readonly now: number,
    private readonly state: WatchState | null,
  ) {}

  async resolve(host: string): Promise<DnsInfo | null> {
    try {
      return sanitizeDns(await this.dns.resolve(host));
    } catch {
      return null;
    }
  }

  /** Current wildcard answers for the root (fresh probe ∪ answers remembered from the last 24h), or null. */
  wildcard(): Promise<Set<string> | null> {
    this.#wildcard ??= (async () => {
      let fresh: Set<string> | null = null;
      try {
        const w = await this.dns.wildcard(this.root);
        fresh = w instanceof Set && w.size > 0 ? w : null;
      } catch {
        fresh = null;
      }
      const recalled = recalledWildcard(this.root, this.now, this.state);
      if (recalled?.rotating) this.#rotatingKnown = true;
      if (recalled?.spread) this.#spread = true;
      if (!fresh) return recalled ? recalled.answers : null;
      // A fresh probe with answers the remembered set lacks (and not explained by a shared CNAME): the wildcard rotates.
      const rotated = Boolean(recalled && recalled.answers.size > 0 && differsBeyondCname(fresh, recalled.answers));
      if (rotated) this.#rotatingKnown = true;
      return rememberWildcard(this.root, fresh, this.now, this.state, rotated);
    })();
    return this.#wildcard;
  }

  /** Resolve fresh random labels (bypassing the provider's wildcard cache); learn any answers as wildcard. */
  async verifyWildcard(): Promise<Set<string> | null> {
    const labels = Array.from({ length: ROTATION_PROBE_LABELS }, () => `wc-${randomBytes(8).toString('hex')}.${this.root}`);
    const infos = await Promise.all(labels.map((l) => this.resolve(l)));
    const answers = infos.flatMap((i) => (i ? answersOf(i) : []));
    if (answers.length > 0) {
      const sets = infos.filter((i): i is DnsInfo => i !== null).map((i) => new Set(answersOf(i)));
      const rotated = sets.some((a) => sets.some((b) => differsBeyondCname(a, b)));
      if (rotated) this.#rotatingKnown = true;
      this.learn(answers, rotated);
    }
    return this.wildcard();
  }

  learn(answers: string[], rotating = false): void {
    if (rotating) this.#rotatingKnown = true;
    const merged = rememberWildcard(this.root, answers, this.now, this.state, rotating, this.#spread);
    this.#wildcard = Promise.resolve(merged);
  }

  /** The rotating wildcard's pool is too scattered to match by prefix (many labels resolve outside the known prefixes). */
  markSpread(): void {
    this.#spread = true;
    this.#rotatingKnown = true;
    const merged = rememberWildcard(this.root, [], this.now, this.state, true, true);
    this.#wildcard = Promise.resolve(merged);
  }

  /**
   * Whether the root's wildcard rotates its answers: remembered, or checked now by resolving a few random labels and
   * comparing them with the known wildcard answers. Only asked when a wildcard exists.
   */
  rotating(): Promise<boolean> {
    this.#rotating ??= (async () => {
      const wildcard = await this.wildcard();
      if (!wildcard || wildcard.size === 0) return false;
      if (this.#rotatingKnown) return true;
      const labels = Array.from({ length: ROTATION_PROBE_LABELS }, () => `wc-${randomBytes(8).toString('hex')}.${this.root}`);
      const infos = (await Promise.all(labels.map((l) => this.resolve(l)))).filter((i): i is DnsInfo => i !== null);
      const rotated = infos.some((i) => differsBeyondCname(new Set(answersOf(i)), wildcard));
      if (infos.length > 0) this.learn(infos.flatMap(answersOf), rotated);
      return rotated || this.#rotatingKnown;
    })();
    return this.#rotating;
  }

  /**
   * True when a DNS answer says nothing beyond "the wildcard answers this name": equal to the wildcard (see
   * matchesWildcard), or — for a rotating wildcard — within the wildcard's address prefixes, or anything at all when the
   * rotating pool is too spread out to tell (CloudFront).
   */
  async wildcardOnly(info: DnsInfo): Promise<boolean> {
    const wildcard = await this.wildcard();
    if (!wildcard || wildcard.size === 0) return false;
    if (matchesWildcard(info, wildcard)) return true;
    if (!(await this.rotating())) return false;
    if (this.#spread) return true;
    const current = (await this.wildcard()) ?? wildcard;
    const prefixes = new Set([...current].map(answerPrefix).filter((p): p is string => p !== null));
    if (prefixes.size === 0 || prefixes.size > WILDCARD_MAX_PREFIXES) return true;
    const addrs = [...info.a.map((x) => `A:${x}`), ...info.aaaa.map((x) => `AAAA:${x}`)];
    if (addrs.length === 0) return false;
    return addrs.every((a) => {
      const p = answerPrefix(a);
      return p !== null && prefixes.has(p);
    });
  }

  /** True if the resolver works right now: the watched host (or the root) resolves. */
  healthy(): Promise<boolean> {
    this.#healthy ??= (async () => {
      if ((await this.resolve(this.watchHost)) !== null) return true;
      return this.watchHost !== this.root && (await this.resolve(this.root)) !== null;
    })();
    return this.#healthy;
  }
}

/**
 * `a` has answers outside `b` that a shared CNAME does not explain (a CNAME wildcard's target may rotate its addresses;
 * matchesWildcard already treats those as the wildcard).
 */
function differsBeyondCname(a: Set<string>, b: Set<string>): boolean {
  const extra = [...a].filter((x) => !b.has(x));
  if (extra.length === 0) return false;
  const cnamesA = [...a].filter((x) => x.startsWith('CNAME:'));
  if (cnamesA.length > 0 && cnamesA.every((c) => b.has(c))) return false;
  return true;
}

/**
 * One subdomain-discovery run for ctx.watch (only if features.subdomains; else return []).
 * rootDomain = ctx.watch.rootDomain. Skip entirely (return []) when rootDomain is an IP / "localhost".
 *
 * Sources (each isolated in try/catch; a failing source is logged at warn and skipped):
 * - 'link'/'code': opts.localHosts (hostnames seen in the site's HTML/JS, pre-labelled by the caller) → normalizeSubdomain.
 * - 'ct': if opts.force or ctx.baseline or now - state.ctLastPoll >= config.subdomainIntervalSec*1000 (and not rate-limited):
 *        providers.ct.certspotter(rootDomain, state.ctCursor) → update state.ctCursor & ctLastPoll.
 *        Keep a module-level Map<rootDomain, {until}> for rate limits.
 * - 'crtsh': if ctx.baseline or now - state.crtshLastPoll >= config.crtshIntervalSec*1000: providers.ct.crtsh(rootDomain);
 *        update state.crtshLastPoll (even on failure, to avoid hammering).
 * - 'dns': if ctx.baseline or opts.force or now - state.dnsLastScan >= config.dnsScanIntervalSec*1000: resolve
 *        `${label}.${rootDomain}` for every COMMON_SUBDOMAINS label (mapLimit 16) via providers.dns; discard answers matching the
 *        wildcard (providers.dns.wildcard(rootDomain) + matchesWildcard). Update state.dnsLastScan.
 *
 * For every candidate host:
 * - Existing record → merge sources, lastSeen = now. If !alive, re-check DNS at most once per subdomainIntervalSec (lastProbe);
 *   when it starts resolving (and not wildcard-only) → alive=true, probeHttp, and (not baseline) add to a 'subdomain_live' alert.
 * - New record → resolve DNS (dns source already has the answer), alive = resolves && !wildcard-only; probeHttp if alive;
 *   upsert; unless ctx.baseline add to a 'subdomain' alert.
 * Probing concurrency: mapLimit 6. Cap new-subdomain alerts at 50 per run (list the rest as count in logs).
 * Returns up to two SubdomainAlerts (kind 'subdomain' then 'subdomain_live'), sorted by host.
 *
 * Never throws: an unexpected failure (e.g. the database) is logged and yields [] so nothing unrecorded is announced.
 */
/** A hostname seen in the site's own HTML/JS. `loud: false` = seen only where it cannot be news (backfill): recorded silently. */
export type LocalHostInput = { host: string; source: Extract<SubdomainSource, 'link' | 'code'>; loud?: boolean };

export async function checkSubdomains(
  ctx: CheckContext,
  opts: { localHosts: LocalHostInput[]; force?: boolean },
): Promise<SubdomainAlert[]> {
  try {
    if (!ctx?.watch?.features?.subdomains) return [];
    const root = discoveryRoot(ctx.watch.rootDomain);
    if (!root) return [];
    return await runDiscovery(ctx, root, opts ?? { localHosts: [] });
  } catch (err) {
    ctx?.log?.error('subdomain discovery failed', { watchId: ctx?.watch?.id, error: errMsg(err) });
    return [];
  }
}

async function runDiscovery(
  ctx: CheckContext,
  root: string,
  opts: { localHosts?: LocalHostInput[]; force?: boolean },
): Promise<SubdomainAlert[]> {
  const { watch, store, config } = ctx;
  const log = ctx.log.child({ watchId: watch.id, root });
  const now = ctx.now();
  const baseline = ctx.baseline === true;
  const force = opts.force === true;
  const intervalMs = Math.max(0, config.subdomainIntervalSec) * 1000;
  const dns = new RunDns(ctx.providers.dns, root, String(watch.host ?? root).toLowerCase(), now, ctx.state ?? null);

  const existing = new Map<string, SubdomainRecord>();
  for (const r of store.listSubdomains(watch.id)) existing.set(r.host, r);

  const candidates = new Map<string, Candidate>();
  let overflow = 0;
  const add: AddCandidate = (raw, source, loud, info = null) => {
    if (typeof raw !== 'string') return;
    const host = normalizeSubdomain(raw, root);
    if (!host) return;
    let c = candidates.get(host);
    if (!c) {
      if (candidates.size >= MAX_CANDIDATES) {
        overflow++;
        return;
      }
      c = { host, sources: new Set(), dns: null, loud: false };
      candidates.set(host, c);
    }
    c.sources.add(source);
    if (loud) c.loud = true;
    if (info && !c.dns) c.dns = info;
  };

  // --- sources -----------------------------------------------------------------------------------------------------
  try {
    const local = Array.isArray(opts.localHosts) ? opts.localHosts : [];
    for (const lh of local) add(lh?.host, lh?.source === 'code' ? 'code' : 'link', lh?.loud !== false);
  } catch (err) {
    log.warn('subdomains: local hosts skipped', { error: errMsg(err) });
  }

  const sources: Array<[string, () => Promise<void>]> = [
    ['certspotter', () => pollCertSpotter(ctx, root, now, force, add, log)],
    ['crt.sh', () => pollCrtsh(ctx, root, now, existing, add)],
    ['dns', () => sweepDns(ctx, root, now, force, dns, existing, add, log)],
  ];
  for (const [name, run] of sources) {
    try {
      await run();
    } catch (err) {
      log.warn(`subdomains: ${name} failed`, { error: errMsg(err) });
    }
  }
  if (overflow > 0) log.warn('subdomains: candidate cap reached', { cap: MAX_CANDIDATES, dropped: overflow });

  // --- merge candidates into records ---------------------------------------------------------------------------------
  const updates = new Map<string, SubdomainRecord>();
  const fresh: Array<{ rec: SubdomainRecord; loud: boolean; dns: DnsInfo | null }> = [];
  const becameAlive: SubdomainRecord[] = [];

  for (const c of candidates.values()) {
    const prev = existing.get(c.host);
    if (prev) {
      const rec: SubdomainRecord = { ...prev, sources: sortSources([...prev.sources, ...c.sources]), lastSeen: now };
      if (c.dns) {
        if (!rec.alive) {
          rec.alive = true;
          if (prev.lastProbe > 0) becameAlive.push(rec);
        }
        rec.dns = c.dns;
        rec.lastProbe = now;
      }
      updates.set(c.host, rec);
    } else {
      const rec: SubdomainRecord = {
        watchId: watch.id,
        host: c.host,
        sources: sortSources(c.sources),
        firstSeen: now,
        lastSeen: now,
        alive: false,
        lastProbe: 0,
        dns: null,
        http: null,
      };
      updates.set(c.host, rec);
      fresh.push({ rec, loud: c.loud, dns: c.dns });
    }
  }

  // --- resolve new names ---------------------------------------------------------------------------------------------
  const toResolve: SubdomainRecord[] = [];
  let unresolved = 0;
  for (const f of fresh) {
    if (f.dns) {
      Object.assign(f.rec, { alive: true, dns: f.dns, lastProbe: now });
    } else if (toResolve.length < MAX_NEW_RESOLVES) {
      toResolve.push(f.rec);
    } else {
      unresolved++;
    }
  }
  if (unresolved > 0) log.info('subdomains: resolution deferred for new names', { deferred: unresolved });
  await mapLimit(toResolve, RESOLVE_CONCURRENCY, async (rec) => {
    // A second try before declaring a fresh name dead: a timeout here would later read as "went live".
    const info = (await dns.resolve(rec.host)) ?? (await dns.resolve(rec.host));
    if (info) {
      const wildcardOnly = await dns.wildcardOnly(info);
      rec.alive = !wildcardOnly;
      rec.dns = wildcardOnly ? null : info;
      rec.lastProbe = now;
    } else if (await dns.healthy()) {
      rec.lastProbe = now;
    }
  });

  // --- re-probe known dead names -------------------------------------------------------------------------------------
  const reprobe = [...existing.values()]
    .filter((r) => !r.alive && !updates.get(r.host)?.alive && (force || reprobeDue(r, now, intervalMs)))
    .sort((a, b) => a.lastProbe - b.lastProbe || byHost(a, b))
    .slice(0, MAX_REPROBES);
  await mapLimit(reprobe, RESOLVE_CONCURRENCY, async (prev) => {
    const info = await dns.resolve(prev.host);
    const rec = updates.get(prev.host) ?? { ...prev };
    if (info) {
      rec.lastProbe = now;
      if (!(await dns.wildcardOnly(info))) {
        rec.alive = true;
        rec.dns = info;
        if (prev.lastProbe > 0) becameAlive.push(rec);
      }
      updates.set(rec.host, rec);
    } else if (await dns.healthy()) {
      rec.lastProbe = now;
      updates.set(rec.host, rec);
    }
  });

  // --- choose what to announce & HTTP-probe --------------------------------------------------------------------------
  let newAlert: SubdomainRecord[] = [];
  let liveAlert: SubdomainRecord[] = [];
  let toProbe: SubdomainRecord[];
  if (baseline) {
    toProbe = fresh
      .map((f) => f.rec)
      .filter((r) => r.alive)
      .sort(byHost)
      .slice(0, BASELINE_HTTP_PROBES);
  } else {
    // Prefer live hosts when capping, then list alphabetically.
    const announce = fresh
      .filter((f) => f.loud)
      .map((f) => f.rec)
      .sort((a, b) => Number(b.alive) - Number(a.alive) || byHost(a, b));
    newAlert = announce.slice(0, MAX_ALERT_HOSTS).sort(byHost);
    liveAlert = [...new Map(becameAlive.map((r) => [r.host, r])).values()].sort(byHost).slice(0, MAX_ALERT_HOSTS);
    if (announce.length > newAlert.length || becameAlive.length > liveAlert.length) {
      log.warn('subdomains: alert cap reached; extra hosts recorded without listing', {
        newTotal: announce.length,
        liveTotal: becameAlive.length,
        cap: MAX_ALERT_HOSTS,
      });
    }
    const silentNew = fresh.length - announce.length;
    if (silentNew > 0) log.info('subdomains: recorded backfilled names silently', { count: silentNew });
    toProbe = [...newAlert.filter((r) => r.alive), ...liveAlert];
  }
  await mapLimit(toProbe, PROBE_CONCURRENCY, async (rec) => {
    try {
      rec.http = await probeHttp(ctx.http, rec.host);
    } catch {
      rec.http = { status: 0, title: null, finalUrl: null, server: null };
    }
  });

  // --- persist, then announce ----------------------------------------------------------------------------------------
  if (updates.size > 0) store.upsertSubdomains([...updates.values()]);

  log.debug('subdomains: run complete', {
    candidates: candidates.size,
    new: fresh.length,
    reprobed: reprobe.length,
    live: becameAlive.length,
    baseline,
  });

  const info = (r: SubdomainRecord): SubdomainInfo => ({ host: r.host, sources: [...r.sources], dns: r.dns, http: r.http });
  const alerts: SubdomainAlert[] = [];
  if (newAlert.length > 0) alerts.push({ kind: 'subdomain', rootDomain: root, subdomains: newAlert.map(info) });
  if (liveAlert.length > 0) alerts.push({ kind: 'subdomain_live', rootDomain: root, subdomains: liveAlert.map(info) });
  if (alerts.length > 0) {
    log.info('subdomains: changes found', { new: newAlert.map((r) => r.host), live: liveAlert.map((r) => r.host) });
  }
  return alerts;
}

async function pollCertSpotter(ctx: CheckContext, root: string, now: number, force: boolean, add: AddCandidate, log: Logger): Promise<void> {
  const { state, config } = ctx;
  const baseline = ctx.baseline === true;
  // Several roots share one hourly budget: space each root's polls so they take turns instead of racing for tokens.
  const qph = config.certspotterQueriesPerHour > 0 ? config.certspotterQueriesPerHour : DEFAULT_CT_QUERIES_PER_HOUR;
  const roots = activeCtRoots(root, now);
  const intervalSec = roots > 1 ? Math.max(config.subdomainIntervalSec, ((roots * 3600) / qph) * 1.2) : config.subdomainIntervalSec;
  if (!(force || baseline || isDue(state.ctLastPoll, intervalSec, now))) return;
  if (ctLimit.until > now) {
    log.debug('subdomains: certspotter rate-limited', { until: new Date(ctLimit.until).toISOString() });
    return;
  }
  ctActiveRoots.set(root, now);

  // Names from the very first successful poll (the baseline poll failed) or from a multi-call backlog were issued long
  // ago. A cursor-less watch whose earlier poll succeeded simply had no certificates yet. Both flags live in the persisted
  // state, so a restart in the middle of a backlog does not turn the rest of it into "new subdomains".
  const firstPoll = !state.ctCursor && !state.ctPolledOk;
  const wasBackfilling = state.ctBackfill === true;
  let calls = 0;
  let more = false;
  let rateLimited = false;
  try {
    do {
      const res = await ctx.providers.ct.certspotter(root, state.ctCursor || null);
      calls++;
      if (res && typeof res.cursor === 'string' && res.cursor.trim()) state.ctCursor = res.cursor;
      more = res?.more === true;
      const silent = !baseline && (firstPoll || wasBackfilling || more);
      if (Array.isArray(res?.names)) for (const n of res.names) add(n, 'ct', !silent);
      const until = res?.rateLimitedUntil;
      if (typeof until === 'number' && Number.isFinite(until)) {
        rateLimited = true;
        if (until > now) ctLimit.until = Math.max(ctLimit.until, until);
        if (res?.localLimit) log.debug('subdomains: certspotter budget used up; waiting', { until: new Date(until).toISOString() });
        else log.warn('subdomains: certspotter rate limit hit', { until: new Date(until).toISOString() });
        break;
      }
      state.ctPolledOk = true;
    } while (baseline && more && calls < CT_BASELINE_MAX_CALLS);
  } finally {
    state.ctLastPoll = now;
    if (more || (rateLimited && (baseline || wasBackfilling || firstPoll))) state.ctBackfill = true;
    else if (calls > 0 && !rateLimited) state.ctBackfill = false;
  }
}

async function pollCrtsh(ctx: CheckContext, root: string, now: number, existing: Map<string, SubdomainRecord>, add: AddCandidate): Promise<void> {
  const { state, watch } = ctx;
  const baseline = ctx.baseline === true;
  if (!(baseline || isDue(state.crtshLastPoll, ctx.config.crtshIntervalSec, now))) return;
  // crt.sh returns every historical name; until one poll has succeeded for this watch (e.g. it timed out during the
  // baseline) the result is a backfill, not news.
  const everPolled = crtshPolled.has(watch.id) || [...existing.values()].some((r) => r.sources.includes('crtsh'));
  const silent = !baseline && !everPolled;
  try {
    const names = await ctx.providers.ct.crtsh(root);
    crtshPolled.add(watch.id);
    if (Array.isArray(names)) for (const n of names) add(n, 'crtsh', !silent);
  } finally {
    state.crtshLastPoll = now;
  }
}

async function sweepDns(
  ctx: CheckContext,
  root: string,
  now: number,
  force: boolean,
  dns: RunDns,
  existing: Map<string, SubdomainRecord>,
  add: AddCandidate,
  log: Logger,
): Promise<void> {
  const { state } = ctx;
  const baseline = ctx.baseline === true;
  if (!(force || baseline || isDue(state.dnsLastScan, ctx.config.dnsScanIntervalSec, now))) return;
  if (!(await dns.healthy())) {
    // Not recorded as a scan: retried on the next run, and "never swept" stays true for the backfill rule below.
    log.warn('subdomains: DNS sweep skipped, watched host does not resolve');
    return;
  }
  const silent = !baseline && !(state.dnsLastScan > 0);

  const results = await mapLimit(COMMON_SUBDOMAINS, DNS_SWEEP_CONCURRENCY, async (label) => {
    const host = `${label}.${root}`;
    return { host, info: await dns.resolve(host) };
  });
  let hits = results.filter((r): r is { host: string; info: DnsInfo } => r.info !== null);

  let wildcard = await dns.wildcard();
  if ((!wildcard || wildcard.size === 0) && hits.length >= BURST_VERIFY_MIN_HITS) wildcard = await dns.verifyWildcard();
  const kept: typeof hits = [];
  for (const h of hits) if (!(await dns.wildcardOnly(h.info))) kept.push(h);
  hits = kept;
  if (hits.length >= BURST_VERIFY_MIN_HITS && wildcard && wildcard.size > 0 && (await dns.rotating())) {
    // Many labels answer outside the rotating wildcard's known prefixes: its pool is larger than what we have seen of it
    // (a CDN alias with per-name edge sets). No wordlist answer can be told from the wildcard in such a zone.
    log.info('subdomains: rotating wildcard with a scattered address pool; DNS sweep hits ignored', { hits: hits.length });
    dns.markSpread();
    hits = [];
  }

  if (!baseline) {
    const groups = new Map<string, Array<{ host: string; info: DnsInfo }>>();
    for (const h of hits) {
      if (existing.has(h.host)) continue;
      const sig = answersOf(h.info).join(',');
      const g = groups.get(sig);
      if (g) g.push(h);
      else groups.set(sig, [h]);
    }
    for (const [sig, group] of groups) {
      if (group.length < WILDCARD_SIGNATURE_MIN) continue;
      log.warn('subdomains: many new labels share one DNS answer; treating it as a wildcard', { answer: sig, labels: group.length });
      // Many labels answering alike next to a known wildcard means the wildcard rotates.
      dns.learn(answersOf(group[0].info), Boolean(wildcard && wildcard.size > 0));
      const drop = new Set(group.map((g) => g.host));
      hits = hits.filter((h) => !drop.has(h.host));
    }
    if (hits.length > 0 && wildcard && wildcard.size > 0 && (await dns.rotating())) {
      // The rotation was learned just now: re-check what is left against the (now wider) wildcard.
      const still: typeof hits = [];
      for (const h of hits) if (!(await dns.wildcardOnly(h.info))) still.push(h);
      hits = still;
    }
  }

  for (const h of hits) add(h.host, 'dns', !silent, h.info);
  state.dnsLastScan = now;
  log.debug('subdomains: DNS sweep done', { labels: COMMON_SUBDOMAINS.length, hits: hits.length, wildcard: wildcard?.size ?? 0 });
}

export type { DnsProvider };
