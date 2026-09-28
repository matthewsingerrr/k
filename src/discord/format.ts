/**
 * Alert → Discord message rendering (pure functions, no network).
 *
 * Style (mirrors the Telegram bot the user showed):
 *   deploy        content "🌐 **unpeg.io** was redeployed (site code changed)."                     color 0x3b82f6
 *   text          content "📝 **Unpeg** text changed: /docs/risks, /docs/guides, /docs/faq (+2 more)" color 0xf59e0b
 *   new_pages     content "🆕 **Unpeg** new page(s): /docs/points, /airdrop"                          color 0x22c55e
 *   removed_pages content "🗑️ **Unpeg** page(s) removed: /docs/old"                                   color 0xef4444
 *   subdomain     content "🛰️ New subdomain on **unpeg.io**: beta.unpeg.io, app.unpeg.io"            color 0xa855f7
 *   subdomain_live content "🟣 Subdomain went live: beta.unpeg.io"                                      color 0xa855f7
 *   file          content "📄 **Unpeg** file changed: whitepaper.pdf"                                 color 0xf97316
 *   status down   content "🔴 **unpeg.io** is DOWN (HTTP 502)"                                        color 0xdc2626
 *   status up     content "🟢 **unpeg.io** is back UP (was down 4m 12s)"                                color 0x16a34a
 *   info          content "ℹ️ **Unpeg**: <message>"                                                   color 0x64748b
 * Content lists paths (urlPath) not full URLs, so Discord doesn't auto-embed link previews; max ~5 items then "(+N more)".
 * If watch.pingRoleId: prefix content with "<@&ROLE> " and set allowedMentions {roles:[ROLE]}; otherwise allowedMentions {parse: []}.
 * (The ping is added once per formatAlerts() batch — on its first payload — so one tick never pings a role several times.
 * A ping role equal to the guild id is the @everyone role and is rendered as "@everyone" with parse ['everyone'].)
 *
 * Embeds (details):
 *   deploy: title "<host> redeployed", url = watch.url; fields: "Build" (`old` → `new`, code-formatted) when build ids known;
 *     "Deployment" (`dpl_A` → `dpl_B`) when every changed asset only differs in one shared query value (Vercel's ?dpl=) — then
 *     the chunk list is cut to 3, it says little; "Bundles" "+N / −M changed" with up to 8 added paths; "New routes in code"
 *     (≤ 20, code-formatted, joined by newlines) when newCodePaths; "New hosts in code" when newCodeHosts.
 *   text: one embed per diff group (max 8 groups, 3 when more than 20 pages changed; then a final line "+N more pages
 *     changed"): title = page title or path of the first
 *     url, url = first url, description = (if group has >1 url: "Same change on N pages: /a, /b, …\n") + "```diff\n<unified>\n```"
 *     — unified is trimmed so the description ≤ 4000 chars (cut whole lines, close the code block). Title change as a field
 *     "Title" `old` → `new`. (With several groups the per-group diff budget shrinks so one tick stays within a few messages.)
 *   new_pages: one embed; description = bullet list "• [path](url) — title" (≤ 25 items, rest "…and N more").
 *   removed_pages: one embed with bullet list "• path (HTTP 404)".
 *   subdomain(_live): one embed per subdomain (max 10) — title = host, url = `https://${host}/` (a redirect shows in the
 *     HTTP field; several subdomains redirecting to one page must not share an embed url),
 *     fields: "Found via" (sources: ct→"Certificate log", crtsh→"crt.sh", dns→"DNS", link→"Site link", code→"Site code"),
 *     "DNS" (A/AAAA/CNAME compact, ≤ 6 values), "HTTP" ("200 · <title>" or "unreachable"). Components: one action row per message with
 *     up to 5 buttons "Watch <host>" custom_id `watchsub:<watchId>:<host>` (ButtonStyle.Secondary) — only for alive hosts that
 *     are not just the watched site again (www.<host>, or redirecting to the watched host).
 *     More than 10 subdomains: 9 detailed embeds + one compact list embed of the rest.
 *   file: embed list "• [filename](url) — modified (820 KB → 863 KB)" / added / removed.
 *   status: embed description with url + detail; up: downtime duration.
 *   info: content "<emoji> **Name**: <first line>" (the message's own leading ℹ️/⚠️ is used, not doubled); further lines, if
 *     any, go into an embed. Messages embed site-controlled paths, so they are escaped.
 * Every embed: footer text "<watch.name> · <watch.host>", timestamp = now (ISO).
 *
 * Discord limits enforced: content ≤ 2000, embed title ≤ 256, description ≤ 4096, field name ≤ 256, field value ≤ 1024,
 * ≤ 25 fields, footer ≤ 2048, ≤ 10 embeds per message, total embed text ≤ 6000 per message — split into multiple payloads if
 * needed (content only on the first payload of an alert; subsequent payloads omit content). Buttons: ≤ 5 per row, label ≤ 80,
 * custom_id ≤ 100 (hosts that would exceed it get no button).
 * User-controlled strings (titles, paths, hosts) are escaped with escapeMarkdown; inside ```diff blocks "```" becomes "ˋˋˋ".
 * formatAlerts never throws: an alert that fails to render becomes a short plain fallback message.
 */

import { ButtonStyle, ComponentType } from 'discord.js';
import type { APIActionRowComponent, APIButtonComponent, APIEmbed, APIEmbedField } from 'discord.js';
import type {
  Alert,
  DeployAlert,
  DnsInfo,
  FileAlert,
  InfoAlert,
  NewPagesAlert,
  PageSource,
  RemovedPagesAlert,
  StatusAlert,
  SubdomainAlert,
  SubdomainInfo,
  SubdomainSource,
  TextAlert,
  TextChange,
  TextDiff,
  Watch,
} from '../types.js';
import { displayUrl, urlFilename, urlPath } from '../extract/url.js';

export interface MessagePayload {
  content?: string;
  embeds: APIEmbed[];
  components?: Array<APIActionRowComponent<APIButtonComponent>>;
  allowedMentions: { parse?: Array<'roles' | 'users' | 'everyone'>; roles?: string[] };
}

/** Discord API limits (https://discord.com/developers/docs/resources/message#embed-object-embed-limits). */
export const DISCORD_LIMITS = {
  content: 2000,
  embedsPerMessage: 10,
  embedTitle: 256,
  embedDescription: 4096,
  embedFields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  authorName: 256,
  embedTotal: 6000,
  actionRows: 5,
  buttonsPerRow: 5,
  buttonLabel: 80,
  customId: 100,
} as const;

export const ALERT_COLORS = {
  deploy: 0x3b82f6,
  text: 0xf59e0b,
  new_pages: 0x22c55e,
  removed_pages: 0xef4444,
  subdomain: 0xa855f7,
  subdomain_live: 0xa855f7,
  file: 0xf97316,
  statusDown: 0xdc2626,
  statusUp: 0x16a34a,
  info: 0x64748b,
} as const;

/** Prefix of subdomain "Watch <host>" button custom ids (`watchsub:<watchId>:<host>`). */
export const WATCH_SUB_PREFIX = 'watchsub:';

/** Content budget per alert; leaves room for a ping prefix within the 2000-char limit. */
const CONTENT_BUDGET = 1900;
const CONTENT_ITEMS = 5;
/** Longest single item (path/host) shown in content, before escaping. */
const CONTENT_ITEM_CHARS = 100;
const MAX_TEXT_GROUPS = 8;
/** A text alert covering more pages than this (a site-wide edit, a redeploy) shows fewer diff embeds. */
const MANY_PAGES = 20;
const MAX_TEXT_GROUPS_MANY = 3;
/** Description budget for text-diff embeds (spec: ≤ 4000). */
const TEXT_DESC_MAX = 4000;
/** Total diff budget for one text alert, spread over its groups (each group gets at least TEXT_DESC_MIN). */
const TEXT_TOTAL_BUDGET = 5200;
const TEXT_DESC_MIN = 900;
const LIST_DESC_BUDGET = 4000;
const NEW_PAGES_LISTED = 25;
const MAX_SUBDOMAIN_EMBEDS = 10;
const DNS_VALUES = 6;
/** Markdown links to longer URLs are rendered as plain text. */
const MAX_LINK_URL = 1000;
const MAX_EMBED_URL = 2000;
const DIFF_TRUNCATED = '… (diff truncated)';
const FOOTER_CHARS = 256;

type Block = { embed: APIEmbed; buttonHost?: string };
interface Rendered {
  content: string;
  blocks: Block[];
}

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  try {
    return String(v);
  } catch {
    return '';
  }
}

function arr<T>(v: T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : [];
}

function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return n === 1 ? word : pluralWord;
}

/**
 * Cut `input` to at most `max` UTF-16 units (Discord counts code points, so this is conservative), appending an ellipsis.
 * Never splits a surrogate pair and never leaves a dangling escape backslash.
 */
export function truncate(input: string, max: number, ellipsis = '…'): string {
  const s = str(input);
  if (!(max > 0)) return '';
  if (s.length <= max) return s;
  const keep = max > ellipsis.length ? max - ellipsis.length : max;
  let cut = s.slice(0, keep);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const slashes = /\\+$/.exec(cut);
  if (slashes && slashes[0].length % 2 === 1) cut = cut.slice(0, -1);
  return max > ellipsis.length ? cut + ellipsis : cut;
}

/** Close an unterminated ``` code block (only possible in bot-written text; user text is escaped). */
function balanceFences(s: string): string {
  return (s.match(/```/g) ?? []).length % 2 === 1 ? `${s}\n\`\`\`` : s;
}

/** Truncate markdown text, keeping ``` code fences balanced. */
function truncateMarkdown(input: string, max: number): string {
  const s = str(input);
  if (s.length <= max) return s;
  let out = truncate(s, max - 4);
  if ((out.match(/```/g) ?? []).length % 2 === 1) out += '\n```';
  return out;
}

/**
 * Escape Discord markdown so user-controlled text renders literally: \ * _ ` [ ] < everywhere, "||" (spoiler) and "~~"
 * (strike) pairs, list/heading/quote markers at line starts, and "@everyone"/"@here" are defanged visually (pings are blocked
 * by allowedMentions anyway). A lone "|" or "~" is left alone so titles like "Risks | Unpeg Docs" stay clean.
 */
export function escapeMarkdown(s: string): string {
  return str(s)
    .replace(/[\\*_`[\]<]/g, '\\$&')
    .replace(/\|\|/g, '\\|\\|')
    .replace(/~~/g, '\\~\\~')
    .replace(/^([^\S\n]*)([#>+-])/gm, '$1\\$2')
    .replace(/^([^\S\n]*\d+)\./gm, '$1\\.')
    .replace(/@(everyone|here)/gi, '@\u200b$1');
}

/** Inline code span; backticks inside become "ˋ" so the span can't be broken out of. */
export function codeSpan(v: string | null | undefined, max = 100): string {
  const t = truncate(str(v).replace(/[\r\n]+/g, ' ').replace(/`/g, 'ˋ').trim(), max);
  return t ? '`' + t + '`' : '—';
}

function bold(s: string, max = CONTENT_ITEM_CHARS): string {
  const t = escapeMarkdown(truncate(str(s).replace(/[\r\n]+/g, ' ').trim(), max));
  return t ? `**${t}**` : '**?**';
}

/** Absolute http(s) URL usable as an embed/link target, or undefined. */
function safeHttpUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_EMBED_URL) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.href.length <= MAX_EMBED_URL ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Markdown link `[text](url)`; `text` must already be escaped. Falls back to the text alone for unusable URLs. */
function mdLink(text: string, url: string): string {
  const safe = safeHttpUrl(url);
  if (!safe || safe.length > MAX_LINK_URL) return text;
  const href = safe.replace(/[()<> ]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  return `[${text}](${href})`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Path (decoded, "/docs/faq") for URLs on the watched host, "host/path" for anything else. */
function shortUrl(url: string, watch: Watch): string {
  const u = str(url);
  const h = hostOf(u);
  if (!h) return u.trim() || '/';
  const d = displayUrl(u);
  if (h === str(watch.host).toLowerCase()) {
    const i = d.indexOf('/');
    return i >= 0 ? d.slice(i) : urlPath(u);
  }
  return d;
}

/** "a, b, c (+N more)": up to `maxItems` escaped items within `budget` chars. */
function inlineList(items: string[], maxItems: number, budget: number): string {
  const out: string[] = [];
  let used = 0;
  for (const item of items) {
    if (out.length >= maxItems) break;
    const piece = escapeMarkdown(truncate(str(item).replace(/[\r\n]+/g, ' '), CONTENT_ITEM_CHARS));
    const add = piece.length + (out.length ? 2 : 0);
    // Keep room for the " (+N more)" suffix.
    if (used + add > budget - 16) break;
    out.push(piece);
    used += add;
  }
  const rest = items.length - out.length;
  if (out.length === 0) return rest > 0 ? `${rest} item${rest === 1 ? '' : 's'}` : '';
  return out.join(', ') + (rest > 0 ? ` (+${rest} more)` : '');
}

/** Newline-joined lines within `budget` chars and `max` items; overflow becomes "…and N more". */
function lineList(lines: string[], max: number, budget: number, head = ''): string {
  const out: string[] = head ? [head] : [];
  let used = head.length;
  let shown = 0;
  for (const line of lines) {
    if (shown >= max) break;
    const add = line.length + (out.length ? 1 : 0);
    if (used + add > budget - 24) break;
    out.push(line);
    used += add;
    shown++;
  }
  const rest = lines.length - shown;
  if (rest > 0) out.push(`…and ${rest} more`);
  return out.join('\n') || '—';
}

function uniq(items: string[]): string[] {
  return [...new Set(items.filter((x) => typeof x === 'string' && x !== ''))];
}

/** Human duration: 45s, 4m 12s, 3h 5m, 2d 4h. */
export function formatDuration(ms: number): string {
  const total = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** Human bytes: 820 B, 12.3 KB, 4.1 MB. Unknown → "?". */
export function formatBytes(n: number | null): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const num = v < 100 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
  return `${num} ${units[i]}`;
}

/** Total character count of an embed as Discord counts it (title+description+field names/values+footer text+author name). */
export function embedLength(e: APIEmbed): number {
  if (!e || typeof e !== 'object') return 0;
  let n = str(e.title).length + str(e.description).length + str(e.footer?.text).length + str(e.author?.name).length;
  for (const f of arr(e.fields)) n += str(f?.name).length + str(f?.value).length;
  return n;
}

/**
 * Make an embed valid for Discord no matter what went into it: every per-field limit, non-empty field names/values,
 * valid URLs, and a total ≤ 6000 (description shrinks first, then trailing fields are dropped).
 */
export function clampEmbed(e: APIEmbed): APIEmbed {
  const L = DISCORD_LIMITS;
  const out: APIEmbed = {};
  const title = truncate(str(e.title).replace(/[\r\n]+/g, ' ').trim(), L.embedTitle);
  if (title) out.title = title;
  const url = safeHttpUrl(e.url);
  if (url) out.url = url;
  const description = truncateMarkdown(balanceFences(str(e.description)), L.embedDescription);
  if (description.trim()) out.description = description;
  if (typeof e.color === 'number' && Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff) out.color = e.color;
  if (typeof e.timestamp === 'string' && e.timestamp) out.timestamp = e.timestamp;
  if (e.author?.name) out.author = { ...e.author, name: truncate(str(e.author.name), L.authorName) };
  const fields: APIEmbedField[] = [];
  for (const f of arr(e.fields).slice(0, L.embedFields)) {
    if (!f) continue;
    const name = truncate(str(f.name).trim(), L.fieldName) || '\u200b';
    const clipped = truncateMarkdown(balanceFences(str(f.value)), L.fieldValue);
    const value = clipped.trim() ? clipped : '—';
    fields.push(f.inline ? { name, value, inline: true } : { name, value });
  }
  if (fields.length) out.fields = fields;
  const footer = truncate(str(e.footer?.text), L.footerText);
  if (footer.trim()) out.footer = { text: footer };

  let over = embedLength(out) - L.embedTotal;
  if (over > 0 && out.description) {
    const keep = out.description.length - over;
    if (keep >= 20) out.description = truncateMarkdown(out.description, keep);
    else delete out.description;
    over = embedLength(out) - L.embedTotal;
  }
  while (over > 0 && out.fields && out.fields.length) {
    out.fields.pop();
    if (!out.fields.length) delete out.fields;
    over = embedLength(out) - L.embedTotal;
  }
  if (over > 0 && out.title) out.title = truncate(out.title, Math.max(1, out.title.length - over));
  if (embedLength(out) === 0 && !out.url) out.description = '\u200b';
  return out;
}

// ---------------------------------------------------------------------------
// Per-kind renderers
// ---------------------------------------------------------------------------

function renderDeploy(watch: Watch, a: DeployAlert): Rendered {
  const host = str(a.host) || hostOf(str(a.url)) || watch.host;
  const fields: APIEmbedField[] = [];
  const oldId = a.buildIdOld ?? null;
  const newId = a.buildIdNew ?? null;
  if (oldId || newId) {
    const value =
      oldId && oldId === newId ? `${codeSpan(newId, 100)} (unchanged)` : `${codeSpan(oldId, 100)} → ${codeSpan(newId, 100)}`;
    fields.push({ name: 'Build', value });
  }
  const added = uniq(arr(a.assetsAdded));
  const removed = uniq(arr(a.assetsRemoved));
  const deployment = sharedQueryChange(added, removed);
  if (deployment) {
    fields.push({ name: 'Deployment', value: `${codeSpan(deployment.from, 100)} → ${codeSpan(deployment.to, 100)}` });
  }
  if (added.length || removed.length) {
    const lines = added.map((u) => codeSpan(shortUrl(u, watch), 110));
    fields.push({
      name: 'Bundles',
      value: lineList(lines, deployment ? 3 : 8, DISCORD_LIMITS.fieldValue, `+${added.length} / −${removed.length} changed`),
    });
  }
  const paths = uniq(arr(a.newCodePaths));
  if (paths.length) {
    fields.push({ name: 'New routes in code', value: lineList(paths.map((p) => codeSpan(p, 100)), 20, DISCORD_LIMITS.fieldValue) });
  }
  const hosts = uniq(arr(a.newCodeHosts));
  if (hosts.length) {
    fields.push({ name: 'New hosts in code', value: lineList(hosts.map((h) => codeSpan(h, 100)), 20, DISCORD_LIMITS.fieldValue) });
  }
  const embed: APIEmbed = {
    title: `${escapeMarkdown(truncate(host, 200))} redeployed`,
    url: watch.url,
    color: ALERT_COLORS.deploy,
    fields,
  };
  if (!fields.length) embed.description = 'The site code changed — a new version is live.';
  return { content: `🌐 ${bold(host)} was redeployed (site code changed).`, blocks: [{ embed }] };
}

function queryParams(u: string): Map<string, string> | null {
  const q = u.indexOf('?');
  if (q === -1) return null;
  try {
    return new Map(new URLSearchParams(u.slice(q + 1)));
  } catch {
    return null;
  }
}

/**
 * A query parameter every added and every removed asset carries, with one value on each side (Vercel's "?dpl=dpl_…"):
 * the deployment id, far more telling than a list of hashed chunk names.
 */
function sharedQueryChange(added: string[], removed: string[]): { from: string; to: string } | null {
  if (added.length === 0 || removed.length === 0) return null;
  const a = added.map(queryParams);
  const r = removed.map(queryParams);
  if (a.some((m) => !m) || r.some((m) => !m)) return null;
  for (const key of (a[0] as Map<string, string>).keys()) {
    const to = new Set(a.map((m) => (m as Map<string, string>).get(key)));
    const from = new Set(r.map((m) => (m as Map<string, string>).get(key)));
    if (to.size !== 1 || from.size !== 1) continue;
    const [t] = to;
    const [f] = from;
    if (t && f && t !== f) return { from: f, to: t };
  }
  return null;
}

/** "```diff … ```" block of whole unified-diff lines within `budget` chars (fences included). */
function diffBlock(unified: string, budget: number): string {
  const open = '```diff\n';
  const close = '\n```';
  const avail = budget - open.length - close.length;
  if (avail < 40) return '';
  const lines = str(unified)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => truncate(l.replace(/`{3,}/g, (m) => 'ˋ'.repeat(m.length)), 400));
  const full = lines.join('\n');
  if (full.length <= avail) return open + full + close;
  const out: string[] = [];
  let used = 0;
  const limit = avail - DIFF_TRUNCATED.length - 1;
  for (const line of lines) {
    const add = line.length + (out.length ? 1 : 0);
    if (used + add > limit) break;
    out.push(line);
    used += add;
  }
  out.push(DIFF_TRUNCATED);
  return open + out.join('\n') + close;
}

type TextGroup = { hash: string; urls: string[]; diff: TextDiff };

function groupsOf(a: TextAlert): TextGroup[] {
  const given = arr(a.groups).filter((g) => g && arr(g.urls).length > 0);
  if (given.length) return given.map((g) => ({ hash: str(g.hash), urls: uniq(arr(g.urls)), diff: g.diff }));
  // Monitors always fill `groups`; rebuild them from `changes` if they didn't.
  const byHash = new Map<string, TextGroup>();
  for (const c of arr(a.changes)) {
    if (!c || !c.url) continue;
    const hash = str(c.diff?.hash) || c.url;
    const g = byHash.get(hash);
    if (g) g.urls.push(c.url);
    else byHash.set(hash, { hash, urls: [c.url], diff: c.diff });
  }
  return [...byHash.values()].sort((x, y) => y.urls.length - x.urls.length);
}

function renderText(watch: Watch, a: TextAlert): Rendered {
  const changes = arr(a.changes).filter((c): c is TextChange => Boolean(c && c.url));
  const byUrl = new Map(changes.map((c) => [c.url, c]));
  const groups = groupsOf(a);
  const urls = uniq(changes.length ? changes.map((c) => c.url) : groups.flatMap((g) => g.urls));
  const content = `📝 ${bold(watch.name)} text changed: ${inlineList(
    urls.map((u) => shortUrl(u, watch)),
    CONTENT_ITEMS,
    CONTENT_BUDGET - 80,
  )}`;

  const shown = groups.slice(0, urls.length > MANY_PAGES ? MAX_TEXT_GROUPS_MANY : MAX_TEXT_GROUPS);
  const perGroup = Math.max(TEXT_DESC_MIN, Math.min(TEXT_DESC_MAX, Math.floor(TEXT_TOTAL_BUDGET / Math.max(1, shown.length))));
  const blocks: Block[] = shown.map((g) => {
    const first = g.urls[0];
    const change = byUrl.get(first);
    const title = str(change?.title).trim() || shortUrl(first, watch);
    let desc = '';
    if (g.urls.length > 1) {
      desc += `Same change on ${g.urls.length} pages: ${inlineList(
        g.urls.map((u) => shortUrl(u, watch)),
        6,
        400,
      )}\n`;
    }
    const titleChange = g.urls.map((u) => byUrl.get(u)?.titleChange).find((t) => t) ?? null;
    const unified = str(g.diff?.unified);
    if (unified.trim()) desc += diffBlock(unified, perGroup - desc.length);
    else desc += titleChange ? 'Only the page title changed.' : 'The visible text changed.';
    const embed: APIEmbed = {
      title: escapeMarkdown(truncate(title.replace(/[\r\n]+/g, ' '), 250)),
      url: first,
      color: ALERT_COLORS.text,
      description: desc,
    };
    if (titleChange) {
      embed.fields = [{ name: 'Title', value: `${codeSpan(titleChange.from, 480)} → ${codeSpan(titleChange.to, 480)}` }];
    }
    return { embed };
  });

  if (groups.length > shown.length) {
    const restUrls = uniq(groups.slice(shown.length).flatMap((g) => g.urls));
    blocks.push({
      embed: {
        color: ALERT_COLORS.text,
        description: `+${restUrls.length} more ${plural(restUrls.length, 'page')} changed: ${inlineList(
          restUrls.map((u) => shortUrl(u, watch)),
          20,
          1500,
        )}`,
      },
    });
  }
  if (!blocks.length) blocks.push({ embed: { color: ALERT_COLORS.text, description: 'The visible text changed.' } });
  return { content, blocks };
}

const SOURCE_NOTE: Partial<Record<PageSource, string>> = {
  code: 'found in site code',
  sitemap: 'sitemap',
  extra: 'added manually',
  redirect: 'redirect target',
};

function renderNewPages(watch: Watch, a: NewPagesAlert): Rendered {
  const pages = arr(a.pages).filter((p) => p && p.url);
  const n = pages.length;
  const lines = pages.map((p) => {
    let line = `• ${mdLink(escapeMarkdown(truncate(shortUrl(p.url, watch), 150)), p.url)}`;
    const title = str(p.title).replace(/[\r\n]+/g, ' ').trim();
    if (title) line += ` — ${escapeMarkdown(truncate(title, 100))}`;
    const note = SOURCE_NOTE[p.source];
    if (note) line += ` · _${note}_`;
    return line;
  });
  return {
    content: `🆕 ${bold(watch.name)} new ${plural(n, 'page')}: ${inlineList(
      pages.map((p) => shortUrl(p.url, watch)),
      CONTENT_ITEMS,
      CONTENT_BUDGET - 80,
    )}`,
    blocks: [
      {
        embed: {
          title: `${n} new ${plural(n, 'page')}`,
          color: ALERT_COLORS.new_pages,
          description: lineList(lines, NEW_PAGES_LISTED, LIST_DESC_BUDGET),
        },
      },
    ],
  };
}

function statusText(status: number): string {
  return typeof status === 'number' && status > 0 ? `HTTP ${status}` : 'unreachable';
}

function renderRemovedPages(watch: Watch, a: RemovedPagesAlert): Rendered {
  const pages = arr(a.pages).filter((p) => p && p.url);
  const n = pages.length;
  const lines = pages.map((p) => `• ${escapeMarkdown(truncate(shortUrl(p.url, watch), 150))} (${statusText(p.status)})`);
  return {
    content: `🗑️ ${bold(watch.name)} ${plural(n, 'page')} removed: ${inlineList(
      pages.map((p) => shortUrl(p.url, watch)),
      CONTENT_ITEMS,
      CONTENT_BUDGET - 80,
    )}`,
    blocks: [
      {
        embed: {
          title: `${n} ${plural(n, 'page')} removed`,
          color: ALERT_COLORS.removed_pages,
          description: lineList(lines, 50, LIST_DESC_BUDGET),
        },
      },
    ],
  };
}

const SOURCE_LABEL: Record<SubdomainSource, string> = {
  ct: 'Certificate log',
  crtsh: 'crt.sh',
  dns: 'DNS',
  link: 'Site link',
  code: 'Site code',
};

function sourcesText(sources: SubdomainSource[] | null | undefined): string {
  const labels = uniq(arr(sources).map((s) => SOURCE_LABEL[s] ?? str(s)));
  return labels.length ? escapeMarkdown(truncate(labels.join(', '), 200)) : 'unknown';
}

function dnsText(dns: DnsInfo | null | undefined): string {
  if (!dns) return 'not resolved';
  const groups: Array<[string, string[]]> = [
    ['CNAME', uniq(arr(dns.cname))],
    ['A', uniq(arr(dns.a))],
    ['AAAA', uniq(arr(dns.aaaa))],
  ];
  const total = groups.reduce((n, [, v]) => n + v.length, 0);
  if (!total) return 'no records';
  let left = DNS_VALUES;
  const lines: string[] = [];
  for (const [type, values] of groups) {
    if (!values.length || left <= 0) continue;
    const take = values.slice(0, left);
    left -= take.length;
    lines.push(`${type} ${take.map((v) => codeSpan(v, 120)).join(', ')}`);
  }
  if (total > DNS_VALUES) lines.push(`+${total - DNS_VALUES} more`);
  return lines.join('\n');
}

function isAlive(sub: SubdomainInfo): boolean {
  const d = sub.dns;
  if (d && (arr(d.a).length || arr(d.aaaa).length || arr(d.cname).length)) return true;
  return Boolean(sub.http && typeof sub.http.status === 'number' && sub.http.status > 0);
}

function httpText(sub: SubdomainInfo): string {
  const h = sub.http;
  if (!h) return 'not probed';
  if (!(typeof h.status === 'number' && h.status > 0)) return 'unreachable';
  let out = String(h.status);
  const title = str(h.title).replace(/[\r\n]+/g, ' ').trim();
  if (title) out += ` · ${escapeMarkdown(truncate(title, 150))}`;
  const finalHost = hostOf(str(h.finalUrl));
  if (finalHost && finalHost !== sub.host) out += ` → ${escapeMarkdown(truncate(finalHost, 150))}`;
  return out;
}

function renderSubdomains(watch: Watch, a: SubdomainAlert): Rendered {
  const seen = new Set<string>();
  const subs: SubdomainInfo[] = [];
  for (const s of arr(a.subdomains)) {
    const host = str(s?.host).trim().toLowerCase();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    subs.push({ ...s, host });
  }
  const n = subs.length;
  const live = a.kind === 'subdomain_live';
  const list = inlineList(
    subs.map((s) => s.host),
    CONTENT_ITEMS,
    CONTENT_BUDGET - 120,
  );
  const content = live
    ? `🟣 ${n === 1 ? 'Subdomain' : 'Subdomains'} went live: ${list}`
    : `🛰️ New ${plural(n, 'subdomain')} on ${bold(str(a.rootDomain) || watch.rootDomain)}: ${list}`;
  const color = live ? ALERT_COLORS.subdomain_live : ALERT_COLORS.subdomain;

  const detailed = n <= MAX_SUBDOMAIN_EMBEDS ? subs : subs.slice(0, MAX_SUBDOMAIN_EMBEDS - 1);
  const watchHost = str(watch.host).toLowerCase();
  /** Not worth a "Watch" button: the watched site itself, its www twin, or a host that just redirects to it. */
  const isWatchedSite = (s: SubdomainInfo) =>
    s.host === watchHost || s.host === `www.${watchHost}` || `www.${s.host}` === watchHost || hostOf(str(s.http?.finalUrl)) === watchHost;
  const blocks: Block[] = detailed.map((s) => ({
    embed: {
      title: escapeMarkdown(truncate(s.host, 250)),
      // Always the host itself: subdomains redirecting to one page must not share an embed url (Discord merges those).
      url: safeHttpUrl(`https://${s.host}/`),
      color,
      fields: [
        { name: 'Found via', value: sourcesText(s.sources), inline: true },
        { name: 'DNS', value: dnsText(s.dns), inline: true },
        { name: 'HTTP', value: httpText(s), inline: true },
      ],
    },
    buttonHost: isAlive(s) && !isWatchedSite(s) ? s.host : undefined,
  }));
  const rest = subs.slice(detailed.length);
  if (rest.length) {
    const lines = rest.map((s) => `• ${codeSpan(s.host, 120)}${isAlive(s) ? ' 🟢' : ''} · ${sourcesText(s.sources)}`);
    blocks.push({
      embed: { title: `…and ${rest.length} more`, color, description: lineList(lines, 200, LIST_DESC_BUDGET) },
    });
  }
  if (!blocks.length) blocks.push({ embed: { color, description: 'No details available.' } });
  return { content, blocks };
}

function renderFiles(watch: Watch, a: FileAlert): Rendered {
  const files = arr(a.files).filter((f) => f && f.url);
  const n = files.length;
  const all = (c: string) => n > 0 && files.every((f) => f.change === c);
  const what = all('added')
    ? `new ${plural(n, 'file')}`
    : all('removed')
      ? `${plural(n, 'file')} removed`
      : `${plural(n, 'file')} changed`;
  const names = files.map((f) => urlFilename(f.url) || shortUrl(f.url, watch));
  const lines = files.map((f, i) => {
    let change: string;
    if (f.change === 'modified') change = `modified (${formatBytes(f.oldSize)} → ${formatBytes(f.newSize)})`;
    else if (f.change === 'added') change = f.newSize !== null && f.newSize !== undefined ? `added (${formatBytes(f.newSize)})` : 'added';
    else if (f.change === 'removed') change = 'removed';
    else change = escapeMarkdown(str(f.change) || 'changed');
    return `• ${mdLink(escapeMarkdown(truncate(names[i], 120)), f.url)} — ${change}`;
  });
  return {
    content: `📄 ${bold(watch.name)} ${what}: ${inlineList(names, CONTENT_ITEMS, CONTENT_BUDGET - 80)}`,
    blocks: [
      {
        embed: {
          title: `${n} ${what}`,
          color: ALERT_COLORS.file,
          description: lineList(lines, 50, LIST_DESC_BUDGET),
        },
      },
    ],
  };
}

function renderStatus(watch: Watch, a: StatusAlert): Rendered {
  const url = str(a.url) || watch.url;
  const host = hostOf(url) || watch.host;
  const detail = str(a.detail).replace(/[\r\n]+/g, ' ').trim();
  const link = mdLink(escapeMarkdown(truncate(displayUrl(url), 200)), url);
  if (!a.up) {
    return {
      content: `🔴 ${bold(host)} is DOWN${detail ? ` (${escapeMarkdown(truncate(detail, 200))})` : ''}`,
      blocks: [
        {
          embed: {
            title: `${escapeMarkdown(truncate(host, 200))} is down`,
            url,
            color: ALERT_COLORS.statusDown,
            description: `${link}\n**Error:** ${detail ? escapeMarkdown(truncate(detail, 1000)) : 'unknown'}`,
          },
        },
      ],
    };
  }
  const down = typeof a.downForMs === 'number' && Number.isFinite(a.downForMs) && a.downForMs >= 0 ? formatDuration(a.downForMs) : null;
  const lines = [link];
  if (down) lines.push(`**Downtime:** ${down}`);
  if (detail) lines.push(escapeMarkdown(truncate(detail, 1000)));
  return {
    content: `🟢 ${bold(host)} is back UP${down ? ` (was down ${down})` : ''}`,
    blocks: [
      {
        embed: {
          title: `${escapeMarkdown(truncate(host, 200))} is back up`,
          url,
          color: ALERT_COLORS.statusUp,
          description: lines.join('\n'),
        },
      },
    ],
  };
}

function renderInfo(watch: Watch, a: InfoAlert): Rendered {
  // Info messages embed site-controlled paths and hosts, so they are escaped like any other user text. A message that
  // starts with its own ℹ️/⚠️ keeps that emoji instead of getting a second one.
  const raw = str(a.message).trim() || '(no details)';
  const lead = /^(ℹ️|ℹ|⚠️|⚠)\s*/u.exec(raw);
  const emoji = lead ? (lead[1].startsWith('⚠') ? '⚠️' : 'ℹ️') : 'ℹ️';
  const message = lead ? raw.slice(lead[0].length) : raw;
  const [firstLine, ...more] = message.split('\n');
  const rest = more.join('\n').trim();
  return {
    content: `${emoji} ${bold(watch.name)}: ${escapeMarkdown(truncate(firstLine.trim() || '(no details)', 400))}`,
    blocks: rest ? [{ embed: { color: ALERT_COLORS.info, description: truncate(escapeMarkdown(rest), LIST_DESC_BUDGET) } }] : [],
  };
}

function render(watch: Watch, alert: Alert): Rendered {
  switch (alert.kind) {
    case 'deploy':
      return renderDeploy(watch, alert);
    case 'text':
      return renderText(watch, alert);
    case 'new_pages':
      return renderNewPages(watch, alert);
    case 'removed_pages':
      return renderRemovedPages(watch, alert);
    case 'subdomain':
    case 'subdomain_live':
      return renderSubdomains(watch, alert);
    case 'file':
      return renderFiles(watch, alert);
    case 'status':
      return renderStatus(watch, alert);
    case 'info':
      return renderInfo(watch, alert);
    default:
      return fallback(watch, alert);
  }
}

function fallback(watch: Watch, alert: unknown): Rendered {
  const kind = str((alert as { kind?: unknown } | null)?.kind) || 'unknown';
  return {
    content: `ℹ️ ${bold(watch.name)}: ${escapeMarkdown(truncate(kind, 40))} change detected (details could not be rendered).`,
    blocks: [{ embed: { color: ALERT_COLORS.info, description: `Change type: ${codeSpan(kind, 40)}` } }],
  };
}

// ---------------------------------------------------------------------------
// Packing into messages
// ---------------------------------------------------------------------------

function buttonRow(watch: Watch, hosts: string[]): APIActionRowComponent<APIButtonComponent> | null {
  const buttons: APIButtonComponent[] = [];
  for (const host of uniq(hosts)) {
    if (buttons.length >= DISCORD_LIMITS.buttonsPerRow) break;
    const customId = `${WATCH_SUB_PREFIX}${watch.id}:${host}`;
    if (customId.length > DISCORD_LIMITS.customId) continue;
    buttons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      label: truncate(`Watch ${host}`, DISCORD_LIMITS.buttonLabel),
      custom_id: customId,
    });
  }
  return buttons.length ? { type: ComponentType.ActionRow, components: buttons } : null;
}

function pack(watch: Watch, r: Rendered, footer: string, timestamp: string): MessagePayload[] {
  const L = DISCORD_LIMITS;
  const payloads: MessagePayload[] = [];
  let embeds: APIEmbed[] = [];
  let hosts: string[] = [];
  let total = 0;
  const flush = () => {
    if (!embeds.length) return;
    const p: MessagePayload = { embeds, allowedMentions: { parse: [] } };
    const row = buttonRow(watch, hosts);
    if (row) p.components = [row];
    payloads.push(p);
    embeds = [];
    hosts = [];
    total = 0;
  };
  for (const block of r.blocks) {
    const e = clampEmbed({ ...block.embed, footer: { text: footer }, timestamp });
    const len = embedLength(e);
    if (embeds.length >= L.embedsPerMessage || (embeds.length > 0 && total + len > L.embedTotal)) flush();
    embeds.push(e);
    total += len;
    if (block.buttonHost) hosts.push(block.buttonHost);
  }
  flush();
  const content = truncateMarkdown(r.content, CONTENT_BUDGET);
  if (payloads.length) payloads[0] = { content, ...payloads[0] };
  else payloads.push({ content, embeds: [], allowedMentions: { parse: [] } });
  return payloads;
}

function pingFor(watch: Watch): { prefix: string; mentions: MessagePayload['allowedMentions'] } | null {
  const role = str(watch.pingRoleId).trim();
  if (!/^\d{5,25}$/.test(role)) return null;
  if (role === str(watch.guildId)) return { prefix: '@everyone ', mentions: { parse: ['everyone'] } };
  return { prefix: `<@&${role}> `, mentions: { roles: [role] } };
}

/** Render a batch of alerts (from one tick) into ordered message payloads. One or more payloads per alert. */
export function formatAlerts(watch: Watch, alerts: Alert[], now?: Date): MessagePayload[] {
  const list = arr(alerts).filter((a) => a && typeof a === 'object');
  if (!list.length || !watch) return [];
  const date = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const timestamp = date.toISOString();
  // Well under the 2048 limit: the footer counts toward every embed's share of the 6000-char message budget.
  const footer = truncate(`${truncate(str(watch.name), 100) || '?'} · ${truncate(str(watch.host), 150)}`, FOOTER_CHARS);

  const payloads: MessagePayload[] = [];
  for (const alert of list) {
    let rendered: Rendered;
    try {
      rendered = render(watch, alert);
    } catch {
      rendered = fallback(watch, alert);
    }
    try {
      payloads.push(...pack(watch, rendered, footer, timestamp));
    } catch {
      payloads.push(...pack(watch, fallback(watch, alert), footer, timestamp));
    }
  }

  const ping = pingFor(watch);
  if (ping && payloads.length) {
    const first = payloads[0];
    first.content = truncate(ping.prefix + str(first.content), DISCORD_LIMITS.content);
    first.allowedMentions = ping.mentions;
  }
  return payloads;
}
