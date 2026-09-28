/**
 * Hostname extraction from raw text (HTML or JS source) via absolute URLs. Shared by html.ts and js.ts.
 *
 * Pure string processing with linear-time regexes; safe on multi-MB inputs.
 */

import { parse as parseDomain } from 'tldts';

export type HostScanMode = 'html' | 'js';

/**
 * Well-known hosts that appear in almost every bundle (spec links, licence headers, error-decoder URLs, xmlns
 * declarations) and never say anything about the watched site. Matching is by domain: an entry also covers its subdomains.
 */
export const JS_NOISE_DOMAINS: readonly string[] = [
  'w3.org',
  'reactjs.org',
  'react.dev',
  'fb.me',
  'github.com',
  'githubusercontent.com',
  'mozilla.org',
  'schema.org',
  'json-schema.org',
  'example.com',
  'example.org',
  'example.net',
  'tc39.es',
  'nodejs.org',
  'npmjs.com',
  'npmjs.org',
  'unpkg.com',
  'jsdelivr.net',
  'feross.org',
  'momentjs.com',
  'lodash.com',
  'sentry.io',
  'polyfill.io',
  'goo.gl',
  'bit.ly',
  // xmlns / namespace hosts
  'xmlns.com',
  'purl.org',
  'ns.adobe.com',
  'schemas.microsoft.com',
  'schemas.openxmlformats.org',
  'ogp.me',
  'rdfs.org',
  'inkscape.org',
  'sodipodi.sourceforge.net',
  // framework / tooling docs referenced from error messages and licence headers
  'nextjs.org',
  'vuejs.org',
  'svelte.dev',
  'angular.io',
  'angular.dev',
  'babeljs.io',
  'webpack.js.org',
  'vitejs.dev',
  'redux.js.org',
  'reactrouter.com',
  'tanstack.com',
  'emotion.sh',
  'whatwg.org',
  'ecma-international.org',
  'ietf.org',
  'unicode.org',
  'apache.org',
  'opensource.org',
  'gnu.org',
  'creativecommons.org',
  'mit-license.org',
];

/** Namespace-style hosts that are noise even in HTML (xmlns declarations, schema.org microdata, RFC example domains). */
export const HTML_NOISE_DOMAINS: readonly string[] = [
  'w3.org',
  'schema.org',
  'json-schema.org',
  'example.com',
  'example.org',
  'example.net',
  'xmlns.com',
  'purl.org',
  'ns.adobe.com',
  'schemas.microsoft.com',
  'schemas.openxmlformats.org',
  'ogp.me',
  'rdfs.org',
  'inkscape.org',
  'sodipodi.sourceforge.net',
];

/** Reserved / non-public TLDs that never resolve publicly. */
const RESERVED_TLDS = new Set(['test', 'invalid', 'example', 'localhost', 'local', 'internal', 'lan', 'home', 'corp']);

function domainSet(list: readonly string[]): Set<string> {
  return new Set(list.map((d) => d.toLowerCase()));
}
const JS_NOISE = domainSet(JS_NOISE_DOMAINS);
const HTML_NOISE = domainSet(HTML_NOISE_DOMAINS);

/** True if `host` or any parent domain of it is in `set`. */
function matchesDomainSet(host: string, set: Set<string>): boolean {
  let h = host;
  for (;;) {
    if (set.has(h)) return true;
    const dot = h.indexOf('.');
    if (dot === -1) return false;
    h = h.slice(dot + 1);
  }
}

/** Whether a (clean, lowercase) host is well-known noise for the given scan mode. */
export function isNoiseHost(host: string, mode: HostScanMode = 'js'): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '');
  const tld = h.slice(h.lastIndexOf('.') + 1);
  if (RESERVED_TLDS.has(tld)) return true;
  return matchesDomainSet(h, mode === 'js' ? JS_NOISE : HTML_NOISE);
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,24}|xn--[a-z0-9-]{1,59})$/;

/**
 * Validate & clean a raw host candidate: lowercase, strip trailing dots/hyphens, require ≥2 labels, a letters-only
 * (or punycode) TLD, and a suffix tldts knows (ICANN or private). Returns null when it is not a plausible public hostname.
 */
export function cleanHost(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const h = raw.toLowerCase().replace(/[.-]+$/, '');
  if (h.length < 4 || h.length > 253 || !h.includes('.')) return null;
  const labels = h.split('.');
  if (labels.length < 2) return null;
  for (const l of labels) if (!LABEL_RE.test(l)) return null;
  if (!TLD_RE.test(labels[labels.length - 1])) return null;
  try {
    const info = parseDomain(h, { allowPrivateDomains: true, extractHostname: false });
    if (info.isIp || !(info.isIcann || info.isPrivate)) return null;
    // A bare public suffix ("co.uk", "vercel.app") is not a host.
    if (!info.domain) return null;
  } catch {
    return null;
  }
  return h;
}

/**
 * `scheme://host` (http, https, ws, wss), bare `//host`, and the JSON-escaped `\/\/host` forms, with optional userinfo.
 * Bounded quantifiers keep this linear on arbitrary input.
 */
const URL_HOST_RE = /(?:\b(https?|wss?):)?(?:\\?\/){2}(?:[^\s/\\@"'<>`]{1,64}@)?([a-z0-9][a-z0-9.-]{0,252})/gi;

const JS_BARE_PRECEDERS = new Set(['"', "'", '`']);
const HTML_BARE_PRECEDERS = new Set(['"', "'", '`', '(', '=']);

/**
 * Hostnames referenced by absolute URLs in `text`, lowercase, deduped & sorted, capped at `limit`.
 * A scheme-less `//host` only counts when immediately preceded by a quote (JS) or a quote, "(" or "=" (HTML) — this
 * rejects `//comment.like` code comments. Noise hosts for the mode are excluded.
 */
export function scanHosts(text: string, mode: HostScanMode, limit = 500): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const bare = mode === 'js' ? JS_BARE_PRECEDERS : HTML_BARE_PRECEDERS;
  const seen = new Map<string, string | null>();
  const out = new Set<string>();
  const re = new RegExp(URL_HOST_RE.source, URL_HOST_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!m[1]) {
      const prev = m.index > 0 ? text[m.index - 1] : '';
      if (!bare.has(prev)) continue;
    }
    const raw = m[2];
    let host = seen.get(raw);
    if (host === undefined) {
      host = cleanHost(raw);
      if (host && isNoiseHost(host, mode)) host = null;
      // Bound memory on adversarial input with endless unique junk candidates.
      if (seen.size < 50_000) seen.set(raw, host);
    }
    if (host) {
      out.add(host);
      // Collect a generous superset, then sort & cap, so the cap is deterministic-ish without unbounded memory.
      if (out.size >= limit * 4) break;
    }
  }
  return [...out].sort().slice(0, limit);
}
