/**
 * robots.txt & sitemap discovery.
 *
 * Regex/simple parsing (no XML dependency). All scanning is linear-time with bounded quantifiers, so a hostile or broken
 * sitemap cannot stall the process.
 */

import { createGunzip } from 'node:zlib';
import type { FetchResult, HttpClient } from '../net/http.js';
import { normalizeUrl } from './url.js';

const MAX_ROBOTS_SITEMAPS = 50;
/** Max bytes fetched per sitemap document (the protocol allows 50MB uncompressed; we read less to stay small). */
const SITEMAP_MAX_BYTES = 10 * 1024 * 1024;
/** Max decompressed bytes for gzip sitemaps. */
const GUNZIP_MAX_BYTES = 20 * 1024 * 1024;
/** Longest <loc> value accepted (real URLs are far shorter; bigger means a broken document). */
const MAX_LOC_CHARS = 8192;
const FETCH_BATCH = 4;
const SITEMAP_ACCEPT = 'application/xml,text/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5';

function isHttpUrl(u: URL): boolean {
  return u.protocol === 'http:' || u.protocol === 'https:';
}

/** Parse robots.txt: absolute "Sitemap:" URLs (case-insensitive directive, resolved against base). */
export function parseRobots(text: string, base: string): { sitemaps: string[] } {
  const sitemaps: string[] = [];
  if (typeof text !== 'string' || !text) return { sitemaps };
  const seen = new Set<string>();
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  for (const line of lines) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (!m) continue;
    let href: string;
    try {
      const u = new URL(m[1], base);
      if (!isHttpUrl(u)) continue;
      u.hash = '';
      href = u.href;
    } catch {
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    sitemaps.push(href);
    if (sitemaps.length >= MAX_ROBOTS_SITEMAPS) break;
  }
  return { sitemaps };
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|([a-zA-Z]{2,4}));/g, (whole, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const cp = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return whole;
    try {
      return String.fromCodePoint(cp);
    } catch {
      return whole;
    }
  });
}

/** Finds the root element of a sitemap-ish document; null if it is not one (e.g. an HTML 404 page). */
function findSitemapRoot(xml: string): { prefix: string; index: boolean } | null {
  const head = xml.slice(0, 64 * 1024);
  const m = /<([A-Za-z_][\w.-]*:)?(urlset|sitemapindex)\b/i.exec(head);
  if (!m) return null;
  // An HTML document that merely mentions the tag is not a sitemap.
  if (/<html[\s>]|<!doctype\s+html/i.test(head.slice(0, m.index))) return null;
  return { prefix: (m[1] ?? '').toLowerCase(), index: m[2].toLowerCase() === 'sitemapindex' };
}

/**
 * Parse a sitemap XML document (urlset or sitemapindex). Extract <loc> values (handle CDATA, XML entities &amp; &lt; &gt; &quot; &apos;,
 * surrounding whitespace, and namespaced tags like <ns:loc>). If the root is <sitemapindex>, locs go to `sitemaps`; otherwise to `urls`.
 * Non-XML input (e.g. an HTML 404 page) → both empty.
 *
 * Only the first <loc> of each <url>/<sitemap> entry with the root element's namespace prefix is taken, so extension
 * tags such as <image:loc> / <video:loc> are ignored. Numeric character references are decoded too.
 */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const empty = { urls: [] as string[], sitemaps: [] as string[] };
  if (typeof xml !== 'string' || xml.length === 0) return empty;
  try {
    const root = findSitemapRoot(xml);
    if (!root) return empty;
    const locs: string[] = [];
    const tagRe = /<(\/?)([A-Za-z_][\w.-]*:)?(url|sitemap|loc)\b[^<>]{0,512}>/gi;
    // First position of each closing tag at/after the last lookup: keeps close-tag searches linear overall even when
    // many <loc> elements are unclosed.
    const closeCache = new Map<string, number>();
    const findClose = (closeTag: string, from: number): number => {
      const cached = closeCache.get(closeTag);
      if (cached !== undefined && (cached === -1 || cached >= from)) return cached;
      const pos = xml.indexOf(closeTag, from);
      closeCache.set(closeTag, pos);
      return pos;
    };
    let entryOpen = false;
    let entryHasLoc = false;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(xml)) !== null) {
      const closing = m[1] === '/';
      const prefix = (m[2] ?? '').toLowerCase();
      const tag = m[3].toLowerCase();
      if (tag !== 'loc') {
        if (prefix !== root.prefix) continue;
        entryOpen = !closing;
        entryHasLoc = false;
        continue;
      }
      if (closing || m[0].endsWith('/>')) continue;
      const valueStart = tagRe.lastIndex;
      const end = findClose(`</${m[2] ?? ''}${m[3]}`, valueStart);
      if (end === -1) break;
      if (end - valueStart > MAX_LOC_CHARS) continue;
      tagRe.lastIndex = end;
      if (prefix !== root.prefix || (entryOpen && entryHasLoc)) continue;
      let value = xml.slice(valueStart, end).trim();
      const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(value);
      value = cdata ? cdata[1].trim() : decodeXmlEntities(value).trim();
      if (!value) continue;
      locs.push(value);
      if (entryOpen) entryHasLoc = true;
    }
    return root.index ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
  } catch {
    return empty;
  }
}

/** Plain-text sitemap (one absolute URL per line, as allowed by sitemaps.org). Empty unless every line is an http(s) URL. */
function parseTextSitemap(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!/^https?:\/\/\S+$/i.test(line)) return [];
    out.push(line);
    if (out.length > 50_000) break;
  }
  return out;
}

function isGzip(buf: Buffer | null): boolean {
  return !!buf && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** Streaming gunzip with an output cap; truncated/corrupt input yields whatever decompressed cleanly. */
function gunzipCapped(buf: Buffer, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, Math.min(size, maxBytes)));
    };
    let gz: ReturnType<typeof createGunzip>;
    try {
      gz = createGunzip();
    } catch {
      resolve(Buffer.alloc(0));
      return;
    }
    gz.on('data', (chunk: Buffer) => {
      if (done) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size >= maxBytes) {
        finish();
        gz.destroy();
      }
    });
    gz.on('end', finish);
    gz.on('error', finish);
    gz.on('close', finish);
    gz.end(buf);
  });
}

async function bodyAsText(res: FetchResult): Promise<string | null> {
  if (isGzip(res.body)) {
    const out = await gunzipCapped(res.body as Buffer, GUNZIP_MAX_BYTES);
    return out.length ? out.toString('utf8') : null;
  }
  if (typeof res.bodyText === 'string') return res.bodyText;
  if (res.body && res.body.length) return res.body.toString('utf8');
  return null;
}

async function safeFetch(http: HttpClient, url: string, accept: string): Promise<FetchResult | null> {
  try {
    return await http.fetch(url, { accept, maxBytes: SITEMAP_MAX_BYTES });
  } catch {
    return null;
  }
}

/**
 * Discover page URLs for a site:
 * 1. GET <origin>/robots.txt (status 200 & text) → Sitemap: entries.
 * 2. Always also try <origin>/sitemap.xml and <origin>/sitemap_index.xml (dedupe).
 * 3. Fetch sitemaps breadth-first (only responses with status 200 whose body parses; gzip-compressed bodies (.gz / magic 1f8b) are
 *    gunzipped with zlib), following sitemap indexes, up to `maxSitemaps` documents total (default 20).
 * 4. Return normalized (normalizeUrl) unique page URLs, capped at `maxUrls` (default 5000), in discovery order.
 * Never throws; network failures just yield fewer URLs.
 *
 * When the start URL has a non-root path (e.g. docs hosted under "/docs"), "<origin><path>/sitemap.xml" is tried as well.
 * Plain-text sitemaps (one URL per line) referenced from robots.txt are accepted too. Sitemaps are fetched in small
 * parallel batches (the HttpClient enforces per-host concurrency); results are processed in queue order, so output order
 * is deterministic.
 */
export async function discoverSitemapUrls(
  http: HttpClient,
  startUrl: string,
  opts?: { maxUrls?: number; maxSitemaps?: number },
): Promise<string[]> {
  return (await discoverSitemap(http, startUrl, opts)).urls;
}

/**
 * A fetch that says nothing about whether the document exists: network error, 429, 5xx or a bot challenge. A 404 (or any
 * other definite answer) means "no such sitemap" and keeps the read complete.
 */
function transientFailure(res: FetchResult | null): boolean {
  if (!res) return true;
  return res.status === 0 || res.status === 429 || res.status >= 500 || res.blocked;
}

/**
 * Like discoverSitemapUrls, but also reports whether the read was `complete`: false when robots.txt or any sitemap
 * document failed transiently (see transientFailure), i.e. pages may be missing from `urls` only because of a hiccup —
 * callers must not treat the difference to a later complete read as news.
 */
export async function discoverSitemap(
  http: HttpClient,
  startUrl: string,
  opts?: { maxUrls?: number; maxSitemaps?: number },
): Promise<{ urls: string[]; complete: boolean }> {
  const maxUrls = Math.max(0, Math.floor(opts?.maxUrls ?? 5000));
  const maxSitemaps = Math.max(0, Math.floor(opts?.maxSitemaps ?? 20));
  const found: string[] = [];
  let complete = true;
  try {
    let start: URL;
    try {
      start = new URL(startUrl);
    } catch {
      return { urls: found, complete };
    }
    if (!isHttpUrl(start) || maxUrls === 0) return { urls: found, complete };
    const origin = start.origin;

    const queue: string[] = [];
    const queued = new Set<string>();
    const enqueue = (raw: string, base: string) => {
      let href: string;
      try {
        const u = new URL(raw, base);
        if (!isHttpUrl(u)) return;
        u.hash = '';
        href = u.href;
      } catch {
        return;
      }
      const key = normalizeUrl(href) ?? href;
      if (queued.has(key)) return;
      queued.add(key);
      queue.push(href);
    };

    const robots = await safeFetch(http, `${origin}/robots.txt`, 'text/plain,*/*;q=0.8');
    if (transientFailure(robots)) complete = false;
    if (robots && robots.status === 200) {
      const text = await bodyAsText(robots);
      if (text && !/^\s*</.test(text)) {
        for (const s of parseRobots(text, robots.finalUrl || `${origin}/robots.txt`).sitemaps) enqueue(s, origin);
      }
    }
    enqueue('/sitemap.xml', origin);
    enqueue('/sitemap_index.xml', origin);
    const dir = start.pathname.replace(/\/+$/, '');
    if (dir) enqueue(`${dir}/sitemap.xml`, origin);

    const seenUrls = new Set<string>();
    let fetched = 0;
    let qi = 0;
    while (qi < queue.length && fetched < maxSitemaps && found.length < maxUrls) {
      const batch = queue.slice(qi, qi + Math.min(FETCH_BATCH, maxSitemaps - fetched));
      qi += batch.length;
      fetched += batch.length;
      const results = await Promise.all(batch.map((u) => safeFetch(http, u, SITEMAP_ACCEPT)));
      for (let i = 0; i < batch.length; i++) {
        const res = results[i];
        if (transientFailure(res)) complete = false;
        if (!res || res.status !== 200) continue;
        const text = await bodyAsText(res);
        if (!text) continue;
        const base = res.finalUrl || batch[i];
        const parsed = parseSitemap(text);
        for (const s of parsed.sitemaps) enqueue(s, base);
        const urls = parsed.urls.length || findSitemapRoot(text) ? parsed.urls : parseTextSitemap(text);
        for (const raw of urls) {
          const n = normalizeUrl(raw, base);
          if (!n || seenUrls.has(n)) continue;
          seenUrls.add(n);
          found.push(n);
          if (found.length >= maxUrls) break;
        }
        if (found.length >= maxUrls) break;
      }
    }
  } catch {
    // Never throw: return whatever was discovered.
    complete = false;
  }
  return { urls: found.slice(0, maxUrls), complete };
}
