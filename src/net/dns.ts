/**
 * DNS helpers: resolution with timeouts, wildcard detection, private-address checks.
 */

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import type { DnsInfo } from '../types.js';

export interface DnsProvider {
  /**
   * Resolve A, AAAA and CNAME for `host` in parallel with a timeout (default 4000ms total).
   * Returns null if the name does not exist / has no A, AAAA or CNAME records (NXDOMAIN, NODATA, SERVFAIL, timeout).
   * Arrays are sorted & de-duplicated; CNAME targets lowercase without trailing dot.
   */
  resolve(host: string): Promise<DnsInfo | null>;
  /**
   * Wildcard detection for `domain`: resolve a few random labels (e.g. `wc-<16 random hex>.${domain}`; four, so a
   * wildcard that rotates its answers shows more of its pool).
   * If any resolves, return the union of their A/AAAA/CNAME answers as a Set of strings (prefixed "A:", "AAAA:", "CNAME:");
   * otherwise return null (no wildcard). Cached per domain for 10 minutes.
   */
  wildcard(domain: string): Promise<Set<string> | null>;
}

export interface DnsProviderOptions {
  /** DNS servers to use; default ["1.1.1.1", "8.8.8.8"]. Empty array = system resolver. */
  servers?: string[];
  timeoutMs?: number;
}

export const DEFAULT_DNS_SERVERS: readonly string[] = ['1.1.1.1', '8.8.8.8'];
const DEFAULT_TIMEOUT_MS = 4000;
const WILDCARD_TTL_MS = 10 * 60_000;
/** A wildcard probe that failed for non-definitive reasons (timeouts, SERVFAIL) is retried sooner. */
const WILDCARD_INCONCLUSIVE_TTL_MS = 60_000;
const WILDCARD_CACHE_MAX = 500;
/** Random labels resolved per wildcard probe. */
const WILDCARD_PROBE_LABELS = 4;
/** Errors that prove the name has no records of that type (as opposed to "we could not find out"). */
const DEFINITIVE_NO_RECORD = new Set(['ENOTFOUND', 'ENODATA']);

interface LookupOutcome {
  info: DnsInfo | null;
  /** False if any query timed out or failed for a reason other than NXDOMAIN/NODATA. */
  definitive: boolean;
}

/** Lowercase ASCII hostname without trailing dot, or null if it cannot be a valid DNS name. */
function normalizeDnsName(host: string): string | null {
  if (typeof host !== 'string') return null;
  let h = host.trim().toLowerCase();
  while (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) return null;
  if (net.isIP(h)) return h;
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(h)) {
    h = domainToASCII(h);
    if (!h) return null;
  }
  if (h.length > 253) return null;
  for (const label of h.split('.')) {
    if (label.length === 0 || label.length > 63 || !/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/.test(label)) return null;
  }
  return h;
}

function normalizeCname(name: string): string {
  let n = String(name).trim().toLowerCase();
  while (n.endsWith('.')) n = n.slice(0, -1);
  return n;
}

function uniqSorted(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))].sort();
}

async function lookupAll(resolver: Resolver, host: string, timeoutMs: number): Promise<LookupOutcome> {
  const name = normalizeDnsName(host);
  if (!name) return { info: null, definitive: true };
  const ipVersion = net.isIP(name);
  if (ipVersion === 4) return { info: { a: [name], aaaa: [], cname: [] }, definitive: true };
  if (ipVersion === 6) return { info: { a: [], aaaa: [name], cname: [] }, definitive: true };

  let a: string[] = [];
  let aaaa: string[] = [];
  let cname: string[] = [];
  let definitive = true;
  const query = (run: () => Promise<string[]>, store: (v: string[]) => void): Promise<void> =>
    Promise.resolve()
      .then(run)
      .then(
        (v) => store(Array.isArray(v) ? v.map(String) : []),
        (err: unknown) => {
          const code = (err as { code?: unknown } | null)?.code;
          if (typeof code !== 'string' || !DEFINITIVE_NO_RECORD.has(code)) definitive = false;
        },
      );

  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    Promise.all([
      query(() => resolver.resolve4(name), (v) => (a = v)),
      query(() => resolver.resolve6(name), (v) => (aaaa = v)),
      query(() => resolver.resolveCname(name), (v) => (cname = v)),
    ]).then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  // On timeout, keep whatever answered in time (e.g. A answered but a broken server never answers AAAA).
  if (timedOut) definitive = false;

  const info: DnsInfo = {
    a: uniqSorted(a),
    aaaa: uniqSorted(aaaa.map((x) => x.toLowerCase())),
    cname: uniqSorted(cname.map(normalizeCname)),
  };
  if (info.a.length === 0 && info.aaaa.length === 0 && info.cname.length === 0) return { info: null, definitive };
  return { info, definitive };
}

/** Create a DnsProvider backed by node:dns/promises Resolver (with `timeout` & `tries: 2`). */
export function createDnsProvider(opts: DnsProviderOptions = {}): DnsProvider {
  const servers = opts.servers ?? [...DEFAULT_DNS_SERVERS];
  const timeoutMs = opts.timeoutMs !== undefined && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  // c-ares tries every server `tries` times with the per-try timeout doubling on the second round
  // (T per server, then 2T per server): size T so a fully failing query ends around our overall deadline.
  const perTryMs = Math.max(100, Math.floor(timeoutMs / (3 * Math.max(1, servers.length))));
  const resolver = new Resolver({ timeout: perTryMs, tries: 2 });
  if (servers.length > 0) {
    try {
      resolver.setServers(servers);
    } catch (err) {
      throw new Error(`invalid DNS servers ${JSON.stringify(servers)}: ${(err as Error).message}`);
    }
  }

  const wildcardCache = new Map<string, { expires: number; value: Promise<Set<string> | null> }>();

  const pruneCache = (now: number) => {
    if (wildcardCache.size < WILDCARD_CACHE_MAX) return;
    for (const [k, v] of wildcardCache) if (v.expires <= now) wildcardCache.delete(k);
    // Still full: drop the oldest insertions.
    for (const k of wildcardCache.keys()) {
      if (wildcardCache.size < WILDCARD_CACHE_MAX) break;
      wildcardCache.delete(k);
    }
  };

  const probeWildcard = async (domain: string, entry: { expires: number }): Promise<Set<string> | null> => {
    const labels = Array.from({ length: WILDCARD_PROBE_LABELS }, () => `wc-${randomBytes(8).toString('hex')}.${domain}`);
    const outcomes = await Promise.all(labels.map((l) => lookupAll(resolver, l, timeoutMs)));
    const set = new Set<string>();
    for (const { info } of outcomes) {
      if (!info) continue;
      for (const x of info.a) set.add(`A:${x}`);
      for (const x of info.aaaa) set.add(`AAAA:${x}`);
      for (const x of info.cname) set.add(`CNAME:${x}`);
    }
    if (set.size > 0) return set;
    if (!outcomes.every((o) => o.definitive)) entry.expires = Date.now() + WILDCARD_INCONCLUSIVE_TTL_MS;
    return null;
  };

  return {
    async resolve(host: string): Promise<DnsInfo | null> {
      try {
        return (await lookupAll(resolver, host, timeoutMs)).info;
      } catch {
        return null;
      }
    },

    async wildcard(domain: string): Promise<Set<string> | null> {
      const d = normalizeDnsName(domain);
      if (!d || net.isIP(d)) return null;
      const now = Date.now();
      let entry = wildcardCache.get(d);
      if (!entry || entry.expires <= now) {
        wildcardCache.delete(d);
        pruneCache(now);
        const fresh: { expires: number; value: Promise<Set<string> | null> } = { expires: now + WILDCARD_TTL_MS, value: Promise.resolve(null) };
        fresh.value = probeWildcard(d, fresh).catch(() => {
          fresh.expires = Date.now() + WILDCARD_INCONCLUSIVE_TTL_MS;
          return null;
        });
        wildcardCache.set(d, fresh);
        entry = fresh;
      }
      const result = await entry.value;
      // Callers get their own copy so the cached answer set cannot be mutated.
      return result ? new Set(result) : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function parseIPv4(s: string): [number, number, number, number] | null {
  if (!net.isIPv4(s)) return null;
  const p = s.split('.').map((x) => Number.parseInt(x, 10));
  return [p[0], p[1], p[2], p[3]];
}

/** Parses any valid IPv6 literal (compressed, embedded IPv4 tail, zone id) into eight 16-bit groups. */
function parseIPv6(input: string): number[] | null {
  let s = input;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const rest = halves[1] ? halves[1].split(':') : [];
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<string>(fill).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function isPrivateV4([a, b, c]: readonly number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 0 && c === 0) || // 192.0.0/24
    (a === 192 && b === 168) || // 192.168/16
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    a >= 224 // 224/4 multicast + 240/4 reserved (incl. broadcast)
  );
}

function embeddedV4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function isPrivateV6(g: readonly number[]): boolean {
  const zeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroUntil(8)) return true; // ::
  if (zeroUntil(7) && g[7] === 1) return true; // ::1
  if (zeroUntil(5) && g[5] === 0xffff) return isPrivateV4(embeddedV4(g[6], g[7])); // ::ffff:a.b.c.d (mapped)
  if (zeroUntil(4) && g[4] === 0xffff && g[5] === 0) return isPrivateV4(embeddedV4(g[6], g[7])); // ::ffff:0:a.b.c.d (translated)
  if (zeroUntil(6)) return isPrivateV4(embeddedV4(g[6], g[7])); // ::a.b.c.d (deprecated compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isPrivateV4(embeddedV4(g[6], g[7])); // 64:ff9b::/96 NAT64
  }
  if (g[0] === 0x2002) return isPrivateV4(embeddedV4(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * True if `ip` (v4 or v6 literal, including IPv4-mapped IPv6 like ::ffff:10.0.0.1) is not publicly routable:
 * 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4,
 * ::, ::1, fc00::/7, fe80::/10, ff00::/8. Non-IP strings → false.
 * Also covers IPv4 embedded in NAT64 / 6to4 / IPv4-compatible IPv6 forms, fec0::/10, bracketed "[::1]" and zone ids.
 */
export function isPrivateAddress(ip: string): boolean {
  if (typeof ip !== 'string') return false;
  let s = ip.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const v4 = parseIPv4(s);
  if (v4) return isPrivateV4(v4);
  const v6 = parseIPv6(s);
  if (v6) return isPrivateV6(v6);
  return false;
}

/**
 * Network prefix of an address for grouping rotating answers: the /24 of an IPv4 address ("1.2.3") or the /48 of an IPv6
 * address ("2001:db8:1"); null for anything else.
 */
export function addressPrefix(ip: string): string | null {
  if (typeof ip !== 'string') return null;
  const v4 = parseIPv4(ip.trim());
  if (v4) return `${v4[0]}.${v4[1]}.${v4[2]}`;
  const v6 = parseIPv6(ip.trim());
  if (v6) return v6.slice(0, 3).map((g) => g.toString(16)).join(':');
  return null;
}

/**
 * True if a hostname is internal by name: "localhost", "*.localhost", "*.local", "*.internal", "*.railway.internal", or has no dot (single label).
 * IP literals return false (classify those with isPrivateAddress); an empty name counts as internal.
 */
export function isInternalHostname(hostname: string): boolean {
  if (typeof hostname !== 'string') return true;
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) return true;
  if (net.isIP(h) || parseIPv6(h)) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  return !h.includes('.');
}

/**
 * True if the DnsInfo answers are entirely contained in a wildcard answer set from `wildcard()` (i.e. it's just the wildcard).
 * A name whose CNAME targets all match the wildcard's CNAME is also the wildcard (its A/AAAA come from the shared target,
 * which may rotate addresses between queries). An info with no answers never matches.
 */
export function matchesWildcard(info: DnsInfo, wildcard: Set<string> | null): boolean {
  if (!wildcard || wildcard.size === 0 || !info) return false;
  const a = (info.a ?? []).map((x) => `A:${String(x).trim()}`);
  const aaaa = (info.aaaa ?? []).map((x) => `AAAA:${String(x).trim().toLowerCase()}`);
  const cname = (info.cname ?? []).map((x) => `CNAME:${normalizeCname(x)}`);
  const all = [...a, ...aaaa, ...cname];
  if (all.length === 0) return false;
  if (all.every((x) => wildcard.has(x))) return true;
  return cname.length > 0 && cname.every((x) => wildcard.has(x));
}
