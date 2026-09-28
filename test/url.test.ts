import { describe, expect, it } from 'vitest';
import {
  classifyUrl,
  displayUrl,
  getRootDomain,
  inScope,
  isUnderDomain,
  normalizeUrl,
  parseWatchInput,
  urlFilename,
  urlPath,
} from '../src/extract/url.js';

describe('normalizeUrl', () => {
  const cases: Array<[string, string | undefined, string | null]> = [
    ['https://a.io', undefined, 'https://a.io/'],
    ['https://a.io/', undefined, 'https://a.io/'],
    ['HTTPS://A.IO/Docs/', undefined, 'https://a.io/Docs'],
    ['https://a.io/docs/', undefined, 'https://a.io/docs'],
    ['https://a.io//docs///faq//', undefined, 'https://a.io/docs/faq'],
    ['https://a.io/docs/index.html', undefined, 'https://a.io/docs'],
    ['https://a.io/index.htm', undefined, 'https://a.io/'],
    ['https://a.io/INDEX.HTML', undefined, 'https://a.io/'],
    ['https://a.io/docs/index.html/', undefined, 'https://a.io/docs'],
    ['https://a.io/a/index.html/index.html', undefined, 'https://a.io/a'],
    ['https://a.io/myindex.html', undefined, 'https://a.io/myindex.html'],
    ['https://a.io:443/x', undefined, 'https://a.io/x'],
    ['http://a.io:80/x', undefined, 'http://a.io/x'],
    ['http://a.io:8080/x', undefined, 'http://a.io:8080/x'],
    ['https://a.io:80/x', undefined, 'https://a.io:80/x'],
    ['https://user:pass@a.io/x', undefined, 'https://a.io/x'],
    ['https://a.io/x#frag', undefined, 'https://a.io/x'],
    ['https://a.io/x?#frag', undefined, 'https://a.io/x'],
    ['https://a.io/x?', undefined, 'https://a.io/x'],
    ['https://a.io/x?b=2&a=1', undefined, 'https://a.io/x?a=1&b=2'],
    ['https://a.io/x?a=2&a=1', undefined, 'https://a.io/x?a=2&a=1'],
    ['https://a.io/x?utm_source=tw&utm_medium=s&id=5', undefined, 'https://a.io/x?id=5'],
    ['https://a.io/x?UTM_Campaign=1&gclid=2&fbclid=3&mc_cid=4&mc_eid=5&ref=6&ref_src=7&_hsenc=8&_hsmi=9&igshid=10&si=11', undefined, 'https://a.io/x'],
    ['https://a.io/x?reference=keep', undefined, 'https://a.io/x?reference=keep'],
    ['https://a.io/x?flag', undefined, 'https://a.io/x?flag'],
    ['https://a.io/x?q=a+b&z=%20', undefined, 'https://a.io/x?q=a+b&z=%20'],
    ['https://a.io/x?&&a=1&&', undefined, 'https://a.io/x?a=1'],
    ['https://unpeg.io./docs', undefined, 'https://unpeg.io/docs'],
    ['https://bücher.de/x', undefined, 'https://xn--bcher-kva.de/x'],
    ['https://a.io/a b', undefined, 'https://a.io/a%20b'],
    ['https://a.io/%7Euser', undefined, 'https://a.io/%7Euser'],
    ['https://a.io/a/./b/../c', undefined, 'https://a.io/a/c'],
    ['https://a.io\\docs\\faq', undefined, 'https://a.io/docs/faq'],
    ['  https://a.io/x  ', undefined, 'https://a.io/x'],
    ['http://[::1]:3000/x', undefined, 'http://[::1]:3000/x'],
    ['http://127.0.0.1:8080/', undefined, 'http://127.0.0.1:8080/'],
    // relative resolution
    ['/docs/faq/', 'https://a.io/x/y', 'https://a.io/docs/faq'],
    ['faq', 'https://a.io/docs/', 'https://a.io/docs/faq'],
    ['../up', 'https://a.io/a/b/c', 'https://a.io/a/up'],
    ['?page=2', 'https://a.io/list', 'https://a.io/list?page=2'],
    ['#top', 'https://a.io/page', 'https://a.io/page'],
    ['//cdn.a.io/x.js', 'https://a.io/', 'https://cdn.a.io/x.js'],
    ['https://b.io/x', 'not a url', 'https://b.io/x'],
    // rejected
    ['mailto:hi@a.io', undefined, null],
    ['mailto:hi@a.io', 'https://a.io/', null],
    ['javascript:void(0)', 'https://a.io/', null],
    ['data:text/html,hi', undefined, null],
    ['tel:+15551234', 'https://a.io/', null],
    ['ftp://a.io/x', undefined, null],
    ['/relative/only', undefined, null],
    ['', undefined, null],
    ['   ', undefined, null],
    ['http://', undefined, null],
    ['https://a.io/' + 'x'.repeat(9000), undefined, null],
  ];

  it.each(cases)('normalizeUrl(%j, %j) → %j', (raw, base, expected) => {
    expect(normalizeUrl(raw, base)).toBe(expected);
  });

  it('never throws on non-string / junk input', () => {
    for (const junk of [null, undefined, 42, {}, [], 'http://%', 'https://a.io/%zz', '\u0000\u0001', '::::', 'https://[bad']) {
      expect(() => normalizeUrl(junk as unknown as string)).not.toThrow();
      expect(() => normalizeUrl('x', junk as unknown as string)).not.toThrow();
    }
  });

  it('is idempotent over many inputs', () => {
    const seeds = [
      ...cases.map(([raw, base]) => [raw, base] as const),
      ...[
        'https://A.io/B/c/?Z=1&y=2&utm_x=3#h',
        'http://a.io:80//a//b//index.html//',
        'https://a.io/%2e%2e/%2E/x',
        'https://a.io/a%2Fb/',
        'https://a.io/?a=%26&b=%3D',
        'https://a.io/;jsessionid=1?x=1',
        'https://a.io/index.html?x=1',
        'https://a.io/ä/ö?ü=1',
        'https://a.io/x?a=1&A=2&b&B',
        'https://xn--bcher-kva.de/',
        'https://a.io/%',
        'https://a.io/tab\there',
        'https://a.io/new\nline',
        "https://a.io/it's",
        'https://a.io/"quoted"',
        'https://a.io/<angle>',
        'https://a.io/{brace}|pipe^caret`tick',
        'https://a.io/x?q=<script>',
        'http://[2001:db8::1]/x/',
        'http://0x7f.1/',
        'http://1.2.3/x',
        'https://a.io/.../..../x',
        'https://a.io/index.html/index.htm/',
      ].map((raw) => [raw, undefined] as const),
    ];
    // Deterministic pseudo-random URLs built from awkward pieces.
    const pieces = ['/', '//', 'a', 'B', '.', '..', 'index.html', '%20', '%2F', '?', '&', '=', 'utm_a', 'x', '#', ' ', 'é', ';', '+'];
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const generated: Array<readonly [string, string | undefined]> = [];
    for (let i = 0; i < 500; i++) {
      let s = 'https://Ex.io';
      const n = 1 + (rnd() % 12);
      for (let j = 0; j < n; j++) s += pieces[rnd() % pieces.length];
      generated.push([s, undefined]);
    }
    let checked = 0;
    for (const [raw, base] of [...seeds, ...generated]) {
      const once = normalizeUrl(raw, base);
      if (once === null) continue;
      checked++;
      expect(normalizeUrl(once), `input ${JSON.stringify(raw)}`).toBe(once);
    }
    expect(checked).toBeGreaterThan(400);
  });
});

describe('getRootDomain', () => {
  it.each([
    ['docs.unpeg.io', 'unpeg.io'],
    ['unpeg.io', 'unpeg.io'],
    ['A.B.CO.UK', 'b.co.uk'],
    ['www.example.com.', 'example.com'],
    ['myapp.vercel.app', 'myapp.vercel.app'],
    ['preview.myapp.vercel.app', 'myapp.vercel.app'],
    ['user.github.io', 'user.github.io'],
    ['localhost', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['[::1]', '[::1]'],
    ['::1', '::1'],
    ['vercel.app', 'vercel.app'],
    ['co.uk', 'co.uk'],
    ['intranet', 'intranet'],
    ['', ''],
  ])('%s → %s', (host, expected) => {
    expect(getRootDomain(host)).toBe(expected);
  });

  it('never throws', () => {
    expect(() => getRootDomain(null as unknown as string)).not.toThrow();
    expect(getRootDomain(null as unknown as string)).toBe('');
  });
});

describe('isUnderDomain', () => {
  it.each([
    ['unpeg.io', 'unpeg.io', true],
    ['docs.unpeg.io', 'unpeg.io', true],
    ['A.Docs.UNPEG.io.', 'unpeg.io', true],
    ['docs.unpeg.io', 'UNPEG.IO.', true],
    ['notunpeg.io', 'unpeg.io', false],
    ['unpeg.io.evil.com', 'unpeg.io', false],
    ['unpeg.io', 'docs.unpeg.io', false],
    ['', 'unpeg.io', false],
    ['unpeg.io', '', false],
  ])('%s under %s → %s', (host, root, expected) => {
    expect(isUnderDomain(host, root)).toBe(expected);
  });
});

describe('classifyUrl', () => {
  it.each([
    ['https://a.io/', 'page'],
    ['https://a.io/docs', 'page'],
    ['https://a.io/docs/faq.html', 'page'],
    ['https://a.io/x.php?id=1', 'page'],
    ['https://a.io/x.aspx', 'page'],
    ['https://a.io/v1.2/docs', 'page'],
    ['https://a.io/blog/post.v2', 'page'],
    ['https://a.io/whitepaper.pdf', 'file'],
    ['https://a.io/WhitePaper.PDF', 'file'],
    ['https://a.io/notes.md', 'file'],
    ['https://a.io/data.csv', 'file'],
    ['https://a.io/terms.docx', 'file'],
    ['https://a.io/data/tokens.json', 'file'],
    ['https://a.io/.well-known/assetlinks.json', 'asset'],
    ['https://a.io/manifest.json', 'asset'],
    ['https://a.io/site.webmanifest', 'asset'],
    ['https://a.io/app.js', 'asset'],
    ['https://a.io/app.mjs?v=2', 'asset'],
    ['https://a.io/style.css', 'asset'],
    ['https://a.io/logo.SVG', 'asset'],
    ['https://a.io/font.woff2', 'asset'],
    ['https://a.io/video.mp4', 'asset'],
    ['https://a.io/_next/static/chunks/x.js', 'asset'],
    ['https://a.io/_next/data/abc/index', 'asset'],
    ['https://a.io/_nuxt/entry', 'asset'],
    ['https://a.io/static/img/logo', 'asset'],
    ['https://a.io/static/whitepaper.pdf', 'file'],
    ['https://a.io/static/about.html', 'page'],
    ['https://a.io/release.zip', 'skip'],
    ['https://a.io/pkg.tar.gz', 'skip'],
    ['https://a.io/sitemap.xml', 'skip'],
    ['https://a.io/feed.rss', 'skip'],
    ['https://a.io/app.apk', 'skip'],
    ['https://a.io/cdn-cgi/l/email-protection', 'skip'],
    ['https://a.io/wp-json/wp/v2/posts', 'skip'],
    ['https://a.io/wp-admin/', 'skip'],
    ['mailto:hi@a.io', 'skip'],
    ['', 'skip'],
    ['/docs/guide.pdf', 'file'],
  ])('%s → %s', (url, expected) => {
    expect(classifyUrl(url)).toBe(expected);
  });

  it('never throws on junk', () => {
    expect(classifyUrl(undefined as unknown as string)).toBe('skip');
    expect(classifyUrl('http://[bad')).toBe('skip');
  });
});

describe('inScope', () => {
  const base = { url: 'https://unpeg.io/', host: 'unpeg.io', scopePath: null, excludePatterns: [] as string[] };

  it('treats absurdly long URLs as out of scope without running exclude regexes over them', () => {
    const long = 'https://unpeg.io/' + 'a'.repeat(9000);
    const t0 = Date.now();
    expect(inScope(long, { ...base, excludePatterns: ['\\w+@'] })).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(inScope('https://unpeg.io/' + 'a'.repeat(1000), base)).toBe(true);
  });

  it('matches same host only', () => {
    expect(inScope('https://unpeg.io/docs', base)).toBe(true);
    expect(inScope('https://UNPEG.io/docs', base)).toBe(true);
    expect(inScope('http://unpeg.io/docs', base)).toBe(true);
    expect(inScope('https://docs.unpeg.io/', base)).toBe(false);
    expect(inScope('https://evil.com/unpeg.io', base)).toBe(false);
    expect(inScope('mailto:x@unpeg.io', base)).toBe(false);
    expect(inScope('not a url', base)).toBe(false);
  });

  it('requires the start URL port', () => {
    const local = { url: 'http://127.0.0.1:43123/', host: '127.0.0.1', scopePath: null, excludePatterns: [] };
    expect(inScope('http://127.0.0.1:43123/page', local)).toBe(true);
    expect(inScope('http://127.0.0.1:43124/page', local)).toBe(false);
    expect(inScope('http://127.0.0.1/page', local)).toBe(false);
    expect(inScope('https://unpeg.io:8443/x', base)).toBe(false);
    expect(inScope('https://unpeg.io:443/x', base)).toBe(true);
  });

  it('respects scopePath at segment boundaries', () => {
    const w = { ...base, scopePath: '/docs' };
    expect(inScope('https://unpeg.io/docs', w)).toBe(true);
    expect(inScope('https://unpeg.io/docs/faq', w)).toBe(true);
    expect(inScope('https://unpeg.io/docsx', w)).toBe(false);
    expect(inScope('https://unpeg.io/', w)).toBe(false);
    expect(inScope('https://unpeg.io/docs/faq', { ...base, scopePath: '/docs/' })).toBe(true);
    expect(inScope('https://unpeg.io/docs/faq', { ...base, scopePath: 'docs' })).toBe(true);
    expect(inScope('https://unpeg.io/anything', { ...base, scopePath: '/' })).toBe(true);
    expect(inScope('https://unpeg.io/anything', { ...base, scopePath: '' })).toBe(true);
  });

  it('applies exclude patterns case-insensitively and ignores invalid ones', () => {
    const w = { ...base, excludePatterns: ['(unclosed', '/BLOG/', '\\.pdf$'] };
    expect(inScope('https://unpeg.io/blog/post', w)).toBe(false);
    expect(inScope('https://unpeg.io/docs/x.PDF', w)).toBe(false);
    expect(inScope('https://unpeg.io/docs', w)).toBe(true);
    expect(inScope('https://unpeg.io/docs', { ...base, excludePatterns: ['[', '*'] })).toBe(true);
  });

  it('excludes query URLs unless allowQuery', () => {
    expect(inScope('https://unpeg.io/list?page=2', base)).toBe(false);
    expect(inScope('https://unpeg.io/list?page=2', base, true)).toBe(true);
    expect(inScope('https://unpeg.io/list?', base)).toBe(true);
  });

  it('never throws on malformed watches', () => {
    const bad = { url: 'garbage', host: 'unpeg.io', scopePath: null, excludePatterns: null as unknown as string[] };
    expect(() => inScope('https://unpeg.io/x', bad)).not.toThrow();
    expect(inScope('https://unpeg.io/x', bad)).toBe(true);
    expect(inScope('https://unpeg.io/x', null as unknown as typeof base)).toBe(false);
  });
});

describe('parseWatchInput', () => {
  it.each([
    ['unpeg.io', { url: 'https://unpeg.io/', host: 'unpeg.io', rootDomain: 'unpeg.io', suggestedName: 'Unpeg' }],
    ['https://unpeg.io/docs/', { url: 'https://unpeg.io/docs', host: 'unpeg.io', rootDomain: 'unpeg.io', suggestedName: 'Unpeg' }],
    ['  docs.unpeg.io  ', { url: 'https://docs.unpeg.io/', host: 'docs.unpeg.io', rootDomain: 'unpeg.io', suggestedName: 'Unpeg' }],
    ['<https://unpeg.io>', { url: 'https://unpeg.io/', host: 'unpeg.io', rootDomain: 'unpeg.io', suggestedName: 'Unpeg' }],
    ['HTTP://WWW.Example.CO.UK/x', { url: 'http://www.example.co.uk/x', host: 'www.example.co.uk', rootDomain: 'example.co.uk', suggestedName: 'Example' }],
    ['http://localhost:8080/', { url: 'http://localhost:8080/', host: 'localhost', rootDomain: 'localhost', suggestedName: 'localhost' }],
    ['localhost:3000', { url: 'https://localhost:3000/', host: 'localhost', rootDomain: 'localhost', suggestedName: 'localhost' }],
    ['http://127.0.0.1:4000/app', { url: 'http://127.0.0.1:4000/app', host: '127.0.0.1', rootDomain: '127.0.0.1', suggestedName: '127.0.0.1' }],
    ['unpeg.io:8443', { url: 'https://unpeg.io:8443/', host: 'unpeg.io', rootDomain: 'unpeg.io', suggestedName: 'Unpeg' }],
    ['myapp.vercel.app', { url: 'https://myapp.vercel.app/', host: 'myapp.vercel.app', rootDomain: 'myapp.vercel.app', suggestedName: 'Myapp' }],
    ['https://bücher.de', { url: 'https://xn--bcher-kva.de/', host: 'xn--bcher-kva.de', rootDomain: 'xn--bcher-kva.de', suggestedName: 'Bücher' }],
    ['https://xn--bcher-kva.example/', { url: 'https://xn--bcher-kva.example/', host: 'xn--bcher-kva.example', rootDomain: 'xn--bcher-kva.example', suggestedName: 'Bücher' }],
    ['123.com', { url: 'https://123.com/', host: '123.com', rootDomain: '123.com', suggestedName: '123.com' }],
    ['360.cn', { url: 'https://360.cn/', host: '360.cn', rootDomain: '360.cn', suggestedName: '360.cn' }],
  ])('%j', (input, expected) => {
    expect(parseWatchInput(input)).toEqual(expected);
  });

  it.each([
    'unpeg',
    'https://intranet/',
    'ftp://unpeg.io',
    'mailto:hi@unpeg.io',
    'javascript:alert(1)',
    'unpeg .io',
    'https://unpeg.io/a b',
    '',
    '   ',
    'https://*.unpeg.io',
    'https://foo..io',
    'https://-bad-.io',
  ])('rejects %j', (input) => {
    expect(parseWatchInput(input)).toBeNull();
  });

  it('never throws on non-strings', () => {
    expect(parseWatchInput(undefined as unknown as string)).toBeNull();
  });
});

describe('display helpers', () => {
  it('displayUrl', () => {
    expect(displayUrl('https://unpeg.io/docs/faq')).toBe('unpeg.io/docs/faq');
    expect(displayUrl('https://unpeg.io/docs/faq/')).toBe('unpeg.io/docs/faq');
    expect(displayUrl('https://unpeg.io/')).toBe('unpeg.io/');
    expect(displayUrl('https://unpeg.io')).toBe('unpeg.io/');
    expect(displayUrl('http://127.0.0.1:8080/x?a=1#frag')).toBe('127.0.0.1:8080/x?a=1');
    expect(displayUrl('https://a.io/caf%C3%A9')).toBe('a.io/café');
    expect(displayUrl('not a url')).toBe('not a url');
  });

  it('urlPath', () => {
    expect(urlPath('https://unpeg.io/docs/faq')).toBe('/docs/faq');
    expect(urlPath('https://unpeg.io/')).toBe('/');
    expect(urlPath('https://unpeg.io')).toBe('/');
    expect(urlPath('https://unpeg.io/list?page=2#x')).toBe('/list?page=2');
    expect(urlPath('/already/a/path')).toBe('/already/a/path');
    expect(urlPath('garbage')).toBe('/');
  });

  it('urlFilename', () => {
    expect(urlFilename('https://a.io/x/whitepaper.pdf')).toBe('whitepaper.pdf');
    expect(urlFilename('https://a.io/x/white%20paper.pdf?v=1')).toBe('white paper.pdf');
    expect(urlFilename('https://a.io/docs/')).toBe('docs');
    expect(urlFilename('https://a.io/')).toBe('a.io');
    expect(urlFilename('http://127.0.0.1:9000/')).toBe('127.0.0.1:9000');
    expect(urlFilename('files/report.md')).toBe('report.md');
    expect(urlFilename('https://a.io/%E0%A4%A')).toBe('%E0%A4%A');
  });
});
