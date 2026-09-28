import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { FetchOptions, FetchResult, HttpClient } from '../src/net/http.js';
import { discoverSitemap, discoverSitemapUrls, parseRobots, parseSitemap } from '../src/extract/sitemap.js';

// ---------------------------------------------------------------------------
// Fake HTTP client (the real one is implemented elsewhere; tests never touch the network)
// ---------------------------------------------------------------------------

interface Route {
  status?: number;
  contentType?: string | null;
  body?: string | Buffer;
  /** Simulate an HttpClient that decodes text bodies (default: true for textual content types). */
  text?: boolean;
  throws?: boolean;
  finalUrl?: string;
}

function result(url: string, r: Route): FetchResult {
  const status = r.status ?? 200;
  const body = r.body === undefined ? null : Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body, 'utf8');
  const ct = r.contentType === undefined ? 'application/xml' : r.contentType;
  const textual = r.text ?? (ct === null || /text|xml|json/.test(ct));
  return {
    url,
    finalUrl: r.finalUrl ?? url,
    status,
    ok: status >= 200 && status < 300,
    notModified: false,
    redirected: false,
    headers: ct ? { 'content-type': ct } : {},
    contentType: ct,
    body,
    bodyText: textual && body ? body.toString('utf8') : null,
    truncated: false,
    blocked: false,
    retryAfterMs: null,
    error: status === 0 ? 'ECONNREFUSED' : null,
    elapsedMs: 1,
  };
}

function fakeHttp(routes: Record<string, Route>) {
  const calls: Array<{ url: string; opts?: FetchOptions }> = [];
  const http = {
    async fetch(url: string, opts?: FetchOptions): Promise<FetchResult> {
      calls.push({ url, opts });
      const r = routes[url];
      if (r?.throws) throw new Error('boom');
      if (!r) return result(url, { status: 404, contentType: 'text/html', body: '<!doctype html><title>404</title><h1>Not found</h1>' });
      return result(url, r);
    },
  };
  return { http: http as unknown as HttpClient, calls };
}

const urlset = (locs: string[], extra = '') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${extra}\n${locs
    .map((l) => `  <url><loc>${l}</loc><lastmod>2026-09-01</lastmod></url>`)
    .join('\n')}\n</urlset>`;
const sitemapIndex = (locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<sitemap><loc>${l}</loc></sitemap>`)
    .join('')}</sitemapindex>`;

// ---------------------------------------------------------------------------

describe('parseRobots', () => {
  it('extracts Sitemap directives case-insensitively and resolves them', () => {
    const txt = [
      '﻿User-agent: *',
      'Disallow: /admin # comment',
      'Sitemap: https://unpeg.io/sitemap.xml',
      'sitemap:/relative-sitemap.xml',
      '  SITEMAP :   https://cdn.unpeg.io/sm/pages.xml.gz   ',
      'Sitemap: https://unpeg.io/sitemap.xml',
      'Sitemap: ftp://unpeg.io/x.xml',
      'Sitemap:',
      '# Sitemap: https://unpeg.io/commented.xml',
      'Sitemap: https://unpeg.io/with#frag',
    ].join('\r\n');
    expect(parseRobots(txt, 'https://unpeg.io/robots.txt')).toEqual({
      sitemaps: [
        'https://unpeg.io/sitemap.xml',
        'https://unpeg.io/relative-sitemap.xml',
        'https://cdn.unpeg.io/sm/pages.xml.gz',
        'https://unpeg.io/with',
      ],
    });
  });

  it('never throws', () => {
    expect(parseRobots('', 'https://a.io/')).toEqual({ sitemaps: [] });
    expect(parseRobots(null as unknown as string, 'https://a.io/')).toEqual({ sitemaps: [] });
    expect(parseRobots('Sitemap: /x.xml', 'not a base')).toEqual({ sitemaps: [] });
    expect(parseRobots('<html><body>not robots</body></html>', 'https://a.io/')).toEqual({ sitemaps: [] });
  });
});

describe('parseSitemap', () => {
  it('parses a urlset', () => {
    expect(parseSitemap(urlset(['https://a.io/', 'https://a.io/docs']))).toEqual({
      urls: ['https://a.io/', 'https://a.io/docs'],
      sitemaps: [],
    });
  });

  it('parses a sitemapindex into sitemaps', () => {
    expect(parseSitemap(sitemapIndex(['https://a.io/s1.xml', 'https://a.io/s2.xml.gz']))).toEqual({
      urls: [],
      sitemaps: ['https://a.io/s1.xml', 'https://a.io/s2.xml.gz'],
    });
  });

  it('handles CDATA, entities, whitespace and numeric references', () => {
    const xml = urlset([
      '<![CDATA[https://a.io/cdata?a=1&b=2]]>',
      '\n   https://a.io/entities?a=1&amp;b=&lt;2&gt;&amp;c=&quot;x&quot;&amp;d=&apos;y&apos;   \n',
      'https://a.io/num&#38;&#x26;',
      '  <![CDATA[  https://a.io/cdata-ws  ]]>  ',
    ]);
    expect(parseSitemap(xml).urls).toEqual([
      'https://a.io/cdata?a=1&b=2',
      `https://a.io/entities?a=1&b=<2>&c="x"&d='y'`,
      'https://a.io/num&&',
      'https://a.io/cdata-ws',
    ]);
  });

  it('handles namespace-prefixed tags and ignores image/video/xhtml extension locs', () => {
    const prefixed = `<?xml version="1.0"?><sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://a.io/p1</sm:loc></sm:url><sm:url><sm:loc>https://a.io/p2</sm:loc></sm:url></sm:urlset>`;
    expect(parseSitemap(prefixed).urls).toEqual(['https://a.io/p1', 'https://a.io/p2']);

    const images = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml">
      <url><image:image><image:loc>https://a.io/img1.png</image:loc></image:image><loc>https://a.io/gallery</loc><xhtml:link rel="alternate" hreflang="de" href="https://a.io/de/gallery"/></url>
      <url><loc>https://a.io/video</loc><video:video><video:content_loc>https://a.io/v.mp4</video:content_loc><video:player_loc>https://a.io/player</video:player_loc></video:video></url>
    </urlset>`;
    expect(parseSitemap(images).urls).toEqual(['https://a.io/gallery', 'https://a.io/video']);
  });

  it('takes only the first loc per entry', () => {
    const xml = '<urlset><url><loc>https://a.io/1</loc><loc>https://a.io/dup</loc></url><url><loc>https://a.io/2</loc></url></urlset>';
    expect(parseSitemap(xml).urls).toEqual(['https://a.io/1', 'https://a.io/2']);
  });

  it('non-XML input yields nothing', () => {
    const html404 = '<!doctype html><html><head><title>404</title></head><body><h1>Not found</h1><pre>&lt;urlset&gt;</pre></body></html>';
    expect(parseSitemap(html404)).toEqual({ urls: [], sitemaps: [] });
    const htmlMentioning = '<!DOCTYPE html><html><body><urlset><loc>https://a.io/x</loc></urlset></body></html>';
    expect(parseSitemap(htmlMentioning)).toEqual({ urls: [], sitemaps: [] });
    expect(parseSitemap('{"urls":["https://a.io/"]}')).toEqual({ urls: [], sitemaps: [] });
    expect(parseSitemap('https://a.io/\nhttps://a.io/b')).toEqual({ urls: [], sitemaps: [] });
    expect(parseSitemap('')).toEqual({ urls: [], sitemaps: [] });
    expect(parseSitemap(undefined as unknown as string)).toEqual({ urls: [], sitemaps: [] });
  });

  it('tolerates leading junk, comments and truncated documents', () => {
    const xml = `\n\n<!-- generated -->\n<?xml version="1.0"?>\n<urlset><url><loc>https://a.io/ok</loc></url><url><loc>https://a.io/cut`;
    expect(parseSitemap(xml).urls).toEqual(['https://a.io/ok']);
  });

  it('is linear on many unclosed locs', () => {
    const xml = '<urlset>' + '<url><loc>https://a.io/x'.repeat(100_000);
    const t0 = performance.now();
    expect(parseSitemap(xml)).toEqual({ urls: [], sitemaps: [] });
    expect(performance.now() - t0).toBeLessThan(1000);
    const big = urlset(Array.from({ length: 50_000 }, (_, i) => `https://a.io/p/${i}`));
    const t1 = performance.now();
    expect(parseSitemap(big).urls).toHaveLength(50_000);
    expect(performance.now() - t1).toBeLessThan(1500);
  });
});

describe('discoverSitemapUrls', () => {
  it('follows robots.txt → sitemap index → plain + gzip child sitemaps, normalizing & deduping', async () => {
    const gz = gzipSync(Buffer.from(urlset(['https://unpeg.io/docs/faq/', 'https://unpeg.io/blog?utm_source=x', 'https://unpeg.io/'])));
    const { http, calls } = fakeHttp({
      'https://unpeg.io/robots.txt': {
        contentType: 'text/plain',
        body: 'User-agent: *\nAllow: /\nSitemap: https://unpeg.io/sitemap-index.xml\n',
      },
      'https://unpeg.io/sitemap-index.xml': { body: sitemapIndex(['https://unpeg.io/sm/pages.xml', '/sm/more.xml.gz']) },
      'https://unpeg.io/sm/pages.xml': { body: urlset(['https://unpeg.io/', 'https://unpeg.io/docs', 'https://unpeg.io/docs/']) },
      'https://unpeg.io/sm/more.xml.gz': { contentType: 'application/x-gzip', body: gz },
      'https://unpeg.io/sitemap.xml': { status: 404, contentType: 'text/html', body: '<!doctype html><h1>404</h1>' },
    });
    const urls = await discoverSitemapUrls(http, 'https://unpeg.io/');
    expect(urls).toEqual(['https://unpeg.io/', 'https://unpeg.io/docs', 'https://unpeg.io/docs/faq', 'https://unpeg.io/blog']);
    const fetched = calls.map((c) => c.url);
    expect(fetched[0]).toBe('https://unpeg.io/robots.txt');
    expect(fetched).toContain('https://unpeg.io/sitemap.xml');
    expect(fetched).toContain('https://unpeg.io/sitemap_index.xml');
    expect(fetched).toContain('https://unpeg.io/sm/more.xml.gz');
    expect(new Set(fetched).size).toBe(fetched.length);
  });

  it('gunzips bodies by magic bytes even when served as XML text, and survives truncated gzip', async () => {
    const full = gzipSync(Buffer.from(urlset(Array.from({ length: 200 }, (_, i) => `https://a.io/p${i}`))));
    const truncated = full.subarray(0, Math.floor(full.length / 2));
    const { http } = fakeHttp({
      'https://a.io/sitemap.xml': { contentType: 'text/xml', body: full },
      'https://a.io/sitemap_index.xml': { contentType: 'application/octet-stream', body: truncated },
    });
    const urls = await discoverSitemapUrls(http, 'https://a.io/');
    expect(urls).toHaveLength(200);
    expect(urls[0]).toBe('https://a.io/p0');
  });

  it('recovers the readable prefix of a truncated gzip sitemap', async () => {
    const full = gzipSync(Buffer.from(urlset(Array.from({ length: 2000 }, (_, i) => `https://a.io/page/${i}`))));
    const { http } = fakeHttp({
      'https://a.io/sitemap.xml': { contentType: 'application/gzip', body: full.subarray(0, Math.floor(full.length * 0.6)) },
    });
    const urls = await discoverSitemapUrls(http, 'https://a.io/');
    expect(urls.length).toBeGreaterThan(100);
    expect(urls.length).toBeLessThan(2000);
    expect(urls[0]).toBe('https://a.io/page/0');
  });

  it('caps decompressed size (gzip bomb) and stays fast', async () => {
    const bomb = gzipSync(Buffer.alloc(200 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const { http } = fakeHttp({ 'https://a.io/sitemap.xml': { contentType: 'application/gzip', body: bomb } });
    const t0 = performance.now();
    expect(await discoverSitemapUrls(http, 'https://a.io/')).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('ignores HTML soft-404s and non-200 responses', async () => {
    const { http } = fakeHttp({
      'https://a.io/robots.txt': { contentType: 'text/html', body: '<!doctype html><html><body>Sitemap: https://a.io/evil.xml</body></html>' },
      'https://a.io/sitemap.xml': { status: 200, contentType: 'text/html', body: '<!doctype html><title>Home</title>' },
      'https://a.io/sitemap_index.xml': { status: 500, body: urlset(['https://a.io/should-not-appear']) },
      'https://a.io/evil.xml': { body: urlset(['https://a.io/evil']) },
    });
    expect(await discoverSitemapUrls(http, 'https://a.io/')).toEqual([]);
  });

  it('never throws when fetch throws or returns status 0', async () => {
    const { http } = fakeHttp({
      'https://a.io/robots.txt': { throws: true },
      'https://a.io/sitemap.xml': { status: 0, contentType: null },
      'https://a.io/sitemap_index.xml': { body: urlset(['https://a.io/ok']) },
    });
    expect(await discoverSitemapUrls(http, 'https://a.io/')).toEqual(['https://a.io/ok']);
    const broken = { fetch: () => Promise.reject(new Error('nope')) } as unknown as HttpClient;
    expect(await discoverSitemapUrls(broken, 'https://a.io/')).toEqual([]);
    const syncThrow = {
      fetch: () => {
        throw new Error('sync');
      },
    } as unknown as HttpClient;
    expect(await discoverSitemapUrls(syncThrow, 'https://a.io/')).toEqual([]);
    expect(await discoverSitemapUrls(broken, 'not a url')).toEqual([]);
    expect(await discoverSitemapUrls(broken, 'mailto:x@a.io')).toEqual([]);
  });

  it('reports whether a read was complete: transient failures (0, 429, 5xx, challenges) make it incomplete, 404s do not', async () => {
    const ok = fakeHttp({ 'https://a.io/sitemap.xml': { body: urlset(['https://a.io/x']) } });
    expect(await discoverSitemap(ok.http, 'https://a.io/')).toEqual({ urls: ['https://a.io/x'], complete: true });

    for (const status of [0, 429, 500, 503]) {
      const bad = fakeHttp({
        'https://a.io/sitemap.xml': { status, body: 'nope', contentType: 'text/plain' },
        'https://a.io/sitemap_index.xml': { body: urlset(['https://a.io/y']) },
      });
      expect(await discoverSitemap(bad.http, 'https://a.io/')).toEqual({ urls: ['https://a.io/y'], complete: false });
    }
    const child = fakeHttp({
      'https://a.io/sitemap.xml': { body: sitemapIndex(['https://a.io/s1.xml', 'https://a.io/s2.xml']) },
      'https://a.io/s1.xml': { body: urlset(['https://a.io/one']) },
      'https://a.io/s2.xml': { status: 502, body: 'bad gateway', contentType: 'text/plain' },
    });
    expect(await discoverSitemap(child.http, 'https://a.io/')).toEqual({ urls: ['https://a.io/one'], complete: false });
    const broken = { fetch: () => Promise.reject(new Error('nope')) } as unknown as HttpClient;
    expect((await discoverSitemap(broken, 'https://a.io/')).complete).toBe(false);
  });

  it('respects maxUrls', async () => {
    const { http } = fakeHttp({
      'https://a.io/sitemap.xml': { body: urlset(Array.from({ length: 100 }, (_, i) => `https://a.io/p${i}`)) },
      'https://a.io/sitemap_index.xml': { body: urlset(['https://a.io/other']) },
    });
    const urls = await discoverSitemapUrls(http, 'https://a.io/', { maxUrls: 10 });
    expect(urls).toEqual(Array.from({ length: 10 }, (_, i) => `https://a.io/p${i}`));
  });

  it('respects maxSitemaps and does not loop on self-referencing indexes', async () => {
    const routes: Record<string, Route> = {
      'https://a.io/sitemap.xml': { body: sitemapIndex(['https://a.io/sitemap.xml', 'https://a.io/s/1.xml']) },
    };
    for (let i = 1; i <= 50; i++) {
      routes[`https://a.io/s/${i}.xml`] = {
        body: `<sitemapindex><sitemap><loc>https://a.io/s/${i + 1}.xml</loc></sitemap><sitemap><loc>https://a.io/s/${i}.xml</loc></sitemap></sitemapindex>`,
      };
    }
    routes['https://a.io/s/3.xml'] = { body: urlset(['https://a.io/from-3']) };
    const { http, calls } = fakeHttp(routes);
    const urls = await discoverSitemapUrls(http, 'https://a.io/', { maxSitemaps: 4 });
    expect(urls).toEqual([]);
    const sitemapCalls = calls.filter((c) => !c.url.endsWith('/robots.txt'));
    expect(sitemapCalls.length).toBe(4);
    expect(new Set(sitemapCalls.map((c) => c.url)).size).toBe(4);

    const more = fakeHttp(routes);
    expect(await discoverSitemapUrls(more.http, 'https://a.io/', { maxSitemaps: 20 })).toEqual(['https://a.io/from-3']);
  });

  it('also tries <path>/sitemap.xml for a sub-path start URL and accepts text sitemaps from robots', async () => {
    const { http, calls } = fakeHttp({
      'https://a.io/robots.txt': { contentType: 'text/plain', body: 'Sitemap: https://a.io/urls.txt' },
      'https://a.io/urls.txt': { contentType: 'text/plain', body: 'https://a.io/t1\nhttps://a.io/t2\n\n' },
      'https://a.io/docs/sitemap.xml': { body: urlset(['https://a.io/docs/intro']) },
    });
    const urls = await discoverSitemapUrls(http, 'https://a.io/docs/');
    expect(urls).toEqual(['https://a.io/t1', 'https://a.io/t2', 'https://a.io/docs/intro']);
    expect(calls.map((c) => c.url)).toContain('https://a.io/docs/sitemap.xml');
  });

  it('resolves relative locs against the final sitemap URL and keeps http(s) only', async () => {
    const { http } = fakeHttp({
      'https://a.io/sitemap.xml': {
        finalUrl: 'https://www.a.io/maps/sitemap.xml',
        body: urlset(['page-rel', '/abs-path', 'mailto:x@a.io', 'javascript:alert(1)', 'https://b.io/external']),
      },
    });
    expect(await discoverSitemapUrls(http, 'https://a.io/')).toEqual([
      'https://www.a.io/maps/page-rel',
      'https://www.a.io/abs-path',
      'https://b.io/external',
    ]);
  });

  it('works against a localhost start URL with a port', async () => {
    const { http } = fakeHttp({
      'http://127.0.0.1:4555/sitemap.xml': { body: urlset(['http://127.0.0.1:4555/a', 'http://127.0.0.1:4555/b/']) },
    });
    expect(await discoverSitemapUrls(http, 'http://127.0.0.1:4555/')).toEqual(['http://127.0.0.1:4555/a', 'http://127.0.0.1:4555/b']);
  });
});
