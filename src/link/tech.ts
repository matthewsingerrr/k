/**
 * Technology fingerprinting ("what is this site built with?") for the Link API's /scan.
 *
 * Data-driven: every technology is one RULE below, listing the signals that identify it:
 * - `headers`   response header present (`true`) or whose value matches a regex (group 1 = version);
 * - `cookies`   a Set-Cookie name matching a regex;
 * - `generator` <meta name="generator"> regex (group 1 = version);
 * - `urls`      script / stylesheet URL regexes (group 1 = version);
 * - `hosts`     domains (a host counts when it equals the entry or is a subdomain of it) referenced by scripts, styles, the
 *               page's HTML (outside plain <a href> links) or the site's JS; `hostRe` for shapes a suffix can't express;
 * - `siteHosts` domains that only count for the scanned site's own hostname ("*.vercel.app" means hosted on Vercel; a
 *               *.vercel.app API in the code does not);
 * - `linkHosts` domains that count even when only linked (a buy.stripe.com checkout link means Stripe);
 * - `text`      literal needles searched in the HTML and the JS bundles, `markup` needles only in the HTML. A needle may
 *               carry `re` (must match a small window around the hit, else that occurrence does not count) and `ver`
 *               (group 1 = version, from the same window);
 * - `weak`      needles that only count when at least `weakMin` (default 2) distinct ones are seen (utility class names).
 *
 * Precision over recall: a single generic word is never a signal (the code mentioning "stripe" or "phantom" proves
 * nothing) — signals are hosts, script URLs, global names, storage keys, package banners, program ids and class names.
 *
 * Speed: the text needles are found in ONE pass per haystack by a rolling four-character key checked against a small
 * filter (~2–3 ms per MB regardless of how many needles there are; see scanText), the window regexes run only on hits,
 * and needles that are settled are switched off mid-scan (a Tailwind bundle repeats "items-center" thousands of times).
 * Inputs are capped, every regex is linear-time, and detectTech never throws.
 */
import type { TechCategory, TechHit } from './types.js';

export interface TechInput {
  url: string;
  /** Lowercase response headers of the homepage. */
  headers: Record<string, string>;
  /** Raw homepage HTML (may be ''). */
  html: string;
  /** Absolute URLs of scripts / styles / preloads on the homepage. */
  scripts: string[];
  styles: string[];
  /** <meta name="generator"> */
  generator: string | null;
  /** Concatenated (capped) source of the site's own JS bundles, for library banners & SDK names (may be ''). */
  js: string;
  /** Hostnames referenced in code / HTML. */
  hosts: string[];
  /** Cookie names from set-cookie. */
  cookies: string[];
  /**
   * Hostnames that only appear as plain links (<a href>) on the page. Optional: only rules that treat a link as proof
   * (a buy.stripe.com checkout link → Stripe) look at them; links to dexscreener.com or x.com are not tech.
   */
  linkHosts?: string[];
}

// ---------------------------------------------------------------------------
// Rule table
// ---------------------------------------------------------------------------

interface NeedleSpec {
  s: string;
  /** Must match the window around a hit for that occurrence to count. */
  re?: RegExp;
  /** Version (group 1) from the window around a hit. */
  ver?: RegExp;
  /** Evidence text (default: `code "<s>"` / `html "<s>"`). */
  ev?: string;
}
type Needle = string | NeedleSpec;

interface Rule {
  name: string;
  cat: TechCategory;
  headers?: Record<string, true | RegExp>;
  cookies?: RegExp;
  generator?: RegExp;
  urls?: RegExp | RegExp[];
  hosts?: string[];
  hostRe?: RegExp;
  siteHosts?: string[];
  linkHosts?: string[];
  text?: Needle[];
  markup?: Needle[];
  weak?: Needle[];
  weakMin?: number;
  implies?: string[];
}

/** A dotted version (group 1) after the product name in a generator tag, e.g. "WordPress 6.5.2", "Astro v4.5.1". */
const V = String.raw`\s*v?(\d+(?:\.\d+){0,3})?`;
const gen = (name: string): RegExp => new RegExp(String.raw`^\s*${name}\b${V}`, 'i');
/** A needle that must not continue a longer identifier / class name ("ant-btn" is not inside "variant-btn"). */
const word = (s: string): NeedleSpec => ({ s, re: new RegExp(`(?<![\\w$-])${s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`) });

const RULES: Rule[] = [
  // ------------------------------------------------------------------ frameworks
  {
    name: 'Next.js',
    cat: 'framework',
    headers: {
      'x-powered-by': /\bnext\.js(?:\s+v?(\d+(?:\.\d+){1,2}))?/i,
      'x-nextjs-cache': true,
      'x-nextjs-prerender': true,
      'x-nextjs-stale-time': true,
      'x-nextjs-postponed': true,
      vary: /next-router-state-tree/i,
    },
    generator: gen('Next\\.js'),
    urls: /\/_next\/static\//,
    markup: ['/_next/static/', 'name="next-size-adjust"', '<next-route-announcer'],
    text: [
      '__NEXT_DATA__',
      'self.__next_f',
      'webpackChunk_N_E',
      'next/dist/',
      '__next_require__',
      '__NEXT_P',
      { s: 'window.next={version:"', ver: /window\.next=\{version:"(\d+\.\d+\.\d+[\w.-]*)"/ },
      { s: '",appDir:!0', ver: /version:"(\d+\.\d+\.\d+[\w.-]*)",appDir:!0/ },
    ],
    implies: ['React'],
  },
  // Internal flags (names starting with "#" are never reported): Next.js router flavour & bundler.
  {
    name: '#next-app',
    cat: 'other',
    headers: { vary: /next-router-state-tree|\brsc\b/i },
    urls: /\/_next\/static\/chunks\/app\//,
    text: ['self.__next_f', '__next_require__', '__next_app__'],
  },
  {
    name: '#next-pages',
    cat: 'other',
    urls: [/\/_next\/static\/chunks\/pages\//, /\/_next\/static\/[\w-]{6,64}\/_buildManifest\.js/],
    markup: ['id="__NEXT_DATA__"'],
  },
  {
    name: '#turbopack',
    cat: 'other',
    urls: /\/_next\/static\/chunks\/turbopack-/,
    text: ['globalThis.TURBOPACK', '__turbopack_'],
  },
  {
    name: 'Nuxt',
    cat: 'framework',
    headers: { 'x-powered-by': /\bnuxt\b/i },
    generator: gen('Nuxt'),
    urls: /\/_nuxt\//,
    markup: ['id="__nuxt"', 'data-n-head='],
    text: ['__NUXT__', '__NUXT_DATA__', '/_nuxt/', 'window.$nuxt'],
    implies: ['Vue'],
  },
  {
    name: 'SvelteKit',
    cat: 'framework',
    urls: /\/_app\/immutable\//,
    markup: ['data-sveltekit-preload-data', 'data-sveltekit-'],
    text: ['__sveltekit_', '/_app/immutable/'],
    implies: ['Svelte', 'Vite'],
  },
  {
    name: 'Svelte',
    cat: 'framework',
    text: ['__svelte', { s: 'svelte-', re: /\bsvelte-(?=[a-z]{0,6}\d)[a-z0-9]{6,7}\b/, ev: 'svelte-<hash> classes' }],
  },
  {
    name: 'Remix',
    cat: 'framework',
    text: ['__remixContext', '__remixManifest', '__remixRouteModules'],
    implies: ['React'],
  },
  {
    name: 'React Router',
    cat: 'framework',
    text: ['__reactRouterContext', '__reactRouterManifest', '__reactRouterRouteModules'],
    implies: ['React'],
  },
  {
    name: 'Gatsby',
    cat: 'framework',
    generator: gen('Gatsby'),
    markup: ['id="___gatsby"', 'id="gatsby-focus-wrapper"', 'gatsby-image-wrapper'],
    text: ['___gatsby', 'webpackChunkgatsby', 'gatsby-chunk-mapping', '___loader'],
    implies: ['React'],
  },
  {
    name: 'Astro',
    cat: 'framework',
    generator: gen('Astro'),
    urls: /\/_astro\//,
    markup: ['<astro-island', 'data-astro-cid-', 'data-astro-transition', '/_astro/'],
    text: ['astro-island', 'astro:page-load'],
  },
  {
    name: 'Vite',
    cat: 'framework',
    markup: ['/@vite/client'],
    text: ['__vite__mapDeps', '__vitePreload', 'vite/modulepreload-polyfill', 'supports("modulepreload")', '__vite_ssr_'],
  },
  {
    name: 'React',
    cat: 'framework',
    markup: ['data-reactroot', 'data-reactid='],
    text: [
      { s: 'rendererPackageName:"react-dom"', ver: /version:"(\d+\.\d+\.\d+[\w.-]*)",rendererPackageName:"react-dom"/ },
      { s: 'reconcilerVersion:"', ver: /reconcilerVersion:"(\d+\.\d+\.\d+)"/ },
      { s: '@license React', ver: /@license React v(\d+\.\d+\.\d+)/ },
      '__reactFiber$',
      '__reactContainer$',
      '__reactProps$',
      '__reactInternalInstance$',
      '_reactRootContainer',
      'Minified React error #',
    ],
  },
  { name: 'Preact', cat: 'framework', text: ['__PREACT_DEVTOOLS__', 'preact/hooks', 'preact/compat'] },
  {
    name: 'Vue',
    cat: 'framework',
    markup: ['data-v-app', 'data-server-rendered="true"', { s: ' data-v-', re: /\sdata-v-[0-9a-f]{8}\b/, ev: 'data-v-<hash> attributes' }],
    text: ['__vue_app__', '__VUE__', '__vue__', '__VUE_OPTIONS_API__', '__VUE_PROD_DEVTOOLS__', '__vueParentComponent'],
  },
  {
    name: 'Angular',
    cat: 'framework',
    markup: [{ s: 'ng-version="', ver: /ng-version="(\d+\.\d+\.\d+[\w.-]*)"/ }, '_nghost-', '_ngcontent-'],
    text: ['ɵɵdefineComponent', 'ɵcmp', 'ɵfac'],
  },
  {
    name: 'AngularJS',
    cat: 'framework',
    urls: /angular(?:js)?(?:\/|@)(1\.\d+\.\d+)\/angular(?:\.min)?\.js|\/angular(?:\.min)?\.js/,
    text: [{ s: '@license AngularJS v', ver: /AngularJS v(\d+\.\d+\.\d+)/ }, 'angular.module('],
  },
  { name: 'SolidJS', cat: 'framework', markup: ['data-hk='], text: ['_$HY'] },
  {
    name: 'Qwik',
    cat: 'framework',
    markup: [{ s: 'q:version="', ver: /q:version="(\d+\.\d+\.\d+[\w.-]*)"/ }, 'q:container=', 'q:base='],
    text: ['qwikloader', 'qwik/json'],
  },
  {
    name: 'Alpine.js',
    cat: 'framework',
    urls: /alpinejs(?:@(\d+\.\d+\.\d+))?/,
    text: ['window.Alpine', 'Alpine.start('],
  },
  {
    name: 'htmx',
    cat: 'framework',
    urls: /htmx\.org(?:@(\d+\.\d+\.\d+))?|\/htmx(?:\.min)?\.js/,
    text: ['htmx.org', 'htmx:afterSwap', 'htmx:configRequest'],
  },
  { name: 'Hugo', cat: 'framework', generator: gen('Hugo') },
  { name: 'Jekyll', cat: 'framework', generator: gen('Jekyll'), markup: ['<!-- Begin Jekyll SEO tag'] },
  { name: 'Eleventy', cat: 'framework', generator: gen('Eleventy') },
  { name: 'Hexo', cat: 'framework', generator: gen('Hexo') },

  // ------------------------------------------------------------------ hosting
  {
    name: 'Vercel',
    cat: 'hosting',
    headers: { 'x-vercel-id': true, 'x-vercel-cache': true, server: /^vercel\b/i },
    siteHosts: ['vercel.app', 'now.sh'],
  },
  {
    name: 'Netlify',
    cat: 'hosting',
    headers: { 'x-nf-request-id': true, server: /^netlify/i },
    siteHosts: ['netlify.app', 'netlify.com'],
  },
  {
    name: 'Cloudflare Pages',
    cat: 'hosting',
    siteHosts: ['pages.dev'],
    implies: ['Cloudflare'],
  },
  {
    name: 'Cloudflare Workers',
    cat: 'hosting',
    siteHosts: ['workers.dev'],
    implies: ['Cloudflare'],
  },
  {
    name: 'Railway',
    cat: 'hosting',
    headers: { 'x-railway-request-id': true, 'x-railway-edge': true, server: /railway/i },
    siteHosts: ['up.railway.app', 'railway.app'],
  },
  {
    name: 'Render',
    cat: 'hosting',
    headers: { 'x-render-origin-server': true, 'rndr-id': true },
    siteHosts: ['onrender.com'],
  },
  {
    name: 'Fly.io',
    cat: 'hosting',
    headers: { 'fly-request-id': true, server: /^fly\//i, via: /\bfly\.io\b/i },
    siteHosts: ['fly.dev'],
  },
  {
    name: 'Amazon S3',
    cat: 'hosting',
    headers: { server: /^amazons3$/i, 'x-amz-bucket-region': true },
    hostRe: /(?:^|\.)s3[.-][a-z0-9.-]{0,60}amazonaws\.com$/,
  },
  { name: 'AWS Amplify', cat: 'hosting', siteHosts: ['amplifyapp.com'] },
  {
    name: 'AWS',
    cat: 'hosting',
    headers: { 'x-amzn-requestid': true, 'x-amzn-trace-id': true, 'x-amz-apigw-id': true, server: /^awselb/i },
    cookies: /^(?:AWSALB|AWSALBCORS|AWSELB)$/,
    siteHosts: ['elasticbeanstalk.com', 'awsapprunner.com', 'execute-api.amazonaws.com'],
  },
  {
    name: 'Google Cloud',
    cat: 'hosting',
    headers: {
      server: /^google frontend$/i,
      via: /\b1\.1 google\b/i,
      'x-cloud-trace-context': true,
      'x-goog-generation': true,
      'x-guploader-uploadid': true,
    },
    hosts: ['storage.googleapis.com'],
    siteHosts: ['appspot.com', 'run.app', 'cloudfunctions.net'],
  },
  {
    name: 'Firebase Hosting',
    cat: 'hosting',
    urls: /\/__\/firebase\//,
    markup: ['/__/firebase/'],
    siteHosts: ['web.app', 'firebaseapp.com'],
  },
  {
    name: 'GitHub Pages',
    cat: 'hosting',
    headers: { server: /^github\.com$/i, 'x-github-request-id': true },
    siteHosts: ['github.io'],
  },
  {
    name: 'Heroku',
    cat: 'hosting',
    headers: { via: /\bvegur\b/i, server: /^heroku/i },
    siteHosts: ['herokuapp.com'],
  },
  {
    name: 'DigitalOcean',
    cat: 'hosting',
    headers: { 'x-do-app-origin': true, 'x-do-orig-status': true },
    hosts: ['digitaloceanspaces.com'],
    siteHosts: ['ondigitalocean.app'],
  },
  {
    name: 'Microsoft Azure',
    cat: 'hosting',
    headers: { 'x-azure-ref': true, 'x-msedge-ref': true, 'x-ms-request-id': true },
    hosts: ['azureedge.net', 'blob.core.windows.net'],
    siteHosts: ['azurewebsites.net', 'azurestaticapps.net', 'azureedge.net'],
  },
  { name: 'Deno Deploy', cat: 'hosting', headers: { server: /^deno(?:\/|$)/i }, siteHosts: ['deno.dev'] },

  // ------------------------------------------------------------------ cdn
  {
    name: 'Cloudflare',
    cat: 'cdn',
    headers: { 'cf-ray': true, 'cf-cache-status': true, server: /^cloudflare/i },
    cookies: /^(?:__cf_bm|cf_clearance|__cflb|__cfruid|_cfuvid)$/,
    urls: /\/cdn-cgi\//,
    markup: ['/cdn-cgi/'],
  },
  {
    name: 'Amazon CloudFront',
    cat: 'cdn',
    headers: { 'x-amz-cf-id': true, 'x-amz-cf-pop': true, via: /cloudfront/i, 'x-cache': /cloudfront/i },
    hosts: ['cloudfront.net'],
  },
  {
    name: 'Fastly',
    cat: 'cdn',
    headers: {
      'x-fastly-request-id': true,
      'fastly-debug-digest': true,
      'x-served-by': /\bcache-[a-z]{3,4}\d*-[a-z]{3,5}\d+/i,
      'x-timer': /^S\d+\.\d+,VS\d/,
    },
  },
  {
    name: 'Akamai',
    cat: 'cdn',
    headers: {
      'x-akamai-transformed': true,
      'akamai-grn': true,
      'x-akamai-request-id': true,
      'akamai-cache-status': true,
      server: /^akamai/i,
    },
    hosts: ['akamaized.net', 'akamaihd.net'],
  },
  {
    name: 'Bunny CDN',
    cat: 'cdn',
    headers: { server: /^bunnycdn/i, 'cdn-pullzone': true, 'cdn-uid': true },
    hosts: ['b-cdn.net'],
  },
  { name: 'jsDelivr', cat: 'cdn', hosts: ['cdn.jsdelivr.net'] },
  { name: 'cdnjs', cat: 'cdn', hosts: ['cdnjs.cloudflare.com'] },
  { name: 'unpkg', cat: 'cdn', hosts: ['unpkg.com'] },
  { name: 'Cloudinary', cat: 'cdn', hosts: ['res.cloudinary.com'] },
  { name: 'imgix', cat: 'cdn', hosts: ['imgix.net'] },

  // ------------------------------------------------------------------ cms / site builders
  {
    name: 'WordPress',
    cat: 'cms',
    generator: gen('WordPress'),
    headers: { link: /rel="https:\/\/api\.w\.org\/"/, 'x-pingback': /xmlrpc\.php/ },
    cookies: /^(?:wordpress_|wp-settings-)/,
    urls: [
      /\/wp-includes\/(?:css\/dist\/block-library\/style(?:\.min)?\.css|js\/wp-emoji-release\.min\.js|js\/wp-embed(?:\.min)?\.js|css\/dashicons(?:\.min)?\.css)\?ver=(\d+\.\d+(?:\.\d+)?)\b/,
      /\/wp-(?:content|includes)\//,
    ],
    markup: [
      '/wp-content/',
      '/wp-includes/',
      { s: 'wp-emoji-release.min.js?ver=', ver: /wp-emoji-release\.min\.js\?ver=(\d+\.\d+(?:\.\d+)?)/ },
      'https://api.w.org/',
    ],
  },
  {
    name: 'WooCommerce',
    cat: 'cms',
    cookies: /^(?:woocommerce_|wp_woocommerce_session_)/,
    urls: /\/wp-content\/plugins\/woocommerce\//,
    text: ['wc_add_to_cart_params', 'woocommerce_params'],
    implies: ['WordPress'],
  },
  {
    name: 'Elementor',
    cat: 'cms',
    generator: gen('Elementor'),
    urls: /\/wp-content\/plugins\/elementor(?:-pro)?\//,
    markup: ['data-elementor-type=', 'elementor-kit-'],
    implies: ['WordPress'],
  },
  {
    name: 'Webflow',
    cat: 'cms',
    generator: gen('Webflow'),
    markup: ['data-wf-site=', 'data-wf-page=', 'w-webflow-badge'],
    hosts: ['website-files.com', 'webflow.com'],
    siteHosts: ['webflow.io'],
  },
  {
    name: 'Framer',
    cat: 'cms',
    generator: /^\s*Framer\b(?:\s+v?(\d+\.\d+(?:\.\d+)?)\b)?/i,
    markup: ['data-framer-hydrate-v2', 'data-framer-name=', 'data-framer-component-type'],
    text: ['__framer_importFromPackage', '__framer_events'],
    hosts: ['framerusercontent.com', 'events.framer.com'],
    siteHosts: ['framer.app', 'framer.website', 'framer.ai', 'framer.media'],
    implies: ['React'],
  },
  {
    name: 'Wix',
    cat: 'cms',
    headers: { 'x-wix-request-id': true, server: /^pepyaka/i },
    generator: /^\s*Wix\.com/i,
    cookies: /^svSession$/,
    hosts: ['parastorage.com', 'wixstatic.com'],
    siteHosts: ['wixsite.com', 'wixstudio.io'],
  },
  {
    name: 'Squarespace',
    cat: 'cms',
    headers: { server: /squarespace/i },
    markup: ['<!-- This is Squarespace. -->', 'Static.SQUARESPACE_CONTEXT'],
    hosts: ['squarespace.com', 'squarespace-cdn.com', 'sqspcdn.com'],
    siteHosts: ['squarespace.com'],
  },
  {
    name: 'Shopify',
    cat: 'cms',
    headers: { 'x-shopid': true, 'x-shopify-stage': true, 'powered-by': /shopify/i },
    cookies: /^(?:_shopify_y|_shopify_s|_shopify_sa_t|cart_sig)$/,
    text: ['Shopify.theme', 'window.Shopify'],
    hosts: ['cdn.shopify.com', 'shopifycdn.net', 'myshopify.com'],
    siteHosts: ['myshopify.com'],
  },
  {
    name: 'Ghost',
    cat: 'cms',
    generator: gen('Ghost'),
    markup: ['data-ghost=', 'ghost-portal'],
    siteHosts: ['ghost.io'],
  },
  {
    name: 'Notion',
    cat: 'cms',
    markup: ['class="notion-app'],
    hosts: ['notion-static.com'],
    siteHosts: ['notion.site'],
  },
  { name: 'Super', cat: 'cms', generator: gen('Super'), hosts: ['super.so'], siteHosts: ['super.site'] },
  { name: 'Carrd', cat: 'cms', generator: gen('Carrd'), siteHosts: ['carrd.co'], linkHosts: ['carrd.co'] },
  {
    name: 'Bubble',
    cat: 'cms',
    headers: { 'x-bubble-capacity-used': true, 'x-bubble-perf': true },
    text: ['bubble_session_uid', '_bubble_page_load_data', 'bubble_page_load_id'],
    hosts: ['bubble.io'],
    siteHosts: ['bubbleapps.io'],
  },
  {
    name: 'Drupal',
    cat: 'cms',
    generator: gen('Drupal'),
    headers: { 'x-drupal-cache': true, 'x-drupal-dynamic-cache': true, 'x-generator': /drupal\s*(\d+)?/i },
    text: ['drupalSettings', 'data-drupal-selector'],
  },
  { name: 'Joomla', cat: 'cms', generator: /^\s*Joomla!?(?:\s+(\d+(?:\.\d+)*))?/i },
  { name: 'Contentful', cat: 'cms', hosts: ['ctfassets.net', 'cdn.contentful.com'] },
  { name: 'Sanity', cat: 'cms', hosts: ['sanity.io'] },
  { name: 'Prismic', cat: 'cms', hosts: ['prismic.io'] },
  { name: 'Storyblok', cat: 'cms', hosts: ['storyblok.com'] },
  { name: 'Strapi', cat: 'cms', headers: { 'x-powered-by': /\bstrapi\b/i } },
  { name: 'Substack', cat: 'cms', hosts: ['substackcdn.com'], siteHosts: ['substack.com'] },

  // ------------------------------------------------------------------ docs
  {
    name: 'Docusaurus',
    cat: 'docs',
    generator: gen('Docusaurus'),
    markup: ['id="__docusaurus"'],
    text: ['__docusaurus', 'docusaurus-plugin-'],
    implies: ['React'],
  },
  {
    name: 'VitePress',
    cat: 'docs',
    generator: gen('VitePress'),
    markup: ['class="VPContent', 'class="VPNav'],
    text: ['__VP_HASH_MAP__', '__VP_SITE_DATA__'],
    implies: ['Vue', 'Vite'],
  },
  {
    name: 'Nextra',
    cat: 'docs',
    markup: ['nextra-nav-container', 'nextra-sidebar-container', 'nextra-content'],
    text: ['nextra-theme-docs', 'nextra-theme-blog', '__nextra_'],
    implies: ['Next.js'],
  },
  {
    name: 'GitBook',
    cat: 'docs',
    generator: /^\s*GitBook\b/i,
    urls: /\/~gitbook\//,
    hosts: ['gitbook.com', 'gitbook.io'],
    siteHosts: ['gitbook.io'],
  },
  {
    name: 'Mintlify',
    cat: 'docs',
    generator: /^\s*Mintlify\b/i,
    urls: /\/mintlify-assets\//,
    text: ['/mintlify-assets/'],
    hosts: ['mintlify.app', 'mintcdn.com', 'mintlify.com'],
    siteHosts: ['mintlify.app', 'mintlify.dev'],
  },
  { name: 'ReadMe', cat: 'docs', hosts: ['readme.io', 'readmeusercontent.com'], siteHosts: ['readme.io'] },
  {
    name: 'MkDocs',
    cat: 'docs',
    generator: /^\s*mkdocs-(\d+(?:\.\d+)+)/i,
    markup: ['md-content', 'data-md-component='],
  },
  { name: 'Docsify', cat: 'docs', text: ['window.$docsify'], urls: /\/docsify(?:@[\d.]+)?\// },
  { name: 'Starlight', cat: 'docs', generator: gen('Starlight'), markup: ['data-starlight', 'sl-markdown-content'], implies: ['Astro'] },
  {
    name: 'Read the Docs',
    cat: 'docs',
    markup: ['READTHEDOCS_DATA'],
    hosts: ['readthedocs.io', 'readthedocs.org'],
    siteHosts: ['readthedocs.io'],
  },

  // ------------------------------------------------------------------ ui
  {
    name: 'Tailwind CSS',
    cat: 'ui',
    text: [
      '--tw-',
      { s: 'tailwindcss v', ver: /tailwindcss v(\d+\.\d+\.\d+)/ },
      'cdn.tailwindcss.com',
    ],
    hosts: ['cdn.tailwindcss.com'],
    weak: ['items-center', 'justify-between', 'rounded-lg', 'tracking-tight', 'hover:bg-', 'md:flex', 'lg:grid-cols-', 'space-y-', 'gap-x-'].map(word),
    weakMin: 3,
  },
  {
    name: 'shadcn/ui',
    cat: 'ui',
    weak: [...['text-muted-foreground', 'ring-offset-background', 'text-card-foreground', 'bg-popover', 'text-primary-foreground'].map(word), 'data-slot='],
    weakMin: 2,
    implies: ['Tailwind CSS'],
  },
  {
    name: 'Radix UI',
    cat: 'ui',
    markup: ['id="radix-'],
    text: ['data-radix-', '@radix-ui/'],
  },
  {
    name: 'MUI',
    cat: 'ui',
    text: ['MuiButtonBase-root', 'MuiTypography-root', 'MuiBox-root', 'MuiPaper-root', '"MuiButtonBase"', '"MuiTypography"'],
  },
  { name: 'Chakra UI', cat: 'ui', text: ['--chakra-', 'chakra-ui-light', 'chakra-ui-dark', 'chakra-ui-color-mode'] },
  {
    name: 'Bootstrap',
    cat: 'ui',
    urls: [/\/bootstrap(?:@|\/)(\d+\.\d+\.\d+)\//i, /\/bootstrap(?:\.bundle)?(?:\.min)?\.(?:css|js)\b/i],
    hosts: ['bootstrapcdn.com'],
    text: [{ s: 'Bootstrap v', re: /Bootstrap v\d/, ver: /Bootstrap v(\d+\.\d+\.\d+)/ }, 'data-bs-toggle', 'data-bs-target'],
  },
  { name: 'Ant Design', cat: 'ui', text: ['ant-btn', 'ant-layout', 'ant-message-notice'].map(word) },
  { name: 'Mantine', cat: 'ui', text: ['--mantine-color', 'mantine-Button-root'] },
  { name: 'Headless UI', cat: 'ui', text: ['data-headlessui-state', 'id="headlessui-'] },
  {
    name: 'styled-components',
    cat: 'ui',
    markup: [{ s: 'data-styled-version="', ver: /data-styled-version="(\d+\.\d+\.\d+)"/ }, 'data-styled='],
    text: ['data-styled-version', '__styled-components'],
  },
  { name: 'Emotion', cat: 'ui', markup: ['data-emotion='], text: ['data-emotion', '__EMOTION_'] },
  { name: 'Framer Motion', cat: 'ui', text: ['framerAppearId', 'MotionHandoffAnimation', 'data-framer-appear-id'] },
  {
    name: 'GSAP',
    cat: 'ui',
    urls: [/\/gsap(?:@|\/)(\d+\.\d+\.\d+)\//, /\/gsap(?:\.min)?\.js\b/],
    text: ['GreenSockGlobals', 'gsap.registerPlugin', 'GSAP target ', { s: 'GSAP ', re: /GSAP \d+\.\d+\.\d+/, ver: /GSAP (\d+\.\d+\.\d+)/ }],
  },
  { name: 'Three.js', cat: 'ui', urls: /\/three(?:@(\d+\.\d+\.\d+))?\/build\/three|\/three(?:\.module)?(?:\.min)?\.js\b/, text: ['__THREE__'] },
  {
    name: 'Lottie',
    cat: 'ui',
    text: ['bodymovin', 'lottie-player', 'dotlottie-player', '@lottiefiles/', 'lottie.loadAnimation'],
    hosts: ['lottiefiles.com', 'lottie.host'],
  },
  { name: 'Spline', cat: 'ui', hosts: ['spline.design', 'splinecode.com'], text: ['@splinetool/'] },
  { name: 'Rive', cat: 'ui', hosts: ['rive.app'], text: ['@rive-app/'] },
  { name: 'Lenis', cat: 'ui', text: ['lenis-smooth', 'lenis-stopped', 'lenis-scrolling'].map(word) },
  { name: 'Swiper', cat: 'ui', text: [word('swiper-wrapper'), word('swiper-slide-active')] },

  // ------------------------------------------------------------------ analytics
  {
    name: 'Google Analytics',
    cat: 'analytics',
    cookies: /^_ga(?:_[A-Z0-9]+)?$/,
    urls: /googletagmanager\.com\/gtag\/js|google-analytics\.com\/(?:analytics|ga)\.js/,
    text: ['googletagmanager.com/gtag/js', "gtag('config'", 'gtag("config"', 'google-analytics.com/analytics.js'],
    hosts: ['google-analytics.com', 'analytics.google.com'],
  },
  {
    name: 'Google Tag Manager',
    cat: 'analytics',
    urls: /googletagmanager\.com\/gtm\.js/,
    text: ['googletagmanager.com/gtm.js', 'googletagmanager.com/ns.html'],
  },
  {
    name: 'Plausible',
    cat: 'analytics',
    text: ['plausible.io/js/', 'window.plausible'],
    hosts: ['plausible.io'],
  },
  {
    name: 'PostHog',
    cat: 'analytics',
    cookies: /^ph_.+_posthog$/,
    text: ['[PostHog.js]', 'posthog.init(', '__posthog', '_posthog'],
    hosts: ['posthog.com'],
  },
  {
    name: 'Mixpanel',
    cat: 'analytics',
    cookies: /^mp_.+_mixpanel$/,
    text: ['mixpanel.init(', '__mp_opt_in_out_', 'api-js.mixpanel.com'],
    hosts: ['mixpanel.com', 'mxpnl.com'],
  },
  {
    name: 'Amplitude',
    cat: 'analytics',
    cookies: /^AMP_[A-Za-z0-9_]+$/,
    text: ['api2.amplitude.com', 'amplitude.getInstance(', 'cdn.amplitude.com'],
    hosts: ['amplitude.com'],
  },
  {
    name: 'Segment',
    cat: 'analytics',
    cookies: /^ajs_(?:anonymous_id|user_id)$/,
    text: ['cdn.segment.com', 'analytics.SNIPPET_VERSION', 'api.segment.io'],
    hosts: ['segment.com', 'segment.io', 'segmentapis.com'],
  },
  {
    name: 'Hotjar',
    cat: 'analytics',
    cookies: /^_hj/,
    text: ['_hjSettings', 'static.hotjar.com'],
    hosts: ['hotjar.com', 'hotjar.io'],
  },
  {
    name: 'Microsoft Clarity',
    cat: 'analytics',
    cookies: /^_cl(?:ck|sk)$/,
    text: ['clarity.ms/tag/'],
    hosts: ['clarity.ms'],
  },
  {
    name: 'Vercel Analytics',
    cat: 'analytics',
    urls: /\/_vercel\/insights\//,
    text: ['/_vercel/insights/', 'va.vercel-scripts.com/v1/script'],
  },
  {
    name: 'Vercel Speed Insights',
    cat: 'analytics',
    urls: /\/_vercel\/speed-insights\//,
    text: ['/_vercel/speed-insights/', 'vitals.vercel-insights.com', 'va.vercel-scripts.com/v1/speed-insights'],
    hosts: ['vitals.vercel-insights.com'],
  },
  {
    name: 'Umami',
    cat: 'analytics',
    text: ['umami.track(', { s: 'data-website-id=', re: /umami/i }],
    hosts: ['umami.is'],
  },
  { name: 'Fathom', cat: 'analytics', text: ['cdn.usefathom.com', 'fathom.trackPageview'], hosts: ['usefathom.com'] },
  {
    name: 'Heap',
    cat: 'analytics',
    text: [{ s: 'heap.load(', re: /(?<![\w$.])heap\.load\(/ }, 'heapanalytics.com', 'heapReadyCb'],
    hosts: ['heapanalytics.com', 'heap-api.com'],
  },
  {
    name: 'Meta Pixel',
    cat: 'analytics',
    text: ["fbq('init'", 'fbq("init"', 'connect.facebook.net/en_US/fbevents.js', '/fbevents.js'],
    hosts: ['connect.facebook.net'],
  },
  {
    name: 'X Pixel',
    cat: 'analytics',
    text: ["twq('config'", 'twq("config"', 'static.ads-twitter.com/uwt.js'],
    hosts: ['static.ads-twitter.com', 'analytics.twitter.com'],
  },
  { name: 'LinkedIn Insight', cat: 'analytics', text: ['_linkedin_partner_id'], hosts: ['snap.licdn.com', 'px.ads.linkedin.com'] },
  { name: 'TikTok Pixel', cat: 'analytics', text: ['ttq.load('], hosts: ['analytics.tiktok.com'] },
  { name: 'Reddit Pixel', cat: 'analytics', text: ["rdt('init'", 'rdt("init"', 'redditstatic.com/ads/pixel.js'] },
  {
    name: 'Cloudflare Web Analytics',
    cat: 'analytics',
    markup: ['data-cf-beacon'],
    hosts: ['static.cloudflareinsights.com', 'cloudflareinsights.com'],
  },
  { name: 'Matomo', cat: 'analytics', text: ['_paq.push(', '/matomo.js', '/piwik.js'], hosts: ['matomo.cloud'] },
  { name: 'Simple Analytics', cat: 'analytics', hosts: ['simpleanalyticscdn.com'] },
  { name: 'Yandex Metrica', cat: 'analytics', text: ['mc.yandex.ru/metrika'], hosts: ['mc.yandex.ru', 'mc.yandex.com'] },
  {
    name: 'HubSpot',
    cat: 'analytics',
    text: ['_hsq.push(', 'hbspt.forms.create'],
    hosts: ['hs-scripts.com', 'hs-analytics.net', 'hsforms.net', 'hs-banner.com'],
  },

  // ------------------------------------------------------------------ monitoring
  {
    name: 'Sentry',
    cat: 'monitoring',
    markup: ['name="sentry-trace"'],
    text: [
      '__SENTRY__',
      'sentry.javascript.',
      'ingest.sentry.io',
      'ingest.us.sentry.io',
      'ingest.de.sentry.io',
      'browser.sentry-cdn.com',
      'js.sentry-cdn.com',
      { s: 'npm:@sentry/', ver: /npm:@sentry\/[\w-]+",version:"(\d+\.\d+\.\d+)"/ },
    ],
    hosts: ['sentry-cdn.com'],
  },
  {
    name: 'Datadog RUM',
    cat: 'monitoring',
    text: [word('DD_RUM'), 'browser-intake-datadoghq', 'datadoghq-browser-agent.com'],
    hosts: ['datadoghq-browser-agent.com', 'browser-intake-datadoghq.com', 'browser-intake-datadoghq.eu'],
  },
  {
    name: 'LogRocket',
    cat: 'monitoring',
    text: ['LogRocket.init(', 'cdn.logrocket.io', 'cdn.lr-ingest.io'],
    hosts: ['logrocket.io', 'logrocket.com', 'lr-ingest.io', 'lr-ingest.com', 'lr-in.com', 'lr-in-prod.com'],
  },
  {
    name: 'Bugsnag',
    cat: 'monitoring',
    text: ['Bugsnag.start(', 'notify.bugsnag.com', 'sessions.bugsnag.com'],
    hosts: ['bugsnag.com'],
  },
  { name: 'New Relic', cat: 'monitoring', text: [word('NREUM'), 'js-agent.newrelic.com'], hosts: ['nr-data.net', 'js-agent.newrelic.com'] },
  { name: 'Rollbar', cat: 'monitoring', text: ['_rollbarConfig'], hosts: ['rollbar.com'] },
  { name: 'Highlight', cat: 'monitoring', hosts: ['highlight.io', 'highlight.run'] },

  // ------------------------------------------------------------------ auth
  {
    name: 'Privy',
    cat: 'auth',
    cookies: /^privy-(?:token|session|id-token|refresh-token)$/,
    text: [
      'privy-app-id',
      'privy-client',
      '@privy-io/',
      'privy:token',
      { s: 'react-auth:', re: /react-auth:\d+\.\d+\.\d+/, ver: /react-auth:(\d+\.\d+\.\d+)/ },
    ],
    hosts: ['privy.io'],
  },
  {
    name: 'Dynamic',
    cat: 'auth',
    text: ['@dynamic-labs/', 'dynamic_authentication_token', 'dynamicauth.com'],
    hosts: ['dynamicauth.com', 'dynamic.xyz', 'dynamic-static-assets.com'],
  },
  { name: 'Web3Auth', cat: 'auth', text: ['@web3auth/', 'web3auth.io'], hosts: ['web3auth.io'] },
  { name: 'Magic', cat: 'auth', text: ['@magic-sdk/', '@magic-ext/', 'auth.magic.link'], hosts: ['magic.link'] },
  {
    name: 'Auth0',
    cat: 'auth',
    cookies: /^(?:auth0\.|_legacy_auth0\.)/,
    text: ['auth0-spa-js', '@auth0/', 'cdn.auth0.com'],
    hosts: ['auth0.com'],
  },
  {
    name: 'Clerk',
    cat: 'auth',
    cookies: /^(?:__client_uat|__clerk_db_jwt)/,
    text: ['@clerk/clerk-js', 'clerk.browser.js', '__clerk_db_jwt', '__clerk_'],
    hosts: ['clerk.accounts.dev', 'clerk.com', 'clerk.dev'],
    hostRe: /^clerk\.[a-z0-9-]+\.[a-z]/,
  },
  {
    name: 'Supabase',
    cat: 'auth',
    cookies: /^sb-.+-auth-token(?:\.\d+)?$/,
    text: [{ s: 'supabase-js', ver: /supabase-js(?:-web|-node|-universal)?\/(\d+\.\d+\.\d+)/ }, '@supabase/', '.supabase.co'],
    hosts: ['supabase.co', 'supabase.in'],
  },
  {
    name: 'Firebase Auth',
    cat: 'auth',
    text: ['firebase:authUser:', '@firebase/auth', 'identitytoolkit.googleapis.com'],
    hosts: ['identitytoolkit.googleapis.com', 'securetoken.googleapis.com'],
  },
  {
    name: 'NextAuth.js',
    cat: 'auth',
    cookies: /^(?:__Secure-|__Host-)?(?:next-auth|authjs)\.(?:session-token|csrf-token|callback-url)/,
    text: ['nextauth.message', '[next-auth]'],
  },
  { name: 'Google Sign-In', cat: 'auth', text: ['accounts.google.com/gsi/client', 'g_id_onload'] },
  { name: 'Turnkey', cat: 'auth', text: ['@turnkey/'], hosts: ['turnkey.com'] },
  { name: 'Stytch', cat: 'auth', text: ['@stytch/'], hosts: ['stytch.com'] },

  // ------------------------------------------------------------------ web3
  {
    name: 'Solana web3.js',
    cat: 'web3',
    text: [
      '@solana/web3.js',
      { s: '"solana-client"', ver: /"solana-client":"js\/(\d+\.\d+\.\d+)"/ },
      'Invalid public key input',
      'getLatestBlockhash',
      'Ed25519SigVerify111111111111111111111111111',
      'SysvarRent111111111111111111111111111111111',
    ],
  },
  {
    name: 'Solana Wallet Adapter',
    cat: 'web3',
    text: ['wallet-adapter-button', 'wallet-adapter-modal', '@solana/wallet-adapter', 'WalletNotReadyError'],
    implies: ['Solana web3.js'],
  },
  { name: 'Phantom', cat: 'web3', text: ['isPhantom', 'phantom.app/ul/', 'window.phantom'], hosts: ['phantom.app'] },
  {
    name: 'Jupiter',
    cat: 'web3',
    text: ['Jupiter.init(', 'terminal.jup.ag', 'plugin.jup.ag', 'quote-api.jup.ag', 'lite-api.jup.ag', '@jup-ag/'],
    hosts: ['jup.ag'],
  },
  {
    name: 'Raydium',
    cat: 'web3',
    text: [
      '@raydium-io/',
      { s: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', ev: 'Raydium AMM program id' },
      { s: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', ev: 'Raydium CLMM program id' },
      { s: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', ev: 'Raydium CPMM program id' },
      { s: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', ev: 'Raydium LaunchLab program id' },
    ],
    hosts: ['raydium.io'],
  },
  {
    name: 'Metaplex',
    cat: 'web3',
    text: ['@metaplex-foundation/', { s: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', ev: 'Token Metadata program id' }, 'mpl-token-metadata'],
  },
  { name: 'Helius', cat: 'web3', text: ['helius-rpc.com'], hosts: ['helius-rpc.com', 'helius.xyz', 'helius.dev'] },
  { name: 'QuickNode', cat: 'web3', text: ['quiknode.pro'], hosts: ['quiknode.pro', 'quicknode.com', 'quicknode.pro'] },
  { name: 'Alchemy', cat: 'web3', text: ['.g.alchemy.com'], hosts: ['alchemy.com', 'alchemyapi.io'] },
  { name: 'Infura', cat: 'web3', text: ['.infura.io/v3'], hosts: ['infura.io', 'infura-ipfs.io'] },
  { name: 'Triton One', cat: 'web3', text: ['rpcpool.com'], hosts: ['rpcpool.com', 'triton.one'] },
  { name: 'Ankr', cat: 'web3', text: ['rpc.ankr.com'], hosts: ['ankr.com'] },
  {
    name: 'ethers',
    cat: 'web3',
    text: [
      '@ethersproject/',
      { s: 'docs.ethers.org/v', ver: /docs\.ethers\.org\/v(\d)/ },
      { s: 'ethers/5.', re: /ethers\/5\.\d+\.\d+/, ver: /ethers\/(5\.\d+\.\d+)/ },
      { s: 'ethers/6.', re: /ethers\/6\.\d+\.\d+/, ver: /ethers\/(6\.\d+\.\d+)/ },
      { s: '"providers/5.', ver: /"providers\/(5\.\d+\.\d+)"/ },
    ],
  },
  {
    name: 'viem',
    cat: 'web3',
    text: [{ s: 'viem@', re: /viem@\d+\.\d+\.\d+/, ver: /viem@(\d+\.\d+\.\d+)/ }, 'viem.sh/docs'],
  },
  {
    name: 'wagmi',
    cat: 'web3',
    text: [
      { s: 'wagmi@', re: /wagmi@\d+\.\d+\.\d+/, ver: /wagmi@(\d+\.\d+\.\d+)/ },
      { s: '@wagmi/core@', ver: /@wagmi\/core@(\d+\.\d+\.\d+)/ },
      'wagmi.sh/',
      'wagmi.recentConnectorId',
      'wagmi.store',
      'wagmi.connected',
    ],
    implies: ['viem'],
  },
  {
    name: 'RainbowKit',
    cat: 'web3',
    markup: ['data-rk=', 'data-rk>'],
    text: ['@rainbow-me/rainbowkit', word('rk-recent'), word('rk-latest-id'), word('rk-version')],
    implies: ['wagmi'],
  },
  {
    name: 'WalletConnect',
    cat: 'web3',
    text: ['@walletconnect/', 'wc@2:', 'relay.walletconnect.com', 'relay.walletconnect.org'],
    hosts: ['walletconnect.com', 'walletconnect.org'],
  },
  {
    name: 'Reown AppKit',
    cat: 'web3',
    text: ['@reown/appkit', 'w3m-modal', 'appkit-button', '@web3modal/'],
    hosts: ['reown.com', 'web3modal.org', 'web3modal.com'],
    implies: ['WalletConnect'],
  },
  {
    name: 'Coinbase Wallet SDK',
    cat: 'web3',
    text: ['@coinbase/wallet-sdk', '-walletlink:', 'keys.coinbase.com', 'www.walletlink.org'],
    hosts: ['walletlink.org', 'keys.coinbase.com'],
  },
  { name: 'MetaMask SDK', cat: 'web3', text: ['@metamask/sdk', 'metamask-sdk'], hosts: ['metamask-sdk.api.cx.metamask.io'] },
  { name: 'Moralis', cat: 'web3', text: ['@moralisweb3/', 'deep-index.moralis.io'], hosts: ['moralis.io', 'moralis.com'] },
  { name: 'The Graph', cat: 'web3', text: ['api.thegraph.com', 'gateway.thegraph.com'], hosts: ['thegraph.com'] },
  {
    name: 'Pyth',
    cat: 'web3',
    text: ['@pythnetwork/', 'hermes.pyth.network', { s: 'FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH', ev: 'Pyth oracle program id' }],
    hosts: ['pyth.network'],
  },
  {
    name: 'Switchboard',
    cat: 'web3',
    text: ['@switchboard-xyz/', { s: 'SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f', ev: 'Switchboard program id' }],
    hosts: ['switchboard.xyz'],
  },
  {
    name: 'pump.fun',
    cat: 'web3',
    text: [
      { s: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', ev: 'pump.fun program id' },
      { s: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', ev: 'PumpSwap program id' },
      'frontend-api.pump.fun',
      'frontend-api-v3.pump.fun',
    ],
    hosts: ['pump.fun', 'pumpportal.fun'],
  },
  {
    name: 'Meteora',
    cat: 'web3',
    text: [
      '@meteora-ag/',
      { s: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', ev: 'Meteora DLMM program id' },
      { s: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', ev: 'Meteora AMM program id' },
      { s: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', ev: 'Meteora DAMM v2 program id' },
      { s: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', ev: 'Meteora DBC program id' },
    ],
    hosts: ['meteora.ag'],
  },
  {
    name: 'Orca',
    cat: 'web3',
    text: ['@orca-so/', { s: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', ev: 'Orca Whirlpools program id' }],
    hosts: ['orca.so'],
  },
  {
    name: 'Tensor',
    cat: 'web3',
    text: ['@tensor-oss/', { s: 'TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN', ev: 'Tensor swap program id' }],
    hosts: ['tensor.trade', 'tensor.so'],
  },
  {
    name: 'Magic Eden',
    cat: 'web3',
    text: [{ s: 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K', ev: 'Magic Eden program id' }, 'api-mainnet.magiceden.'],
    hosts: ['magiceden.io', 'magiceden.dev', 'magiceden.us'],
  },
  {
    name: 'Birdeye',
    cat: 'web3',
    text: ['public-api.birdeye.so', 'birdeye.so/tv-widget'],
    hosts: ['public-api.birdeye.so', 'api.birdeye.so', 'multichain-api.birdeye.so'],
  },
  {
    name: 'DexScreener',
    cat: 'web3',
    text: ['api.dexscreener.com', { s: 'dexscreener.com/', re: /dexscreener\.com\/[\w/-]{1,120}\?embed=1/, ev: 'DexScreener embed' }],
    hosts: ['api.dexscreener.com', 'io.dexscreener.com', 'cdn.dexscreener.com'],
  },
  { name: 'GMGN', cat: 'web3', hosts: ['gmgn.ai', 'gmgn.cc'] },
  {
    name: 'TradingView',
    cat: 'web3',
    urls: /\/charting_library\//,
    text: ['charting_library', 'TradingView.widget(', 'tradingview-widget-container', 's3.tradingview.com/tv.js'],
    hosts: ['s3.tradingview.com', 'tradingview-widget.com'],
  },
  {
    name: 'Lightweight Charts',
    cat: 'web3',
    text: [{ s: 'Lightweight Charts', ver: /Lightweight Charts(?:™)? v(\d+\.\d+\.\d+)/ }, 'lightweight-charts'],
  },
  { name: 'thirdweb', cat: 'web3', text: ['@thirdweb-dev/'], hosts: ['thirdweb.com', 'ipfscdn.io'] },
  {
    name: 'IPFS',
    cat: 'web3',
    hosts: ['ipfs.io', 'mypinata.cloud', 'pinata.cloud', 'nftstorage.link', 'w3s.link', 'dweb.link', 'cloudflare-ipfs.com', 'ipfs.dweb.link'],
  },
  { name: 'Arweave', cat: 'web3', hosts: ['arweave.net', 'irys.xyz', 'ar-io.net'] },
  { name: 'CoinGecko API', cat: 'web3', text: ['api.coingecko.com', 'pro-api.coingecko.com'], hosts: ['api.coingecko.com', 'pro-api.coingecko.com'] },
  { name: 'CoinMarketCap API', cat: 'web3', hosts: ['pro-api.coinmarketcap.com', 'api.coinmarketcap.com'] },
  { name: 'Solscan API', cat: 'web3', hosts: ['api.solscan.io', 'pro-api.solscan.io', 'public-api.solscan.io', 'api-v2.solscan.io'] },
  { name: 'Etherscan API', cat: 'web3', hosts: ['api.etherscan.io', 'api.basescan.org', 'api.bscscan.com', 'api.arbiscan.io'] },
  {
    name: 'Jito',
    cat: 'web3',
    text: ['block-engine.jito.wtf', 'jitodontfront'],
    hosts: ['jito.wtf', 'jito.network'],
  },
  {
    name: 'Anchor',
    cat: 'web3',
    text: ['@coral-xyz/anchor', '@project-serum/anchor', 'Program log: AnchorError'],
  },
  { name: 'Uniswap', cat: 'web3', text: ['@uniswap/'], hosts: ['interface.gateway.uniswap.org', 'api.uniswap.org'] },
  { name: 'LI.FI', cat: 'web3', text: ['@lifi/'], hosts: ['li.quest'] },
  { name: '0x API', cat: 'web3', hosts: ['api.0x.org'] },
  { name: 'Wormhole', cat: 'web3', text: ['@wormhole-foundation/'], hosts: ['wormholescan.io', 'wormhole.com'] },
  { name: 'deBridge', cat: 'web3', hosts: ['debridge.finance'] },
  { name: 'Drift', cat: 'web3', text: ['@drift-labs/', { s: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH', ev: 'Drift program id' }] },
  { name: 'Kamino', cat: 'web3', text: ['@kamino-finance/'], hosts: ['kamino.finance'] },
  { name: 'Sanctum', cat: 'web3', hosts: ['sanctum.so'] },

  // ------------------------------------------------------------------ payments
  {
    name: 'Stripe',
    cat: 'payments',
    text: ['js.stripe.com/v3', '@stripe/stripe-js', 'checkout.stripe.com'],
    hosts: ['stripe.com', 'stripe.network'],
    linkHosts: ['buy.stripe.com', 'checkout.stripe.com', 'billing.stripe.com', 'donate.stripe.com'],
  },
  {
    name: 'PayPal',
    cat: 'payments',
    text: ['paypal.com/sdk/js', 'paypalobjects.com'],
    hosts: ['paypal.com', 'paypalobjects.com'],
    linkHosts: ['paypal.me'],
  },
  {
    name: 'Coinbase Commerce',
    cat: 'payments',
    text: ['commerce.coinbase.com'],
    hosts: ['commerce.coinbase.com'],
    linkHosts: ['commerce.coinbase.com'],
  },
  { name: 'MoonPay', cat: 'payments', text: ['@moonpay/'], hosts: ['moonpay.com'] },
  { name: 'Transak', cat: 'payments', text: ['@transak/'], hosts: ['transak.com'] },
  { name: 'Helio', cat: 'payments', text: ['@heliofi/'], hosts: ['hel.io'], linkHosts: ['hel.io'] },
  { name: 'Solana Pay', cat: 'payments', text: ['@solana/pay'] },
  { name: 'Paddle', cat: 'payments', text: ['Paddle.Setup(', 'Paddle.Initialize('], hosts: ['paddle.com'] },
  { name: 'Lemon Squeezy', cat: 'payments', text: ['LemonSqueezy.Setup'], hosts: ['lemonsqueezy.com', 'lmsqueezy.com'] },

  // ------------------------------------------------------------------ support
  {
    name: 'Intercom',
    cat: 'support',
    cookies: /^intercom-(?:id|session|device-id)-/,
    text: ['intercomSettings', 'widget.intercom.io'],
    hosts: ['intercom.io', 'intercomcdn.com'],
  },
  { name: 'Crisp', cat: 'support', text: ['CRISP_WEBSITE_ID', 'client.crisp.chat'], hosts: ['crisp.chat'] },
  { name: 'Zendesk', cat: 'support', markup: ['id="ze-snippet"'], text: ['zESettings', 'static.zdassets.com'], hosts: ['zdassets.com', 'zopim.com'] },
  { name: 'Tawk.to', cat: 'support', text: ['Tawk_API', 'embed.tawk.to'], hosts: ['tawk.to'] },
  { name: 'Tidio', cat: 'support', hosts: ['tidio.co', 'tidiochat.com'] },
  { name: 'Chatwoot', cat: 'support', text: ['chatwootSettings', 'chatwootSDK'] },
  {
    name: 'Discord widget',
    cat: 'support',
    text: ['discord.com/widget?id=', 'discordapp.com/widget?id=', 'discord.com/api/guilds/', 'e.widgetbot.io'],
    hosts: ['widgetbot.io'],
  },
  { name: 'Telegram widget', cat: 'support', text: ['telegram.org/js/telegram-widget.js', 'data-telegram-login', 'data-telegram-post'] },

  // ------------------------------------------------------------------ fonts
  {
    name: 'Google Fonts',
    cat: 'fonts',
    text: ['fonts.googleapis.com', 'fonts.gstatic.com'],
    hosts: ['fonts.googleapis.com', 'fonts.gstatic.com'],
  },
  { name: 'Adobe Fonts', cat: 'fonts', text: ['use.typekit.net'], hosts: ['typekit.net'] },
  {
    name: 'Font Awesome',
    cat: 'fonts',
    urls: [/font-awesome\/(\d+\.\d+\.\d+)\//i, /fontawesome-(?:free|pro)@(\d+\.\d+\.\d+)/i, /font-?awesome/i],
    text: [{ s: 'Font Awesome ', re: /Font Awesome (?:Free|Pro|\d)/, ver: /Font Awesome (?:Free|Pro) (\d+\.\d+\.\d+)/ }, 'kit.fontawesome.com'],
    hosts: ['fontawesome.com'],
  },
  { name: 'Bunny Fonts', cat: 'fonts', hosts: ['fonts.bunny.net'] },
  { name: 'Fontshare', cat: 'fonts', hosts: ['api.fontshare.com', 'cdn.fontshare.com'] },

  // ------------------------------------------------------------------ security
  {
    name: 'Cloudflare Turnstile',
    cat: 'security',
    text: ['challenges.cloudflare.com/turnstile', 'cf-turnstile', 'turnstile.render('],
  },
  {
    name: 'reCAPTCHA',
    cat: 'security',
    text: ['/recaptcha/api.js', '/recaptcha/enterprise.js', 'grecaptcha', word('g-recaptcha')],
    hosts: ['recaptcha.net'],
  },
  { name: 'hCaptcha', cat: 'security', text: ['hcaptcha.com/1/api.js', word('h-captcha'), 'hcaptcha.render('], hosts: ['hcaptcha.com'] },
  {
    name: 'Vercel Firewall',
    cat: 'security',
    headers: { 'x-vercel-mitigated': true },
    text: ['Vercel Security Checkpoint', '/.well-known/vercel/security/'],
  },
  {
    name: 'Cloudflare Bot Management',
    cat: 'security',
    headers: { 'cf-mitigated': true },
    cookies: /^(?:__cf_bm|cf_clearance)$/,
    text: ['/cdn-cgi/challenge-platform/'],
    implies: ['Cloudflare'],
  },
  {
    name: 'DataDome',
    cat: 'security',
    headers: { 'x-datadome': true, 'x-dd-b': true },
    cookies: /^datadome$/,
    text: ['captcha-delivery.com', 'js.datadome.co'],
    hosts: ['captcha-delivery.com', 'datadome.co'],
  },
  {
    name: 'HUMAN (PerimeterX)',
    cat: 'security',
    cookies: /^_px(?:hd|vid|3|2|cvid)$/,
    text: ['px-captcha', '_pxAppId'],
    hosts: ['perimeterx.net', 'px-cdn.net', 'px-cloud.net'],
  },
  {
    name: 'Imperva',
    cat: 'security',
    headers: { 'x-iinfo': true, 'x-cdn': /imperva|incapsula/i },
    cookies: /^(?:incap_ses_|visid_incap_|nlbi_)/,
    text: ['_Incapsula_Resource'],
  },
  {
    name: 'AWS WAF',
    cat: 'security',
    headers: { 'x-amzn-waf-action': true },
    cookies: /^aws-waf-token$/,
    hosts: ['awswaf.com'],
  },
  { name: 'Sucuri', cat: 'security', headers: { 'x-sucuri-id': true, 'x-sucuri-cache': true, server: /sucuri/i } },
  { name: 'Arkose Labs', cat: 'security', hosts: ['arkoselabs.com', 'funcaptcha.com'] },

  // ------------------------------------------------------------------ other (servers, realtime, data, embeds)
  { name: 'Nginx', cat: 'other', headers: { server: /^nginx(?:\/(\d+(?:\.\d+)+))?/i } },
  { name: 'OpenResty', cat: 'other', headers: { server: /^openresty(?:\/(\d+(?:\.\d+)+))?/i } },
  { name: 'Apache', cat: 'other', headers: { server: /^apache(?:\/(\d+(?:\.\d+)+))?/i } },
  { name: 'LiteSpeed', cat: 'other', headers: { server: /^litespeed/i } },
  { name: 'Caddy', cat: 'other', headers: { server: /^caddy/i } },
  { name: 'Envoy', cat: 'other', headers: { server: /^envoy/i, 'x-envoy-upstream-service-time': true } },
  { name: 'Microsoft IIS', cat: 'other', headers: { server: /^microsoft-iis(?:\/(\d+(?:\.\d+)+))?/i } },
  { name: 'Express', cat: 'other', headers: { 'x-powered-by': /^express$/i } },
  { name: 'PHP', cat: 'other', headers: { 'x-powered-by': /\bphp(?:\/(\d+(?:\.\d+)+))?/i }, cookies: /^PHPSESSID$/ },
  {
    name: 'ASP.NET',
    cat: 'other',
    headers: { 'x-powered-by': /asp\.net/i, 'x-aspnet-version': /^(\d+(?:\.\d+)+)/ },
    cookies: /^ASP\.NET_SessionId$/,
  },
  {
    name: 'jQuery',
    cat: 'other',
    urls: [/jquery[.-](\d+\.\d+\.\d+)(?:\.slim)?(?:\.min)?\.js/i, /\/jquery@(\d+\.\d+\.\d+)\//i, /\/jquery\/(\d+\.\d+\.\d+)\//i, /\/jquery(?:\.slim)?(?:\.min)?\.js\b/i],
    text: [
      { s: 'jQuery v', re: /jQuery v\d/, ver: /jQuery v(\d+\.\d+\.\d+)/ },
      { s: 'jquery:"', re: /jquery:"\d/, ver: /jquery:"(\d+\.\d+\.\d+)"/ },
    ],
  },
  { name: 'Socket.IO', cat: 'other', text: ['socket.io/?EIO=', 'socket.io-client', '/socket.io/'] },
  { name: 'Pusher', cat: 'other', text: ['js.pusher.com'], hosts: ['pusher.com', 'pusherapp.com'] },
  { name: 'Ably', cat: 'other', hosts: ['ably.io', 'ably-realtime.com'] },
  { name: 'Apollo GraphQL', cat: 'other', text: ['__APOLLO_STATE__', '__APOLLO_CLIENT__'] },
  {
    name: 'Firebase',
    cat: 'other',
    text: ['@firebase/app', '@firebase/firestore', 'firestore.googleapis.com'],
    hosts: ['firebaseio.com', 'firestore.googleapis.com', 'firebasestorage.googleapis.com', 'firebaseinstallations.googleapis.com'],
  },
  { name: 'Google Maps', cat: 'other', text: ['maps.googleapis.com/maps/api/js'] },
  { name: 'YouTube embed', cat: 'other', text: ['youtube.com/embed/', 'youtube-nocookie.com/embed/'] },
];

// ---------------------------------------------------------------------------
// Compiled tables (built once at module load)
// ---------------------------------------------------------------------------

const KIND_TEXT = 0;
const KIND_MARKUP = 1;
const KIND_WEAK = 2;

interface CompiledNeedle {
  id: number;
  rule: number;
  kind: 0 | 1 | 2;
  s: string;
  re: RegExp | null;
  ver: RegExp | null;
  ev: string | null;
}

interface CompiledRule extends Rule {
  urlList: RegExp[];
}

/** Caps: bigger inputs are scanned up to these lengths. */
const MAX_HTML_CHARS = 4 * 1024 * 1024;
const MAX_JS_CHARS = 8 * 1024 * 1024;
const MAX_URLS = 1000;
const MAX_HOSTS = 2000;
const MAX_COOKIES = 100;
/** Characters on each side of a needle hit that its `re` / `ver` regex sees. */
const WINDOW = 200;
/** Occurrences of a needle whose `re` fails (or whose version is still unknown) are tried at most this often. */
const MAX_TRIES = 24;
/** Hard stop for pathological inputs (endless candidate positions sharing a needle's first four characters). */
const MAX_CANDIDATES = 250_000;
const MAX_EVIDENCE = 90;
/** Needles are keyed by their first four characters; shorter ones are ignored. */
const KEY_LEN = 4;
const FILTER_BITS = 16;
const FILTER_SHIFT = 32 - FILTER_BITS;

const CATEGORY_ORDER: readonly TechCategory[] = [
  'framework', 'hosting', 'cdn', 'cms', 'docs', 'ui', 'analytics', 'monitoring', 'auth', 'payments', 'support', 'web3',
  'fonts', 'security', 'other',
];

const COMPILED: CompiledRule[] = RULES.map((r) => ({ ...r, urlList: r.urls === undefined ? [] : Array.isArray(r.urls) ? r.urls : [r.urls] }));
const RULE_BY_NAME = new Map<string, number>();
COMPILED.forEach((r, i) => {
  if (!RULE_BY_NAME.has(r.name)) RULE_BY_NAME.set(r.name, i);
});

const NEEDLES: CompiledNeedle[] = [];
/** Needle string → needles with that exact string. */
const BY_STRING = new Map<string, CompiledNeedle[]>();

function addNeedle(rule: number, kind: 0 | 1 | 2, n: Needle): void {
  const spec: NeedleSpec = typeof n === 'string' ? { s: n } : n;
  if (typeof spec.s !== 'string' || spec.s.length < KEY_LEN) return;
  const c: CompiledNeedle = { id: NEEDLES.length, rule, kind, s: spec.s, re: spec.re ?? null, ver: spec.ver ?? null, ev: spec.ev ?? null };
  NEEDLES.push(c);
  let list = BY_STRING.get(c.s);
  if (!list) BY_STRING.set(c.s, (list = []));
  list.push(c);
}
COMPILED.forEach((r, i) => {
  for (const n of r.text ?? []) addNeedle(i, KIND_TEXT, n);
  for (const n of r.markup ?? []) addNeedle(i, KIND_MARKUP, n);
  for (const n of r.weak ?? []) addNeedle(i, KIND_WEAK, n);
});

/**
 * Multi-needle search index. Every needle string gets an id; strings are grouped by a 32-bit key made of the low bytes
 * of their first four characters. The scanner rolls the same key over the haystack (one charCodeAt per position) and
 * only looks a key up when its slot in a 2^16-entry filter is set, so the cost is linear in the haystack and almost
 * independent of the number of needles. Candidates are confirmed with startsWith (the key drops high bytes).
 */
const STRINGS: string[] = [...BY_STRING.keys()];
const STRING_NEEDLES: CompiledNeedle[][] = STRINGS.map((s) => BY_STRING.get(s) ?? []);
const STRING_MARKUP_ONLY: boolean[] = STRING_NEEDLES.map((list) => list.every((n) => n.kind === KIND_MARKUP));
const KEY_STRINGS = new Map<number, number[]>();

function keyOf(s: string, at: number): number {
  let k = 0;
  for (let j = 0; j < KEY_LEN; j++) k = ((k << 8) | (s.charCodeAt(at + j) & 0xff)) >>> 0;
  return k;
}

function slotOf(key: number): number {
  return Math.imul(key, 0x9e3779b1) >>> FILTER_SHIFT;
}

STRINGS.forEach((s, sid) => {
  const key = keyOf(s, 0);
  let list = KEY_STRINGS.get(key);
  if (!list) KEY_STRINGS.set(key, (list = []));
  list.push(sid);
});

/** Domain → rules listing it, per host kind. */
type HostKind = 'host' | 'site' | 'link';
const HOST_TABLE = new Map<string, Array<{ rule: number; kind: HostKind }>>();
COMPILED.forEach((r, i) => {
  const add = (list: string[] | undefined, kind: HostKind) => {
    for (const raw of list ?? []) {
      const d = raw.toLowerCase();
      let entries = HOST_TABLE.get(d);
      if (!entries) HOST_TABLE.set(d, (entries = []));
      entries.push({ rule: i, kind });
    }
  };
  add(r.hosts, 'host');
  add(r.siteHosts, 'site');
  add(r.linkHosts, 'link');
});
const HOST_RE_RULES = COMPILED.map((r, i) => [i, r.hostRe] as const).filter((x): x is readonly [number, RegExp] => x[1] instanceof RegExp);
const HEADER_RULES = COMPILED.map((_, i) => i).filter((i) => COMPILED[i].headers);
const COOKIE_RULES = COMPILED.map((_, i) => i).filter((i) => COMPILED[i].cookies);
const GENERATOR_RULES = COMPILED.map((_, i) => i).filter((i) => COMPILED[i].generator);
const URL_RULES = COMPILED.map((_, i) => i).filter((i) => COMPILED[i].urlList.length > 0);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

interface Acc {
  evidence: string;
  version: string | null;
}

class Detection {
  readonly hits = new Map<number, Acc>();
  readonly done = new Uint8Array(NEEDLES.length);
  readonly tries = new Uint8Array(NEEDLES.length);
  readonly weak = new Map<number, Set<string>>();

  hit(rule: number, evidence: string, version: string | null | undefined): void {
    const v = cleanVersion(version);
    const cur = this.hits.get(rule);
    if (!cur) this.hits.set(rule, { evidence: clip(evidence, MAX_EVIDENCE), version: v });
    else if (!cur.version && v) cur.version = v;
  }

  has(name: string): boolean {
    const i = RULE_BY_NAME.get(name);
    return i !== undefined && this.hits.has(i);
  }
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function cleanVersion(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/^v/i, '');
  return /^\d+(?:\.\d+){0,3}(?:[-+][\w.]{1,16})?$/.test(t) && t.length <= 24 ? t : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strList(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === 'string' && x) out.push(x);
    if (out.length >= cap) break;
  }
  return out;
}

function hostOf(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]+)/i.exec(url);
  if (!m) return null;
  return m[1].toLowerCase().replace(/\.+$/, '') || null;
}

/** "cdn.privy.io/js/sdk.js" style label for a script URL. */
function shortUrl(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^?#]*)/i.exec(url);
  const s = m ? m[1] : url;
  return s.length > 60 ? `${s.slice(0, 28)}…${s.slice(-28)}` : s;
}

function checkHeaders(d: Detection, headers: Record<string, string>): void {
  for (const i of HEADER_RULES) {
    const tests = COMPILED[i].headers as Record<string, true | RegExp>;
    for (const name of Object.keys(tests)) {
      const raw = headers[name];
      if (raw === undefined || raw === null) continue;
      const value = String(raw).slice(0, 1000);
      const test = tests[name];
      if (test === true) {
        d.hit(i, `${name} header`, null);
        break;
      }
      const m = test.exec(value);
      if (m) {
        d.hit(i, `${name}: ${clip(value, 40)}`, m[1]);
        break;
      }
    }
  }
}

function checkCookies(d: Detection, cookies: string[]): void {
  if (cookies.length === 0) return;
  for (const i of COOKIE_RULES) {
    const re = COMPILED[i].cookies as RegExp;
    for (const c of cookies) {
      if (re.test(c)) {
        d.hit(i, `cookie ${clip(c, 40)}`, null);
        break;
      }
    }
  }
}

function checkGenerator(d: Detection, generator: string): void {
  if (!generator) return;
  const g = generator.slice(0, 300);
  for (const i of GENERATOR_RULES) {
    const m = (COMPILED[i].generator as RegExp).exec(g);
    if (m) d.hit(i, `generator "${clip(g, 50)}"`, m[1]);
  }
}

function checkUrls(d: Detection, urls: string[]): void {
  if (urls.length === 0) return;
  for (const i of URL_RULES) {
    let matched = false;
    outer: for (const url of urls) {
      for (const re of COMPILED[i].urlList) {
        const m = re.exec(url);
        if (!m) continue;
        if (!matched) {
          d.hit(i, `script ${shortUrl(url)}`, m[1]);
          matched = true;
        } else d.hit(i, '', m[1]);
        if (d.hits.get(i)?.version) break outer;
      }
    }
  }
}

/** Calls `fn(rule, domain)` for every rule listing `host` or one of its parent domains under `kind`. */
function lookupHost(host: string, kind: HostKind, fn: (rule: number) => void): void {
  let h = host;
  for (let depth = 0; depth < 10; depth++) {
    const entries = HOST_TABLE.get(h);
    if (entries) for (const e of entries) if (e.kind === kind) fn(e.rule);
    const dot = h.indexOf('.');
    if (dot === -1) return;
    h = h.slice(dot + 1);
  }
}

function checkHosts(d: Detection, siteHost: string | null, codeHosts: string[], assetHosts: Set<string>, linkHosts: string[]): void {
  if (siteHost) lookupHost(siteHost, 'site', (r) => d.hit(r, `site on ${clip(siteHost, 60)}`, null));
  for (const h of assetHosts) {
    lookupHost(h, 'host', (r) => d.hit(r, `script from ${h}`, null));
    for (const [r, re] of HOST_RE_RULES) if (re.test(h)) d.hit(r, `script from ${h}`, null);
  }
  for (const h of codeHosts) {
    lookupHost(h, 'host', (r) => d.hit(r, `host ${h}`, null));
    for (const [r, re] of HOST_RE_RULES) if (re.test(h)) d.hit(r, `host ${h}`, null);
  }
  for (const h of linkHosts) lookupHost(h, 'link', (r) => d.hit(r, `link to ${h}`, null));
}

/** Whether needle string `sid` can still contribute anything in this haystack. */
function stringLive(d: Detection, sid: number, inHtml: boolean): boolean {
  if (!inHtml && STRING_MARKUP_ONLY[sid]) return false;
  for (const n of STRING_NEEDLES[sid]) if (!d.done[n.id] && (inHtml || n.kind !== KIND_MARKUP)) return true;
  return false;
}

/** Process a confirmed occurrence of needle string `sid` at `at`. */
function onHit(d: Detection, sid: number, hay: string, at: number, inHtml: boolean): void {
  const where = inHtml ? 'html' : 'code';
  for (const n of STRING_NEEDLES[sid]) {
    if (d.done[n.id]) continue;
    if (n.kind === KIND_MARKUP && !inHtml) continue;
    let version: string | null = null;
    if (n.re || n.ver) {
      const win = hay.slice(Math.max(0, at - WINDOW), at + n.s.length + WINDOW);
      if (n.re && !n.re.test(win)) {
        if (++d.tries[n.id] >= MAX_TRIES) d.done[n.id] = 1;
        continue;
      }
      if (n.ver) version = n.ver.exec(win)?.[1] ?? null;
    }
    // A needle that could still yield a version stays live for a few more occurrences.
    if (!n.ver || version || ++d.tries[n.id] >= MAX_TRIES) d.done[n.id] = 1;
    if (n.kind === KIND_WEAK) {
      let set = d.weak.get(n.rule);
      if (!set) d.weak.set(n.rule, (set = new Set()));
      set.add(n.s);
    } else {
      d.hit(n.rule, n.ev ?? `${where} "${clip(n.s, 40)}"`, version);
    }
  }
}

/**
 * One pass over `hay` looking for every live needle (see STRINGS). Keys whose needles are all settled are switched
 * off in the filter as soon as that happens, so a token repeated thousands of times costs one lookup, not thousands.
 */
function scanText(d: Detection, hay: string, inHtml: boolean): void {
  const n = hay.length;
  if (n < KEY_LEN) return;
  // Live strings per key, and live keys per filter slot (several keys may share a slot).
  const keyLive = new Map<number, number>();
  const slotLive = new Uint16Array(1 << FILTER_BITS);
  for (const [key, sids] of KEY_STRINGS) {
    let live = 0;
    for (const sid of sids) if (stringLive(d, sid, inHtml)) live++;
    if (live > 0) {
      keyLive.set(key, live);
      slotLive[slotOf(key)]++;
    }
  }
  let liveKeys = keyLive.size;
  if (liveKeys === 0) return;
  const dead = new Uint8Array(STRINGS.length);

  let key = keyOf(hay, 0) >>> 8;
  let candidates = 0;
  for (let i = KEY_LEN - 1; i < n; i++) {
    key = ((key << 8) | (hay.charCodeAt(i) & 0xff)) >>> 0;
    const slot = Math.imul(key, 0x9e3779b1) >>> FILTER_SHIFT;
    if (slotLive[slot] === 0) continue;
    const sids = KEY_STRINGS.get(key);
    if (sids === undefined) continue;
    if (++candidates > MAX_CANDIDATES) return;
    const at = i - (KEY_LEN - 1);
    for (const sid of sids) {
      if (dead[sid]) continue;
      if (!hay.startsWith(STRINGS[sid], at)) continue;
      onHit(d, sid, hay, at, inHtml);
      if (stringLive(d, sid, inHtml)) continue;
      dead[sid] = 1;
      const left = (keyLive.get(key) ?? 1) - 1;
      keyLive.set(key, left);
      if (left === 0) {
        slotLive[slot]--;
        if (--liveKeys === 0) return;
      }
    }
  }
}

function finishWeak(d: Detection): void {
  for (const [rule, set] of d.weak) {
    const min = COMPILED[rule].weakMin ?? 2;
    if (set.size >= min) d.hit(rule, `markers ${[...set].slice(0, 3).join(', ')}`, null);
  }
}

function toHits(d: Detection): TechHit[] {
  const out = new Map<string, TechHit>();
  for (const [rule, acc] of d.hits) {
    const r = COMPILED[rule];
    if (r.name.startsWith('#')) continue;
    if (!out.has(r.name)) out.set(r.name, { name: r.name, category: r.cat, version: acc.version, evidence: acc.evidence });
  }

  // Next.js flavour: router and bundler go first in the evidence.
  const next = out.get('Next.js');
  if (next) {
    const app = d.has('#next-app');
    const pages = d.has('#next-pages');
    const parts: string[] = [];
    if (app && pages) parts.push('app + pages router');
    else if (app) parts.push('app router');
    else if (pages) parts.push('pages router');
    if (d.has('#turbopack')) parts.push('Turbopack');
    if (parts.length) next.evidence = clip(`${parts.join(' · ')} · ${next.evidence}`, MAX_EVIDENCE);
  }

  // Implied technologies (Next.js → React, …), transitively.
  const queue = [...out.values()];
  while (queue.length) {
    const hit = queue.shift() as TechHit;
    const rule = RULE_BY_NAME.get(hit.name);
    for (const name of rule === undefined ? [] : (COMPILED[rule].implies ?? [])) {
      if (out.has(name)) continue;
      const idx = RULE_BY_NAME.get(name);
      if (idx === undefined) continue;
      const implied: TechHit = { name, category: COMPILED[idx].cat, version: null, evidence: `implied by ${hit.name}` };
      out.set(name, implied);
      queue.push(implied);
    }
  }

  return [...out.values()].sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(a.category);
    const cb = CATEGORY_ORDER.indexOf(b.category);
    if (ca !== cb) return ca - cb;
    const na = a.name.toLowerCase();
    const nb = b.name.toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
}

/**
 * Detect technologies from headers, HTML, script/style URLs, JS bundle contents, hostnames and cookies.
 * Pure & synchronous, must be fast (< 50ms on a 5MB input) and never throw. Results deduped by name, sorted by
 * category then name.
 *
 * Categories are ordered as declared in TechCategory (framework, hosting, cdn, cms, docs, ui, analytics, monitoring,
 * auth, payments, support, web3, fonts, security, other); names case-insensitively within a category. Technologies that
 * imply others (Next.js → React) add those with evidence "implied by …". Next.js evidence starts with the router flavour
 * ("app router", "pages router") and "Turbopack" when detectable.
 */
export function detectTech(input: TechInput): TechHit[] {
  const d = new Detection();
  try {
    const inp = (input ?? {}) as Partial<TechInput>;
    const headers: Record<string, string> = {};
    if (inp.headers && typeof inp.headers === 'object') {
      for (const [k, v] of Object.entries(inp.headers)) if (v !== undefined && v !== null) headers[k.toLowerCase()] = String(v);
    }
    const scripts = strList(inp.scripts, MAX_URLS);
    const styles = strList(inp.styles, MAX_URLS);
    const urls = [...scripts, ...styles].slice(0, MAX_URLS);
    const siteHost = hostOf(str(inp.url));

    const assetHosts = new Set<string>();
    for (const u of urls) {
      const h = hostOf(u);
      if (h && h !== siteHost) assetHosts.add(h);
    }
    const codeHosts = [...new Set(strList(inp.hosts, MAX_HOSTS).map((h) => h.toLowerCase().replace(/\.+$/, '')))].filter(
      (h) => h && h !== siteHost && !assetHosts.has(h),
    );
    const linkHosts = [...new Set(strList(inp.linkHosts, MAX_HOSTS).map((h) => h.toLowerCase().replace(/\.+$/, '')))];

    checkHeaders(d, headers);
    checkGenerator(d, str(inp.generator));
    checkUrls(d, urls);
    checkHosts(d, siteHost, codeHosts, assetHosts, linkHosts);
    checkCookies(d, strList(inp.cookies, MAX_COOKIES));

    const html = str(inp.html);
    const js = str(inp.js);
    scanText(d, html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html, true);
    scanText(d, js.length > MAX_JS_CHARS ? js.slice(0, MAX_JS_CHARS) : js, false);
    finishWeak(d);
  } catch {
    // Fall through with whatever was detected so far.
  }
  try {
    return toHits(d);
  } catch {
    return [];
  }
}

/** Every technology name detectTech can report (for docs / UI legends). */
export function knownTechnologies(): Array<{ name: string; category: TechCategory }> {
  return COMPILED.filter((r) => !r.name.startsWith('#')).map((r) => ({ name: r.name, category: r.cat }));
}
