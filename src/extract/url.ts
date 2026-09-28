/**
 * URL normalization & classification.
 *
 * Every function here is pure and total: bad input yields null / 'skip' / false / a best-effort string, never an exception.
 */

import { isIP } from 'node:net';
import { domainToUnicode } from 'node:url';
import { getDomain } from 'tldts';
import type { Watch } from '../types.js';

/** URLs longer than this are treated as junk (data blobs, tracking payloads). */
const MAX_URL_LENGTH = 8192;

const TRACKING_PARAMS = new Set([
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  '_hsenc',
  '_hsmi',
  'igshid',
  'si',
]);

function isHttpProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:';
}

function safeDecodeComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function safeDecodeUri(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** Lowercase, trim, strip trailing dots. */
function cleanHostname(host: string): string {
  if (typeof host !== 'string') return '';
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

function isIpLiteral(host: string): boolean {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return isIP(h) !== 0;
}

function normalizePath(pathname: string): string {
  let p = pathname || '/';
  if (!p.startsWith('/')) p = '/' + p;
  // Loop until stable so that e.g. "/a/index.html/" → "/a" in one call (idempotency).
  for (;;) {
    const before = p;
    p = p.replace(/\/{2,}/g, '/');
    p = p.replace(/\/index\.html?$/i, '/');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    if (p === before) break;
  }
  return p || '/';
}

function normalizeQuery(search: string): string {
  if (!search || search === '?') return '';
  const kept: Array<{ key: string; raw: string }> = [];
  for (const raw of search.slice(1).split('&')) {
    if (!raw) continue;
    const eq = raw.indexOf('=');
    const rawKey = eq === -1 ? raw : raw.slice(0, eq);
    const key = safeDecodeComponent(rawKey.replace(/\+/g, ' ')).toLowerCase();
    if (key.startsWith('utm_') || TRACKING_PARAMS.has(key)) continue;
    kept.push({ key: rawKey, raw });
  }
  if (kept.length === 0) return '';
  // Array.prototype.sort is stable, so repeated keys keep their relative order.
  kept.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return '?' + kept.map((k) => k.raw).join('&');
}

function parseUrl(raw: string, base?: string): URL | null {
  try {
    return base ? new URL(raw, base) : new URL(raw);
  } catch {
    if (!base) return null;
    // An invalid base must not prevent absolute URLs from parsing.
    try {
      return new URL(raw);
    } catch {
      return null;
    }
  }
}

/**
 * Normalize a URL for identity/dedup. Returns null for unparseable or non-http(s) URLs (mailto:, javascript:, data:, tel:, etc).
 * - Resolve relative to `base` if given.
 * - Lowercase scheme & hostname; drop default ports (:80 for http, :443 for https); drop username/password.
 * - Drop the fragment (#...).
 * - Remove tracking params: utm_*, gclid, fbclid, mc_cid, mc_eid, ref, ref_src, _hsenc, _hsmi, igshid, si. Sort remaining params by key (stable).
 *   Drop a trailing "?" if no params remain.
 * - Pathname: collapse duplicate slashes, decode unreserved percent-escapes where safe is NOT required (leave as URL gives),
 *   remove a trailing slash unless path is "/" (so "https://a.io/docs/" → "https://a.io/docs", "https://a.io" → "https://a.io/").
 * - Remove "/index.html" / "/index.htm" suffix (→ parent path with same trailing-slash rule).
 *
 * Also strips a trailing dot from the hostname ("unpeg.io." → "unpeg.io"). Idempotent: normalize(normalize(x)) === normalize(x).
 */
export function normalizeUrl(raw: string, base?: string): string | null {
  if (typeof raw !== 'string') return null;
  const input = raw.trim();
  if (!input || input.length > MAX_URL_LENGTH) return null;
  const u = parseUrl(input, typeof base === 'string' && base ? base : undefined);
  if (!u || !isHttpProtocol(u.protocol)) return null;
  const hostname = u.hostname.replace(/\.+$/, '');
  if (!hostname) return null;
  const host = u.port ? `${hostname}:${u.port}` : hostname;
  return `${u.protocol}//${host}${normalizePath(u.pathname)}${normalizeQuery(u.search)}`;
}

/**
 * Registrable domain for a hostname via tldts getDomain (e.g. "docs.unpeg.io" → "unpeg.io", "a.b.co.uk" → "b.co.uk").
 * For IP addresses, "localhost", or anything tldts can't resolve, return the lowercase hostname itself.
 *
 * PSL private suffixes are honoured ("myapp.vercel.app" → "myapp.vercel.app", not "vercel.app"), so subdomain discovery
 * never targets a whole hosting platform.
 */
export function getRootDomain(hostname: string): string {
  const h = cleanHostname(hostname);
  if (!h) return '';
  if (h === 'localhost' || isIpLiteral(h)) return h;
  try {
    const d = getDomain(h, { allowPrivateDomains: true });
    return d ? d.toLowerCase() : h;
  } catch {
    return h;
  }
}

/** True if `host` equals `rootDomain` or is a subdomain of it (case-insensitive, ignores a trailing dot). */
export function isUnderDomain(host: string, rootDomain: string): boolean {
  const h = cleanHostname(host);
  const r = cleanHostname(rootDomain);
  if (!h || !r) return false;
  return h === r || h.endsWith('.' + r);
}

export type UrlClass = 'page' | 'file' | 'asset' | 'skip';

const FILE_EXTS = new Set([
  'pdf', 'txt', 'md', 'markdown', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'rtf', 'odt', 'epub',
]);
const ASSET_EXTS = new Set([
  'js', 'mjs', 'cjs', 'css', 'map', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg',
  'ico', 'bmp', 'tiff', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a', 'wasm', 'webmanifest',
]);
const SKIP_EXTS = new Set([
  'zip', 'gz', 'tgz', 'rar', '7z', 'dmg', 'exe', 'msi', 'apk', 'ipa', 'iso', 'bin', 'xml', 'rss', 'atom',
]);
const PAGE_EXTS = new Set(['html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'shtml', 'xhtml', 'cfm']);

/** Lowercase extension of the last path segment ("" if none). */
function extensionOf(lowerPath: string): string {
  const seg = lowerPath.slice(lowerPath.lastIndexOf('/') + 1);
  const dot = seg.lastIndexOf('.');
  if (dot <= 0 || dot === seg.length - 1) return '';
  const ext = seg.slice(dot + 1);
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : '';
}

/**
 * Classify a URL by its pathname extension (case-insensitive):
 * - 'file': pdf, txt, md, markdown, doc, docx, xls, xlsx, csv, ppt, pptx, rtf, odt, epub, json (only if path contains "/.well-known/" or ends with "manifest.json" → 'asset' instead; other .json → 'file'), zip? NO → zip is 'skip'.
 * - 'asset': js, mjs, cjs, css, map, woff, woff2, ttf, otf, eot, png, jpg, jpeg, gif, webp, avif, svg, ico, bmp, tiff, mp4, webm, mov, mp3, wav, ogg, m4a, wasm, webmanifest.
 * - 'skip': zip, gz, tgz, rar, 7z, dmg, exe, msi, apk, ipa, iso, bin, xml (sitemaps are handled separately), rss, atom, and any URL whose path starts with /cdn-cgi/, /wp-json/, /wp-admin/, /_next/, /_nuxt/, /static/ (last three only when they have an asset extension or no extension? → treat /_next/ and /_nuxt/ always as 'asset').
 * - otherwise 'page' (no extension, .html, .htm, .php, .asp, .aspx, .jsp, or any unknown extension).
 *
 * Resolution of the /static/ case: extension rules apply first (so /static/whitepaper.pdf is a 'file'); an extension-less or
 * unknown-extension URL under /static/ is an 'asset'. Unparseable or non-http(s) URLs are 'skip'.
 */
export function classifyUrl(url: string): UrlClass {
  if (typeof url !== 'string' || !url.trim()) return 'skip';
  let pathname: string;
  try {
    const u = new URL(url.trim(), 'http://placeholder.invalid/');
    if (!isHttpProtocol(u.protocol)) return 'skip';
    pathname = u.pathname;
  } catch {
    return 'skip';
  }
  const lower = pathname.toLowerCase();
  if (/^\/(?:cdn-cgi|wp-json|wp-admin)(?:\/|$)/.test(lower)) return 'skip';
  if (/^\/(?:_next|_nuxt)(?:\/|$)/.test(lower)) return 'asset';
  const ext = extensionOf(lower);
  if (ext === 'json') {
    return lower.includes('/.well-known/') || lower.endsWith('manifest.json') ? 'asset' : 'file';
  }
  if (FILE_EXTS.has(ext)) return 'file';
  if (ASSET_EXTS.has(ext)) return 'asset';
  if (SKIP_EXTS.has(ext)) return 'skip';
  if (lower.startsWith('/static/') && !PAGE_EXTS.has(ext)) return 'asset';
  return 'page';
}

/** URLs longer than this are never in scope (junk crawl targets); user exclude regexes never run over them. */
export const MAX_SCOPED_URL_CHARS = 2048;

const regexCache = new Map<string, RegExp | null>();
const REGEX_CACHE_MAX = 1000;

/** Compile a user-supplied exclude pattern (flag "i"); null if invalid. Cached. */
/**
 * A path glob like "/profile/*" or "/blog/**" (starts with "/", contains "*", only URL path characters, no regex ".*").
 * Anything else is treated as a regular expression.
 */
export function isPathGlob(source: string): boolean {
  return typeof source === 'string' && source.startsWith('/') && source.includes('*') && !source.includes('.*') && /^[A-Za-z0-9\-._~%!$&'()+,;=:@\/*]+$/.test(source);
}

/**
 * Compile a user URL pattern (exclude rule). Path globs match the URL's path: "*" = one path segment (or part of one),
 * "**" = anything, and a trailing "/*" covers everything below that folder at any depth ("/profile/*" matches
 * "/profile/alice" and "/profile/alice/posts", but not "/profile" itself). Other patterns are case-insensitive regexes
 * tested against the full URL. Invalid regexes → null.
 */
export function compileUrlPattern(source: string): RegExp | null {
  if (typeof source !== 'string' || !source) return null;
  if (isPathGlob(source)) {
    let glob = source;
    let tail = '';
    if (glob.endsWith('/*') && !glob.endsWith('/**')) {
      glob = glob.slice(0, -2);
      tail = '/.+';
    }
    const body = glob
      .split(/(\*\*|\*)/)
      .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    try {
      return new RegExp(`^[a-z][a-z0-9+.-]*://[^/?#]+${body}${tail}/?(?:[?#].*)?$`, 'i');
    } catch {
      return null;
    }
  }
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}

function compileExclude(source: string): RegExp | null {
  const cached = regexCache.get(source);
  if (cached !== undefined) return cached;
  let re: RegExp | null = null;
  try {
    re = source ? compileUrlPattern(source) : null;
  } catch {
    re = null;
  }
  if (regexCache.size >= REGEX_CACHE_MAX) regexCache.clear();
  regexCache.set(source, re);
  return re;
}

/** "/docs/" → "/docs"; "docs" → "/docs"; "", "/" or null → null (whole host). */
function normalizeScopePath(scopePath: string | null | undefined): string | null {
  if (typeof scopePath !== 'string') return null;
  let p = scopePath.trim();
  if (!p) return null;
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return p ? p : null;
}

/**
 * Whether a normalized URL belongs to a watch's crawl scope:
 * same hostname as watch.host (exact, case-insensitive; port must also match the start URL's port if any),
 * pathname starts with watch.scopePath when set (prefix at a segment boundary: "/docs" matches "/docs" and "/docs/x" not "/docsx"),
 * and no watch.excludePatterns rule matches (a path glob like "/profile/*", or a regex tested on the full URL; see
 * compileUrlPattern). Invalid regexes are ignored.
 * URLs with a query string are in scope only if `allowQuery` is true (default false) — avoids infinite crawl spaces.
 *
 * Ports are compared exactly as URL reports them ("" for the scheme default), so a watch on http://127.0.0.1:8080/ only
 * matches :8080 URLs and a watch on https://a.io/ does not match https://a.io:8443/.
 */
export function inScope(
  url: string,
  watch: Pick<Watch, 'url' | 'host' | 'scopePath' | 'excludePatterns'>,
  allowQuery = false,
): boolean {
  if (typeof url !== 'string' || !watch) return false;
  if (url.length > MAX_SCOPED_URL_CHARS) return false;
  const u = parseUrl(url.trim());
  if (!u || !isHttpProtocol(u.protocol)) return false;
  if (cleanHostname(u.hostname) !== cleanHostname(watch.host ?? '')) return false;
  const start = parseUrl(typeof watch.url === 'string' ? watch.url : '');
  if (u.port !== (start ? start.port : '')) return false;
  if (!allowQuery && u.search && u.search !== '?') return false;
  const scope = normalizeScopePath(watch.scopePath);
  if (scope && !(u.pathname === scope || u.pathname.startsWith(scope + '/'))) return false;
  const patterns = Array.isArray(watch.excludePatterns) ? watch.excludePatterns : [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    const re = compileExclude(pattern);
    if (re && re.test(url)) return false;
  }
  return true;
}

export interface ParsedWatchInput {
  /** Normalized start URL. */
  url: string;
  /** Lowercase hostname (no port). */
  host: string;
  rootDomain: string;
  /** Suggested display name: registrable-domain label capitalized ("unpeg.io" → "Unpeg"), or hostname for IPs. */
  suggestedName: string;
}

const HOST_LABEL_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/**
 * Parse user input like "unpeg.io", "https://unpeg.io/docs", "http://localhost:8080/" into a watch target.
 * Adds "https://" if no scheme. Rejects (returns null) non-http(s) schemes, hostnames without a dot
 * (except "localhost" and IP literals), and strings with spaces.
 *
 * Also accepts Discord's link-suppression form "<https://unpeg.io>" and "host:port" without a scheme.
 */
export function parseWatchInput(input: string): ParsedWatchInput | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  if (!s || /\s/.test(s) || s.length > 2048) return null;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== 'http' && name !== 'https') {
      // "localhost:8080" / "unpeg.io:443/x" look like a scheme but are host:port.
      if (!/^\d/.test(s.slice(scheme[0].length))) return null;
      s = 'https://' + s;
    }
  } else {
    s = 'https://' + s.replace(/^\/+/, '');
  }

  const url = normalizeUrl(s);
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = cleanHostname(u.hostname);
  if (!host) return null;
  const ip = isIpLiteral(host);
  if (!ip && host !== 'localhost') {
    if (!host.includes('.')) return null;
    const labels = host.split('.');
    if (!labels.every((l) => HOST_LABEL_RE.test(l))) return null;
  }

  const rootDomain = getRootDomain(host);
  let suggestedName = host;
  if (!ip && host !== 'localhost') {
    const label = rootDomain.split('.')[0] || host;
    if (/^\d+$/.test(label)) {
      // "123.com": an all-digit name would read like an IPv4 number (and like a watch id) — use the domain itself.
      suggestedName = rootDomain;
    } else {
      let pretty = label;
      // Only punycode labels need decoding; the WHATWG host parser would turn other labels into IPv4 numbers.
      if (/^xn--/i.test(label)) {
        try {
          pretty = domainToUnicode(label) || label;
        } catch {
          pretty = label;
        }
      }
      suggestedName = pretty.charAt(0).toUpperCase() + pretty.slice(1);
    }
  }
  return { url, host, rootDomain, suggestedName };
}

/**
 * Pretty short form of a URL for display: host + path (+ "?query"), no scheme, no trailing slash except root ("unpeg.io/docs/faq").
 * The root is shown as "unpeg.io/". Percent-escapes in the path are decoded for readability. Invalid input is returned trimmed.
 */
export function displayUrl(url: string): string {
  if (typeof url !== 'string') return '';
  const u = parseUrl(url.trim());
  if (!u) return url.trim();
  let path = u.pathname || '/';
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  const search = u.search && u.search !== '?' ? u.search : '';
  return u.host + safeDecodeUri(path) + search;
}

/** Path + query of a URL for compact lists ("/docs/faq"); "/" for root. Raw (not decoded); invalid input → itself if it looks like a path, else "/". */
export function urlPath(url: string): string {
  if (typeof url !== 'string') return '/';
  const u = parseUrl(url.trim());
  if (!u) return url.trim().startsWith('/') ? url.trim() : '/';
  const search = u.search && u.search !== '?' ? u.search : '';
  return (u.pathname || '/') + search;
}

/** Filename part of a URL path ("https://a.io/x/whitepaper.pdf" → "whitepaper.pdf"; root → host). */
export function urlFilename(url: string): string {
  if (typeof url !== 'string') return '';
  const u = parseUrl(url.trim());
  if (!u) {
    const parts = url.trim().split(/[?#]/)[0].split('/').filter(Boolean);
    return parts.length ? safeDecodeComponent(parts[parts.length - 1]) : url.trim();
  }
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length === 0) return u.host;
  return safeDecodeComponent(segs[segs.length - 1]);
}
