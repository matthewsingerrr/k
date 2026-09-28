/**
 * Static analysis of JavaScript bundles ("code intel"): route-like paths and hostnames referenced in code.
 *
 * Pure string processing (no JS parser dependency). Every regex is linear-time (bounded quantifiers, no nested
 * repetition), so multi-MB minified bundles are scanned in a few tens of milliseconds.
 */

import type { JsAnalysis } from '../types.js';
import { scanHosts } from './hosts.js';

export const MAX_JS_PATHS = 3000;
export const MAX_JS_HOSTS = 500;

/**
 * A quote, then a path literal that is the WHOLE string content, then the same quote (optionally backslash-escaped, for
 * JSON embedded in strings). Anchoring on the quote pair instead of tokenizing strings means a mis-tokenized regex literal
 * (e.g. /["']/) can never shift quote parity and hide later literals.
 */
const PATH_LITERAL_RE = /(["'`])(\/[A-Za-z0-9][A-Za-z0-9\-._~/[\]%:@]{0,119})\\?\1/g;

const ASSET_EXTS = new Set([
  'js', 'mjs', 'cjs', 'css', 'map', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'woff', 'woff2', 'ttf', 'otf',
  'eot', 'mp4', 'webm', 'mp3', 'wav', 'json', 'txt', 'xml', 'wasm', 'html', 'htm',
]);

const EXCLUDED_PREFIXES = ['/_next/', '/_nuxt/', '/static/', '/assets/', '/node_modules/', '/cdn-cgi/', '/__', '/@'];

/** Common regex flag groups: "/foo/gi" is a regex source, not a route. Kept explicit so "/my" or "/us" survive. */
const REGEX_FLAG_SEGMENTS = new Set(['g', 'i', 'm', 'gi', 'ig', 'gm', 'mg', 'gim', 'gmi', 'gu', 'giu', 'gs', 'gy']);

/** Single-segment literals that are units / rate suffixes ("$10" + "/month"), not routes. */
const UNIT_WORDS = new Set([
  'mo', 'yr', 'hr', 'min', 'mins', 'sec', 'secs', 'ms', 'px', 'em', 'rem', 'vh', 'vw', 'day', 'days', 'wk', 'week', 'weeks',
  'month', 'months', 'year', 'years', 'hour', 'hours', 'kb', 'mb', 'gb', 'tb',
]);

/** "[slug]", "[[...slug]]", "[...all]" — Next.js-style dynamic segments. */
const DYNAMIC_SEGMENT_RE = /^\[{1,2}(?:\.\.\.)?[A-Za-z_][A-Za-z0-9_-]*\]{1,2}$/;

function looksLikeRegex(segs: string[]): boolean {
  for (const seg of segs) {
    if (seg.includes('[') || seg.includes(']')) {
      if (!DYNAMIC_SEGMENT_RE.test(seg)) return true;
      // "[a-z]" / "[0-9]" are character-class ranges, not route params.
      if (/\[[A-Za-z0-9]-[A-Za-z0-9]\]/.test(seg)) return true;
    }
  }
  return REGEX_FLAG_SEGMENTS.has(segs[segs.length - 1]);
}

/** Returns the cleaned route path (trailing slash removed) or null if the literal is not route-like. */
export function cleanRoutePath(raw: string): string | null {
  if (raw.length < 2 || raw.length > 120) return null;
  if (!/^\/[A-Za-z0-9][A-Za-z0-9\-._~/[\]%:@]*$/.test(raw)) return null;
  if (raw.includes('//')) return null;
  const lower = raw.toLowerCase();
  const lowerSlash = lower.endsWith('/') ? lower : lower + '/';
  for (const prefix of EXCLUDED_PREFIXES) if (lowerSlash.startsWith(prefix)) return null;

  const p = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const segs = p.slice(1).split('/');
  if (segs.length === 1 && segs[0].length < 2) return null;

  const last = segs[segs.length - 1];
  const dot = last.lastIndexOf('.');
  if (dot !== -1 && ASSET_EXTS.has(last.slice(dot + 1).toLowerCase())) return null;

  // "/1/2", "/2024", "/1.0.3" — numbers & versions, not routes.
  if (segs.every((s) => /^[\d.:_~-]+$/.test(s))) return null;
  // printf-style "/%s" or broken escapes.
  if (/%(?![0-9A-Fa-f]{2})/.test(p)) return null;
  if (looksLikeRegex(segs)) return null;
  if (segs.length === 1 && UNIT_WORDS.has(segs[0].toLowerCase())) return null;
  return p;
}

/**
 * Extract from minified JS source:
 * - paths: string literals (quoted with ', ", or `) whose whole content is a route-like path:
 *     /^\/[A-Za-z0-9][A-Za-z0-9\-._~\/\[\]%:@]*$/ , length 2..120, no "//" anywhere, not ending in an asset/file extension
 *     (js, mjs, css, map, png, jpg, jpeg, gif, svg, webp, avif, ico, woff, woff2, ttf, otf, eot, mp4, webm, mp3, wav, json, txt, xml, wasm, html, htm),
 *     not starting with /_next/, /_nuxt/, /static/, /assets/, /node_modules/, /cdn-cgi/, /__, /@,
 *     not a regex-looking literal, not all-digits segments like "/1/2", and not a single segment shorter than 2 chars after the slash.
 *     Also include path parts of absolute same-looking URLs? NO — only bare path literals.
 *     Also include template-literal prefixes like `/docs/${x}` → "/docs/" is NOT included (contains ${); skip template literals with ${.
 * - hosts: hostnames from absolute URLs in the source: (https?|wss?):\/\/<host>(:port)? and also "//<host>" only when preceded by a quote.
 *     host must contain a dot and a valid TLD-like last label (letters, 2..24), lowercase, strip trailing dot.
 *     Exclude well-known noise: w3.org, www.w3.org, reactjs.org, react.dev, fb.me, github.com, githubusercontent.com hosts,
 *     mozilla.org, developer.mozilla.org, schema.org, json-schema.org, example.com, example.org, localhost, tc39.es, nodejs.org,
 *     npmjs.com, unpkg.com, jsdelivr.net hosts, feross.org, momentjs.com, lodash.com, sentry.io and *.sentry.io, polyfill.io,
 *     goo.gl, bit.ly, xmlns hosts, and any host ending in ".test" or ".invalid".
 * Both arrays sorted & deduped. Cap: 3000 paths, 500 hosts.
 *
 * Paths are returned without a trailing slash ("/docs/" → "/docs"). Hosts must also have a public suffix known to the PSL,
 * and the noise list is extended with framework-docs / licence hosts (see JS_NOISE_DOMAINS in hosts.ts).
 */
export function analyzeJs(source: string): JsAnalysis {
  if (typeof source !== 'string' || source.length === 0) return { paths: [], hosts: [] };
  const paths = new Set<string>();
  try {
    const re = new RegExp(PATH_LITERAL_RE.source, PATH_LITERAL_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const p = cleanRoutePath(m[2]);
      if (p) {
        paths.add(p);
        if (paths.size >= MAX_JS_PATHS * 4) break;
      }
    }
  } catch {
    // Pure string scanning should not throw; stay total regardless.
  }
  let hosts: string[] = [];
  try {
    hosts = scanHosts(source, 'js', MAX_JS_HOSTS);
  } catch {
    hosts = [];
  }
  return { paths: [...paths].sort().slice(0, MAX_JS_PATHS), hosts };
}
