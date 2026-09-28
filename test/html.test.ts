import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { limitNesting, looksLikeHtml, pageTextSnapshot, parseHtml, type ParsedPage } from '../src/extract/html.js';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const APP_ROUTER_BUILD_ID = 'KU791SoC2tXw-mGI_0Sms';

/** Lines that would indicate script/JSON/RSC payload leaking into visible text. */
function junkLines(lines: string[]): string[] {
  return lines.filter((l) =>
    /self\.__next_f|\$Sreact|_next\/static|\{"|":\[|\\"|function\s*\(|sessionStorage|@context/.test(l),
  );
}

describe('parseHtml — Next.js app router fixtures (unpeg.io)', () => {
  const docs = parseHtml(fixture('nextjs-app-docs.html'), 'https://unpeg.io/docs');
  const home = parseHtml(fixture('nextjs-app-home.html'), 'https://unpeg.io/');

  it('fixtures really carry the escaped build id', () => {
    expect(fixture('nextjs-app-home.html')).toContain(`\\"b\\":\\"${APP_ROUTER_BUILD_ID}\\"`);
    expect(fixture('nextjs-app-docs.html')).toContain(`\\"b\\":\\"${APP_ROUTER_BUILD_ID}\\"`);
  });

  it('extracts the app-router build id from RSC flight data', () => {
    expect(docs.buildId).toBe(APP_ROUTER_BUILD_ID);
    expect(home.buildId).toBe(APP_ROUTER_BUILD_ID);
  });

  it('extracts title, description and og:image', () => {
    expect(docs.title).toBe('Docs · Unpeg');
    expect(docs.description).toBe(
      'How Unpeg BREAK/HOLD contracts work: terms, price measurement, risks, guides for the app, and the public API.',
    );
    expect(home.title).toBe('Unpeg');
    expect(home.ogImage).toBe('https://unpeg.io/brand/og.png');
    expect(home.generator).toBeNull();
    expect(home.canonical).toBeNull();
    expect(home.noindex).toBe(false);
  });

  it('produces sensible docs lines: nav items, headings, paragraphs, table cells', () => {
    const lines = docs.textLines;
    expect(junkLines(lines)).toEqual([]);
    // Header & nav items are separate lines, not glued ("OverviewHow it works...").
    expect(lines.slice(0, 6)).toEqual(['UNPEG', 'Docs', 'Open app →', 'Start', 'Overview', 'How it works']);
    for (const item of ['BREAK and HOLD', 'Fixed terms', 'Price and reporters', 'Markets and status', 'FAQ', 'API', 'Brand']) {
      expect(lines).toContain(item);
    }
    expect(lines).toContain('Unpeg in one page');
    expect(lines).toContain('The problem');
    expect(lines).toContain('A seven-day contract on whether a token trades away from what it tracks, and for how long.');
    // Inline markup + React's <!-- --> separators stay on one line with correct spacing.
    expect(lines.some((l) => l.includes('issues two transferable notes: one BREAK and one HOLD. Over the next'))).toBe(true);
    expect(lines).toContain('0.02625 SOL');
    expect(lines[lines.length - 1]).toBe('How it works →');
    // Every line is collapsed & trimmed and non-empty.
    for (const l of lines) {
      expect(l).toBe(l.trim());
      expect(l).not.toMatch(/\s{2,}/);
      expect(l.length).toBeGreaterThan(0);
    }
  });

  it('drops hidden loaders / aria-hidden decorations and scripts on the home page', () => {
    const lines = home.textLines;
    expect(junkLines(lines)).toEqual([]);
    expect(lines.slice(0, 6)).toEqual(['UNPEG', 'Fully funded contracts on depeg duration', 'Docs', 'Whitepaper', '$UNPEG', 'Open app →']);
    // The aria-hidden BREAK/HOLD rail and the loader tiles are gone.
    expect(lines).not.toContain('Break');
    expect(lines).not.toContain('U');
    expect(lines).toContain('Mint a pair before the series starts: 0.03 SOL in, one BREAK and one HOLD out');
  });

  it('collects links (normalized, deduped, incl. external) and same-document assets', () => {
    expect(docs.links).toEqual([
      'https://unpeg.io/',
      'https://unpeg.io/app',
      'https://unpeg.io/docs',
      'https://unpeg.io/docs/how-it-works',
      'https://unpeg.io/docs/notes',
      'https://unpeg.io/docs/terms',
      'https://unpeg.io/docs/oracle',
      'https://unpeg.io/docs/risks',
      'https://unpeg.io/docs/guides',
      'https://unpeg.io/docs/markets',
      'https://unpeg.io/docs/faq',
      'https://unpeg.io/docs/api',
      'https://unpeg.io/docs/brand',
      'https://unpeg.io/app/series',
    ]);
    expect(home.links).toContain('https://unpeg.io/whitepaper.pdf');
    expect(home.links).toContain('https://x.com/unpegdotio');
    expect(home.links.some((l) => l.startsWith('https://dexscreener.com/solana/'))).toBe(true);
    expect(docs.assets.scripts).toContain('https://unpeg.io/_next/static/chunks/188k11-l71qp9.js');
    expect(docs.assets.scripts).toContain('https://unpeg.io/_next/static/chunks/310vm2bl3xxpt.js');
    expect(new Set(docs.assets.scripts).size).toBe(docs.assets.scripts.length);
    expect(docs.assets.styles).toEqual([
      'https://unpeg.io/_next/static/chunks/0--9-y9nvg2ye.css',
      'https://unpeg.io/_next/static/chunks/2395517br8gh-.css',
    ]);
    // Only the as=script preload; font preloads are excluded.
    expect(docs.assets.preloads).toEqual(['https://unpeg.io/_next/static/chunks/310vm2bl3xxpt.js']);
  });

  it('collects hosts from absolute URLs in attributes and inline scripts', () => {
    expect(home.hosts).toEqual(['dexscreener.com', 'unpeg.io', 'x.com']);
    expect(docs.hosts).toEqual(['unpeg.io']);
  });

  it('is deterministic', () => {
    expect(parseHtml(fixture('nextjs-app-docs.html'), 'https://unpeg.io/docs')).toEqual(docs);
  });
});

describe('parseHtml — Next.js pages router fixture', () => {
  const html = fixture('extract-nextjs-pages.html');
  const p = parseHtml(html, 'https://acme.finance/earn');

  it('reads buildId from __NEXT_DATA__', () => {
    expect(p.buildId).toBe('Xk3pQ9rT7vW2yZ5aB8cD1');
  });

  it('falls back to the _buildManifest.js script path', () => {
    const noData = html.replace(/<script id="__NEXT_DATA__"[\s\S]*?<\/script>/, '');
    expect(noData).not.toContain('__NEXT_DATA__');
    expect(parseHtml(noData, 'https://acme.finance/earn').buildId).toBe('Xk3pQ9rT7vW2yZ5aB8cD1');
    const ssgOnly = noData.replace(/<script src="[^"]*_buildManifest\.js"[^>]*><\/script>/, '');
    expect(ssgOnly).not.toContain('_buildManifest');
    expect(parseHtml(ssgOnly, 'https://acme.finance/earn').buildId).toBe('Xk3pQ9rT7vW2yZ5aB8cD1');
  });

  it('reads buildId from truncated __NEXT_DATA__ via regex fallback', () => {
    const truncated =
      '<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{},"page":"/","buildId":"abc_DEF-123","props2":[1,2,';
    expect(parseHtml(truncated, 'https://a.io/').buildId).toBe('abc_DEF-123');
  });

  it('extracts metadata, text and links', () => {
    expect(p.title).toBe('Acme Finance — Earn');
    expect(p.description).toBe('Earn yield on your idle stablecoins with Acme.');
    expect(p.ogImage).toBe('https://acme.finance/og/earn.png');
    expect(p.canonical).toBe('https://acme.finance/earn');
    expect(p.textLines).toEqual([
      'Earn',
      'Borrow',
      'Docs',
      'Launch app',
      'Earn on stablecoins',
      'Deposit USDC and earn a variable APY. Current rate: 4.21% APY.',
      'TVL',
      '$12,345,678',
      'Depositors',
      '1,024',
      'Read the risk disclosure before depositing.',
      'Terms · Privacy · Contact',
    ]);
    expect(p.links).toContain('https://app.acme.finance/');
    expect(p.links).toContain('https://acme.finance/docs/earn');
    expect(p.links.some((l) => l.startsWith('mailto:'))).toBe(false);
    expect(p.hosts).toEqual(['acme.finance', 'api.acme.finance', 'app.acme.finance']);
    expect(p.assets.preloads).toEqual(['https://acme.finance/_next/static/css/2f1c7b0e8a9d.css']);
  });
});

describe('parseHtml — plain static fixture', () => {
  const p = parseHtml(fixture('extract-static.html'), 'https://oakivy.example.com/');

  it('collapses title/description whitespace and decodes entities', () => {
    expect(p.title).toBe('Oak & Ivy Bakery');
    expect(p.description).toBe('Fresh bread, daily.');
    expect(p.generator).toBe('Hugo 0.121.1');
    expect(p.canonical).toBe('https://oakivy.example.com/');
    expect(p.buildId).toBeNull();
    expect(p.noindex).toBe(false);
  });

  it('produces block/inline lines', () => {
    expect(p.textLines).toEqual([
      'Home',
      'Menu',
      'About us',
      'Shop',
      'Welcome to Oak & Ivy',
      'Hello world, we bake every morning.',
      'Open 7am–3pm.',
      'The best sourdough in town.',
      'Item',
      'Price',
      'Sourdough',
      '$6',
      'line one',
      'line two',
      'Download our menu (PDF) or print.',
      'Jump to hours Call Email',
      '© 2026 Oak & Ivy · Instagram',
    ]);
  });

  it('normalizes links and drops non-http schemes (the RSS alternate is a feed, not a page)', () => {
    expect(p.links).toEqual([
      'https://oakivy.example.com/',
      'https://oakivy.example.com/menu',
      'https://oakivy.example.com/about',
      'https://shop.oakivy.example.com/cart?a=1&b=2',
      'https://oakivy.example.com/files/menu.pdf',
      'https://www.instagram.com/oakivy',
    ]);
  });

  it('resolves assets keeping query strings', () => {
    expect(p.assets.scripts).toEqual([
      'https://oakivy.example.com/js/app.js?v=3',
      'https://www.googletagmanager.com/gtag/js?id=G-XXXX',
    ]);
    expect(p.assets.styles).toEqual(['https://oakivy.example.com/css/site.css?v=3']);
    expect(p.assets.preloads).toEqual([]);
  });

  it('excludes RFC example domains from hosts', () => {
    expect(p.hosts).toEqual(['www.googletagmanager.com', 'www.instagram.com']);
  });
});

describe('parseHtml — docs (Docusaurus-like) fixture', () => {
  const p = parseHtml(fixture('extract-docs.html'), 'https://docs.acme.finance/staking');

  it('reads metadata; description beats og:description', () => {
    expect(p.title).toBe('Staking | Acme Docs');
    expect(p.description).toBe('How staking works on Acme.');
    expect(p.generator).toBe('Docusaurus v3.5.2');
    expect(p.canonical).toBe('https://docs.acme.finance/staking');
  });

  it('keeps code blocks line-by-line and syntax tokens joined', () => {
    expect(p.textLines).toContain('const stake = await acme.stake(100)');
    expect(p.textLines).toContain('console.log(stake)');
  });

  it('keeps inline prices and prose together, splits nav/sidebar items', () => {
    expect(p.textLines).toContain('Prices: $10 per month.');
    expect(p.textLines).toContain('Stake ACME to earn a share of protocol fees. Rewards are paid every epoch (about 2 days).');
    expect(p.textLines.slice(0, 5)).toEqual(['Skip to main content', 'Acme Docs', 'Guides', 'API', 'GitHub']);
    expect(p.textLines).toContain('How it works');
    expect(p.textLines).toContain('Unstaking takes 7 days.');
    expect(p.textLines.filter((l) => l === 'Staking')).toHaveLength(3);
    expect(p.textLines).not.toContain('External link');
  });

  it('hosts ignore xmlns but keep real external links', () => {
    expect(p.hosts).toEqual(['docs.acme.finance', 'github.com']);
    expect(p.links).toContain('https://github.com/acme/docs');
  });
});

describe('parseHtml — hidden content fixture', () => {
  const p = parseHtml(fixture('extract-hidden.html'), 'https://h.example.org/');

  it('removes invisible content', () => {
    expect(p.textLines).toEqual([
      'Visible heading',
      'Visible paragraph',
      'Aria false is visible',
      'Display block is visible',
      'Weird display value is visible',
      'Visibility hidden is kept',
      'Option A',
      'Option B',
      'Click me',
      'Label text',
      'Zerowidth and non breaking spaces',
      'Nested visible',
    ]);
    const all = p.textLines.join('\n');
    for (const secret of [
      'HIDDEN',
      'ARIA',
      'DISPLAY_NONE',
      'NOSCRIPT',
      'TEMPLATE',
      'SVG_',
      'CANVAS',
      'IFRAME',
      'OBJECT',
      'COMMENT',
      'LD_JSON',
      'STYLE_TEXT',
      'SCRIPT_TEXT',
      '404',
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  it('uses the last non-empty <title> (Next.js 404 appends one in the body)', () => {
    expect(p.title).toBe('404: This page could not be found.');
  });

  it('still collects links inside noscript', () => {
    expect(p.links).toEqual(['https://h.example.org/noscript-link']);
  });
});

describe('parseHtml — build id detection (other frameworks)', () => {
  const page = (head: string, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

  it('app router: unescaped "b" form via regex fallback', () => {
    const html = page('', `<script>self.__next_f.push([1,"0:{\\"b\\":\\"BUILD_id-12345\\",\\"f\\":[]}\n"]) /* not JSON */ ;;</script>`);
    expect(parseHtml(html, 'https://a.io/').buildId).toBe('BUILD_id-12345');
    const raw = page('', `<script>window.__next_f = window.__next_f || []; var x = {"b":"RawBuild_987654"};</script>`);
    expect(parseHtml(raw, 'https://a.io/').buildId).toBe('RawBuild_987654');
  });

  it('app router: row 0 split across push chunks', () => {
    const html = page(
      '',
      '<script>(self.__next_f=self.__next_f||[]).push([0])</script>' +
        '<script>self.__next_f.push([1,"1:\\"$Sreact.fragment\\"\\n0:{\\"P\\":null,\\"c\\":[\\"\\"],"])</script>' +
        '<script>self.__next_f.push([1,"\\"b\\":\\"SplitChunkId01\\"}\\n"])</script>',
    );
    expect(parseHtml(html, 'https://a.io/').buildId).toBe('SplitChunkId01');
  });

  it('app router: Next 13/14 array row 0', () => {
    const html = page('', '<script>self.__next_f.push([1,"0:[\\"OldStyleBuild42\\",[[\\"children\\",\\"__PAGE__\\"]]]\\n"])</script>');
    expect(parseHtml(html, 'https://a.io/').buildId).toBe('OldStyleBuild42');
  });

  it('app router: ignores ids that are too short', () => {
    const html = page('', '<script>self.__next_f.push([1,"0:{\\"b\\":\\"short\\"}\\n"])</script>');
    expect(parseHtml(html, 'https://a.io/').buildId).toBeNull();
  });

  it('Nuxt config buildId and builds/meta path', () => {
    const cfg = page(
      '',
      '<script>window.__NUXT__={};window.__NUXT__.config={public:{},app:{baseURL:"/",buildId:"8f3c2a1b-77aa-4c1e",buildAssetsDir:"/_nuxt/",cdnURL:""}}</script>',
    );
    expect(parseHtml(cfg, 'https://a.io/').buildId).toBe('8f3c2a1b-77aa-4c1e');
    const meta = page('<link rel="prefetch" href="/_nuxt/builds/meta/0d9e8f7a-1234.json">');
    expect(parseHtml(meta, 'https://a.io/').buildId).toBe('0d9e8f7a-1234');
  });

  it('Gatsby webpackCompilationHash', () => {
    const html = page('', '<script>window.___webpackCompilationHash="3b2d9f0c1a2e4f5a6b7c";</script>');
    expect(parseHtml(html, 'https://a.io/').buildId).toBe('3b2d9f0c1a2e4f5a6b7c');
    const json = page('', '<script>var pd = {"webpackCompilationHash":"abcdef123456"}</script>');
    expect(parseHtml(json, 'https://a.io/').buildId).toBe('abcdef123456');
  });

  it('SvelteKit __sveltekit_<id>', () => {
    const html = page('', '<script>{ __sveltekit_1x9abz = { base: new URL(".", location).pathname.slice(0, -1) }; }</script>');
    expect(parseHtml(html, 'https://a.io/').buildId).toBe('1x9abz');
  });

  it('Astro and plain sites → null', () => {
    const astro = page('<meta name="generator" content="Astro v4.0.0"><script type="module" src="/_astro/hoisted.abc123.js"></script>');
    const p = parseHtml(astro, 'https://a.io/');
    expect(p.buildId).toBeNull();
    expect(p.generator).toBe('Astro v4.0.0');
  });
});

describe('parseHtml — text extraction rules', () => {
  const lines = (body: string) => parseHtml(`<html><body>${body}</body></html>`, 'https://a.io/').textLines;

  it('inline elements stay on one line; blocks and <br> split', () => {
    expect(lines('<p>Hello <b>world</b></p>')).toEqual(['Hello world']);
    expect(lines('<p>a<br>b<br/>c</p>')).toEqual(['a', 'b', 'c']);
    expect(lines('<div>one<div>two</div>three</div>')).toEqual(['one', 'two', 'three']);
    expect(lines('<ul><li>x</li><li>y</li></ul><hr><h2>z</h2>')).toEqual(['x', 'y', 'z']);
    expect(lines('<p>x<b>bold</b><i>italic</i>y</p>')).toEqual(['xbolditalicy']);
    expect(lines('<p><b>bold</b><i>italic</i></p>')).toEqual(['bolditalic']);
  });

  it('item containers split glued layout children only', () => {
    expect(lines('<nav><a href="/a">Docs</a><a href="/b">Blog</a></nav>')).toEqual(['Docs', 'Blog']);
    expect(lines('<nav> <a href="/a">Docs</a> <a href="/b">Blog</a> </nav>')).toEqual(['Docs Blog']);
    expect(lines('<p><span>$</span><span>10</span></p>')).toEqual(['$10']);
    expect(lines('<p><span>10 </span><span>SOL</span></p>')).toEqual(['10 SOL']);
    expect(lines('<div><span>TVL</span><span>$1,024</span></div>')).toEqual(['TVL', '$1,024']);
    expect(lines('<pre><code><span>const</span><span> x</span></code></pre>')).toEqual(['const x']);
    expect(lines('<p><code><span>a</span><span>b</span></code></p>')).toEqual(['ab']);
  });

  it('pre keeps line breaks; other whitespace collapses', () => {
    expect(lines('<pre>a\n  b\r\nc</pre>')).toEqual(['a', 'b', 'c']);
    expect(lines('<p>  lots \n\t of   space&nbsp;&nbsp;here </p>')).toEqual(['lots of space here']);
  });

  it('does not dedupe lines', () => {
    expect(lines('<p>same</p><p>same</p>')).toEqual(['same', 'same']);
  });

  it('works without a body element', () => {
    expect(parseHtml('Just text <b>here</b>', 'https://a.io/').textLines).toEqual(['Just text here']);
  });

  it('decodes entities', () => {
    expect(lines('<p>&lt;tag&gt; &amp; &quot;q&quot; &#39;s&#39; &euro;5 &#x1F600;</p>')).toEqual(['<tag> & "q" \'s\' €5 😀']);
  });
});

describe('parseHtml — links, base href, assets', () => {
  it('honours <base href> for all relative URLs', () => {
    const p = parseHtml(
      '<html><head><link rel="stylesheet" href="s.css"><base href="https://cdn.a.io/sub/"></head><body><a href="page">x</a><script src="app.js"></script></body></html>',
      'https://a.io/x/y',
    );
    expect(p.links).toEqual(['https://cdn.a.io/sub/page']);
    expect(p.assets.scripts).toEqual(['https://cdn.a.io/sub/app.js']);
    expect(p.assets.styles).toEqual(['https://cdn.a.io/sub/s.css']);
  });

  it('ignores invalid base href', () => {
    const p = parseHtml('<base href="javascript:alert(1)"><a href="/p">x</a>', 'https://a.io/');
    expect(p.links).toEqual(['https://a.io/p']);
  });

  it('collects area and link[rel=alternate]; dedupes', () => {
    const p = parseHtml(
      '<link rel="alternate" hreflang="de" href="/de"><map><area href="/map-target"></map><a href="/x">1</a><a href="/x/">2</a><a href="/x#y">3</a><a>no href</a><a href="">empty</a>',
      'https://a.io/',
    );
    expect(p.links).toEqual(['https://a.io/de', 'https://a.io/map-target', 'https://a.io/x']);
  });

  it('skips alternate formats of the page (markdown twins, feeds) but keeps alternate pages and plain .md links', () => {
    const p = parseHtml(
      '<link rel="alternate" type="text/markdown" href="/x.md"><link rel="alternate" type="application/rss+xml" href="/feed.xml">' +
        '<link rel="alternate" type="text/html" hreflang="fr" href="/fr"><link rel="alternate" hreflang="de" href="/de">' +
        '<a href="/guide.md">Guide</a>',
      'https://a.io/x',
    );
    expect(p.links).toEqual(['https://a.io/fr', 'https://a.io/de', 'https://a.io/guide.md']);
  });

  it('preload filtering', () => {
    const p = parseHtml(
      '<link rel="preload" as="script" href="/a.js"><link rel="modulepreload" href="/b.mjs"><link rel="prefetch" as="style" href="/c.css"><link rel="preload" as="font" href="/f.woff2"><link rel="preload" as="image" href="/i.png"><link rel="stylesheet preload" as="style" href="/d.css">',
      'https://a.io/',
    );
    expect(p.assets.preloads).toEqual(['https://a.io/a.js', 'https://a.io/b.mjs', 'https://a.io/c.css', 'https://a.io/d.css']);
    expect(p.assets.styles).toEqual(['https://a.io/d.css']);
  });

  it('skips data: and javascript: asset URLs', () => {
    const p = parseHtml('<script src="data:text/javascript,1"></script><script src="javascript:1"></script>', 'https://a.io/');
    expect(p.assets.scripts).toEqual([]);
  });

  it('noindex from meta robots', () => {
    expect(parseHtml('<meta name="robots" content="NOINDEX, nofollow">', 'https://a.io/').noindex).toBe(true);
    expect(parseHtml('<meta name="ROBOTS" content="none">', 'https://a.io/').noindex).toBe(true);
    expect(parseHtml('<meta name="robots" content="index">', 'https://a.io/').noindex).toBe(false);
  });

  it('title handling: last non-empty, svg titles ignored', () => {
    expect(parseHtml('<title>First</title><body><title>  </title></body>', 'https://a.io/').title).toBe('First');
    expect(parseHtml('<title>A</title><body><title>B</title></body>', 'https://a.io/').title).toBe('B');
    expect(parseHtml('<title>Page</title><body><svg><title>Icon</title></svg></body>', 'https://a.io/').title).toBe('Page');
    expect(parseHtml('<p>no title</p>', 'https://a.io/').title).toBeNull();
  });

  it('description falls back to og:description', () => {
    expect(parseHtml('<meta property="og:description" content=" OG  desc ">', 'https://a.io/').description).toBe('OG desc');
    expect(parseHtml('<meta name="description" content="  ">', 'https://a.io/').description).toBeNull();
  });

  it('hosts: protocol-relative only after quote/(/=, escaped JSON URLs, noise removed', () => {
    const p = parseHtml(
      `<html><body style="background:url(//img.cdn.acme.io/bg.png)">
       <img src="//static.acme.io/x.png">
       <script>
         // commented.out code //window.location
         var a = "https:\\/\\/api.acme.io\\/v1"; var ws = 'wss://stream.acme.io:8443/feed';
         var ns = "http://www.w3.org/2000/svg"; var e = "https://example.com/"; var t = "https://api.acme.test/";
       </script></body></html>`,
      'https://acme.io/',
    );
    expect(p.hosts).toEqual(['api.acme.io', 'img.cdn.acme.io', 'static.acme.io', 'stream.acme.io']);
  });
});

describe('parseHtml — robustness', () => {
  it('never throws on malformed or hostile input', () => {
    const inputs: unknown[] = [
      '',
      '<',
      '<<<>>>',
      '<html',
      '<div><p><table><tr><td>cell</div></span></b>',
      '<!-- unclosed comment',
      '<script>never closed',
      '<a href="http://[bad">x</a><a href="http://%">y</a><link rel=stylesheet href="::">',
      '<p>\u0000\u0001\uFFFF</p>',
      '\uFEFF<!doctype html><title>BOM</title>',
      '<svg><svg><svg>' + '<g>'.repeat(5000),
      null,
      undefined,
      12345,
      { html: 'x' },
    ];
    for (const input of inputs) {
      expect(() => parseHtml(input as string, 'https://a.io/')).not.toThrow();
      expect(() => parseHtml(input as string, 'not a base')).not.toThrow();
    }
    expect(parseHtml('\uFEFF<!doctype html><title>BOM</title>', 'https://a.io/').title).toBe('BOM');
    expect(parseHtml('<div><p><table><tr><td>cell</div></span></b>', 'https://a.io/').textLines).toEqual(['cell']);
  });

  it('returns a complete empty-ish page for non-strings', () => {
    const p = parseHtml(undefined as unknown as string, 'https://a.io/');
    expect(p).toEqual<ParsedPage>({
      title: null,
      description: null,
      ogImage: null,
      canonical: null,
      generator: null,
      textLines: [],
      links: [],
      assets: { scripts: [], styles: [], preloads: [] },
      buildId: null,
      hosts: [],
      noindex: false,
    });
  });

  it('relative links with an invalid base are dropped, absolute ones kept', () => {
    const p = parseHtml('<a href="/rel">r</a><a href="https://b.io/abs">a</a>', 'garbage');
    expect(p.links).toEqual(['https://b.io/abs']);
  });

  it('parses only the first 3MB of huge documents, quickly', () => {
    const chunk = '<div class="row"><p>Row text <b>bold</b></p><a href="/r">r</a></div>';
    const huge = '<html><body>' + chunk.repeat(Math.ceil((3.5 * 1024 * 1024) / chunk.length)) + '<p>AFTER_CAP</p></body></html>';
    expect(huge.length).toBeGreaterThan(3.5 * 1024 * 1024);
    const t0 = performance.now();
    const p = parseHtml(huge, 'https://a.io/');
    const elapsed = performance.now() - t0;
    expect(p.textLines.join('\n')).not.toContain('AFTER_CAP');
    expect(p.textLines.length).toBeGreaterThan(10_000);
    expect(p.links).toEqual(['https://a.io/r']);
    expect(elapsed).toBeLessThan(5000);
  });

  it('pathologically deep nesting finishes fast', () => {
    const cases = [
      '<div>'.repeat(200_000) + 'deep',
      '<span>x</i>'.repeat(100_000),
      '<b>'.repeat(200_000),
      '<div/>'.repeat(200_000),
      '<table>'.repeat(50_000),
    ];
    for (const html of cases) {
      const t0 = performance.now();
      const p = parseHtml(html, 'https://a.io/');
      expect(p).toBeTruthy();
      expect(performance.now() - t0).toBeLessThan(2000);
    }
  });

  it('limitNesting cuts only beyond the depth limit and ignores raw text / comments / void tags', () => {
    const normal = '<div><p>a<p>b<ul><li>x<li>y</ul><img src=x><br><input></div>';
    expect(limitNesting(normal, 3)).toBe(normal);
    expect(limitNesting('<div><div><div><div>x', 3)).toBe('<div><div><div>');
    expect(limitNesting('<script>' + '<div>'.repeat(10) + '</script><div>ok</div>', 3)).toContain('ok');
    expect(limitNesting('<!--' + '<div>'.repeat(10) + '--><div>ok</div>', 3)).toContain('ok');
    expect(limitNesting('<svg>' + '<path/>'.repeat(10) + '</svg>', 3)).toContain('</svg>');
    expect(limitNesting('<div></div>'.repeat(100), 3)).toBe('<div></div>'.repeat(100));
  });
});

describe('pageTextSnapshot', () => {
  const base = parseHtml('<title>T</title><meta name="description" content="D"><p>one</p><p>two</p>', 'https://a.io/');

  it('formats title, description and lines', () => {
    expect(pageTextSnapshot(base)).toBe('# T\n> D\none\ntwo');
  });

  it('omits missing title / description', () => {
    expect(pageTextSnapshot({ ...base, title: null })).toBe('> D\none\ntwo');
    expect(pageTextSnapshot({ ...base, title: null, description: null })).toBe('one\ntwo');
    expect(pageTextSnapshot({ ...base, title: null, description: null, textLines: [] })).toBe('');
  });

  it('is pure', () => {
    const p = parseHtml(fixture('nextjs-app-docs.html'), 'https://unpeg.io/docs');
    expect(pageTextSnapshot(p)).toBe(pageTextSnapshot(parseHtml(fixture('nextjs-app-docs.html'), 'https://unpeg.io/docs')));
    expect(pageTextSnapshot(p).startsWith('# Docs · Unpeg\n> How Unpeg')).toBe(true);
  });
});

describe('looksLikeHtml', () => {
  it.each([
    ['text/html', null, true],
    ['text/html; charset=utf-8', null, true],
    ['TEXT/HTML', '', true],
    ['application/xhtml+xml', null, true],
    ['application/json', '{"a":1}', false],
    [null, '<!DOCTYPE html><html>', true],
    [null, '  \n\t<!doctype HTML>', true],
    [null, '\uFEFF<html lang="en">', true],
    [null, '<html>', true],
    [null, '<?xml version="1.0"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN">', true],
    [null, '<!-- generated --><!doctype html>', true],
    ['application/octet-stream', '<!doctype html>', true],
    [null, '<htmlx>', false],
    [null, '<?xml version="1.0"?><urlset>', false],
    [null, '{"html": "<html>"}', false],
    [null, 'hello <html>', false],
    [null, '<!-- unclosed', false],
    [null, null, false],
    [null, '', false],
    ['text/plain', 'plain', false],
  ])('(%j, %j) → %j', (ct, body, expected) => {
    expect(looksLikeHtml(ct, body)).toBe(expected);
  });
});
