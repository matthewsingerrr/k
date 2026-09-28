import { describe, expect, it } from 'vitest';
import { analyzeJs, cleanRoutePath, MAX_JS_HOSTS, MAX_JS_PATHS } from '../src/extract/js.js';
import { cleanHost, isNoiseHost, scanHosts } from '../src/extract/hosts.js';

describe('analyzeJs — paths', () => {
  it('extracts route-like string literals in all quote styles', () => {
    const src = `const a="/docs/points",b='/api/v1/claim',c=\`/app/series\`;fetch("/api/v2/users/:id");go('/blog/[slug]');x("/users/@me")`;
    expect(analyzeJs(src).paths).toEqual(['/api/v1/claim', '/api/v2/users/:id', '/app/series', '/blog/[slug]', '/docs/points', '/users/@me']);
  });

  it('does not turn regex literals into paths', () => {
    const src = String.raw`e.replace(/\s+/g,"");t.split(/\//);n.match(/^\/api\//);r=/"/g;s=new RegExp("/[a-z]+/","g");q=/\/docs\/(\w+)/i;`;
    expect(analyzeJs(src).paths).toEqual([]);
  });

  it('rejects noise literals', () => {
    const rejected = [
      '/',
      '/a',
      '/x/',
      '//cdn.foo.com/x',
      '/a//b',
      '/_next/static/chunks/x',
      '/_nuxt/entry',
      '/static/media/logo',
      '/static',
      '/assets/img',
      '/node_modules/react',
      '/cdn-cgi/trace',
      '/__nextjs_original-stack-frame',
      '/@vite/client',
      '/_error',
      '/favicon.ico',
      '/logo.svg',
      '/manifest.json',
      '/sw.js',
      '/robots.txt',
      '/sitemap.xml',
      '/index.html',
      '/fonts/inter.woff2',
      '/1/2',
      '/2024',
      '/1.0.3',
      '/10/20/30',
      '/%s',
      '/%s/%d',
      '/foo/g',
      '/foo/gi',
      '/gi',
      '/[a-z]',
      '/foo/[0-9]',
      '/foo/[',
      '/month',
      '/mo',
      '/min',
      '/a b',
      '/' + 'x'.repeat(120),
      '/docs/${id}',
      '/q?x=1',
    ];
    for (const lit of rejected) {
      expect(analyzeJs(`x("${lit}")`).paths, lit).toEqual([]);
    }
  });

  it('accepts real routes and normalizes the trailing slash', () => {
    const accepted: Array<[string, string]> = [
      ['/docs/', '/docs'],
      ['/docs/points', '/docs/points'],
      ['/api/v1/claim', '/api/v1/claim'],
      ['/en', '/en'],
      ['/my', '/my'],
      ['/us', '/us'],
      ['/v1', '/v1'],
      ['/blog/2024/hello-world', '/blog/2024/hello-world'],
      ['/docs/[[...slug]]', '/docs/[[...slug]]'],
      ['/shop/[...all]', '/shop/[...all]'],
      ['/files/report.pdf', '/files/report.pdf'],
      ['/page.php', '/page.php'],
      ['/caf%C3%A9', '/caf%C3%A9'],
      ['/a~b/c_d.e-f', '/a~b/c_d.e-f'],
      ['/Docs/API', '/Docs/API'],
    ];
    for (const [lit, expected] of accepted) {
      expect(analyzeJs(`x('${lit}')`).paths, lit).toEqual([expected]);
    }
  });

  it('skips template literals with interpolation but keeps plain ones', () => {
    expect(analyzeJs('a=`/docs/${x}`;b=`/docs/points`;c=`/api/${v}/x`').paths).toEqual(['/docs/points']);
  });

  it('handles JSON-escaped literals inside strings', () => {
    const src = String.raw`JSON.parse("{\"href\":\"/docs/faq\",\"api\":\"https:\/\/api.unpeg.io\/v1\"}");var h='<a href="/about">'`;
    const r = analyzeJs(src);
    expect(r.paths).toEqual(['/about', '/docs/faq']);
    expect(r.hosts).toEqual(['api.unpeg.io']);
  });

  it('mismatched quotes and regexes containing quotes do not hide later literals', () => {
    const src = String.raw`a=/["']/g;b="it's";c='say "hi"';d=/'/;e="/docs/after-quotes";f='/api/also'`;
    expect(analyzeJs(src).paths).toEqual(['/api/also', '/docs/after-quotes']);
  });

  it('sorts and dedupes', () => {
    const src = '"/b/x","/a/x","/b/x","/a/x/","/c"';
    expect(analyzeJs(src).paths).toEqual(['/a/x', '/b/x']);
  });

  it('caps paths at MAX_JS_PATHS, keeping the lexicographically smallest', () => {
    const src = Array.from({ length: MAX_JS_PATHS + 500 }, (_, i) => `"/r/p${String(i).padStart(5, '0')}"`).join(',');
    const { paths } = analyzeJs(src);
    expect(paths).toHaveLength(MAX_JS_PATHS);
    expect(paths[0]).toBe('/r/p00000');
    expect(paths).toEqual([...paths].sort());
  });

  it('cleanRoutePath is exported and total', () => {
    expect(cleanRoutePath('/docs/')).toBe('/docs');
    expect(cleanRoutePath('')).toBeNull();
    expect(cleanRoutePath('docs')).toBeNull();
  });
});

describe('analyzeJs — hosts', () => {
  it('extracts hosts from absolute URLs with schemes, ports and userinfo', () => {
    const src = `a="https://api.unpeg.io/v1";b='http://Stats.Unpeg.IO:8080/x';c="wss://ws.unpeg.io/feed";d="ws://rpc.unpeg.io";e="https://user:pw@auth.unpeg.io/login";f="https://unpeg.io."`;
    expect(analyzeJs(src).hosts).toEqual(['api.unpeg.io', 'auth.unpeg.io', 'rpc.unpeg.io', 'stats.unpeg.io', 'unpeg.io', 'ws.unpeg.io']);
  });

  it('accepts protocol-relative URLs only after a quote', () => {
    const src = `x="//cdn.unpeg.io/a.js";y='//img.unpeg.io';z=\`//tpl.unpeg.io\`;// comment.unpeg.io
//window.location
a=b//c.d.unpeg.io
w=(//paren.unpeg.io)`;
    expect(analyzeJs(src).hosts).toEqual(['cdn.unpeg.io', 'img.unpeg.io', 'tpl.unpeg.io']);
  });

  it('excludes well-known noise hosts', () => {
    const noise = [
      'http://www.w3.org/2000/svg',
      'http://w3.org/1999/xlink',
      'https://reactjs.org/docs/error-decoder.html',
      'https://react.dev/errors/418',
      'https://fb.me/react-polyfills',
      'https://github.com/facebook/react',
      'https://api.github.com/repos',
      'https://raw.githubusercontent.com/x',
      'https://developer.mozilla.org/en-US/docs',
      'https://mozilla.org',
      'https://schema.org/Thing',
      'https://json-schema.org/draft-07/schema',
      'https://example.com/',
      'https://www.example.org/',
      'http://localhost:3000/',
      'https://tc39.es/ecma262/',
      'https://nodejs.org/api',
      'https://www.npmjs.com/package/x',
      'https://unpkg.com/react',
      'https://cdn.jsdelivr.net/npm/x',
      'https://feross.org',
      'https://momentjs.com/guides',
      'https://lodash.com/license',
      'https://sentry.io',
      'https://o123.ingest.sentry.io/api/1',
      'https://polyfill.io/v3',
      'https://goo.gl/abc',
      'https://bit.ly/abc',
      'http://purl.org/dc/elements/1.1/',
      'http://ns.adobe.com/xap/1.0/',
      'https://nextjs.org/docs/messages/x',
      'https://api.unpeg.test/',
      'https://foo.invalid/',
      'https://printer.local/',
      'http://127.0.0.1:8080/',
      'http://10.0.0.1/',
      'https://intranet/',
      'https://co.uk/',
      'https://window.location/', // not a real public suffix combo? .location is not a TLD
    ];
    const src = noise.map((u) => `"${u}"`).join(';');
    expect(analyzeJs(src).hosts).toEqual([]);
  });

  it('keeps real third-party hosts', () => {
    const src = `"https://api.mainnet-beta.solana.com","https://rpc.helius.xyz/?api-key=x","https://unpeg.vercel.app/","https://api.dexscreener.com/latest"`;
    expect(analyzeJs(src).hosts).toEqual(['api.dexscreener.com', 'api.mainnet-beta.solana.com', 'rpc.helius.xyz', 'unpeg.vercel.app']);
  });

  it('caps hosts at MAX_JS_HOSTS', () => {
    const src = Array.from({ length: MAX_JS_HOSTS + 200 }, (_, i) => `"https://h${String(i).padStart(4, '0')}.unpeg.io/"`).join(',');
    const { hosts } = analyzeJs(src);
    expect(hosts).toHaveLength(MAX_JS_HOSTS);
    expect(hosts).toEqual([...hosts].sort());
  });

  it('host helpers', () => {
    expect(cleanHost('API.Unpeg.IO.')).toBe('api.unpeg.io');
    expect(cleanHost('unpeg.io-')).toBe('unpeg.io');
    expect(cleanHost('-bad.io')).toBeNull();
    expect(cleanHost('a..b.com')).toBeNull();
    expect(cleanHost('1.2.3.4')).toBeNull();
    expect(cleanHost('foo.123')).toBeNull();
    expect(cleanHost('xn--bcher-kva.de')).toBe('xn--bcher-kva.de');
    expect(isNoiseHost('docs.sentry.io')).toBe(true);
    expect(isNoiseHost('github.com', 'html')).toBe(false);
    expect(isNoiseHost('www.w3.org', 'html')).toBe(true);
    expect(isNoiseHost('api.unpeg.io')).toBe(false);
    expect(scanHosts('', 'js')).toEqual([]);
  });
});

describe('analyzeJs — robustness & performance', () => {
  it('returns empty results for empty / non-string input', () => {
    expect(analyzeJs('')).toEqual({ paths: [], hosts: [] });
    expect(analyzeJs(undefined as unknown as string)).toEqual({ paths: [], hosts: [] });
    expect(analyzeJs(42 as unknown as string)).toEqual({ paths: [], hosts: [] });
  });

  it('handles a 5MB synthetic minified bundle in < 1.5s', () => {
    const parts: string[] = [];
    let i = 0;
    let size = 0;
    while (size < 5 * 1024 * 1024) {
      const piece =
        `function f${i}(e,t){var n=e.replace(/\\s+/g,"").split(/[,;]/);` +
        `if(t)return fetch("/api/v1/item${i % 700}",{headers:{"x-k":"${'k'.repeat(i % 30)}"}});` +
        `var u='https://api${i % 40}.unpeg.io/v1',w="http://www.w3.org/2000/svg",r=\`/docs/\${n}\`;` +
        `return n.length>2?"/docs/page-${i % 900}":'${'"'.repeat(i % 3)}'+/["']/g.source+"//not a host"+u+w+r}`;
      parts.push(piece);
      size += piece.length;
      i++;
    }
    const bundle = parts.join(';');
    expect(bundle.length).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    const t0 = performance.now();
    const r = analyzeJs(bundle);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1500);
    expect(r.paths).toContain('/docs/page-0');
    expect(r.paths).toContain('/api/v1/item699');
    expect(r.paths).toHaveLength(1600);
    expect(r.hosts).toHaveLength(40);
    expect(r.hosts).not.toContain('www.w3.org');
  });

  it('pathological inputs stay fast (no catastrophic backtracking)', () => {
    const inputs = [
      '"/' + 'a/'.repeat(500_000),
      '"' + '/'.repeat(1_000_000),
      "'".repeat(1_000_000),
      'https://'.repeat(200_000),
      'https://' + 'a.'.repeat(500_000),
      '"//' + 'a-'.repeat(500_000),
      ('"/' + 'x'.repeat(119) + 'y').repeat(20_000),
      '\\'.repeat(1_000_000),
    ];
    for (const src of inputs) {
      const t0 = performance.now();
      analyzeJs(src);
      expect(performance.now() - t0).toBeLessThan(1500);
    }
  });
});
