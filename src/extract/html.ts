/**
 * HTML parsing: visible text, links, assets, framework build ids.
 *
 * Parsing uses cheerio's htmlparser2 backend (`cheerio/slim`): several times faster than parse5 and far cheaper on
 * pathological markup. The DOM is then walked ONCE, iteratively (no recursion → no stack overflow on deep trees), collecting
 * metadata, links, assets, inline scripts and visible text together.
 */

import { load } from 'cheerio/slim';
import { normalizeUrl } from './url.js';
import { scanHosts } from './hosts.js';

export interface ParsedPage {
  /** <title> text, whitespace-collapsed & trimmed; if multiple <title> tags, the LAST non-empty one (Next.js 404s append one). */
  title: string | null;
  /** meta[name=description] (fallback og:description), collapsed & trimmed. */
  description: string | null;
  ogImage: string | null;
  /** link[rel=canonical] resolved absolute (normalized), or null. */
  canonical: string | null;
  /** meta[name=generator] content, or null. */
  generator: string | null;
  /**
   * Visible text as lines. Algorithm:
   * - Remove: script, style, noscript, template, svg, canvas, iframe, object, embed, head, [hidden], [aria-hidden="true"],
   *   elements with inline style display:none, and HTML comments.
   * - Walk the <body> (or root if no body) producing text; block-level elements (address, article, aside, blockquote, br, dd, details,
   *   dialog, div, dl, dt, fieldset, figcaption, figure, footer, form, h1-h6, header, hr, li, main, nav, ol, p, pre, section, summary,
   *   table, tr, td, th, ul, option, button, label) start a new line; inline elements do not (so "Hello <b>world</b>" stays one line).
   * - Each line: decode entities (cheerio does), replace   with space, collapse whitespace runs to one space, trim.
   * - Drop empty lines. Do NOT dedupe lines.
   *
   * Refinements for readable, stable lines on real sites:
   * - Text inside <pre> keeps its own line breaks.
   * - "Item containers": when an element has no direct non-whitespace text and two of its element children touch with no
   *   text at all between them (typical of React/JSX output such as `<nav><a>Docs</a><a>Blog</a></nav>`), each child
   *   starts its own line instead of being glued into "DocsBlog". Inline formatting tags, letter-less pieces
   *   (`<span>$</span><span>10</span>`) and pre/code subtrees are exempt, so prose and code keep flowing.
   * - <title> elements in the body (not rendered by browsers) are skipped; zero-width characters are removed.
   */
  textLines: string[];
  /** Absolute normalized (normalizeUrl) URLs from a[href], area[href], link[rel=alternate][href] (HTML alternates only); deduped; includes external links. */
  links: string[];
  assets: {
    /** script[src] absolute URLs (not normalized beyond resolution; keep query strings), deduped, document order. */
    scripts: string[];
    /** link[rel~=stylesheet][href] absolute URLs, deduped. */
    styles: string[];
    /** link[rel~=preload|modulepreload|prefetch][href] where as=script|style or rel=modulepreload, absolute URLs, deduped. */
    preloads: string[];
  };
  /**
   * Framework build id when detectable, first match wins:
   * - Next.js pages router: JSON in <script id="__NEXT_DATA__"> → .buildId
   * - Next.js pages router: "/_next/static/<id>/_buildManifest.js" or "_ssgManifest.js" in any script src
   * - Next.js app router: RSC flight data in inline scripts `self.__next_f.push(...)` containing `"b":"<id>"` — the raw HTML has it
   *   escaped as `\"b\":\"<id>\"`; match both escaped and unescaped forms; id matches [A-Za-z0-9_-]{8,64}.
   * - Nuxt: window.__NUXT__ config buildId / `buildAssetsDir`… or "/_nuxt/builds/meta/<id>.json"
   * - Gatsby: "webpackCompilationHash":"<hash>" in page-data / inline script
   * - SvelteKit: `__sveltekit_<id>` global name in inline script
   * - Astro: none (return null)
   */
  buildId: string | null;
  /** Hostnames (lowercase) found anywhere in the raw HTML via absolute URLs (http(s)://host, wss://host, //host) — attributes and inline scripts included. */
  hosts: string[];
  /** meta[name=robots] contains noindex. */
  noindex: boolean;
}

/** Documents larger than this (in UTF-16 code units ≈ bytes for ASCII) are parsed only up to this point. */
export const MAX_HTML_CHARS = 3 * 1024 * 1024;
/** Estimated element nesting beyond this is cut off before parsing (htmlparser2's open-element stack is O(depth) per op). */
export const MAX_NESTING_DEPTH = 1000;
const MAX_LINKS = 10_000;
const MAX_ASSETS = 2_000;
const MAX_HOSTS = 500;
const MAX_FLIGHT_CHARS = 8 * 1024 * 1024;

/** Structural view of domhandler nodes (avoids a type dependency on a transitive package). */
interface DomNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

/** Subtrees whose text is never visible. `title` is included because a <title> in the body is not rendered. */
const REMOVED_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'head', 'title',
]);

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tr', 'td', 'th', 'ul', 'option', 'button', 'label',
  // Also block-ish in every UA stylesheet; keeps lines from gluing.
  'body', 'html', 'caption', 'legend', 'menu', 'hgroup', 'center', 'search', 'select', 'optgroup', 'thead', 'tbody',
  'tfoot', 'textarea', 'listing', 'xmp', 'plaintext', 'frameset', 'noframes',
]);

const DISPLAY_NONE_RE = /(?:^|[;\s])display\s*:\s*none\s*(?:!\s*important\s*)?(?:;|$)/i;
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const WS_RE = /\s+/g;

function isElement(n: DomNode): boolean {
  return (n.type === 'tag' || n.type === 'script' || n.type === 'style') && typeof n.name === 'string';
}

function collapse(s: string): string {
  return s.replace(ZERO_WIDTH_RE, '').replace(WS_RE, ' ').trim();
}

function nonEmpty(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null;
  const c = collapse(s);
  return c ? c : null;
}

function isHiddenElement(attrs: Record<string, string>): boolean {
  if (Object.prototype.hasOwnProperty.call(attrs, 'hidden')) return true;
  const aria = attrs['aria-hidden'];
  if (typeof aria === 'string' && aria.trim().toLowerCase() === 'true') return true;
  const style = attrs.style;
  return typeof style === 'string' && style.length > 0 && DISPLAY_NONE_RE.test(style);
}

/** Direct text children only (title/script/style content is a single raw-text node in htmlparser2). */
function directText(el: DomNode): string {
  const kids = el.children;
  if (!kids || kids.length === 0) return '';
  if (kids.length === 1) return kids[0].type === 'text' ? (kids[0].data ?? '') : '';
  let s = '';
  for (const k of kids) if (k.type === 'text' && k.data) s += k.data;
  return s;
}

/** Inline formatting (phrasing) tags: glued siblings of these are prose ("<b>x</b><i>y</i>"), never layout items. */
const PHRASING_TAGS = new Set([
  'b', 'i', 'em', 'strong', 'code', 'sup', 'sub', 'small', 'mark', 'abbr', 'kbd', 'var', 'samp', 's', 'u', 'q', 'cite',
  'time', 'data', 'bdi', 'bdo', 'ruby', 'rt', 'rp', 'wbr', 'font', 'del', 'ins', 'dfn', 'tt', 'big', 'strike',
]);
/** Subtrees where glued elements are intentional (syntax-highlight tokens) and item splitting is disabled. */
const MONO_TAGS = new Set(['pre', 'code', 'kbd', 'samp', 'textarea', 'listing', 'xmp']);
const LETTER_RE = /\p{L}/u;
const EDGE_BUDGET = 24;

interface EdgeInfo {
  /** First / last character of the element's visible text ("" if none found within budget). */
  first: string;
  last: string;
  letter: boolean;
}

/** Visible text nodes of `el` in document order, visiting at most EDGE_BUDGET nodes from the given end. */
function edgeTexts(el: DomNode, fromEnd: boolean): string[] {
  const out: string[] = [];
  const stack: DomNode[] = [el];
  let budget = EDGE_BUDGET;
  while (stack.length > 0 && budget-- > 0) {
    const n = stack.pop() as DomNode;
    if (n.type === 'text') {
      if (n.data && /\S/.test(n.data)) out.push(n.data);
      if (out.length >= 3) break;
      continue;
    }
    if (!isElement(n) || !n.children) continue;
    const name = (n.name as string).toLowerCase();
    if (REMOVED_TAGS.has(name) || isHiddenElement(n.attribs ?? {})) continue;
    const kids = n.children;
    if (fromEnd) for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
    else for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

function edgeInfo(el: DomNode): EdgeInfo {
  const head = edgeTexts(el, false);
  const tail = edgeTexts(el, true);
  const firstText = head[0] ?? '';
  const lastText = tail[0] ?? '';
  return {
    first: firstText ? firstText.replace(ZERO_WIDTH_RE, '').charAt(0) : '',
    last: lastText ? lastText.replace(ZERO_WIDTH_RE, '').slice(-1) : '',
    letter: head.some((t) => LETTER_RE.test(t)) || tail.some((t) => LETTER_RE.test(t)),
  };
}

/**
 * True when `el` lays out its children as separate items: no direct non-whitespace text, and two adjacent element
 * children (no text node, not even whitespace, between them) that would visually glue: neither is an inline formatting
 * tag, at least one contains letters, and their touching edges are not whitespace.
 * Matches JSX-style `<nav><a>Docs</a><a>Blog</a></nav>` and `<span>TVL</span><span>$1,024</span>`; leaves
 * `<span>$</span><span>10</span>`, `<span>10 </span><span>SOL</span>` and `<b>a</b><i>b</i>` inline.
 */
function isItemContainer(el: DomNode): boolean {
  const kids = el.children;
  if (!kids || kids.length < 2) return false;
  for (const k of kids) if (k.type === 'text' && k.data && /\S/.test(k.data)) return false;
  let prev: EdgeInfo | null = null;
  for (const k of kids) {
    if (k.type === 'text') {
      prev = null;
      continue;
    }
    if (!isElement(k)) continue; // comments do not separate siblings
    const name = (k.name as string).toLowerCase();
    if (PHRASING_TAGS.has(name) || REMOVED_TAGS.has(name) || isHiddenElement(k.attribs ?? {})) {
      prev = null;
      continue;
    }
    const cur = edgeInfo(k);
    if (!cur.first) continue; // empty element (icon, spacer): does not separate or glue
    if (prev && (prev.letter || cur.letter) && !/\s/.test(prev.last) && !/\s/.test(cur.first)) return true;
    prev = cur;
  }
  return false;
}

const VOID_TAGS = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'command', 'embed', 'frame', 'hr', 'image', 'img', 'input', 'isindex',
  'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
/** Elements the parser closes implicitly (so unclosed ones do not deepen the tree). */
const AUTO_CLOSE_TAGS = new Set([
  'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'rb', 'rt', 'rtc', 'rp',
  'colgroup', 'caption', 'html', 'head', 'body',
]);
/** htmlparser2's raw-text elements: content is not tokenized as tags. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'title', 'textarea', 'xmp']);
const rawTextCloseRe = new Map<string, RegExp>();

/**
 * Cheap pre-scan approximating the parser's open-element stack. If nesting exceeds `maxDepth`, return the document cut
 * just before the offending tag. Real pages nest < 100 deep; this only trips on broken or hostile markup, where the parser
 * would otherwise go quadratic and stall the event loop.
 */
export function limitNesting(html: string, maxDepth = MAX_NESTING_DEPTH): string {
  const re = /<(\/?)([a-zA-Z][^\s/>]*)([^>]*)>|<!--/g;
  const stack: string[] = [];
  let foreignAt = -1; // index in stack of the outermost open <svg>/<math>, -1 if none
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[0] === '<!--') {
      const end = html.indexOf('-->', re.lastIndex);
      if (end === -1) break;
      re.lastIndex = end + 3;
      continue;
    }
    const name = m[2].toLowerCase();
    if (m[1] === '/') {
      // Pop to the nearest matching open element; search only near the top (stray end tags are ignored like the parser does).
      for (let i = stack.length - 1, k = 0; i >= 0 && k < 64; i--, k++) {
        if (stack[i] === name) {
          stack.length = i;
          if (foreignAt >= i) foreignAt = -1;
          break;
        }
      }
      continue;
    }
    // "/>" only self-closes inside svg/math; in HTML "<script src=x />" still opens a raw-text element.
    const selfClosing = m[3].endsWith('/');
    if (RAW_TEXT_TAGS.has(name) && !(selfClosing && foreignAt >= 0)) {
      let closeRe = rawTextCloseRe.get(name);
      if (!closeRe) {
        closeRe = new RegExp(`</${name}[\\s/>]`, 'gi');
        rawTextCloseRe.set(name, closeRe);
      }
      closeRe.lastIndex = re.lastIndex;
      const close = closeRe.exec(html);
      if (!close) break;
      re.lastIndex = close.index + close[0].length;
      continue;
    }
    if (VOID_TAGS.has(name) || AUTO_CLOSE_TAGS.has(name)) continue;
    if (selfClosing && foreignAt >= 0) continue;
    if ((name === 'svg' || name === 'math') && foreignAt < 0) foreignAt = stack.length;
    stack.push(name);
    if (stack.length > maxDepth) return html.slice(0, m.index);
  }
  return html;
}

function emptyPage(): ParsedPage {
  return {
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
  };
}

interface InlineScript {
  id: string | null;
  text: string;
}

interface Collected {
  titles: string[];
  description: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  generator: string | null;
  noindex: boolean;
  baseHref: string | null;
  canonical: string | null;
  links: string[];
  /** Raw hrefs already in `links` (exact-duplicate filter so repeats cannot exhaust MAX_LINKS). */
  linkSet: Set<string>;
  scripts: string[];
  styles: string[];
  preloads: string[];
  inlineScripts: InlineScript[];
  textLines: string[];
}

function addLink(c: Collected, href: string): void {
  if (c.links.length >= MAX_LINKS || c.linkSet.has(href)) return;
  c.linkSet.add(href);
  c.links.push(href);
}

function isHtmlAlternate(type: string | undefined): boolean {
  const t = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
  return t === '' || t === 'text/html' || t === 'application/xhtml+xml';
}

function relTokens(rel: string | undefined): string[] {
  return typeof rel === 'string' ? rel.toLowerCase().split(/\s+/).filter(Boolean) : [];
}

function collectElement(name: string, attrs: Record<string, string>, el: DomNode, inSvg: boolean, c: Collected): void {
  switch (name) {
    case 'title':
      if (!inSvg) c.titles.push(directText(el));
      return;
    case 'meta': {
      const metaName = (attrs.name ?? '').trim().toLowerCase();
      const prop = (attrs.property ?? '').trim().toLowerCase();
      const content = attrs.content;
      if (typeof content !== 'string' || !content.trim()) return;
      if (metaName === 'description') c.description ??= content;
      else if (metaName === 'generator') c.generator ??= content;
      else if (metaName === 'robots' && /\b(?:noindex|none)\b/i.test(content)) c.noindex = true;
      if (prop === 'og:description' || metaName === 'og:description') c.ogDescription ??= content;
      if (prop === 'og:image' || metaName === 'og:image') c.ogImage ??= content;
      return;
    }
    case 'base':
      if (c.baseHref === null && typeof attrs.href === 'string' && attrs.href.trim()) c.baseHref = attrs.href;
      return;
    case 'link': {
      const href = attrs.href;
      if (typeof href !== 'string' || !href.trim()) return;
      const rel = relTokens(attrs.rel);
      if (rel.includes('canonical') && c.canonical === null) c.canonical = href;
      // Alternate *pages* (translations, AMP) are links; alternate formats of the same page (a docs platform's
      // "text/markdown" twin, RSS/Atom feeds, JSON, XML sitemaps) are not.
      if (rel.includes('alternate') && isHtmlAlternate(attrs.type)) addLink(c, href);
      if (rel.includes('stylesheet') && c.styles.length < MAX_ASSETS) c.styles.push(href);
      const as = (attrs.as ?? '').trim().toLowerCase();
      const isPreload = rel.includes('preload') || rel.includes('modulepreload') || rel.includes('prefetch');
      if (isPreload && (as === 'script' || as === 'style' || rel.includes('modulepreload')) && c.preloads.length < MAX_ASSETS) {
        c.preloads.push(href);
      }
      return;
    }
    case 'script': {
      const src = attrs.src;
      if (typeof src === 'string' && src.trim()) {
        if (c.scripts.length < MAX_ASSETS) c.scripts.push(src);
      } else {
        const text = directText(el);
        if (text) c.inlineScripts.push({ id: typeof attrs.id === 'string' ? attrs.id : null, text });
      }
      return;
    }
    case 'a':
    case 'area': {
      const href = attrs.href;
      if (typeof href === 'string' && href.trim()) addLink(c, href);
      return;
    }
    default:
      return;
  }
}

interface Frame {
  node: DomNode;
  idx: number;
  /** Text in this subtree is invisible. */
  off: boolean;
  pre: boolean;
  /** Inside pre/code: item splitting disabled. */
  mono: boolean;
  /** Children of this element each start a new line (item container). */
  items: boolean;
  /** This element breaks lines on enter/exit. */
  brk: boolean;
  svg: boolean;
}

/** Single iterative pass over the DOM. */
function walk(root: DomNode, c: Collected): void {
  let parts: string[] = [];
  const flush = () => {
    if (parts.length === 0) return;
    const line = collapse(parts.join(''));
    parts = [];
    if (line) c.textLines.push(line);
  };
  const addText = (data: string, pre: boolean) => {
    if (!pre || (data.indexOf('\n') === -1 && data.indexOf('\r') === -1)) {
      parts.push(data);
      return;
    }
    const pieces = data.split(/\r\n|\r|\n/);
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0) flush();
      parts.push(pieces[i]);
    }
  };

  const stack: Frame[] = [{ node: root, idx: 0, off: false, pre: false, mono: false, items: false, brk: false, svg: false }];
  while (stack.length > 0) {
    const f = stack[stack.length - 1];
    const kids = f.node.children;
    if (!kids || f.idx >= kids.length) {
      stack.pop();
      if (f.brk) flush();
      continue;
    }
    const child = kids[f.idx++];
    if (child.type === 'text') {
      if (!f.off && child.data) addText(child.data, f.pre);
      continue;
    }
    if (!isElement(child)) continue; // comments, directives, CDATA

    const name = (child.name as string).toLowerCase();
    const attrs = child.attribs ?? {};
    const svg = f.svg || name === 'svg';
    collectElement(name, attrs, child, svg, c);

    const off = f.off || REMOVED_TAGS.has(name) || isHiddenElement(attrs);
    const brk = !off && (BLOCK_TAGS.has(name) || f.items);
    if (brk) flush();
    if (!child.children || child.children.length === 0) {
      if (brk) flush();
      continue;
    }
    const mono = f.mono || MONO_TAGS.has(name);
    stack.push({
      node: child,
      idx: 0,
      off,
      pre: f.pre || (mono && name !== 'code' && name !== 'kbd' && name !== 'samp'),
      mono,
      items: !off && !mono && isItemContainer(child),
      brk,
      svg,
    });
  }
  flush();
}

function resolveHttp(raw: string | null, base: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = base ? new URL(s, base) : new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function dedupe(values: Iterable<string | null>): string[] {
  const out = new Set<string>();
  for (const v of values) if (v) out.add(v);
  return [...out];
}

// ---------------------------------------------------------------------------
// Build id detection
// ---------------------------------------------------------------------------

const APP_ROUTER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NEXT_PUSH_PREFIX = 'self.__next_f.push(';

function validPagesBuildId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= 128 && !/[\s"'<>]/.test(s) ? s : null;
}

/** Next.js pages router: __NEXT_DATA__ JSON (regex fallback for truncated JSON). */
function nextDataBuildId(scripts: InlineScript[]): string | null {
  for (const s of scripts) {
    if (s.id !== '__NEXT_DATA__') continue;
    try {
      const data = JSON.parse(s.text) as { buildId?: unknown } | null;
      const id = validPagesBuildId(data?.buildId);
      if (id) return id;
    } catch {
      // fall through to regex
    }
    const m = /"buildId"\s*:\s*"([^"\\]{1,128})"/.exec(s.text);
    const id = validPagesBuildId(m?.[1]);
    if (id) return id;
  }
  return null;
}

function nextManifestBuildId(urls: string[]): string | null {
  const re = /\/_next\/static\/([^/?#]+)\/_(?:buildManifest|ssgManifest)\.js/;
  for (const u of urls) {
    const m = re.exec(u);
    if (m && m[1] !== 'chunks' && m[1] !== 'css' && m[1] !== 'media') {
      const id = validPagesBuildId(m[1]);
      if (id) return id;
    }
  }
  return null;
}

/**
 * Next.js app router: decode every `self.__next_f.push([1,"…"])` chunk (they are JSON), join them into the flight
 * stream, and read the build id from row 0 — `{"b":"<id>",…}` (Next 15+) or `["<id>",…]` (Next 13/14).
 * Falls back to a regex over the raw (escaped or unescaped) script text.
 */
function nextFlightBuildId(scripts: InlineScript[]): string | null {
  const flightScripts = scripts.filter((s) => s.text.includes('__next_f'));
  if (flightScripts.length === 0) return null;

  const chunks: string[] = [];
  let total = 0;
  for (const s of flightScripts) {
    const t = s.text.trim();
    if (!t.startsWith(NEXT_PUSH_PREFIX)) continue;
    const inner = t.slice(NEXT_PUSH_PREFIX.length).replace(/\)\s*;?\s*$/, '');
    try {
      const arr = JSON.parse(inner) as unknown;
      if (Array.isArray(arr) && arr[0] === 1 && typeof arr[1] === 'string') {
        chunks.push(arr[1]);
        total += arr[1].length;
        if (total > MAX_FLIGHT_CHARS) break;
      }
    } catch {
      // Non-JSON chunk; the regex fallback below still sees it.
    }
  }
  if (chunks.length > 0) {
    const flight = chunks.join('');
    const start = flight.startsWith('0:') ? 0 : flight.indexOf('\n0:') + 1;
    if (start > 0 || flight.startsWith('0:')) {
      const end = flight.indexOf('\n', start);
      const row = flight.slice(start + 2, end === -1 ? undefined : end);
      try {
        const v = JSON.parse(row) as unknown;
        if (Array.isArray(v)) {
          if (typeof v[0] === 'string' && APP_ROUTER_ID_RE.test(v[0])) return v[0];
          if (Array.isArray(v[1]) && typeof v[1][0] === 'string' && APP_ROUTER_ID_RE.test(v[1][0])) return v[1][0];
        } else if (v && typeof v === 'object') {
          const b = (v as { b?: unknown }).b;
          if (typeof b === 'string' && APP_ROUTER_ID_RE.test(b)) return b;
        }
      } catch {
        // fall through to regex
      }
    }
  }

  const bRe = /\\?"b\\?"\s*:\s*\\?"([A-Za-z0-9_-]{8,64})\\?"/;
  const rowRe = /(?:^|\\n|\n|\[1,")0:\[\\?"([A-Za-z0-9_-]{8,64})\\?"/;
  for (const s of flightScripts) {
    const m = bRe.exec(s.text) ?? rowRe.exec(s.text);
    if (m) return m[1];
  }
  return null;
}

function nuxtBuildId(scripts: InlineScript[], urls: string[], html: string): string | null {
  const metaRe = /\/_nuxt\/builds\/meta\/([A-Za-z0-9_-]{6,64})\.json/;
  for (const s of scripts) {
    if (!s.text.includes('__NUXT__') && !s.text.includes('buildId')) continue;
    const m = /\bbuildId\\?["']?\s*:\s*\\?["']([A-Za-z0-9_-]{6,64})\\?["']/.exec(s.text);
    if (m) return m[1];
  }
  for (const u of urls) {
    const m = metaRe.exec(u);
    if (m) return m[1];
  }
  const m = metaRe.exec(html);
  return m ? m[1] : null;
}

function gatsbyBuildId(scripts: InlineScript[]): string | null {
  const re = /webpackCompilationHash\\?["']?\s*[:=]\s*\\?["']([A-Za-z0-9_-]{6,64})\\?["']/;
  for (const s of scripts) {
    if (!s.text.includes('webpackCompilationHash')) continue;
    const m = re.exec(s.text);
    if (m) return m[1];
  }
  return null;
}

function svelteKitBuildId(scripts: InlineScript[]): string | null {
  const re = /\b__sveltekit_([A-Za-z0-9]{2,64})\b/;
  for (const s of scripts) {
    if (!s.text.includes('__sveltekit_')) continue;
    const m = re.exec(s.text);
    if (m) return m[1];
  }
  return null;
}

function detectBuildId(c: Collected, resolvedUrls: string[], html: string): string | null {
  return (
    nextDataBuildId(c.inlineScripts) ??
    nextManifestBuildId([...c.scripts, ...c.preloads, ...resolvedUrls]) ??
    nextFlightBuildId(c.inlineScripts) ??
    nuxtBuildId(c.inlineScripts, [...c.scripts, ...c.preloads], html) ??
    gatsbyBuildId(c.inlineScripts) ??
    svelteKitBuildId(c.inlineScripts)
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an HTML document. Never throws: malformed input yields a best-effort result, and on an internal failure an empty
 * ParsedPage is returned. Input beyond MAX_HTML_CHARS is ignored, as is markup nested deeper than MAX_NESTING_DEPTH.
 * Relative URLs resolve against the document's first <base href> (if valid http(s)), else `baseUrl`.
 */
export function parseHtml(html: string, baseUrl: string): ParsedPage {
  try {
    if (typeof html !== 'string' || html.length === 0) return emptyPage();
    const capped = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
    const source = limitNesting(capped);

    const $ = load(source);
    const root = $.root()[0] as unknown as DomNode;
    const c: Collected = {
      titles: [],
      description: null,
      ogDescription: null,
      ogImage: null,
      generator: null,
      noindex: false,
      baseHref: null,
      canonical: null,
      links: [],
      linkSet: new Set(),
      scripts: [],
      styles: [],
      preloads: [],
      inlineScripts: [],
      textLines: [],
    };
    walk(root, c);

    const pageBase = typeof baseUrl === 'string' && baseUrl.trim() ? resolveHttp(baseUrl, null) : null;
    const docBase = resolveHttp(c.baseHref, pageBase) ?? pageBase;

    const links: string[] = [];
    const seenLinks = new Set<string>();
    for (const raw of c.links) {
      const n = normalizeUrl(raw, docBase ?? undefined);
      if (n && !seenLinks.has(n)) {
        seenLinks.add(n);
        links.push(n);
      }
    }
    const scripts = dedupe(c.scripts.map((s) => resolveHttp(s, docBase)));
    const styles = dedupe(c.styles.map((s) => resolveHttp(s, docBase)));
    const preloads = dedupe(c.preloads.map((s) => resolveHttp(s, docBase)));

    let title: string | null = null;
    for (let i = c.titles.length - 1; i >= 0; i--) {
      const t = nonEmpty(c.titles[i]);
      if (t) {
        title = t;
        break;
      }
    }

    let buildId: string | null = null;
    try {
      buildId = detectBuildId(c, [...scripts, ...preloads], source);
    } catch {
      buildId = null;
    }

    let hosts: string[] = [];
    try {
      hosts = scanHosts(capped, 'html', MAX_HOSTS);
    } catch {
      hosts = [];
    }

    const ogRaw = nonEmpty(c.ogImage);
    return {
      title,
      description: nonEmpty(c.description) ?? nonEmpty(c.ogDescription),
      ogImage: ogRaw ? (resolveHttp(ogRaw, docBase) ?? ogRaw) : null,
      canonical: c.canonical ? normalizeUrl(c.canonical, docBase ?? undefined) : null,
      generator: nonEmpty(c.generator),
      textLines: c.textLines,
      links,
      assets: { scripts, styles, preloads },
      buildId,
      hosts,
      noindex: c.noindex,
    };
  } catch {
    return emptyPage();
  }
}

/**
 * Canonical text snapshot used for storage & diffing. Format (lines joined with "\n"):
 *   "# <title>"                (only if title)
 *   "> <description>"          (only if description)
 *   ...textLines
 * Identical input → identical output (pure).
 */
export function pageTextSnapshot(p: ParsedPage): string {
  const lines: string[] = [];
  if (p?.title) lines.push(`# ${p.title}`);
  if (p?.description) lines.push(`> ${p.description}`);
  if (Array.isArray(p?.textLines)) for (const l of p.textLines) lines.push(l);
  return lines.join('\n');
}

/**
 * Cheap check whether a response looks like HTML (content-type text/html or application/xhtml+xml, or body starts with
 * <!doctype html / <html after whitespace/BOM). Leading `<?xml …?>` declarations and HTML comments are skipped too.
 */
export function looksLikeHtml(contentType: string | null, bodyText: string | null): boolean {
  if (typeof contentType === 'string') {
    const media = contentType.split(';')[0].trim().toLowerCase();
    if (media === 'text/html' || media === 'application/xhtml+xml') return true;
  }
  if (typeof bodyText !== 'string' || bodyText.length === 0) return false;
  let s = bodyText.slice(0, 4096).replace(/^\uFEFF/, '').trimStart();
  for (let guard = 0; guard < 20; guard++) {
    if (s.startsWith('<!--')) {
      const end = s.indexOf('-->');
      if (end === -1) return false;
      s = s.slice(end + 3).trimStart();
    } else if (s.startsWith('<?xml')) {
      const end = s.indexOf('?>');
      if (end === -1) return false;
      s = s.slice(end + 2).trimStart();
    } else {
      break;
    }
  }
  return /^<!doctype\s+html\b/i.test(s) || /^<html[\s>]/i.test(s);
}
