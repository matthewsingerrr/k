/**
 * Slash commands + the shared building blocks the dashboard (panel.ts) reuses.
 *
 * Registered commands (default_member_permissions = ManageGuild, guild-only):
 *   /panel  → post the Site Watcher dashboard in this channel (deps.panel.placePanel) and reply ephemerally with its link.
 *             Everything else — pause/resume, settings, checks on/off, ignore/skip rules, extra pages, pages, subdomains,
 *             history and site details — lives on the dashboard (buttons, selects and modals; see panel.ts).
 *   /watch add     url(req) name channel interval ping → validate, reject duplicates / over-limit, create, defer (public),
 *                  run the silent baseline (bounded by REPLY_DEADLINE_MS), edit the reply with a summary, then start the watch.
 *   /watch remove  site(req, autocomplete) → store.deleteWatch + monitor.onWatchRemoved.
 *   /watch check   site(req, autocomplete) full:bool → defer (ephemeral), monitor.checkNow, report.
 *   /watch list    → public embed listing the server's watches.
 *   /watch help    → ephemeral help.
 *   /link create|list|revoke → API tokens for the browser extension / other bots (see link.ts; routed to handleLinkCommand).
 * Autocomplete for `site`: guild watches filtered by id/name/host, ≤ 25 choices "name — host", value = String(id).
 * Autocomplete for `/link revoke label` → handleLinkAutocomplete.
 * Errors → ephemeral "⚠️ <message>" (stack logged unless it is a UserError). Mutating commands re-check Manage Server.
 *
 * Buttons: `watchsub:<watchId>:<host>` (from subdomain alerts) → watch that subdomain as its own site (Manage Server).
 *
 * Implementation notes:
 * - Duplicate checks and inserts happen synchronously (no await in between) BEFORE deferring, so a double-submitted command,
 *   modal or double-clicked button can never create two watches.
 * - User-supplied regexes run against every page on every sweep: nested quantifiers ("(a+)+") and patterns that are slow on
 *   adversarial input are rejected, and so are patterns that would blank out all text / exclude every URL.
 * - A second watch on a root domain whose subdomains another watch already scans gets subdomains off by default, is warned
 *   about duplicate redeploy/uptime alerts for the same host, and is named after its subdomain or first path segment.
 * - Replies never wait on a scan longer than the interaction token lives (15 min): after REPLY_DEADLINE_MS the reply says the
 *   scan is still running and the watch starts by itself when it finishes.
 */

import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIEmbedField,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type RepliableInteraction,
  type SlashCommandStringOption,
} from 'discord.js';
import vm from 'node:vm';
import { parse as parseDomain } from 'tldts';
import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import type { BaselineSummary, Monitor } from '../monitor/scheduler.js';
import { isWalledOff } from '../monitor/status.js';
import type { AlertKind, Logger, Watch, WatchFeatures, WatchState } from '../types.js';
import { compileUrlPattern, isPathGlob, isUnderDomain, normalizeUrl, parseWatchInput, urlPath, type ParsedWatchInput } from '../extract/url.js';
import { ALERT_COLORS, WATCH_SUB_PREFIX, clampEmbed, codeSpan, escapeMarkdown, formatDuration, truncate } from './format.js';
import { LINK_COMMAND_NAME, handleLinkAutocomplete, handleLinkCommand, linkCommandDefinition } from './link.js';
import type { PanelHost } from './panel.js';

export interface CommandDeps {
  store: Store;
  monitor: Monitor;
  config: Config;
  log: Logger;
  /** Owner of the persistent dashboard message (null/absent until it is available). */
  panel?: PanelHost | null;
}

export const COMMAND_NAME = 'watch';
export const PANEL_COMMAND_NAME = 'panel';
export const MAX_INTERVAL_SEC = 3600;
export const SWEEP_MIN_SEC = 30;
export const SWEEP_MAX_SEC = 86_400;
export const MAX_PAGES_LIMIT = 1000;
export const MAX_NAME_CHARS = 100;
export const MAX_PATTERN_CHARS = 300;
export const MAX_PATTERNS = 25;
export const MAX_EXTRA_URLS = 50;
export const MAX_SCOPE_CHARS = 200;
const PAGES_LISTED = 40;
const SUBDOMAINS_LISTED = 60;
const EPHEMERAL = MessageFlags.Ephemeral;
export const NO_MENTIONS = { parse: [] as never[] };
/** Interaction tokens expire after 15 minutes: reply before that even if a scan is still running. */
export const REPLY_DEADLINE_MS = 13 * 60_000;
/** Discord error codes meaning "the bot can't see / post in that channel". */
const ACCESS_ERROR_CODES = new Set([10003, 50001, 50013]);

/** Human labels for alert kinds in replies. */
const KIND_LABEL: Record<AlertKind, string> = {
  deploy: 'redeploy',
  text: 'text changes',
  new_pages: 'new pages',
  removed_pages: 'removed pages',
  subdomain: 'new subdomains',
  subdomain_live: 'subdomains live',
  file: 'files',
  status: 'uptime',
  info: 'notes',
};

const KIND_EMOJI: Record<AlertKind, string> = {
  deploy: '🌐',
  text: '📝',
  new_pages: '🆕',
  removed_pages: '🗑️',
  subdomain: '🛰️',
  subdomain_live: '🟣',
  file: '📄',
  status: '🚦',
  info: 'ℹ️',
};

/** Resolves with the promise's value, or `{ done: false }` once `ms` passed first (the promise keeps running). */
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.then((value) => ({ done: true as const, value })), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A problem with the user's input: shown as "⚠️ <message>" without logging a stack. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** A UserError about one entry of a list the user entered (`index` into that list; null = the list as a whole). */
export class ListEntryError extends UserError {
  constructor(
    message: string,
    readonly index: number | null,
  ) {
    super(message);
    this.name = 'ListEntryError';
  }
}

/** The server already watches its maximum number of sites (MAX_WATCHES_PER_GUILD). */
export class WatchLimitError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = 'WatchLimitError';
  }
}

const UNKNOWN_SITE = 'Unknown site. Use /watch list.';
export const NEED_MANAGE = 'You need the **Manage Server** permission to do that.';

/** Subcommands that change state (or trigger network work) and so require Manage Server. */
const PRIVILEGED = new Set(['add', 'remove', 'check']);

/** Feature flags in display order: [key, label]. */
const FEATURES: ReadonlyArray<readonly [keyof WatchFeatures, string]> = [
  ['deploy', 'redeploys'],
  ['text', 'text changes'],
  ['pages', 'new/removed pages'],
  ['subdomains', 'subdomains'],
  ['files', 'files'],
  ['status', 'uptime'],
  ['codeIntel', 'code intel'],
];

export type ToggleKey = keyof WatchFeatures | 'maskNumbers';

/** Every on/off switch of a watch (the dashboard's 🧩 Features view), in display order. */
export const FEATURE_TOGGLES: ReadonlyArray<{ key: ToggleKey; label: string; emoji: string; hint: string }> = [
  { key: 'deploy', label: 'Redeploys', emoji: '🌐', hint: 'new JS/CSS bundles or build id' },
  { key: 'text', label: 'Text changes', emoji: '📝', hint: 'visible text on tracked pages, with a diff' },
  { key: 'pages', label: 'New pages', emoji: '🆕', hint: 'pages added or removed (links, sitemap, code)' },
  { key: 'subdomains', label: 'Subdomains', emoji: '🛰️', hint: 'new subdomains (certificate logs, DNS, code)' },
  { key: 'files', label: 'Files', emoji: '📄', hint: 'linked PDFs, docs, markdown…' },
  { key: 'status', label: 'Uptime', emoji: '🚦', hint: 'site goes down / comes back up' },
  { key: 'codeIntel', label: 'Code intel', emoji: '🔎', hint: 'new routes and hosts in freshly deployed code' },
  { key: 'maskNumbers', label: 'Ignore numbers', emoji: '🔢', hint: 'ignore changes that only touch numbers' },
];

export function toggleValue(w: Watch, key: ToggleKey): boolean {
  return key === 'maskNumbers' ? w.maskNumbers : Boolean(w.features[key]);
}

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Smallest allowed check interval (config.minIntervalSec, kept within 1..MAX_INTERVAL_SEC). */
export function minInterval(config: Pick<Config, 'minIntervalSec'>): number {
  return clampInt(config?.minIntervalSec, 1, MAX_INTERVAL_SEC, 10);
}

/** Check interval of a new watch when none is given. */
export function defaultInterval(config: Pick<Config, 'minIntervalSec' | 'defaultIntervalSec'>): number {
  return Math.min(MAX_INTERVAL_SEC, Math.max(clampInt(config?.defaultIntervalSec, 1, MAX_INTERVAL_SEC, 30), minInterval(config)));
}

const siteOption = (o: SlashCommandStringOption) =>
  o.setName('site').setDescription('Watched site (pick from the list, or type its name, id or URL)').setRequired(true).setAutocomplete(true).setMaxLength(200);

/** JSON bodies for command registration: `/watch`, `/panel` and `/link`. */
export function commandDefinitions(config: Pick<Config, 'minIntervalSec'>): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const minInt = minInterval(config);
  const watch = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription('Watch websites for redeploys, text changes, new pages, subdomains and downtime')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Start watching a website')
        .addStringOption((o) => o.setName('url').setDescription('Site URL, e.g. unpeg.io or https://unpeg.io/docs').setRequired(true).setMaxLength(2000))
        .addStringOption((o) => o.setName('name').setDescription('Display name (default: from the domain)').setMaxLength(MAX_NAME_CHARS))
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Channel for alerts (default: this channel)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addIntegerOption((o) =>
          o.setName('interval').setDescription(`Seconds between homepage checks (${minInt}-${MAX_INTERVAL_SEC})`).setMinValue(minInt).setMaxValue(MAX_INTERVAL_SEC),
        )
        .addRoleOption((o) => o.setName('ping').setDescription('Role to ping on alerts')),
    )
    .addSubcommand((s) => s.setName('remove').setDescription('Stop watching a site').addStringOption(siteOption))
    .addSubcommand((s) =>
      s
        .setName('check')
        .setDescription('Check a site right now')
        .addStringOption(siteOption)
        .addBooleanOption((o) => o.setName('full').setDescription('Re-check every tracked page, not just the homepage')),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List watched sites in this server'))
    .addSubcommand((s) => s.setName('help').setDescription('What this bot detects and how to use it'));
  const panel = new SlashCommandBuilder()
    .setName(PANEL_COMMAND_NAME)
    .setDescription('Post the Site Watcher dashboard in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .setDMPermission(false);
  return [watch.toJSON(), panel.toJSON(), linkCommandDefinition()];
}

// ---------------------------------------------------------------------------
// Shared helpers (also used by the dashboard)
// ---------------------------------------------------------------------------

export type Repliable = RepliableInteraction;
export type ActionRow = APIActionRowComponent<APIComponentInMessageActionRow>;
export interface Body {
  content?: string;
  embeds?: APIEmbed[];
  components?: ActionRow[];
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function errorCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

/** Send (or update) the interaction response; never throws (the interaction may have expired). */
export async function respond(i: Repliable, body: Body, ephemeral: boolean, log: Logger): Promise<void> {
  const embeds = body.embeds?.map(clampEmbed);
  const content = body.content !== undefined ? truncate(body.content, 2000) : undefined;
  const components = body.components;
  try {
    if (i.deferred) {
      await i.editReply({ content: content ?? '', embeds: embeds ?? [], components: components ?? [], allowedMentions: NO_MENTIONS });
    } else if (i.replied) {
      await i.followUp({ content, embeds, components, allowedMentions: NO_MENTIONS, ...(ephemeral ? { flags: EPHEMERAL } : {}) });
    } else {
      await i.reply({ content, embeds, components, allowedMentions: NO_MENTIONS, ...(ephemeral ? { flags: EPHEMERAL } : {}) });
    }
  } catch (err) {
    log.warn('failed to respond to interaction', { err: errMessage(err) });
  }
}

export async function defer(i: Repliable, ephemeral: boolean, log: Logger): Promise<void> {
  if (i.deferred || i.replied) return;
  try {
    await i.deferReply(ephemeral ? { flags: EPHEMERAL } : {});
  } catch (err) {
    log.warn('deferReply failed', { err: errMessage(err) });
  }
}

export async function replyError(i: Repliable, err: unknown, log: Logger, what: string): Promise<void> {
  if (!(err instanceof UserError)) log.error(`${what} failed`, { err: err instanceof Error ? err : String(err) });
  await respond(i, { content: `⚠️ ${truncate(errMessage(err), 1900)}` }, true, log);
}

export function hasManageGuild(i: Pick<Repliable, 'memberPermissions'>): boolean {
  try {
    return Boolean(i.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
  } catch {
    return false;
  }
}

/** Throws a friendly UserError unless the member has Manage Server. */
export function requireManageGuild(i: Pick<Repliable, 'memberPermissions'>): void {
  if (!hasManageGuild(i)) throw new UserError(NEED_MANAGE);
}

export function channelMention(id: string): string {
  return /^\d{5,25}$/.test(id) ? `<#${id}>` : `\`${id}\``;
}

export function roleMention(id: string | null, guildId: string): string {
  if (!id) return 'none';
  return id === guildId ? '@everyone' : `<@&${id}>`;
}

function unix(ms: number): number {
  return Math.floor(ms / 1000);
}

export function when(ms: number | null | undefined): string {
  return typeof ms === 'number' && ms > 0 ? `<t:${unix(ms)}:R>` : 'never';
}

/** Escaped single-line display name. */
export function nameOf(w: Pick<Watch, 'name'>, max = MAX_NAME_CHARS): string {
  return escapeMarkdown(truncate(w.name.replace(/[\r\n]+/g, ' '), max));
}

export function featureSummary(f: WatchFeatures): string {
  const on = FEATURES.filter(([k]) => f[k]).map(([, label]) => label);
  if (on.length === FEATURES.length) return 'all checks';
  return on.length ? on.join(', ') : 'nothing (all checks off)';
}

/** Newline-joined lines within `budget` chars and `max` items; overflow becomes "…and N more". */
export function linesWithin(lines: string[], max: number, budget: number, more = (n: number) => `…and ${n} more`): string {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (out.length >= max) break;
    const add = line.length + (out.length ? 1 : 0);
    if (used + add > budget - 40) break;
    out.push(line);
    used += add;
  }
  const rest = lines.length - out.length;
  if (rest > 0) out.push(more(rest));
  return out.join('\n');
}

function resolveSite(i: ChatInputCommandInteraction, deps: CommandDeps, guildId: string): Watch {
  const raw = i.options.getString('site', true);
  const w = deps.store.findWatch(guildId, raw);
  if (!w || w.guildId !== guildId) throw new UserError(UNKNOWN_SITE);
  return w;
}

/** Trimmed single-line display name; rejects empty and number-only names (those would be read as watch ids). */
export function cleanName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) throw new UserError('The name cannot be empty.');
  if (name.length > MAX_NAME_CHARS) throw new UserError(`The name is too long (max ${MAX_NAME_CHARS} characters).`);
  if (/^#?\d+$/.test(name)) throw new UserError('The name cannot be just a number (numbers are used as watch ids).');
  return name;
}

export function nameTaken(deps: Pick<CommandDeps, 'store'>, guildId: string, name: string, exceptId?: number): boolean {
  const lower = name.toLowerCase();
  return deps.store.listWatches(guildId).some((w) => w.id !== exceptId && w.name.trim().toLowerCase() === lower);
}

function uniqueName(deps: Pick<CommandDeps, 'store'>, guildId: string, base: string): string {
  const clean = truncate(base, MAX_NAME_CHARS - 4);
  if (!nameTaken(deps, guildId, clean)) return clean;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${clean} ${n}`;
    if (!nameTaken(deps, guildId, candidate)) return candidate;
  }
  return `${clean} ${Date.now()}`;
}

/**
 * Path-prefix scope: undefined = not given, null = whole site. Accepts "/docs", "docs/", or a full URL (its path is used).
 */
export function parseScope(raw: string | null | undefined): string | null | undefined {
  if (raw === null || raw === undefined) return undefined;
  let v = raw.trim();
  if (!v || v === '/' || /^(none|off|all)$/i.test(v)) return null;
  if (/^https?:\/\//i.test(v)) {
    try {
      v = new URL(v).pathname;
    } catch {
      throw new UserError('The scope must be a path prefix like `/docs`.');
    }
  }
  if (v.length > MAX_SCOPE_CHARS || /[\s?#]/.test(v)) throw new UserError('The scope must be a path prefix like `/docs`.');
  if (!v.startsWith('/')) v = '/' + v;
  v = v.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return v || null;
}

/**
 * Heuristic for catastrophic backtracking: a group containing an unbounded or repeated quantifier that is itself quantified
 * ("(a+)+", "(\w*)*", "(?:x{2,})+"). Not a full analysis — it catches the common ReDoS shape without false positives on
 * ordinary patterns.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  const stack: boolean[] = [];
  let inner = false; // current group contains a quantifier
  const quantAt = (idx: number): number => {
    const c = pattern[idx];
    if (c === '*' || c === '+') return 1;
    if (c === '{') {
      const m = /^\{\d+(,\d*)?\}/.exec(pattern.slice(idx));
      if (m) return m[0].length;
    }
    return 0;
  };
  for (let idx = 0; idx < pattern.length; idx++) {
    const c = pattern[idx];
    if (c === '\\') {
      idx++;
      continue;
    }
    if (c === '[') {
      // Skip a character class.
      idx++;
      if (pattern[idx] === '^') idx++;
      if (pattern[idx] === ']') idx++;
      while (idx < pattern.length && pattern[idx] !== ']') {
        if (pattern[idx] === '\\') idx++;
        idx++;
      }
      continue;
    }
    if (c === '(') {
      stack.push(inner);
      inner = false;
      continue;
    }
    if (c === ')') {
      const groupHadQuantifier = inner;
      inner = stack.pop() ?? false;
      const q = quantAt(idx + 1);
      if (q && groupHadQuantifier) return true;
      if (q || groupHadQuantifier) inner = true;
      if (q) idx += q;
      continue;
    }
    if (quantAt(idx)) inner = true;
  }
  return false;
}

const BROAD_SAMPLE = 'The quick brown fox jumps over the lazy dog 1234567890';

/** Total time a pattern may take on the adversarial probe inputs below. Sane patterns need well under 10ms. */
const REGEX_PROBE_TIMEOUT_MS = 200;
const REGEX_PROBE_INPUTS: readonly string[] = (() => {
  const n = 5000;
  return [
    'a'.repeat(n) + '!',
    'x'.repeat(n),
    '0'.repeat(n) + 'x',
    ' a'.repeat(n / 2) + '!',
    'ab'.repeat(n / 2),
    'aA1 -_.:/'.repeat(n / 10),
    'https://unpeg.io/' + 'a/'.repeat(n / 2) + '?',
    'Last updated 5 minutes ago · $1,234.56 · Docs '.repeat(n / 50),
  ];
})();

/**
 * Whether a regex finishes quickly on adversarial inputs (long runs of one character, near-misses, URL-ish and page-ish
 * text). Runs inside a vm context with a timeout, because only the vm watchdog can interrupt a runaway regex; this catches
 * catastrophic patterns the static check misses (e.g. "(a|a)*$", "a*a*a*b").
 */
export function regexIsFast(source: string, flags: string, timeoutMs = REGEX_PROBE_TIMEOUT_MS): boolean {
  try {
    const context = vm.createContext({ source, flags, inputs: REGEX_PROBE_INPUTS });
    vm.runInContext(
      'for (const s of inputs) { const re = new RegExp(source, flags); s.replace(re, ""); re.lastIndex = 0; re.test(s); }',
      context,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate an ignore (text) or exclude (URL) regex: syntax, ReDoS shape, speed on adversarial input, and not so broad that it
 * would blank out all text / exclude every URL. Returns the trimmed pattern.
 */
export function validatePattern(pattern: string, kind: 'ignore' | 'exclude'): string {
  const p = pattern.trim();
  if (!p) throw new UserError('The pattern cannot be empty.');
  if (p.length > MAX_PATTERN_CHARS) throw new UserError(`The pattern is too long (max ${MAX_PATTERN_CHARS} characters).`);
  let re: RegExp;
  try {
    re = kind === 'exclude' && isPathGlob(p) ? (compileUrlPattern(p) as RegExp) : new RegExp(p, kind === 'ignore' ? 'gi' : 'i');
  } catch (err) {
    throw new UserError(`Invalid regex: ${errMessage(err).replace(/^Invalid regular expression: /, '')}`);
  }
  const glob = kind === 'exclude' && isPathGlob(p); // globs compile to simple, linear regexes
  if (!glob && hasNestedQuantifier(p)) {
    throw new UserError('That pattern has nested repetition like `(a+)+`, which can freeze the bot on some pages. Please simplify it.');
  }
  if (!glob && !regexIsFast(p, re.flags)) {
    throw new UserError('That pattern is too slow on long pages (catastrophic backtracking). Please simplify it.');
  }
  if (kind === 'ignore') {
    re.lastIndex = 0;
    const m = re.exec(BROAD_SAMPLE);
    if (m && m[0].length >= BROAD_SAMPLE.length) {
      throw new UserError('That pattern matches whole lines of any text, so every change would be ignored. Make it more specific.');
    }
  } else if (re.test('https://example.com/') && re.test('https://unrelated.org/docs/page')) {
    throw new UserError('That pattern matches every URL, so nothing would be tracked. Make it more specific.');
  }
  return p;
}

/**
 * Validate an edited pattern list (the 🚫 Rules modal, the Link API): at most MAX_PATTERNS entries, and every entry that is
 * not in `current` passes validatePattern (existing entries were validated when they were added). Throws ListEntryError
 * with the failing entry's index in `next` (null when the list is too long).
 */
export function validateNewPatterns(next: string[], current: string[], kind: 'ignore' | 'exclude'): void {
  const what = kind === 'ignore' ? 'ignore' : 'skip-URL';
  if (next.length > MAX_PATTERNS) throw new ListEntryError(`At most ${MAX_PATTERNS} ${what} patterns per site (you entered ${next.length}).`, null);
  for (let n = 0; n < next.length; n++) {
    const p = next[n];
    if (current.includes(p)) continue; // validated when it was added
    try {
      validatePattern(p, kind);
    } catch (err) {
      if (err instanceof UserError) throw new ListEntryError(`${kind === 'ignore' ? 'Ignore' : 'Skip-URL'} pattern ${codeSpan(p, 100)}: ${err.message}`, n);
      throw err;
    }
  }
}

/**
 * Resolve an edited extra-pages list (one entry per line) against the watch (resolvePageUrl), de-duplicated, at most
 * MAX_EXTRA_URLS. `check(url, index)` may throw to refuse a resolved URL. Throws ListEntryError with the failing entry's
 * index (null when the list is too long).
 */
export function resolveExtraPages(
  lines: string[],
  watch: Pick<Watch, 'url' | 'host' | 'rootDomain'>,
  check?: (url: string, index: number) => void,
): string[] {
  const extra: string[] = [];
  for (let n = 0; n < lines.length; n++) {
    const url = resolvePageUrl(lines[n], watch);
    if (!url) throw new ListEntryError(`${codeSpan(lines[n], 100)} is not a valid http(s) URL or path.`, n);
    check?.(url, n);
    if (!extra.includes(url)) extra.push(url);
  }
  if (extra.length > MAX_EXTRA_URLS) throw new ListEntryError(`At most ${MAX_EXTRA_URLS} extra pages per site (you entered ${extra.length}).`, null);
  return extra;
}

/**
 * Resolve an extra-page URL: absolute http(s) URLs as-is, "unpeg.io/x"-style inputs whose host is (under) the watched domain or
 * a real public domain followed by a path, anything else relative to the watch URL. Returns a normalized URL or null.
 */
export function resolvePageUrl(raw: string, watch: Pick<Watch, 'url' | 'host' | 'rootDomain'>): string | null {
  let s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  if (!s || /\s/.test(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:]+:\d/.test(s)) {
    return /^https?:\/\//i.test(s) ? normalizeUrl(s) : null;
  }
  if (s.startsWith('//')) return normalizeUrl('https:' + s);
  if (!/^[./?#]/.test(s)) {
    const first = s.split(/[/?#]/)[0].toLowerCase();
    const host = first.replace(/:\d+$/, '');
    if (host.includes('.')) {
      let absolute = host === watch.host || isUnderDomain(host, watch.rootDomain);
      if (!absolute && s.length > first.length) {
        try {
          const info = parseDomain(host, { allowPrivateDomains: true });
          absolute = Boolean(info.domain && (info.isIcann || info.isPrivate));
        } catch {
          absolute = false;
        }
      }
      if (absolute) return normalizeUrl('https://' + s);
    }
  }
  return normalizeUrl(s, watch.url);
}

/** Missing bot permissions in a channel (best effort: empty when it can't be determined). */
export function missingChannelPerms(i: Pick<Repliable, 'guild'>, channelId: string): string[] {
  try {
    const guild = i.guild;
    const me = guild?.members?.me;
    const cache = guild?.channels?.cache;
    // The Guilds intent keeps every channel cached: a channel missing from a populated cache was deleted.
    if (cache && typeof cache.get === 'function' && cache.size > 0 && !cache.get(channelId)) return ['channel not found'];
    const channel = cache?.get(channelId);
    if (!me || !channel || typeof channel.permissionsFor !== 'function') return [];
    const perms = channel.permissionsFor(me);
    if (!perms) return [];
    const needed: Array<[bigint, string]> = [
      [PermissionFlagsBits.ViewChannel, 'View Channel'],
      [channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages, 'Send Messages'],
      [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
    ];
    return needed.filter(([flag]) => !perms.has(flag)).map(([, label]) => label);
  } catch {
    return [];
  }
}

/** A warning line when the bot can't deliver alerts to `channelId`, else null. */
export function permsWarning(i: Pick<Repliable, 'guild'> | undefined, channelId: string): string | null {
  if (!i) return null;
  const missing = missingChannelPerms(i, channelId);
  if (missing.includes('channel not found')) {
    return `⚠️ The alert channel ${channelMention(channelId)} no longer exists — alerts can't be delivered. Pick another one under ⚙️ Settings on the dashboard.`;
  }
  return missing.length
    ? `⚠️ I'm missing **${missing.join(', ')}** in ${channelMention(channelId)} — alerts can't be delivered until that's fixed.`
    : null;
}

function shortBuild(id: string | null): string | null {
  if (!id) return null;
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function baselineLines(watch: Watch, summary: BaselineSummary | null, error: string | null): string[] {
  const lines: string[] = [];
  if (summary) {
    const parts = [
      `${summary.pagesTracked} ${summary.pagesTracked === 1 ? 'page' : 'pages'}`,
      `${summary.files} ${summary.files === 1 ? 'file' : 'files'}`,
    ];
    if (watch.features.subdomains) parts.push(`${summary.subdomains} ${summary.subdomains === 1 ? 'subdomain' : 'subdomains'}`);
    const build = shortBuild(summary.buildId);
    if (build) parts.push(`build ${codeSpan(build, 20)}`);
    else if (summary.assets) parts.push(`${summary.assets} bundles`);
    lines.push(`Baseline: ${parts.join(', ')} (took ${formatDuration(summary.durationMs)}).`);
    if (summary.pagesKnown > summary.pagesTracked) lines.push(`${summary.pagesKnown} URLs known in total.`);
    const redirect = summary.redirectedTo;
    if (redirect?.adopted) {
      lines.push(`↪️ ${escapeMarkdown(redirect.from)} redirects to **${escapeMarkdown(redirect.to)}** — watching that.`);
    } else if (redirect) {
      lines.push(
        `⚠️ ${escapeMarkdown(redirect.from)} redirects to ${escapeMarkdown(redirect.to)} (another domain) — only the start page can be checked. Add that site instead to watch it.`,
      );
    }
    if (summary.homeBlocked) {
      lines.push(
        `⚠️ The site shows a bot challenge to the watcher (HTTP ${summary.homeStatus || '?'}) — nothing can be checked until it stops. You'll get a note here if that persists.`,
      );
    } else if (summary.homeStatus === 429) {
      lines.push("⚠️ The site is rate-limiting the watcher (HTTP 429) — the first scan is retried when it lets up.");
    } else if (!summary.homeStatus) {
      lines.push("⚠️ The homepage was unreachable — I'll keep checking and alert when it comes up.");
    } else if (summary.homeStatus >= 400) {
      lines.push(`⚠️ The homepage returned HTTP ${summary.homeStatus} — I'll keep checking.`);
    }
  } else if (error) {
    lines.push(`⚠️ The first scan failed (${truncate(error, 300)}) — it will be retried automatically.`);
  }
  return lines;
}

/** Cert Spotter without an API key shares its hourly quota with every other client on the host's IP. */
export function ctNote(deps: Pick<CommandDeps, 'store' | 'config'>): string {
  if (deps.config.certspotterApiKey) return '';
  const n = deps.store.listWatches().filter((w) => w.features.subdomains && !w.paused).length;
  return n > 2 ? `\n⚠️ ${n} sites share one Certificate Transparency quota (no CERTSPOTTER_API_KEY): new names can take a while.` : '';
}

function storageWarning(config: Config): string | null {
  return config.dataDirPersistent
    ? null
    : '⚠️ Storage is not persistent: watches and history will be lost on every redeploy. Attach a Railway volume and set `DATA_DIR` to its mount path.';
}

async function baselineAndStart(deps: CommandDeps, watch: Watch): Promise<{ summary: BaselineSummary | null; error: string | null }> {
  try {
    return { summary: await deps.monitor.runBaseline(watch.id), error: null };
  } catch (err) {
    deps.log.warn('baseline failed', { watchId: watch.id, err: errMessage(err) });
    return { summary: null, error: errMessage(err) };
  }
}

/** Hand a stored watch to the monitor (after its first scan). Returns the fresh row, or undefined if it was deleted. */
export function startWatch(deps: CommandDeps, watchId: number): Watch | undefined {
  const fresh = deps.store.getWatch(watchId);
  if (!fresh) return undefined;
  try {
    deps.monitor.onWatchAdded(fresh);
  } catch (err) {
    deps.log.error('monitor.onWatchAdded failed', { watchId, err: err instanceof Error ? err : String(err) });
  }
  return fresh;
}

/** Tell the monitor a watch changed (never throws). */
export function notifyUpdated(deps: CommandDeps, watch: Watch): void {
  try {
    deps.monitor.onWatchUpdated(watch);
  } catch (err) {
    deps.log.error('monitor.onWatchUpdated failed', { watchId: watch.id, err: err instanceof Error ? err : String(err) });
  }
}

/** Delete a watch and stop its loops. */
export function removeWatch(deps: CommandDeps, w: Watch, by: string): void {
  deps.store.deleteWatch(w.id);
  try {
    deps.monitor.onWatchRemoved(w.id);
  } catch (err) {
    deps.log.error('monitor.onWatchRemoved failed', { watchId: w.id, err: err instanceof Error ? err : String(err) });
  }
  deps.log.info('watch removed', { watchId: w.id, url: w.url, by });
}

// ---------------------------------------------------------------------------
// Add flow (shared by /watch add and the dashboard's Add site modal)
// ---------------------------------------------------------------------------

/** Throws WatchLimitError when the server already holds the maximum number of watches. */
function checkWatchLimit(deps: Pick<CommandDeps, 'store' | 'config'>, guildId: string): void {
  const max = deps.config.maxWatchesPerGuild;
  if (typeof max === 'number' && max > 0 && deps.store.listWatches(guildId).length >= max) {
    throw new WatchLimitError(`This server already watches ${max} sites (the limit). Remove one first.`);
  }
}

const SUBDOMAIN_HOST_RE = /^[a-z0-9_.-]{1,253}$/;

/**
 * "Watch this subdomain" (the button on subdomain alerts, the Link API): the https://<host>/ target when `rawHost` is a host
 * name under the parent's root domain (lowercased, trailing dots dropped), else null.
 */
export function subdomainTarget(parent: Pick<Watch, 'rootDomain'>, rawHost: string): ParsedWatchInput | null {
  const host = String(rawHost).toLowerCase().replace(/\.+$/, '');
  if (!SUBDOMAIN_HOST_RE.test(host)) return null;
  const parsed = parseWatchInput(`https://${host}/`);
  return parsed && isUnderDomain(parsed.host, parent.rootDomain) ? parsed : null;
}

/**
 * Store a watch for a subdomain the parent found — synchronously, so two clicks can't both pass the duplicate check. It
 * inherits the parent's channel, interval, sweep, max pages, ping role, checks (subdomains off), ignore patterns and
 * "Ignore numbers", named "<parent> (<first label>)". The server's existing watch of https://<host>/ is returned as
 * `created: false`. Throws WatchLimitError at the server's site limit. The caller runs the first scan.
 */
export function addSubdomainWatch(
  deps: Pick<CommandDeps, 'store' | 'config'>,
  parent: Watch,
  target: ParsedWatchInput,
  userId: string,
): { created: boolean; watch: Watch } {
  const { store } = deps;
  const guildId = parent.guildId;
  const existing = store.findWatchByUrl(guildId, `${target.host}/`);
  if (existing) return { created: false, watch: existing };
  checkWatchLimit(deps, guildId);
  const label = target.host.split('.')[0] || target.host;
  const watch = store.createWatch({
    guildId,
    channelId: parent.channelId,
    name: uniqueName(deps, guildId, `${truncate(parent.name, 60)} (${truncate(label, 30)})`),
    url: target.url,
    host: target.host,
    rootDomain: target.rootDomain,
    createdBy: userId,
    intervalSec: parent.intervalSec,
    sweepSec: parent.sweepSec,
    maxPages: parent.maxPages,
    pingRoleId: parent.pingRoleId,
    features: { ...parent.features, subdomains: false },
    ignorePatterns: parent.ignorePatterns,
    maskNumbers: parent.maskNumbers,
  });
  return { created: true, watch };
}

/**
 * A default name that tells a second watch of the same site apart: "Unpeg docs" for docs.unpeg.io or unpeg.io/docs,
 * instead of "Unpeg 2".
 */
export function distinctName(deps: CommandDeps, guildId: string, parsed: { suggestedName: string; host: string; rootDomain: string; url: string }): string {
  const base = parsed.suggestedName;
  if (!nameTaken(deps, guildId, base)) return base;
  let label = '';
  const sub = parsed.host.endsWith(`.${parsed.rootDomain}`) ? parsed.host.slice(0, -parsed.rootDomain.length - 1).split('.')[0] : '';
  if (sub && sub !== 'www') label = sub;
  else {
    try {
      const seg = new URL(parsed.url).pathname.split('/').filter(Boolean)[0] ?? '';
      label = decodeURIComponent(seg).replace(/[-_]+/g, ' ').trim();
    } catch {
      label = '';
    }
  }
  if (label && !/^\d+$/.test(label)) return uniqueName(deps, guildId, `${base} ${truncate(label, 40)}`);
  return uniqueName(deps, guildId, base);
}

export interface AddRequest {
  guildId: string;
  /** Alert channel. */
  channelId: string;
  userId: string;
  url: string;
  name?: string | null;
  intervalSec?: number | null;
  pingRoleId?: string | null;
  subdomains?: boolean | null;
  /** false → only the start URL and extra pages (features.pages off, maxPages 1). */
  crawl?: boolean | null;
  scope?: string | null;
  maxPages?: number | null;
}

export interface PreparedAdd {
  watch: Watch;
  /** Notes for the summary (overlap with other watches of the same site). */
  notes: string[];
}

/**
 * Validate an add request and store the watch — synchronously, so two submissions can't both pass the duplicate check.
 * Throws UserError on bad input, duplicates or the per-server limit.
 */
export function prepareAdd(deps: CommandDeps, req: AddRequest): PreparedAdd {
  const { store, config, log } = deps;
  const { guildId } = req;
  const parsed = parseWatchInput(req.url);
  if (!parsed) {
    throw new UserError(
      `${codeSpan(req.url, 100)} doesn't look like a website URL. Try something like \`unpeg.io\` or \`https://unpeg.io/docs\`.`,
    );
  }
  // Scheme-less lookup: http:// and https:// versions of one URL are the same site.
  const existing = store.findWatchByUrl(guildId, parsed.url.replace(/^https?:\/\//i, ''));
  if (existing) throw new UserError(`Already watching ${existing.url} as **#${existing.id} ${nameOf(existing)}**.`);
  checkWatchLimit(deps, guildId);

  const explicitName = cleanName(req.name ?? null);
  if (explicitName && nameTaken(deps, guildId, explicitName)) {
    throw new UserError(`A site named **${escapeMarkdown(explicitName)}** already exists. Pick another name.`);
  }
  const minInt = minInterval(config);
  const interval = req.intervalSec ?? null;
  if (interval !== null && (!Number.isInteger(interval) || interval < minInt || interval > MAX_INTERVAL_SEC)) {
    throw new UserError(`The check interval must be between ${minInt} and ${MAX_INTERVAL_SEC} seconds.`);
  }
  const maxPages = req.maxPages ?? null;
  if (maxPages !== null && (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_LIMIT)) {
    throw new UserError(`Max pages must be between 1 and ${MAX_PAGES_LIMIT}.`);
  }
  const scopePath = parseScope(req.scope ?? null) ?? null;
  const name = explicitName ?? distinctName(deps, guildId, parsed);

  const features: Partial<WatchFeatures> = {};
  const subdomains = req.subdomains ?? null;
  if (subdomains !== null) features.subdomains = subdomains;
  if (req.crawl === false) features.pages = false;

  // Other watches of the same site: subdomains would be announced twice, and the same host's redeploys/outages too.
  const siblings = store.listWatches(guildId).filter((w) => w.rootDomain === parsed.rootDomain);
  const notes: string[] = [];
  const subdomainOwner = siblings.find((w) => w.features.subdomains);
  if (subdomains === null && subdomainOwner) {
    features.subdomains = false;
    notes.push(
      `Subdomains of ${escapeMarkdown(parsed.rootDomain)} are already tracked by **#${subdomainOwner.id} ${nameOf(subdomainOwner)}** — off here (turn them on under 🧩 Features on the dashboard to override).`,
    );
  }
  const sameHost = siblings.find((w) => w.host === parsed.host);
  if (sameHost) {
    notes.push(
      `Redeploy and uptime alerts for ${escapeMarkdown(parsed.host)} already come from **#${sameHost.id} ${nameOf(sameHost)}** — turn **Redeploys** and **Uptime** off under 🧩 Features on one of them to avoid duplicates${
        sameHost.scopePath ? '' : ', and note that its crawl already covers the whole host unless it is scoped'
      }.`,
    );
  }

  const watch = store.createWatch({
    guildId,
    channelId: req.channelId,
    name,
    url: parsed.url,
    host: parsed.host,
    rootDomain: parsed.rootDomain,
    createdBy: req.userId,
    intervalSec: interval ?? defaultInterval(config),
    maxPages: req.crawl === false ? 1 : (maxPages ?? undefined),
    pingRoleId: req.pingRoleId ?? null,
    features,
    scopePath,
  });
  log.info('watch added', { watchId: watch.id, url: watch.url, guild: guildId, by: req.userId });
  return { watch, notes };
}

/**
 * Run the first (silent) scan of a prepared watch — never longer than the interaction token lives — and send the summary via
 * `send` (which must not throw), then start the watch. `i` is used for channel-permission warnings.
 */
export async function finishAdd(deps: CommandDeps, prepared: PreparedAdd, send: (body: Body) => Promise<void>, i?: Pick<Repliable, 'guild'>): Promise<void> {
  const { store, config } = deps;
  const created = prepared.watch;
  const scan = baselineAndStart(deps, created);
  const timely = await withDeadline(scan, REPLY_DEADLINE_MS);
  if (!timely.done) {
    // The interaction token would expire: say so now; the watch starts by itself once its first scan finishes.
    void scan.then(() => startWatch(deps, created.id));
    await send({
      content: `⏳ Still scanning **${nameOf(created)}** (${created.url}) — the watch is saved and starts when the first scan finishes; follow it on the dashboard.`,
    });
    return;
  }
  const { summary, error } = timely.value;
  const watch = store.getWatch(created.id);
  if (!watch) {
    await send({ content: `⚠️ **${nameOf(created)}** was removed while its first scan was running.` });
    return;
  }

  const lines = [
    `${watch.url} in ${channelMention(watch.channelId)} — every ${watch.intervalSec}s.`,
    ...baselineLines(watch, summary, error),
    `Detecting: ${featureSummary(watch.features)}.`,
    ...prepared.notes,
  ];
  if (watch.scopePath) lines.push(`Scope: ${codeSpan(watch.scopePath, 200)}`);
  if (watch.pingRoleId) lines.push(`Pinging ${roleMention(watch.pingRoleId, watch.guildId)} on alerts.`);
  const perms = permsWarning(i, watch.channelId);
  if (perms) lines.push(perms);
  const storage = storageWarning(config);
  if (storage) lines.push(storage);
  try {
    await send({
      embeds: [
        {
          title: `✅ Watching ${nameOf(watch)}`,
          url: watch.url,
          color: ALERT_COLORS.new_pages,
          description: lines.join('\n'),
          footer: { text: `#${watch.id} · ${watch.host}` },
        },
      ],
    });
  } finally {
    startWatch(deps, watch.id);
  }
}

// ---------------------------------------------------------------------------
// Check (shared by /watch check and the dashboard's ⚡ Check now)
// ---------------------------------------------------------------------------

/** Run a check (bounded by REPLY_DEADLINE_MS) and describe the outcome. Throws if the check itself crashes. */
export async function runCheck(deps: CommandDeps, w: Watch, full: boolean, i?: Pick<Repliable, 'guild'>): Promise<string> {
  const check = deps.monitor.checkNow(w.id, { full });
  const timely = await withDeadline(check, REPLY_DEADLINE_MS);
  if (!timely.done) {
    check.catch((err: unknown) => deps.log.warn('check failed', { watchId: w.id, err: errMessage(err) }));
    return `⏳ Still checking **${nameOf(w)}** — any alerts will be posted to ${channelMention(w.channelId)}.`;
  }
  const res = timely.value;
  const n = res.alerts.length;
  const took = formatDuration(res.durationMs);
  const lines: string[] = [];
  if (n === 0 && res.error) {
    lines.push(`⚠️ The check of **${nameOf(w)}** didn't complete (took ${took}): ${escapeMarkdown(truncate(res.error, 500))}`);
  } else if (n === 0) {
    lines.push(`✅ No changes on **${nameOf(w)}**${full ? ' (full check)' : ''} — took ${took}.`);
  } else {
    const kinds = [...new Set(res.alerts.map((a) => KIND_LABEL[a.kind] ?? a.kind))].join(', ');
    lines.push(`📣 Found ${n} change${n === 1 ? '' : 's'} (${kinds}) — posted to ${channelMention(w.channelId)}, took ${took}.`);
    if (res.error) lines.push(`⚠️ ${escapeMarkdown(truncate(res.error, 500))}`);
  }
  const perms = permsWarning(i, w.channelId);
  if (perms) lines.push(perms);
  if (w.paused) lines.push('ℹ️ This site is paused, so it is only checked on demand.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Renderers (site card, pages, subdomains, history, help)
// ---------------------------------------------------------------------------

export interface SiteStatus {
  emoji: string;
  label: string;
  color: number;
}

/** Paused ⏸️ > first scan pending ⏳ > down 🔴 > up 🟢. */
export function siteStatus(w: Watch, state: Pick<WatchState, 'status'> | null | undefined): SiteStatus {
  if (w.paused) return { emoji: '⏸️', label: 'Paused', color: ALERT_COLORS.info };
  if (!w.baselineDone) return { emoji: '⏳', label: 'First scan pending', color: ALERT_COLORS.text };
  if (state && state.status && !state.status.up) return { emoji: '🔴', label: 'Down', color: ALERT_COLORS.statusDown };
  if (isWalledOff(state)) return { emoji: '🛡️', label: 'Blocked by the site’s bot protection', color: ALERT_COLORS.text };
  return { emoji: '🟢', label: 'Up', color: ALERT_COLORS.statusUp };
}

/** Watch state, or null if it can't be read. */
export function safeState(store: Pick<Store, 'getState'>, watchId: number): WatchState | null {
  try {
    return store.getState(watchId);
  } catch {
    return null;
  }
}

function runtimeLine(deps: CommandDeps, w: Watch): string {
  try {
    const rt = deps.monitor.runtimeInfo(w.id);
    const parts = [rt.running ? 'running' : 'stopped'];
    if (rt.baselineRunning) parts.push('baseline scan in progress');
    if (typeof rt.lastTickMs === 'number') {
      parts.push(`last check took ${rt.lastTickMs < 1000 ? `${Math.round(rt.lastTickMs)}ms` : formatDuration(rt.lastTickMs)}`);
    }
    if (rt.nextTickAt) parts.push(`next ${when(rt.nextTickAt)}`);
    return parts.join(' · ');
  } catch (err) {
    deps.log.debug('runtimeInfo failed', { watchId: w.id, err: errMessage(err) });
    return 'unknown';
  }
}

/** Compact on/off grid of every switch, four per line. */
export function featureGrid(w: Watch): string {
  const cells = FEATURE_TOGGLES.map((t) => `${toggleValue(w, t.key) ? '✅' : '⬜'} ${t.label}`);
  const rows: string[] = [];
  for (let n = 0; n < cells.length; n += 4) rows.push(cells.slice(n, n + 4).join(' · '));
  return rows.join('\n');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The site card: status, schedule, delivery, counts, build, rules, checks, runtime. */
export function renderSiteInfo(deps: CommandDeps, w: Watch, i?: Pick<Repliable, 'guild'>): APIEmbed {
  const { store } = deps;
  const state = safeState(store, w.id) ?? null;
  const tracked = store.listPages(w.id, { kind: 'page', tracked: true });
  const knownPages = store.countPages(w.id, { kind: 'page' });
  const files = store.countPages(w.id, { kind: 'file' });
  const subs = store.listSubdomains(w.id);
  const alive = subs.filter((s) => s.alive).length;
  const gone = tracked.filter((p) => p.gone).length;
  const dynamic = tracked.filter((p) => p.dynamic).length;

  const st = siteStatus(w, state);
  let statusLine = `${st.emoji} **${st.label}**`;
  if (state && !w.paused && !state.status.up) {
    if (state.status.downSince) statusLine += ` since ${when(state.status.downSince)}`;
    if (state.status.lastError) statusLine += ` (${escapeMarkdown(truncate(state.status.lastError, 200))})`;
  }
  statusLine += ` · last check ${when(state?.lastCheckAt)} · last change ${when(state?.lastChangeAt)}`;

  const deploy = state?.deploy ?? null;
  const buildParts: string[] = [];
  if (deploy?.buildId) buildParts.push(codeSpan(deploy.buildId, 80));
  if (deploy) buildParts.push(`${deploy.assets.length} bundles`);
  if (deploy?.generator) buildParts.push(escapeMarkdown(truncate(deploy.generator, 80)));

  const rules = [
    plural(w.ignorePatterns.length, 'ignore pattern'),
    plural(w.excludePatterns.length, 'skipped URL pattern'),
    plural(w.extraUrls.length, 'extra page'),
    `scope: ${w.scopePath ? codeSpan(w.scopePath, 100) : 'whole site'}`,
  ];

  const fields: APIEmbedField[] = [
    { name: 'Schedule', value: `every ${w.intervalSec}s\nall pages ~${formatDuration(w.sweepSec * 1000)}`, inline: true },
    { name: 'Alerts', value: `${channelMention(w.channelId)}\nping: ${roleMention(w.pingRoleId, w.guildId)}`, inline: true },
    { name: 'Build', value: buildParts.length ? buildParts.join(' · ') : 'unknown', inline: true },
    {
      name: 'Pages',
      value: `${tracked.length} tracked (max ${w.maxPages}) · ${knownPages} known\n${files} files · ${gone} gone · ${dynamic} too dynamic`,
      inline: true,
    },
    { name: 'Subdomains', value: w.features.subdomains ? `${subs.length} known · ${alive} live${ctNote(deps)}` : `off (${subs.length} known)`, inline: true },
    { name: 'Rules', value: rules.join('\n'), inline: true },
    { name: 'Checks', value: featureGrid(w), inline: false },
    { name: 'Runtime', value: runtimeLine(deps, w), inline: false },
  ];
  if (state?.lastError) fields.push({ name: 'Last error', value: codeSpan(state.lastError, 900), inline: false });
  const perms = permsWarning(i, w.channelId);
  if (perms) fields.push({ name: 'Delivery', value: perms, inline: false });
  return {
    title: `${st.emoji} ${nameOf(w)}`,
    url: w.url,
    color: st.color,
    description: `${truncate(w.url, 500)}\n${statusLine}`,
    fields,
    footer: { text: `#${w.id} · ${w.host} · added ${new Date(w.createdAt).toISOString().slice(0, 10)}` },
  };
}

export function renderPages(deps: CommandDeps, w: Watch): APIEmbed {
  const { store } = deps;
  const tracked = store.listPages(w.id, { kind: 'page', tracked: true });
  const known = store.countPages(w.id, { kind: 'page' });
  const files = store.listPages(w.id, { kind: 'file' });
  const gone = tracked.filter((p) => p.gone).length;
  const dynamic = tracked.filter((p) => p.dynamic).length;
  const head = `**${tracked.length}** tracked · **${known}** known · **${files.length}** files · **${gone}** gone · **${dynamic}** too dynamic to diff`;
  const lines = tracked.map((p) => {
    let line = codeSpan(urlPath(p.url), 120);
    const title = (p.title ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (title) line += ` · ${escapeMarkdown(truncate(title, 60))}`;
    if (p.gone) line += ' · _gone_';
    else if (p.dynamic) line += ' · _dynamic_';
    return line;
  });
  const embed: APIEmbed = {
    title: `📄 Pages of ${nameOf(w)}`,
    url: w.url,
    color: ALERT_COLORS.info,
    description: `${head}\n\n${lines.length ? linesWithin(lines, PAGES_LISTED, 3800) : '_No pages tracked yet._'}`,
  };
  if (files.length) {
    embed.fields = [
      {
        name: 'Files',
        value: linesWithin(
          files.map((f) => `${codeSpan(urlPath(f.url), 120)}${f.gone ? ' · _gone_' : ''}`),
          15,
          1024,
        ),
      },
    ];
  }
  return embed;
}

const SUB_SOURCE: Record<string, string> = { ct: 'CT', crtsh: 'crt.sh', dns: 'DNS', link: 'link', code: 'code' };

export function renderSubdomains(deps: CommandDeps, w: Watch): APIEmbed {
  const subs = deps.store.listSubdomains(w.id).sort((a, b) => Number(b.alive) - Number(a.alive) || a.host.localeCompare(b.host));
  const alive = subs.filter((s) => s.alive).length;
  const lines = subs.map(
    (s) => `${s.alive ? '🟢' : '⚪'} ${codeSpan(s.host, 100)} · ${s.sources.map((src) => SUB_SOURCE[src] ?? src).join(', ') || '?'}`,
  );
  const off = w.features.subdomains ? '' : '\n_Subdomain detection is off for this site (turn it on under 🧩 Features)._';
  return {
    title: `🛰️ Subdomains of ${escapeMarkdown(w.rootDomain)}`,
    color: ALERT_COLORS.subdomain,
    description: `**${subs.length}** known · **${alive}** live${off}\n\n${lines.length ? linesWithin(lines, SUBDOMAINS_LISTED, 3800) : '_None found yet._'}`,
    footer: { text: `${w.name} · ${w.host}` },
  };
}

export function renderHistory(deps: CommandDeps, w: Watch, limit = 15): APIEmbed {
  const events = deps.store.listEvents(w.id, Math.max(1, Math.min(25, limit)));
  const lines = events.map(
    (e) => `<t:${unix(e.createdAt)}:R> ${KIND_EMOJI[e.kind] ?? '•'} ${escapeMarkdown(truncate(e.summary.replace(/[\r\n]+/g, ' '), 150))}`,
  );
  return {
    title: `🕘 Recent alerts — ${nameOf(w)}`,
    color: ALERT_COLORS.info,
    description: lines.length ? linesWithin(lines, 25, 4000) : `_No alerts yet for **${nameOf(w)}**._`,
  };
}

export function renderHelp(): APIEmbed {
  const description = [
    'I watch websites 24/7 and post the moment something changes:',
    '🌐 **Redeploys** — new JS/CSS bundles or build id',
    '📝 **Text changes** — visible text on tracked pages, with a diff',
    '🆕 **New / removed pages** — from links, sitemaps and routes in the site code',
    '🛰️ **New subdomains** — certificate logs, DNS and hostnames in the site code',
    '📄 **Files** — linked PDFs, docs, markdown…',
    '🔴 **Downtime** — site down / back up',
  ].join('\n');
  const dashboard = [
    '`/panel` posts the dashboard in a channel. From it:',
    '➕ **Add site** · pick a site from the menu to open its card',
    '⚡ check now · ⏸️ pause / ▶️ resume · ⚙️ settings (name, interval, channel, ping role)',
    '🧩 checks on/off · 🚫 rules (ignored text, skipped URLs, extra pages, scope)',
    '📄 pages · 🛰️ subdomains · 🕘 history · 🗑️ remove',
  ].join('\n');
  const commands = [
    '`/watch add url:unpeg.io` — start watching (the first scan is silent)',
    '`/watch list` — everything being watched',
    '`/watch check` — check right now',
    '`/watch remove` — stop watching',
    '`/link create` — connect the browser extension (or another bot): scan any site, add it here in one click',
  ].join('\n');
  const tips = [
    'Noisy page? Add an ignore pattern under 🚫 Rules — matching text is stripped before comparing.',
    'Skip whole sections with a URL pattern like `/blog/`.',
    'Counters and prices that tick constantly are detected automatically; force it with 🔢 Ignore numbers.',
  ].join('\n');
  return {
    title: '📖 Site Watcher — help',
    color: ALERT_COLORS.info,
    description,
    fields: [
      { name: 'Dashboard', value: dashboard },
      { name: 'Commands', value: commands },
      { name: 'Tips', value: tips },
    ],
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface Ctx {
  i: ChatInputCommandInteraction;
  deps: CommandDeps;
  guildId: string;
}

async function cmdAdd({ i, deps, guildId }: Ctx): Promise<void> {
  const prepared = prepareAdd(deps, {
    guildId,
    channelId: i.options.getChannel('channel')?.id ?? i.channelId,
    userId: i.user.id,
    url: i.options.getString('url', true),
    name: i.options.getString('name'),
    intervalSec: i.options.getInteger('interval'),
    pingRoleId: i.options.getRole('ping')?.id ?? null,
  });
  await defer(i, false, deps.log);
  await finishAdd(deps, prepared, (body) => respond(i, body, false, deps.log), i);
}

async function cmdRemove({ i, deps, guildId }: Ctx): Promise<void> {
  const w = resolveSite(i, deps, guildId);
  removeWatch(deps, w, i.user.id);
  await respond(i, { content: `🗑️ Stopped watching **${nameOf(w)}** (<${w.url}>).` }, false, deps.log);
}

async function cmdList({ i, deps, guildId }: Ctx): Promise<void> {
  const watches = deps.store.listWatches(guildId);
  if (!watches.length) {
    await respond(i, { content: 'No sites are watched in this server yet. Add one with `/watch add url:unpeg.io` or from the `/panel` dashboard.' }, false, deps.log);
    return;
  }
  const lines = watches.map(
    (w) =>
      `**#${w.id} ${nameOf(w)}** — ${truncate(w.url, 300)} · every ${w.intervalSec}s · ${channelMention(w.channelId)}${
        missingChannelPerms(i, w.channelId).length ? ' ⚠️' : ''
      } · ${featureSummary(w.features)}${w.paused ? ' · ⏸️ paused' : ''}`,
  );
  await respond(
    i,
    {
      embeds: [
        {
          title: `Watched sites (${watches.length})`,
          color: ALERT_COLORS.info,
          description: linesWithin(lines, 100, 4000, (n) => `…and ${n} more — see the \`/panel\` dashboard.`),
        },
      ],
    },
    false,
    deps.log,
  );
}

async function cmdCheck({ i, deps, guildId }: Ctx): Promise<void> {
  const w = resolveSite(i, deps, guildId);
  const full = i.options.getBoolean('full') ?? false;
  await defer(i, true, deps.log);
  const content = await runCheck(deps, w, full, i);
  await respond(i, { content }, true, deps.log);
}

async function cmdHelp({ i, deps }: Ctx): Promise<void> {
  await respond(i, { embeds: [renderHelp()] }, true, deps.log);
}

async function cmdPanel({ i, deps, guildId }: Ctx): Promise<void> {
  requireManageGuild(i);
  let host: PanelHost | null | undefined;
  try {
    host = deps.panel;
  } catch {
    host = null;
  }
  if (!host) throw new UserError('The dashboard is not available right now — try again in a few seconds.');
  await defer(i, true, deps.log);
  let url: string;
  try {
    url = await host.placePanel(guildId, i.channelId);
  } catch (err) {
    if (ACCESS_ERROR_CODES.has(errorCode(err) as number)) {
      throw new UserError(
        "I can't post the dashboard here. I need **View Channel**, **Send Messages**, **Embed Links**, **Attach Files** and **Pin Messages** in this channel.",
      );
    }
    throw err;
  }
  await respond(i, { content: `📌 Dashboard posted: ${url}\nPick a site from its menu to manage it, or press **Add site**.` }, true, deps.log);
}

const HANDLERS: Record<string, (ctx: Ctx) => Promise<void>> = {
  add: cmdAdd,
  remove: cmdRemove,
  list: cmdList,
  check: cmdCheck,
  help: cmdHelp,
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function handleChatInput(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
  let what = `/${COMMAND_NAME}`;
  try {
    if (!interaction.inGuild() || !interaction.guildId) {
      await respond(interaction, { content: 'This command only works inside a server.' }, true, deps.log);
      return;
    }
    if (interaction.commandName === LINK_COMMAND_NAME) {
      what = `/${LINK_COMMAND_NAME}`;
      await handleLinkCommand(interaction, deps); // replies to its own errors
      return;
    }
    const ctx: Ctx = { i: interaction, deps, guildId: interaction.guildId };
    if (interaction.commandName === PANEL_COMMAND_NAME) {
      what = `/${PANEL_COMMAND_NAME}`;
      await cmdPanel(ctx);
      return;
    }
    const sub = interaction.options.getSubcommand(false) ?? '';
    what = `/${COMMAND_NAME} ${sub}`;
    const handler = HANDLERS[sub];
    if (!handler) throw new UserError(`Unknown subcommand \`${truncate(sub, 32) || '?'}\` — the rest lives on the \`/panel\` dashboard.`);
    if (PRIVILEGED.has(sub)) requireManageGuild(interaction);
    await handler(ctx);
  } catch (err) {
    await replyError(interaction, err, deps.log, what);
  }
}

export async function handleAutocomplete(interaction: AutocompleteInteraction, deps: CommandDeps): Promise<void> {
  try {
    if (!interaction.inGuild() || !interaction.guildId) {
      await interaction.respond([]);
      return;
    }
    if (interaction.commandName === LINK_COMMAND_NAME) {
      await handleLinkAutocomplete(interaction, deps);
      return;
    }
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'site') {
      await interaction.respond([]);
      return;
    }
    const q = String(focused.value ?? '')
      .trim()
      .toLowerCase()
      .replace(/^#/, '');
    const watches = deps.store.listWatches(interaction.guildId);
    const rank = (w: Watch): number => {
      if (!q) return 1;
      const name = w.name.toLowerCase();
      if (String(w.id) === q) return 0;
      if (name.startsWith(q) || w.host.startsWith(q)) return 1;
      if (name.includes(q) || w.host.includes(q) || w.url.toLowerCase().includes(q)) return 2;
      return -1;
    };
    const choices = watches
      .map((w) => ({ w, r: rank(w) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.w.id - b.w.id)
      .slice(0, 25)
      .map(({ w }) => ({
        name: truncate(`${w.name.replace(/[\r\n]+/g, ' ')} — ${w.host}${w.paused ? ' (paused)' : ''}`, 100) || String(w.id),
        value: String(w.id),
      }));
    await interaction.respond(choices);
  } catch (err) {
    deps.log.warn('autocomplete failed', { err: errMessage(err) });
    try {
      if (!interaction.responded) await interaction.respond([]);
    } catch {
      // expired
    }
  }
}

const WATCH_SUB_RE = /^watchsub:(\d{1,15}):([a-z0-9_.-]{1,253})$/i;

export async function handleButton(interaction: ButtonInteraction, deps: CommandDeps): Promise<void> {
  const { store, log } = deps;
  try {
    if (!interaction.inGuild() || !interaction.guildId) throw new UserError('This button only works inside a server.');
    const guildId = interaction.guildId;
    const m = interaction.customId.startsWith(WATCH_SUB_PREFIX) ? WATCH_SUB_RE.exec(interaction.customId) : null;
    if (!m) throw new UserError('This button is no longer valid.');
    if (!hasManageGuild(interaction)) throw new UserError('You need the **Manage Server** permission to add watches.');
    const parent = store.getWatch(Number(m[1]));
    if (!parent || parent.guildId !== guildId) throw new UserError('The watch that found this subdomain no longer exists.');
    const parsed = subdomainTarget(parent, m[2]);
    if (!parsed) throw new UserError('This button is no longer valid.');
    const added = addSubdomainWatch(deps, parent, parsed, interaction.user.id);
    if (!added.created) {
      throw new UserError(`Already watching **${escapeMarkdown(parsed.host)}** as **#${added.watch.id} ${nameOf(added.watch)}**.`);
    }
    const created = added.watch;
    log.info('watch added from subdomain button', { watchId: created.id, url: created.url, parent: parent.id, by: interaction.user.id });

    await defer(interaction, true, log);
    const scan = baselineAndStart(deps, created);
    const timely = await withDeadline(scan, REPLY_DEADLINE_MS);
    if (!timely.done) {
      void scan.then(() => startWatch(deps, created.id));
      await respond(
        interaction,
        { content: `⏳ Still scanning **${escapeMarkdown(parsed.host)}** — the watch is saved and starts when the first scan finishes.` },
        true,
        log,
      );
      return;
    }
    const { summary, error } = timely.value;
    const watch = startWatch(deps, created.id);
    if (!watch) {
      await respond(interaction, { content: `⚠️ **${escapeMarkdown(parsed.host)}** was removed while its first scan was running.` }, true, log);
      return;
    }
    const lines = [
      `✅ Now watching **${escapeMarkdown(parsed.host)}** as **#${watch.id} ${nameOf(watch)}** in ${channelMention(watch.channelId)}.`,
      ...baselineLines(watch, summary, error),
    ];
    await respond(interaction, { content: lines.join('\n') }, true, log);
  } catch (err) {
    await replyError(interaction, err, log, 'watchsub button');
  }
}
