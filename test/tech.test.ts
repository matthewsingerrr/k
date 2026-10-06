import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectTech, knownTechnologies, type TechInput } from '../src/link/tech.js';
import { parseHtml } from '../src/extract/html.js';
import type { TechHit } from '../src/link/types.js';

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function input(over: Partial<TechInput> = {}): TechInput {
  return { url: 'https://site.io/', headers: {}, html: '', scripts: [], styles: [], generator: null, js: '', hosts: [], cookies: [], ...over };
}

/** TechInput the way scan.ts builds it from a page. */
function fromPage(html: string, url: string, over: Partial<TechInput> = {}): TechInput {
  const p = parseHtml(html, url);
  return input({
    url,
    html,
    scripts: [...p.assets.scripts, ...p.assets.preloads],
    styles: p.assets.styles,
    generator: p.generator,
    hosts: p.hosts,
    ...over,
  });
}

const names = (hits: TechHit[]) => hits.map((h) => h.name);
const find = (hits: TechHit[], name: string) => hits.find((h) => h.name === name);

describe('detectTech — real-world pages', () => {
  it('Next.js app router + Turbopack on Vercel (unpeg.io fixture)', () => {
    const hits = detectTech(
      fromPage(fixture('nextjs-app-home.html'), 'https://unpeg.io/', {
        headers: { server: 'Vercel', 'x-vercel-id': 'iad1::iad1::8l2kq-1759600000000-abc', 'x-vercel-cache': 'HIT' },
      }),
    );
    const next = find(hits, 'Next.js');
    expect(next).toBeDefined();
    expect(next?.category).toBe('framework');
    expect(next?.evidence).toMatch(/^app router · Turbopack/);
    expect(next?.evidence).not.toMatch(/pages router/);
    expect(find(hits, 'React')).toMatchObject({ category: 'framework', evidence: 'implied by Next.js' });
    expect(find(hits, 'Vercel')).toMatchObject({ category: 'hosting', evidence: 'x-vercel-id header' });
    // The page links to dexscreener.com and x.com and talks about Solana and Pyth: none of that is tech.
    for (const n of ['DexScreener', 'Pyth', 'Solana web3.js', 'WordPress']) expect(names(hits)).not.toContain(n);
    for (const h of hits) expect(h.evidence.length).toBeLessThanOrEqual(90);
  });

  it('Next.js pages router: router flavour from __NEXT_DATA__ and the build manifest', () => {
    const hits = detectTech(fromPage(fixture('extract-nextjs-pages.html'), 'https://acme.finance/earn', { headers: { 'x-powered-by': 'Next.js' } }));
    const next = find(hits, 'Next.js');
    expect(next?.evidence).toMatch(/^pages router/);
    expect(next?.evidence).toContain('x-powered-by');
    expect(names(hits)).toContain('React');
  });

  it('WordPress: version from the generator tag, plugins, jQuery version from its URL', () => {
    const html = `<!DOCTYPE html><html><head>
      <meta name="generator" content="WordPress 6.5.2" />
      <link rel="https://api.w.org/" href="https://blog.example.org/wp-json/" />
      <link rel="stylesheet" href="https://blog.example.org/wp-includes/css/dist/block-library/style.min.css?ver=6.5.2" />
      <link rel="stylesheet" href="https://blog.example.org/wp-content/plugins/woocommerce/assets/css/woocommerce.css?ver=8.7.0" />
      <script src="https://blog.example.org/wp-includes/js/jquery/jquery.min.js?ver=3.7.1"></script>
      <script src="https://blog.example.org/wp-content/themes/astra/assets/js/minified/frontend.min.js?ver=4.6.4"></script>
      <script>var woocommerce_params = {"ajax_url":"\\/wp-admin\\/admin-ajax.php"};</script>
      </head><body class="home page-template-default"><p>Hello</p></body></html>`;
    const hits = detectTech(fromPage(html, 'https://blog.example.org/', { headers: { server: 'nginx/1.25.3', 'x-powered-by': 'PHP/8.2.14' } }));
    expect(find(hits, 'WordPress')).toMatchObject({ category: 'cms', version: '6.5.2' });
    expect(find(hits, 'WordPress')?.evidence).toContain('generator');
    expect(find(hits, 'WooCommerce')).toMatchObject({ category: 'cms' });
    expect(find(hits, 'Nginx')).toMatchObject({ version: '1.25.3' });
    expect(find(hits, 'PHP')).toMatchObject({ version: '8.2.14' });
    expect(names(hits)).toContain('jQuery');
  });

  it('WordPress version from a wp-includes ?ver= query when there is no generator tag', () => {
    const html = `<html><head><link rel="stylesheet" href="/wp-includes/css/dist/block-library/style.min.css?ver=6.4.3"></head><body></body></html>`;
    const hits = detectTech(fromPage(html, 'https://shop.example.net/'));
    expect(find(hits, 'WordPress')).toMatchObject({ version: '6.4.3' });
  });

  it('Webflow site with Google Fonts and GSAP', () => {
    const html = `<!DOCTYPE html><html data-wf-domain="www.launch.xyz" data-wf-page="65f1c0a1b2c3d4e5f6a7b8c9" data-wf-site="65f1c0a1b2c3d4e5f6a7b8c0">
      <head><meta content="Webflow" name="generator"/>
      <link href="https://cdn.prod.website-files.com/65f1c0a1b2c3d4e5f6a7b8c0/css/launch.webflow.shared.4c2f.css" rel="stylesheet" type="text/css"/>
      <link href="https://fonts.googleapis.com" rel="preconnect"/>
      <script src="https://ajax.googleapis.com/ajax/libs/webfont/1.6.26/webfont.js"></script></head>
      <body><a class="w-webflow-badge" href="https://webflow.com?utm_campaign=brandjs">Made in Webflow</a>
      <script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
      <script src="https://cdn.prod.website-files.com/65f1c0a1b2c3d4e5f6a7b8c0/js/webflow.7c1a2b3d.js" type="text/javascript"></script>
      </body></html>`;
    const hits = detectTech(fromPage(html, 'https://www.launch.xyz/'));
    expect(find(hits, 'Webflow')).toMatchObject({ category: 'cms' });
    expect(find(hits, 'Google Fonts')).toMatchObject({ category: 'fonts' });
    expect(find(hits, 'GSAP')).toMatchObject({ category: 'ui', version: '3.12.5' });
    expect(find(hits, 'jsDelivr')).toMatchObject({ category: 'cdn' });
  });

  it('web3 dApp bundle: Solana web3.js, Privy, Helius, wallet adapter, React version, Sentry, PostHog', () => {
    const js = [
      '/*! For license information please see main.js.LICENSE.txt */',
      '(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[179],{1234:function(e,t,n){',
      'var r=n(5678);const s="@solana/web3.js";const o={"solana-client":"js/1.95.3"};',
      'class P extends Error{constructor(){super("Invalid public key input")}}',
      'const rpc="https://mainnet.helius-rpc.com/?api-key="+key;',
      'fetch("https://auth.privy.io/api/v1/apps/"+id,{headers:{"privy-app-id":id,"privy-client":"react-auth:1.88.4"}});',
      'e.className="wallet-adapter-button wallet-adapter-button-trigger";',
      'var Ys={bundleType:0,version:"18.3.1",rendererPackageName:"react-dom"};',
      'window.__SENTRY__=window.__SENTRY__||{};var dsn="https://abc123@o450000.ingest.us.sentry.io/4507000000000000";',
      'posthog.init("phc_abc",{api_host:"https://us.i.posthog.com"});',
      '}}]);',
    ].join('\n');
    const hits = detectTech(
      input({
        url: 'https://pad.example/',
        js,
        hosts: ['mainnet.helius-rpc.com', 'auth.privy.io', 'us.i.posthog.com'],
        scripts: ['https://pad.example/_next/static/chunks/main-abc.js'],
      }),
    );
    expect(find(hits, 'Solana web3.js')).toMatchObject({ category: 'web3', version: '1.95.3' });
    expect(find(hits, 'Privy')).toMatchObject({ category: 'auth', version: '1.88.4' });
    expect(find(hits, 'Helius')).toMatchObject({ category: 'web3' });
    expect(find(hits, 'Helius')?.evidence).toContain('helius-rpc.com');
    expect(find(hits, 'Solana Wallet Adapter')).toBeDefined();
    expect(find(hits, 'React')).toMatchObject({ version: '18.3.1' });
    expect(find(hits, 'Sentry')).toMatchObject({ category: 'monitoring' });
    expect(find(hits, 'PostHog')).toMatchObject({ category: 'analytics' });
    expect(find(hits, 'Next.js')).toBeDefined();
  });

  it('works from bundle text alone (no host list) for RPC hosts and SDKs', () => {
    const js = 'const c=new Connection("https://mainnet.helius-rpc.com/?api-key=x");const h={"privy-app-id":a};';
    const hits = detectTech(input({ js }));
    expect(names(hits)).toEqual(expect.arrayContaining(['Helius', 'Privy']));
  });

  it('EVM stack: wagmi + RainbowKit + viem versions, WalletConnect hosts', () => {
    const js =
      'localStorage.getItem("wagmi.recentConnectorId");var v="Version: viem@2.21.1";' +
      'var w="wagmi@2.12.17";localStorage.setItem("rk-recent",JSON.stringify(r));' +
      'new WebSocket("wss://relay.walletconnect.org/?projectId="+p);';
    const hits = detectTech(input({ js, hosts: ['relay.walletconnect.org'] }));
    expect(find(hits, 'viem')).toMatchObject({ version: '2.21.1' });
    expect(find(hits, 'wagmi')).toMatchObject({ version: '2.12.17' });
    expect(names(hits)).toEqual(expect.arrayContaining(['RainbowKit', 'WalletConnect']));
  });

  it('headers, cookies and site hosts', () => {
    const hits = detectTech(
      input({
        url: 'https://my-app.up.railway.app/',
        headers: { 'cf-ray': '8a1b2c3d4e5f-FRA', server: 'cloudflare', 'x-railway-request-id': 'abc' },
        cookies: ['__cf_bm', '_ga', '_ga_ABC123', 'ph_phc_abc_posthog'],
      }),
    );
    expect(find(hits, 'Cloudflare')).toMatchObject({ category: 'cdn' });
    expect(find(hits, 'Cloudflare Bot Management')).toMatchObject({ category: 'security', evidence: 'cookie __cf_bm' });
    expect(find(hits, 'Railway')).toMatchObject({ category: 'hosting' });
    expect(find(hits, 'Google Analytics')).toBeDefined();
    expect(find(hits, 'PostHog')).toBeDefined();

    const site = detectTech(input({ url: 'https://unpeg.vercel.app/' }));
    expect(find(site, 'Vercel')?.evidence).toBe('site on unpeg.vercel.app');
  });

  it('Tailwind + shadcn/ui from utility classes', () => {
    const html = `<html><body><div class="flex items-center justify-between gap-x-4 rounded-lg">
      <p class="text-sm text-muted-foreground tracking-tight">Hi</p>
      <button data-slot="button" class="bg-primary text-primary-foreground ring-offset-background hover:bg-primary/90">Go</button>
      </div></body></html>`;
    const hits = detectTech(input({ html }));
    expect(find(hits, 'Tailwind CSS')?.evidence).toMatch(/^markers /);
    expect(names(hits)).toContain('shadcn/ui');
  });
});

describe('detectTech — precision guards', () => {
  it('generic words in code or copy are not signals', () => {
    const js =
      'const stripe = getStripe(); var phantom = true; let privy = "privy"; const next = items.next(); ' +
      'React.createElement("div"); var wordpress = "WordPress"; const solana = "solana"; const jupiter = 1; ' +
      'var tailwind = "items-center"; var gsap = "gsap"; var sentry = "sentry"; var firebase = "firebase"; ' +
      'var raydium = "raydium"; var webflow = "webflow"; var pump = "pump.fun is great";';
    const html =
      '<html><body><p>We moved from WordPress to Next.js; pay with Stripe or Phantom on Solana.</p>' +
      '<p>Built with React and Tailwind. Ask us on Discord or Telegram.</p></body></html>';
    const hits = detectTech(input({ js, html }));
    expect(hits).toEqual([]);
  });

  it('plain links to trading sites, socials or vendors are not tech; checkout links are', () => {
    const hits = detectTech(
      input({
        linkHosts: ['dexscreener.com', 'x.com', 't.me', 'birdeye.so', 'gmgn.ai', 'webflow.com', 'buy.stripe.com'],
      }),
    );
    // A checkout link proves Stripe; a link to webflow.com (without the badge markup) proves nothing.
    expect(names(hits)).toEqual(['Stripe']);
  });

  it('a *.vercel.app API in the code does not mean the site is on Vercel', () => {
    const hits = detectTech(input({ url: 'https://site.io/', hosts: ['api-foo.vercel.app', 'thing.netlify.app'] }));
    expect(names(hits)).not.toContain('Vercel');
    expect(names(hits)).not.toContain('Netlify');
  });

  it('a needle verified by its window does not count on a near miss', () => {
    // "svelte-" without a hash, "GSAP " without a version, dexscreener without ?embed=1.
    const js = 'import "svelte-hmr"; log("GSAP is fun"); open("https://dexscreener.com/solana/abc");';
    const hits = detectTech(input({ js }));
    expect(names(hits)).not.toContain('Svelte');
    expect(names(hits)).not.toContain('GSAP');
    expect(names(hits)).not.toContain('DexScreener');
  });

  it('two weak utility classes are not enough for Tailwind', () => {
    const hits = detectTech(input({ html: '<div class="items-center justify-between">x</div>' }));
    expect(names(hits)).not.toContain('Tailwind CSS');
  });

  it('needles inside longer class names / identifiers do not count', () => {
    const html =
      '<div class="d-flex align-items-center justify-content-between rounded-lg variant-btn variant-layout">' +
      '<form class="with-captcha"></form><a class="bookmark-recent fork-version"></a></div>';
    const js = 'var ADD_RUMBLE=1;var x={UNREUMATIC:1};const lenis_smooth=1;foo.heap.load(1);';
    const hits = detectTech(input({ html, js }));
    expect(hits).toEqual([]);
  });
});

describe('detectTech — output shape & robustness', () => {
  it('dedupes by name and sorts by category order then name', () => {
    const hits = detectTech(
      input({
        url: 'https://x.vercel.app/',
        headers: { 'x-vercel-id': 'a', 'cf-ray': 'b', server: 'Vercel' },
        js: '"privy-app-id";"@solana/web3.js";window.__SENTRY__;"rendererPackageName:\\"react-dom\\""',
        hosts: ['mainnet.helius-rpc.com', 'fonts.googleapis.com', 'auth.privy.io'],
      }),
    );
    const seen = new Set<string>();
    for (const h of hits) {
      expect(seen.has(h.name)).toBe(false);
      seen.add(h.name);
    }
    const order = ['framework', 'hosting', 'cdn', 'cms', 'docs', 'ui', 'analytics', 'monitoring', 'auth', 'payments', 'support', 'web3', 'fonts', 'security', 'other'];
    for (let i = 1; i < hits.length; i++) {
      const a = hits[i - 1];
      const b = hits[i];
      const ca = order.indexOf(a.category);
      const cb = order.indexOf(b.category);
      expect(ca).toBeLessThanOrEqual(cb);
      if (ca === cb) expect(a.name.toLowerCase() <= b.name.toLowerCase()).toBe(true);
    }
    expect(names(hits)).toEqual(['Vercel', 'Cloudflare', 'Sentry', 'Privy', 'Helius', 'Solana web3.js', 'Google Fonts']);
  });

  it('never throws on junk input', () => {
    const junk = [
      undefined,
      null,
      {},
      { url: 42, headers: null, html: 7, scripts: 'x', styles: [null, 3], generator: {}, js: [], hosts: [1, null], cookies: 'a' },
      { url: 'not a url', headers: { server: undefined, 'x-powered-by': null }, html: '\u0000'.repeat(10), js: '\uD800'.repeat(100) },
    ];
    for (const j of junk) {
      expect(() => detectTech(j as unknown as TechInput)).not.toThrow();
      expect(Array.isArray(detectTech(j as unknown as TechInput))).toBe(true);
    }
  });

  it('covers the advertised catalogue', () => {
    const known = knownTechnologies();
    expect(known.length).toBeGreaterThanOrEqual(120);
    const all = new Set(known.map((k) => k.name));
    for (const n of [
      'Next.js', 'Nuxt', 'SvelteKit', 'Remix', 'Gatsby', 'Astro', 'Vite', 'React', 'Vue', 'Angular', 'SolidJS', 'Qwik', 'Docusaurus',
      'VitePress', 'Hugo', 'Jekyll', 'Eleventy', 'Vercel', 'Netlify', 'Cloudflare', 'Cloudflare Pages', 'Cloudflare Workers',
      'Railway', 'Render', 'Fly.io', 'Amazon CloudFront', 'Amazon S3', 'AWS Amplify', 'Google Cloud', 'Firebase Hosting',
      'GitHub Pages', 'Heroku', 'DigitalOcean', 'Fastly', 'Akamai', 'WordPress', 'Webflow', 'Framer', 'Wix', 'Squarespace',
      'Shopify', 'Ghost', 'Notion', 'Super', 'Carrd', 'Bubble', 'GitBook', 'Mintlify', 'ReadMe', 'Nextra', 'Tailwind CSS',
      'shadcn/ui', 'Radix UI', 'MUI', 'Chakra UI', 'Bootstrap', 'Framer Motion', 'GSAP', 'Three.js', 'Lottie',
      'Google Analytics', 'Google Tag Manager', 'Plausible', 'PostHog', 'Mixpanel', 'Amplitude', 'Segment', 'Hotjar',
      'Microsoft Clarity', 'Vercel Analytics', 'Vercel Speed Insights', 'Umami', 'Fathom', 'Heap', 'Sentry', 'Datadog RUM',
      'LogRocket', 'Bugsnag', 'Privy', 'Dynamic', 'Web3Auth', 'Magic', 'Auth0', 'Clerk', 'Supabase', 'Firebase Auth',
      'NextAuth.js', 'Solana web3.js', 'Solana Wallet Adapter', 'Phantom', 'Jupiter', 'Raydium', 'Metaplex', 'Helius',
      'QuickNode', 'Alchemy', 'Infura', 'Triton One', 'ethers', 'viem', 'wagmi', 'RainbowKit', 'WalletConnect',
      'Reown AppKit', 'Coinbase Wallet SDK', 'Moralis', 'The Graph', 'Pyth', 'Switchboard', 'pump.fun', 'Meteora', 'Orca',
      'Tensor', 'Magic Eden', 'Birdeye', 'DexScreener', 'GMGN', 'TradingView', 'Stripe', 'PayPal', 'Coinbase Commerce',
      'Intercom', 'Crisp', 'Zendesk', 'Tawk.to', 'Discord widget', 'Google Fonts', 'Adobe Fonts', 'Font Awesome',
      'Cloudflare Turnstile', 'reCAPTCHA', 'hCaptcha', 'Vercel Firewall',
    ]) {
      expect(all.has(n), n).toBe(true);
    }
  });
});

describe('detectTech — performance', () => {
  it('scans 5 MB of HTML + JS well under the budget', () => {
    // Realistic-ish minified code: identifiers, strings, near-misses of needles ("__next", "wallet", "data-").
    const parts: string[] = [];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const words = ['function', 'return', 'window', 'document', '__next', 'wallet', 'data-', 'className', 'items-center', 'api', 'solana', 'privy', 'react'];
    let len = 0;
    while (len < 2.5 * 1024 * 1024) {
      const w = words[Math.floor(rnd() * words.length)];
      const p = `${w}${Math.floor(rnd() * 1e6).toString(36)}("${w}-${len % 97}"),`;
      parts.push(p);
      len += p.length;
    }
    const body = parts.join('');
    const js = `${body}var x={"privy-app-id":1};`;
    const html = `<html><body>${body}<div data-wf-site="x"></div></body></html>`;
    const inp = input({ html, js, hosts: Array.from({ length: 300 }, (_, i) => `h${i}.example.com`) });
    detectTech(inp); // warm-up (JIT)
    const t = performance.now();
    const hits = detectTech(inp);
    const ms = performance.now() - t;
    expect(names(hits)).toEqual(expect.arrayContaining(['Privy', 'Webflow']));
    expect(ms).toBeLessThan(150);
  });

  it('stays bounded on pathological repetition', () => {
    const js = '__next'.repeat(500_000) + 'items-center '.repeat(100_000);
    const t = performance.now();
    detectTech(input({ html: js, js }));
    expect(performance.now() - t).toBeLessThan(500);
  });
});
