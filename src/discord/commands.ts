/**
 * Slash commands & component interactions.
 *
 * One top-level command `/watch` (default_member_permissions = ManageGuild, dm_permission false) with subcommands:
 *   add     url:string(req) name:string channel:channel(text/announcement) interval:int(seconds, min config.minIntervalSec, max 3600)
 *           ping:role subdomains:bool crawl:bool (false → only the start URL + extra pages; sets features.pages=false & maxPages=1)
 *           scope:string (path prefix, e.g. /docs) max_pages:int(1..1000)
 *           → parseWatchInput (reject invalid with an ephemeral error); reject duplicates in the guild (findWatchByUrl);
 *             store.createWatch; monitor.onWatchAdded is NOT enough — defer reply (ephemeral false), await monitor.runBaseline(id),
 *             then edit reply with a summary embed ("✅ Watching Unpeg (https://unpeg.io/) in #alerts — baseline: 12 pages, 2 files,
 *             5 subdomains, build `KU79…`, every 30s"), then monitor.onWatchAdded(watch). If the homepage was unreachable/blocked,
 *             say so in the summary (still keep the watch). If !config.dataDirPersistent add a warning line that data will be lost on
 *             redeploy (attach a Railway volume and set DATA_DIR).
 *   remove  site:string(req, autocomplete) → store.deleteWatch + monitor.onWatchRemoved.
 *   list    → embed listing guild watches: "#id **name** — url · every Ns · #channel · features · paused?" (ephemeral false).
 *   info    site(req, autocomplete) → embed: url, channel, interval/sweep, features on/off, pages tracked/known, files, subdomains,
 *           build id, last check (relative <t:unix:R>), last change, last error, runtime info.
 *   check   site(req, autocomplete) full:bool → defer, monitor.checkNow, reply with "No changes" or "Sent N alert(s)" (+ error).
 *   pause / resume  site(req, autocomplete) → updateWatch({paused}) + monitor.onWatchUpdated.
 *   set     site(req, autocomplete) + optional: name, channel, interval, sweep(int 30..86400), ping(role), clear_ping(bool),
 *           max_pages, scope (string; "/" or "none" clears), and feature booleans: deploy, text, pages, subdomains, files, status,
 *           code_intel, ignore_numbers → updateWatch + monitor.onWatchUpdated; reply with the changed settings.
 *   ignore  site(req, autocomplete) pattern:string(req, a regex) remove:bool → validate regex (new RegExp(p,'gi') in try/catch),
 *           add/remove in ignorePatterns, store.resetPageNoise(id), updateWatch, onWatchUpdated (triggers silent re-baseline).
 *   exclude site pattern remove → same for excludePatterns (URL regex).
 *   addpage site url(req) remove:bool → absolute URL (relative paths resolved against watch.url), must be http(s); add/remove extraUrls.
 *   pages   site(req, autocomplete) → ephemeral list of tracked pages (path · title), up to 40, plus counts (known/tracked/files/gone/dynamic).
 *   subdomains site(req, autocomplete) → ephemeral list of known subdomains (host · alive? · sources), up to 60.
 *   history site(req, autocomplete) limit:int(1..25, default 10) → events newest first with <t:unix:R>.
 *   help    → ephemeral embed explaining what the bot detects and the commands.
 * Autocomplete for `site`: guild watches filtered by the typed text (id/name/host), up to 25 choices, name "name — host", value = String(id).
 * Any lookup failure → ephemeral "Unknown site. Use /watch list." Errors → ephemeral "⚠️ <message>" (log the stack).
 * Guard: all handlers require interaction.inGuild(); re-check member has ManageGuild permission for mutating subcommands
 * (defense in depth even though default_member_permissions is set).
 *
 * Buttons: custom_id `watchsub:<watchId>:<host>` (from subdomain alerts) → requires ManageGuild; if a watch for https://<host>/
 * already exists in the guild → ephemeral "Already watching"; else create a watch for https://<host>/ in the same channel as the
 * parent watch, name "<parent name> (<first label>)", features = parent features but subdomains=false; runBaseline; onWatchAdded;
 * reply ephemeral "✅ Now watching <host>".
 *
 * Implementation notes:
 * - Duplicate checks and inserts happen synchronously (no await in between) BEFORE deferring, so a double-submitted command or a
 *   double-clicked button can never create two watches.
 * - Mutations reply publicly (an audit trail for the shared server); read-only views other than `list` are ephemeral.
 * - User-supplied regexes run against every page on every sweep, so patterns with nested quantifiers ("(a+)+") — the classic
 *   catastrophic-backtracking shape — and patterns that would blank out all text / exclude every URL are rejected.
 * - A second watch on a root domain that another watch already scans for subdomains gets subdomains off by default (they
 *   would be announced twice), is warned about duplicate redeploy/uptime alerts for the same host, and is named after its
 *   subdomain or first path segment ("Unpeg docs") rather than "Unpeg 2". A server can hold at most
 *   config.maxWatchesPerGuild watches.
 * - Replies never wait on a scan longer than the interaction token lives (15 min): after REPLY_DEADLINE_MS the reply says
 *   the scan is still running and the watch starts by itself when it finishes.
 */

import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type APIEmbed,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type SlashCommandStringOption,
} from 'discord.js';
import vm from 'node:vm';
import { parse as parseDomain } from 'tldts';
import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import type { BaselineSummary, Monitor } from '../monitor/scheduler.js';
import type { AlertKind, Logger, Watch, WatchFeatures, WatchPatch } from '../types.js';
import { isUnderDomain, normalizeUrl, parseWatchInput, urlPath } from '../extract/url.js';
import { ALERT_COLORS, WATCH_SUB_PREFIX, clampEmbed, codeSpan, escapeMarkdown, formatDuration, truncate } from './format.js';

export interface CommandDeps {
  store: Store;
  monitor: Monitor;
  config: Config;
  log: Logger;
}

export const COMMAND_NAME = 'watch';
export const MAX_INTERVAL_SEC = 3600;
export const SWEEP_MIN_SEC = 30;
export const SWEEP_MAX_SEC = 86_400;
export const MAX_PAGES_LIMIT = 1000;
export const MAX_NAME_CHARS = 100;
export const MAX_PATTERN_CHARS = 300;
export const MAX_PATTERNS = 25;
export const MAX_EXTRA_URLS = 50;
const MAX_SCOPE_CHARS = 200;
const PAGES_LISTED = 40;
const SUBDOMAINS_LISTED = 60;
const EPHEMERAL = MessageFlags.Ephemeral;
const NO_MENTIONS = { parse: [] as never[] };
/** Interaction tokens expire after 15 minutes: reply before that even if a scan is still running. */
export const REPLY_DEADLINE_MS = 13 * 60_000;

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

const UNKNOWN_SITE = 'Unknown site. Use /watch list.';

/** Subcommands that change state (or trigger network work) and so require Manage Server. */
const PRIVILEGED = new Set(['add', 'remove', 'set', 'pause', 'resume', 'ignore', 'exclude', 'addpage', 'check']);

/** Feature flags in display order: [key, label, `/watch set` option name]. */
const FEATURES: ReadonlyArray<readonly [keyof WatchFeatures, string, string]> = [
  ['deploy', 'redeploys', 'deploy'],
  ['text', 'text changes', 'text'],
  ['pages', 'new/removed pages', 'pages'],
  ['subdomains', 'subdomains', 'subdomains'],
  ['files', 'files', 'files'],
  ['status', 'uptime', 'status'],
  ['codeIntel', 'code intel', 'code_intel'],
];

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

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

function minInterval(config: Pick<Config, 'minIntervalSec'>): number {
  return clampInt(config?.minIntervalSec, 1, MAX_INTERVAL_SEC, 10);
}

const siteOption = (o: SlashCommandStringOption) =>
  o.setName('site').setDescription('Watched site (pick from the list, or type its name, id or URL)').setRequired(true).setAutocomplete(true).setMaxLength(200);

/** JSON bodies for command registration (currently just `/watch`). */
export function commandDefinitions(config: Pick<Config, 'minIntervalSec'>): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const minInt = minInterval(config);
  const cmd = new SlashCommandBuilder()
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
        .addRoleOption((o) => o.setName('ping').setDescription('Role to ping on alerts'))
        .addBooleanOption((o) => o.setName('subdomains').setDescription('Detect new subdomains (default: on)'))
        .addBooleanOption((o) => o.setName('crawl').setDescription('Crawl the site for pages (off = only the start URL and added pages)'))
        .addStringOption((o) => o.setName('scope').setDescription('Only crawl paths under this prefix, e.g. /docs').setMaxLength(MAX_SCOPE_CHARS))
        .addIntegerOption((o) => o.setName('max_pages').setDescription(`Max pages whose text is tracked (1-${MAX_PAGES_LIMIT})`).setMinValue(1).setMaxValue(MAX_PAGES_LIMIT)),
    )
    .addSubcommand((s) => s.setName('remove').setDescription('Stop watching a site').addStringOption(siteOption))
    .addSubcommand((s) => s.setName('list').setDescription('List watched sites in this server'))
    .addSubcommand((s) => s.setName('info').setDescription('Show settings and status of a watched site').addStringOption(siteOption))
    .addSubcommand((s) =>
      s
        .setName('check')
        .setDescription('Check a site right now')
        .addStringOption(siteOption)
        .addBooleanOption((o) => o.setName('full').setDescription('Re-check every tracked page, not just the homepage')),
    )
    .addSubcommand((s) => s.setName('pause').setDescription('Pause checks for a site').addStringOption(siteOption))
    .addSubcommand((s) => s.setName('resume').setDescription('Resume checks for a paused site').addStringOption(siteOption))
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Change settings of a watched site')
        .addStringOption(siteOption)
        .addStringOption((o) => o.setName('name').setDescription('New display name').setMaxLength(MAX_NAME_CHARS))
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Channel for alerts').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addIntegerOption((o) =>
          o.setName('interval').setDescription(`Seconds between homepage checks (${minInt}-${MAX_INTERVAL_SEC})`).setMinValue(minInt).setMaxValue(MAX_INTERVAL_SEC),
        )
        .addIntegerOption((o) =>
          o.setName('sweep').setDescription(`Seconds to re-check every tracked page once (${SWEEP_MIN_SEC}-${SWEEP_MAX_SEC})`).setMinValue(SWEEP_MIN_SEC).setMaxValue(SWEEP_MAX_SEC),
        )
        .addRoleOption((o) => o.setName('ping').setDescription('Role to ping on alerts'))
        .addBooleanOption((o) => o.setName('clear_ping').setDescription('Stop pinging a role'))
        .addIntegerOption((o) => o.setName('max_pages').setDescription(`Max pages whose text is tracked (1-${MAX_PAGES_LIMIT})`).setMinValue(1).setMaxValue(MAX_PAGES_LIMIT))
        .addStringOption((o) => o.setName('scope').setDescription('Only crawl under this path prefix; "/" or "none" = whole site').setMaxLength(MAX_SCOPE_CHARS))
        .addBooleanOption((o) => o.setName('deploy').setDescription('Detect redeploys (JS/CSS bundles, build id)'))
        .addBooleanOption((o) => o.setName('text').setDescription('Detect visible text changes'))
        .addBooleanOption((o) => o.setName('pages').setDescription('Detect new and removed pages'))
        .addBooleanOption((o) => o.setName('subdomains').setDescription('Detect new subdomains'))
        .addBooleanOption((o) => o.setName('files').setDescription('Detect changes to linked files (pdf, md, ...)'))
        .addBooleanOption((o) => o.setName('status').setDescription('Alert when the site goes down / comes back up'))
        .addBooleanOption((o) => o.setName('code_intel').setDescription('On redeploy, scan new JS for new routes and hosts'))
        .addBooleanOption((o) => o.setName('ignore_numbers').setDescription('Ignore changes that only touch numbers (prices, counters)')),
    )
    .addSubcommand((s) =>
      s
        .setName('ignore')
        .setDescription('Ignore text matching a regex when comparing pages')
        .addStringOption(siteOption)
        .addStringOption((o) => o.setName('pattern').setDescription('JavaScript regex (case-insensitive), e.g. Last updated.*').setRequired(true).setMaxLength(MAX_PATTERN_CHARS))
        .addBooleanOption((o) => o.setName('remove').setDescription('Remove this pattern instead of adding it')),
    )
    .addSubcommand((s) =>
      s
        .setName('exclude')
        .setDescription('Never crawl or track URLs matching a regex')
        .addStringOption(siteOption)
        .addStringOption((o) => o.setName('pattern').setDescription('JavaScript regex matched against full URLs, e.g. /blog/').setRequired(true).setMaxLength(MAX_PATTERN_CHARS))
        .addBooleanOption((o) => o.setName('remove').setDescription('Remove this pattern instead of adding it')),
    )
    .addSubcommand((s) =>
      s
        .setName('addpage')
        .setDescription('Always track an extra page or file (e.g. an unlinked page)')
        .addStringOption(siteOption)
        .addStringOption((o) => o.setName('url').setDescription('Absolute URL or a path like /docs/secret').setRequired(true).setMaxLength(2000))
        .addBooleanOption((o) => o.setName('remove').setDescription('Stop tracking this extra page')),
    )
    .addSubcommand((s) => s.setName('pages').setDescription('List tracked pages of a site').addStringOption(siteOption))
    .addSubcommand((s) => s.setName('subdomains').setDescription('List known subdomains of a site').addStringOption(siteOption))
    .addSubcommand((s) =>
      s
        .setName('history')
        .setDescription('Recent alerts for a site')
        .addStringOption(siteOption)
        .addIntegerOption((o) => o.setName('limit').setDescription('How many (1-25, default 10)').setMinValue(1).setMaxValue(25)),
    )
    .addSubcommand((s) => s.setName('help').setDescription('What this bot detects and how to use it'));
  return [cmd.toJSON()];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Repliable = ChatInputCommandInteraction | ButtonInteraction;
type Body = { content?: string; embeds?: APIEmbed[] };

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** Send (or update) the interaction response; never throws (the interaction may have expired). */
async function respond(i: Repliable, body: Body, ephemeral: boolean, log: Logger): Promise<void> {
  const embeds = body.embeds?.map(clampEmbed);
  const content = body.content !== undefined ? truncate(body.content, 2000) : undefined;
  try {
    if (i.deferred) {
      await i.editReply({ content: content ?? '', embeds: embeds ?? [], allowedMentions: NO_MENTIONS });
    } else if (i.replied) {
      await i.followUp({ content, embeds, allowedMentions: NO_MENTIONS, ...(ephemeral ? { flags: EPHEMERAL } : {}) });
    } else {
      await i.reply({ content, embeds, allowedMentions: NO_MENTIONS, ...(ephemeral ? { flags: EPHEMERAL } : {}) });
    }
  } catch (err) {
    log.warn('failed to respond to interaction', { err: errMessage(err) });
  }
}

async function defer(i: Repliable, ephemeral: boolean, log: Logger): Promise<void> {
  if (i.deferred || i.replied) return;
  try {
    await i.deferReply(ephemeral ? { flags: EPHEMERAL } : {});
  } catch (err) {
    log.warn('deferReply failed', { err: errMessage(err) });
  }
}

async function replyError(i: Repliable, err: unknown, log: Logger, what: string): Promise<void> {
  if (!(err instanceof UserError)) log.error(`${what} failed`, { err: err instanceof Error ? err : String(err) });
  await respond(i, { content: `⚠️ ${truncate(errMessage(err), 1900)}` }, true, log);
}

function hasManageGuild(i: Repliable): boolean {
  try {
    return Boolean(i.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
  } catch {
    return false;
  }
}

function channelMention(id: string): string {
  return /^\d{5,25}$/.test(id) ? `<#${id}>` : `\`${id}\``;
}

function roleMention(id: string | null, guildId: string): string {
  if (!id) return 'none';
  return id === guildId ? '@everyone' : `<@&${id}>`;
}

function unix(ms: number): number {
  return Math.floor(ms / 1000);
}

function when(ms: number | null | undefined): string {
  return typeof ms === 'number' && ms > 0 ? `<t:${unix(ms)}:R>` : 'never';
}

function nameOf(w: Watch): string {
  return escapeMarkdown(truncate(w.name.replace(/[\r\n]+/g, ' '), MAX_NAME_CHARS));
}

function featureSummary(f: WatchFeatures): string {
  const on = FEATURES.filter(([k]) => f[k]).map(([, label]) => label);
  if (on.length === FEATURES.length) return 'all checks';
  return on.length ? on.join(', ') : 'nothing (all checks off)';
}

/** Newline-joined lines within `budget` chars and `max` items; overflow becomes "…and N more". */
function linesWithin(lines: string[], max: number, budget: number, more = (n: number) => `…and ${n} more`): string {
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

function intOption(i: ChatInputCommandInteraction, name: string, min: number, max: number, unit = ''): number | null {
  const v = i.options.getInteger(name);
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < min || v > max) throw new UserError(`\`${name}\` must be between ${min} and ${max}${unit}.`);
  return v;
}

/** Trimmed single-line display name; rejects empty and number-only names (those would be read as watch ids). */
function cleanName(raw: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) throw new UserError('The name cannot be empty.');
  if (name.length > MAX_NAME_CHARS) throw new UserError(`The name is too long (max ${MAX_NAME_CHARS} characters).`);
  if (/^#?\d+$/.test(name)) throw new UserError('The name cannot be just a number (numbers are used as watch ids).');
  return name;
}

function nameTaken(deps: CommandDeps, guildId: string, name: string, exceptId?: number): boolean {
  const lower = name.toLowerCase();
  return deps.store.listWatches(guildId).some((w) => w.id !== exceptId && w.name.trim().toLowerCase() === lower);
}

function uniqueName(deps: CommandDeps, guildId: string, base: string): string {
  const clean = truncate(base, MAX_NAME_CHARS - 4);
  if (!nameTaken(deps, guildId, clean)) return clean;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${clean} ${n}`;
    if (!nameTaken(deps, guildId, candidate)) return candidate;
  }
  return `${clean} ${Date.now()}`;
}

/**
 * Path-prefix scope: undefined = option not given, null = whole site. Accepts "/docs", "docs/", or a full URL (its path is used).
 */
export function parseScope(raw: string | null): string | null | undefined {
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

function validatePattern(pattern: string, kind: 'ignore' | 'exclude'): string {
  const p = pattern.trim();
  if (!p) throw new UserError('The pattern cannot be empty.');
  if (p.length > MAX_PATTERN_CHARS) throw new UserError(`The pattern is too long (max ${MAX_PATTERN_CHARS} characters).`);
  let re: RegExp;
  try {
    re = new RegExp(p, kind === 'ignore' ? 'gi' : 'i');
  } catch (err) {
    throw new UserError(`Invalid regex: ${errMessage(err).replace(/^Invalid regular expression: /, '')}`);
  }
  if (hasNestedQuantifier(p)) {
    throw new UserError('That pattern has nested repetition like `(a+)+`, which can freeze the bot on some pages. Please simplify it.');
  }
  if (!regexIsFast(p, re.flags)) {
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
 * Resolve an `addpage` URL: absolute http(s) URLs as-is, "unpeg.io/x"-style inputs whose host is (under) the watched domain or a
 * real public domain followed by a path, anything else relative to the watch URL. Returns a normalized URL or null.
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
function missingChannelPerms(i: Repliable, channelId: string): string[] {
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

function permsWarning(i: Repliable, channelId: string): string | null {
  const missing = missingChannelPerms(i, channelId);
  if (missing.includes('channel not found')) {
    return `⚠️ The alert channel ${channelMention(channelId)} no longer exists — alerts can't be delivered. Pick another one with \`/watch set channel:\`.`;
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
function ctNote(deps: CommandDeps): string {
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

function startWatch(deps: CommandDeps, watchId: number): Watch | undefined {
  const fresh = deps.store.getWatch(watchId);
  if (!fresh) return undefined;
  try {
    deps.monitor.onWatchAdded(fresh);
  } catch (err) {
    deps.log.error('monitor.onWatchAdded failed', { watchId, err: err instanceof Error ? err : String(err) });
  }
  return fresh;
}

function notifyUpdated(deps: CommandDeps, watch: Watch): void {
  try {
    deps.monitor.onWatchUpdated(watch);
  } catch (err) {
    deps.log.error('monitor.onWatchUpdated failed', { watchId: watch.id, err: err instanceof Error ? err : String(err) });
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

interface Ctx {
  i: ChatInputCommandInteraction;
  deps: CommandDeps;
  guildId: string;
}

/** Throws when the server already holds the maximum number of watches. */
function checkWatchLimit(deps: CommandDeps, guildId: string): void {
  const max = deps.config.maxWatchesPerGuild;
  if (typeof max === 'number' && max > 0 && deps.store.listWatches(guildId).length >= max) {
    throw new UserError(`This server already watches ${max} sites (the limit). Remove one with \`/watch remove\` first.`);
  }
}

/**
 * A default name that tells a second watch of the same site apart: "Unpeg docs" for docs.unpeg.io or unpeg.io/docs,
 * instead of "Unpeg 2".
 */
function distinctName(deps: CommandDeps, guildId: string, parsed: { suggestedName: string; host: string; rootDomain: string; url: string }): string {
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

async function cmdAdd({ i, deps, guildId }: Ctx): Promise<void> {
  const { store, config, log } = deps;
  const rawUrl = i.options.getString('url', true);
  const parsed = parseWatchInput(rawUrl);
  if (!parsed) {
    throw new UserError(
      `${codeSpan(rawUrl, 100)} doesn't look like a website URL. Try something like \`unpeg.io\` or \`https://unpeg.io/docs\`.`,
    );
  }
  // Scheme-less lookup: http:// and https:// versions of one URL are the same site.
  const existing = store.findWatchByUrl(guildId, parsed.url.replace(/^https?:\/\//i, ''));
  if (existing) throw new UserError(`Already watching ${existing.url} as **#${existing.id} ${nameOf(existing)}**.`);
  checkWatchLimit(deps, guildId);

  const explicitName = cleanName(i.options.getString('name'));
  if (explicitName && nameTaken(deps, guildId, explicitName)) {
    throw new UserError(`A site named **${escapeMarkdown(explicitName)}** already exists. Pick another name.`);
  }
  const name = explicitName ?? distinctName(deps, guildId, parsed);
  const channelId = i.options.getChannel('channel')?.id ?? i.channelId;
  const interval = intOption(i, 'interval', minInterval(config), MAX_INTERVAL_SEC, 's');
  const maxPages = intOption(i, 'max_pages', 1, MAX_PAGES_LIMIT);
  const pingRoleId = i.options.getRole('ping')?.id ?? null;
  const subdomains = i.options.getBoolean('subdomains');
  const crawl = i.options.getBoolean('crawl');
  const scopePath = parseScope(i.options.getString('scope')) ?? null;

  const features: Partial<WatchFeatures> = {};
  if (subdomains !== null && subdomains !== undefined) features.subdomains = subdomains;
  if (crawl === false) features.pages = false;

  // Other watches of the same site: subdomains would be announced twice, and the same host's redeploys/outages too.
  const siblings = store.listWatches(guildId).filter((w) => w.rootDomain === parsed.rootDomain);
  const notes: string[] = [];
  const subdomainOwner = siblings.find((w) => w.features.subdomains);
  if ((subdomains === null || subdomains === undefined) && subdomainOwner) {
    features.subdomains = false;
    notes.push(
      `Subdomains of ${escapeMarkdown(parsed.rootDomain)} are already tracked by **#${subdomainOwner.id} ${nameOf(subdomainOwner)}** — off here (pass \`subdomains:true\` to override).`,
    );
  }
  const sameHost = siblings.find((w) => w.host === parsed.host);
  if (sameHost) {
    notes.push(
      `Redeploy and uptime alerts for ${escapeMarkdown(parsed.host)} already come from **#${sameHost.id} ${nameOf(sameHost)}** — use \`/watch set deploy:false status:false\` on one of them to avoid duplicates${
        sameHost.scopePath ? '' : ', and note that its crawl already covers the whole host unless it is scoped'
      }.`,
    );
  }

  const created = store.createWatch({
    guildId,
    channelId,
    name,
    url: parsed.url,
    host: parsed.host,
    rootDomain: parsed.rootDomain,
    createdBy: i.user.id,
    intervalSec: interval ?? Math.max(config.defaultIntervalSec, minInterval(config)),
    maxPages: crawl === false ? 1 : (maxPages ?? undefined),
    pingRoleId,
    features,
    scopePath,
  });
  log.info('watch added', { watchId: created.id, url: created.url, guild: guildId, by: i.user.id });

  await defer(i, false, log);
  const scan = baselineAndStart(deps, created);
  const timely = await withDeadline(scan, REPLY_DEADLINE_MS);
  if (!timely.done) {
    // The interaction token would expire: say so now; the watch starts by itself once its first scan finishes.
    void scan.then(() => startWatch(deps, created.id));
    await respond(
      i,
      {
        content: `⏳ Still scanning **${nameOf(created)}** (${created.url}) — the watch is saved and starts when the first scan finishes; see \`/watch info\`.`,
      },
      false,
      log,
    );
    return;
  }
  const { summary, error } = timely.value;
  const watch = store.getWatch(created.id);
  if (!watch) {
    await respond(i, { content: `⚠️ **${nameOf(created)}** was removed while its first scan was running.` }, false, log);
    return;
  }

  const lines = [
    `${watch.url} in ${channelMention(watch.channelId)} — every ${watch.intervalSec}s.`,
    ...baselineLines(watch, summary, error),
    `Detecting: ${featureSummary(watch.features)}.`,
    ...notes,
  ];
  if (watch.scopePath) lines.push(`Scope: ${codeSpan(watch.scopePath, 200)}`);
  if (watch.pingRoleId) lines.push(`Pinging ${roleMention(watch.pingRoleId, guildId)} on alerts.`);
  const perms = permsWarning(i, watch.channelId);
  if (perms) lines.push(perms);
  const storage = storageWarning(config);
  if (storage) lines.push(storage);
  try {
    await respond(
      i,
      {
        embeds: [
          {
            title: `✅ Watching ${nameOf(watch)}`,
            url: watch.url,
            color: ALERT_COLORS.new_pages,
            description: lines.join('\n'),
            footer: { text: `#${watch.id} · ${watch.host}` },
          },
        ],
      },
      false,
      log,
    );
  } finally {
    startWatch(deps, watch.id);
  }
}

async function cmdRemove({ i, deps, guildId }: Ctx): Promise<void> {
  const w = resolveSite(i, deps, guildId);
  deps.store.deleteWatch(w.id);
  try {
    deps.monitor.onWatchRemoved(w.id);
  } catch (err) {
    deps.log.error('monitor.onWatchRemoved failed', { watchId: w.id, err: err instanceof Error ? err : String(err) });
  }
  deps.log.info('watch removed', { watchId: w.id, url: w.url, by: i.user.id });
  await respond(i, { content: `🗑️ Stopped watching **${nameOf(w)}** (<${w.url}>).` }, false, deps.log);
}

async function cmdList({ i, deps, guildId }: Ctx): Promise<void> {
  const watches = deps.store.listWatches(guildId);
  if (!watches.length) {
    await respond(i, { content: 'No sites are watched in this server yet. Add one with `/watch add url:unpeg.io`.' }, false, deps.log);
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
          description: linesWithin(lines, 100, 4000, (n) => `…and ${n} more — use \`/watch info\` for details.`),
        },
      ],
    },
    false,
    deps.log,
  );
}

function patternList(patterns: string[], empty = 'none'): string {
  return patterns.length ? linesWithin(patterns.map((p) => codeSpan(p, 200)), 25, 1024) : empty;
}

async function cmdInfo({ i, deps, guildId }: Ctx): Promise<void> {
  const { store } = deps;
  const w = resolveSite(i, deps, guildId);
  const state = store.getState(w.id);
  const tracked = store.listPages(w.id, { kind: 'page', tracked: true });
  const knownPages = store.countPages(w.id, { kind: 'page' });
  const files = store.countPages(w.id, { kind: 'file' });
  const subs = store.listSubdomains(w.id);
  const alive = subs.filter((s) => s.alive).length;
  const gone = tracked.filter((p) => p.gone).length;
  const dynamic = tracked.filter((p) => p.dynamic).length;

  let runtime = 'unknown';
  try {
    const rt = deps.monitor.runtimeInfo(w.id);
    const parts = [rt.running ? 'running' : 'stopped'];
    if (rt.baselineRunning) parts.push('baseline scan in progress');
    if (typeof rt.lastTickMs === 'number') {
      parts.push(`last check took ${rt.lastTickMs < 1000 ? `${Math.round(rt.lastTickMs)}ms` : formatDuration(rt.lastTickMs)}`);
    }
    if (rt.nextTickAt) parts.push(`next ${when(rt.nextTickAt)}`);
    runtime = parts.join(' · ');
  } catch (err) {
    deps.log.debug('runtimeInfo failed', { watchId: w.id, err: errMessage(err) });
  }

  const st = state.status;
  const statusLine = w.paused
    ? '⏸️ paused'
    : st.up
      ? '🟢 up'
      : `🔴 down${st.downSince ? ` since ${when(st.downSince)}` : ''}${st.lastError ? ` (${escapeMarkdown(truncate(st.lastError, 200))})` : ''}`;

  const deploy = state.deploy;
  const buildParts: string[] = [];
  if (deploy?.buildId) buildParts.push(codeSpan(deploy.buildId, 80));
  if (deploy) buildParts.push(`${deploy.assets.length} bundles`);
  if (deploy?.generator) buildParts.push(escapeMarkdown(truncate(deploy.generator, 80)));

  const fields = [
    { name: 'URL', value: truncate(w.url, 1000), inline: false },
    { name: 'Channel', value: channelMention(w.channelId), inline: true },
    { name: 'Schedule', value: `every ${w.intervalSec}s · all pages ~${formatDuration(w.sweepSec * 1000)}`, inline: true },
    { name: 'Status', value: `${statusLine}${w.baselineDone ? '' : ' · baseline pending'}`, inline: true },
    { name: 'Checks', value: FEATURES.map(([k, label]) => `${w.features[k] ? '✅' : '❌'} ${label}`).join('\n'), inline: true },
    {
      name: 'Pages',
      value: `${tracked.length} tracked (max ${w.maxPages}) · ${knownPages} known\n${files} files · ${gone} gone · ${dynamic} too dynamic`,
      inline: true,
    },
    { name: 'Subdomains', value: w.features.subdomains ? `${subs.length} known · ${alive} live${ctNote(deps)}` : 'off', inline: true },
    { name: 'Build', value: buildParts.length ? buildParts.join(' · ') : 'unknown', inline: true },
    { name: 'Last check', value: when(state.lastCheckAt), inline: true },
    { name: 'Last change', value: when(state.lastChangeAt), inline: true },
    { name: 'Ping', value: roleMention(w.pingRoleId, guildId), inline: true },
    { name: 'Scope', value: w.scopePath ? codeSpan(w.scopePath, 200) : 'whole site', inline: true },
    { name: 'Ignore numbers', value: w.maskNumbers ? 'yes' : 'auto', inline: true },
    { name: 'Runtime', value: runtime, inline: false },
  ];
  if (state.lastError) fields.push({ name: 'Last error', value: codeSpan(state.lastError, 900), inline: false });
  const perms = permsWarning(i, w.channelId);
  if (perms) fields.push({ name: 'Delivery', value: perms, inline: false });
  if (w.ignorePatterns.length) fields.push({ name: 'Ignored text', value: patternList(w.ignorePatterns), inline: false });
  if (w.excludePatterns.length) fields.push({ name: 'Excluded URLs', value: patternList(w.excludePatterns), inline: false });
  if (w.extraUrls.length) {
    fields.push({ name: 'Extra pages', value: linesWithin(w.extraUrls.map((u) => truncate(u, 200)), 20, 1024), inline: false });
  }
  await respond(
    i,
    {
      embeds: [
        {
          title: `#${w.id} ${nameOf(w)}`,
          url: w.url,
          color: ALERT_COLORS.info,
          fields,
          footer: { text: `Added ${new Date(w.createdAt).toISOString().slice(0, 10)}` },
        },
      ],
    },
    true,
    deps.log,
  );
}

async function cmdCheck({ i, deps, guildId }: Ctx): Promise<void> {
  const w = resolveSite(i, deps, guildId);
  const full = i.options.getBoolean('full') ?? false;
  await defer(i, true, deps.log);
  const check = deps.monitor.checkNow(w.id, { full });
  const timely = await withDeadline(check, REPLY_DEADLINE_MS);
  if (!timely.done) {
    check.catch((err: unknown) => deps.log.warn('check failed', { watchId: w.id, err: errMessage(err) }));
    await respond(i, { content: `⏳ Still checking **${nameOf(w)}** — any alerts will be posted to ${channelMention(w.channelId)}.` }, true, deps.log);
    return;
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
  await respond(i, { content: lines.join('\n') }, true, deps.log);
}

async function cmdPause({ i, deps, guildId }: Ctx, paused: boolean): Promise<void> {
  const w = resolveSite(i, deps, guildId);
  if (w.paused === paused) {
    await respond(i, { content: `**${nameOf(w)}** is already ${paused ? 'paused' : 'running'}.` }, true, deps.log);
    return;
  }
  const updated = deps.store.updateWatch(w.id, { paused });
  notifyUpdated(deps, updated);
  await respond(
    i,
    { content: paused ? `⏸️ Paused **${nameOf(w)}** — no checks until \`/watch resume\`.` : `▶️ Resumed **${nameOf(w)}**.` },
    false,
    deps.log,
  );
}

async function cmdSet({ i, deps, guildId }: Ctx): Promise<void> {
  const { store, config } = deps;
  const w = resolveSite(i, deps, guildId);
  const patch: WatchPatch = {};
  const changes: string[] = [];

  const name = cleanName(i.options.getString('name'));
  if (name !== null && name !== w.name) {
    if (nameTaken(deps, guildId, name, w.id)) throw new UserError(`A site named **${escapeMarkdown(name)}** already exists.`);
    patch.name = name;
    changes.push(`name: **${nameOf(w)}** → **${escapeMarkdown(name)}**`);
  }
  const channel = i.options.getChannel('channel');
  if (channel && channel.id !== w.channelId) {
    patch.channelId = channel.id;
    changes.push(`channel: ${channelMention(w.channelId)} → ${channelMention(channel.id)}`);
  }
  const interval = intOption(i, 'interval', minInterval(config), MAX_INTERVAL_SEC, 's');
  if (interval !== null && interval !== w.intervalSec) {
    patch.intervalSec = interval;
    changes.push(`interval: ${w.intervalSec}s → ${interval}s`);
  }
  const sweep = intOption(i, 'sweep', SWEEP_MIN_SEC, SWEEP_MAX_SEC, 's');
  if (sweep !== null && sweep !== w.sweepSec) {
    patch.sweepSec = sweep;
    changes.push(`full sweep: ${w.sweepSec}s → ${sweep}s`);
  }
  const ping = i.options.getRole('ping');
  const clearPing = i.options.getBoolean('clear_ping') ?? false;
  if (ping && clearPing) throw new UserError('Use either `ping` or `clear_ping`, not both.');
  if (ping && ping.id !== w.pingRoleId) {
    patch.pingRoleId = ping.id;
    changes.push(`ping: ${roleMention(w.pingRoleId, guildId)} → ${roleMention(ping.id, guildId)}`);
  } else if (clearPing && w.pingRoleId) {
    patch.pingRoleId = null;
    changes.push(`ping: ${roleMention(w.pingRoleId, guildId)} → none`);
  }
  const maxPages = intOption(i, 'max_pages', 1, MAX_PAGES_LIMIT);
  if (maxPages !== null && maxPages !== w.maxPages) {
    patch.maxPages = maxPages;
    changes.push(`max pages: ${w.maxPages} → ${maxPages}`);
  }
  const scope = parseScope(i.options.getString('scope'));
  if (scope !== undefined && scope !== w.scopePath) {
    patch.scopePath = scope;
    changes.push(`scope: ${w.scopePath ? codeSpan(w.scopePath, 200) : 'whole site'} → ${scope ? codeSpan(scope, 200) : 'whole site'}`);
  }
  const features: Partial<WatchFeatures> = {};
  for (const [key, label, option] of FEATURES) {
    const v = i.options.getBoolean(option);
    if (v === null || v === undefined || v === w.features[key]) continue;
    features[key] = v;
    changes.push(`${label}: ${v ? 'on' : 'off'}`);
  }
  if (Object.keys(features).length) patch.features = { ...w.features, ...features };
  const ignoreNumbers = i.options.getBoolean('ignore_numbers');
  if (ignoreNumbers !== null && ignoreNumbers !== undefined && ignoreNumbers !== w.maskNumbers) {
    patch.maskNumbers = ignoreNumbers;
    changes.push(`ignore number-only changes: ${ignoreNumbers ? 'on' : 'off'}`);
  }

  if (!changes.length) {
    await respond(i, { content: `Nothing to change for **${nameOf(w)}** — pass at least one new setting.` }, true, deps.log);
    return;
  }
  const updated = store.updateWatch(w.id, patch);
  notifyUpdated(deps, updated);
  deps.log.info('watch updated', { watchId: w.id, by: i.user.id, changes: Object.keys(patch) });
  const lines = [`⚙️ Updated **${nameOf(updated)}**:`, ...changes.map((c) => `• ${c}`)];
  if (patch.channelId) {
    const perms = permsWarning(i, patch.channelId);
    if (perms) lines.push(perms);
  }
  await respond(i, { content: lines.join('\n') }, false, deps.log);
}

async function cmdPatterns({ i, deps, guildId }: Ctx, kind: 'ignore' | 'exclude'): Promise<void> {
  const w = resolveSite(i, deps, guildId);
  const remove = i.options.getBoolean('remove') ?? false;
  const raw = i.options.getString('pattern', true).trim();
  const current = kind === 'ignore' ? w.ignorePatterns : w.excludePatterns;
  let next: string[];
  let message: string;
  if (remove) {
    if (!current.includes(raw)) {
      throw new UserError(`${codeSpan(raw, 200)} is not in the list. Current patterns:\n${patternList(current)}`);
    }
    next = current.filter((p) => p !== raw);
    message =
      kind === 'ignore'
        ? `👁️ **${nameOf(w)}** no longer ignores ${codeSpan(raw, 300)}.`
        : `↩️ **${nameOf(w)}** no longer excludes URLs matching ${codeSpan(raw, 300)}.`;
  } else {
    const pattern = validatePattern(raw, kind);
    if (current.includes(pattern)) throw new UserError(`${codeSpan(pattern, 200)} is already in the list.`);
    if (current.length >= MAX_PATTERNS) throw new UserError(`At most ${MAX_PATTERNS} patterns per site. Remove one first.`);
    next = [...current, pattern];
    message =
      kind === 'ignore'
        ? `🙈 **${nameOf(w)}** now ignores text matching ${codeSpan(pattern, 300)}.`
        : `🚫 **${nameOf(w)}** now skips URLs matching ${codeSpan(pattern, 300)}.`;
    if (kind === 'exclude') {
      try {
        if (new RegExp(pattern, 'i').test(w.url)) message += '\n⚠️ This pattern also matches the start URL.';
      } catch {
        // validated above
      }
    }
  }
  // Ignore patterns change the compared text: clear the noise heuristics so pages are re-judged under the new rules.
  if (kind === 'ignore') deps.store.resetPageNoise(w.id);
  const updated = deps.store.updateWatch(w.id, kind === 'ignore' ? { ignorePatterns: next } : { excludePatterns: next });
  notifyUpdated(deps, updated);
  message += `\nPages are re-baselined silently (${next.length} ${next.length === 1 ? 'pattern' : 'patterns'} active).`;
  await respond(i, { content: message }, false, deps.log);
}

async function cmdAddPage({ i, deps, guildId }: Ctx): Promise<void> {
  const w = resolveSite(i, deps, guildId);
  const raw = i.options.getString('url', true);
  const remove = i.options.getBoolean('remove') ?? false;
  const url = resolvePageUrl(raw, w);
  if (!url) throw new UserError(`${codeSpan(raw, 100)} is not a valid http(s) URL or path.`);
  const idx = w.extraUrls.findIndex((u) => (normalizeUrl(u) ?? u) === url);
  let next: string[];
  let message: string;
  if (remove) {
    if (idx < 0) {
      const list = w.extraUrls.length ? linesWithin(w.extraUrls.map((u) => `• <${truncate(u, 200)}>`), 20, 1500) : 'none';
      throw new UserError(`<${url}> is not an extra page of **${nameOf(w)}**. Extra pages:\n${list}`);
    }
    next = w.extraUrls.filter((_, n) => n !== idx);
    message = `📌 Stopped tracking <${url}> as an extra page of **${nameOf(w)}**.`;
  } else {
    if (idx >= 0) throw new UserError(`<${url}> is already tracked for **${nameOf(w)}**.`);
    if (w.extraUrls.length >= MAX_EXTRA_URLS) throw new UserError(`At most ${MAX_EXTRA_URLS} extra pages per site. Remove one first.`);
    next = [...w.extraUrls, url];
    message = `📌 Now also tracking <${url}> for **${nameOf(w)}**.`;
  }
  const updated = deps.store.updateWatch(w.id, { extraUrls: next });
  notifyUpdated(deps, updated);
  await respond(i, { content: message }, false, deps.log);
}

async function cmdPages({ i, deps, guildId }: Ctx): Promise<void> {
  const { store } = deps;
  const w = resolveSite(i, deps, guildId);
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
    title: `Pages of ${nameOf(w)}`,
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
  await respond(i, { embeds: [embed] }, true, deps.log);
}

const SUB_SOURCE: Record<string, string> = { ct: 'CT', crtsh: 'crt.sh', dns: 'DNS', link: 'link', code: 'code' };

async function cmdSubdomains({ i, deps, guildId }: Ctx): Promise<void> {
  const w = resolveSite(i, deps, guildId);
  const subs = deps.store.listSubdomains(w.id).sort((a, b) => Number(b.alive) - Number(a.alive) || a.host.localeCompare(b.host));
  const alive = subs.filter((s) => s.alive).length;
  const lines = subs.map(
    (s) => `${s.alive ? '🟢' : '⚪'} ${codeSpan(s.host, 100)} · ${s.sources.map((src) => SUB_SOURCE[src] ?? src).join(', ') || '?'}`,
  );
  const off = w.features.subdomains ? '' : '\n_Subdomain detection is off for this site (`/watch set subdomains:true`)._';
  await respond(
    i,
    {
      embeds: [
        {
          title: `Subdomains of ${escapeMarkdown(w.rootDomain)}`,
          color: ALERT_COLORS.subdomain,
          description: `**${subs.length}** known · **${alive}** live${off}\n\n${
            lines.length ? linesWithin(lines, SUBDOMAINS_LISTED, 3800) : '_None found yet._'
          }`,
          footer: { text: `${w.name} · ${w.host}` },
        },
      ],
    },
    true,
    deps.log,
  );
}

async function cmdHistory({ i, deps, guildId }: Ctx): Promise<void> {
  const w = resolveSite(i, deps, guildId);
  const limit = intOption(i, 'limit', 1, 25) ?? 10;
  const events = deps.store.listEvents(w.id, limit);
  if (!events.length) {
    await respond(i, { content: `No alerts yet for **${nameOf(w)}**.` }, true, deps.log);
    return;
  }
  const lines = events.map(
    (e) => `<t:${unix(e.createdAt)}:R> ${KIND_EMOJI[e.kind] ?? '•'} ${escapeMarkdown(truncate(e.summary.replace(/[\r\n]+/g, ' '), 150))}`,
  );
  await respond(
    i,
    {
      embeds: [
        {
          title: `Recent alerts — ${nameOf(w)}`,
          color: ALERT_COLORS.info,
          description: linesWithin(lines, 25, 4000),
        },
      ],
    },
    true,
    deps.log,
  );
}

async function cmdHelp({ i, deps }: Ctx): Promise<void> {
  const description = [
    'I watch websites 24/7 and post here the moment something changes:',
    '🌐 **Redeploys** — new JS/CSS bundles or build id',
    '📝 **Text changes** — visible text on tracked pages, with a diff',
    '🆕 **New / removed pages** — from links, sitemaps and routes in the site code',
    '🛰️ **New subdomains** — certificate logs, DNS and hostnames in the site code',
    '📄 **Files** — linked PDFs, docs, markdown…',
    '🔴 **Downtime** — site down / back up',
  ].join('\n');
  const commands = [
    '`/watch add url:unpeg.io` — start watching (first scan is silent)',
    '`/watch list` · `/watch info` — what is watched and how it is doing',
    '`/watch check` — check right now',
    '`/watch set` — interval, channel, ping role, checks on/off…',
    '`/watch pause` · `/watch resume` · `/watch remove`',
    '`/watch pages` · `/watch subdomains` · `/watch history`',
    '`/watch addpage` — also track an unlinked page or file',
  ].join('\n');
  const tips = [
    'Noisy page? `/watch ignore pattern:` strips matching text before comparing.',
    'Skip whole sections with `/watch exclude pattern:/blog/`.',
    'Counters and prices that tick constantly are detected automatically; force it with `/watch set ignore_numbers:true`.',
  ].join('\n');
  await respond(
    i,
    {
      embeds: [
        {
          title: 'Site Watcher — help',
          color: ALERT_COLORS.info,
          description,
          fields: [
            { name: 'Commands', value: commands },
            { name: 'Tips', value: tips },
          ],
        },
      ],
    },
    true,
    deps.log,
  );
}

const HANDLERS: Record<string, (ctx: Ctx) => Promise<void>> = {
  add: cmdAdd,
  remove: cmdRemove,
  list: cmdList,
  info: cmdInfo,
  check: cmdCheck,
  pause: (c) => cmdPause(c, true),
  resume: (c) => cmdPause(c, false),
  set: cmdSet,
  ignore: (c) => cmdPatterns(c, 'ignore'),
  exclude: (c) => cmdPatterns(c, 'exclude'),
  addpage: cmdAddPage,
  pages: cmdPages,
  subdomains: cmdSubdomains,
  history: cmdHistory,
  help: cmdHelp,
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function handleChatInput(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
  let sub = '';
  try {
    if (!interaction.inGuild() || !interaction.guildId) {
      await respond(interaction, { content: 'This command only works inside a server.' }, true, deps.log);
      return;
    }
    sub = interaction.options.getSubcommand(false) ?? '';
    const handler = HANDLERS[sub];
    if (!handler) throw new UserError(`Unknown subcommand \`${truncate(sub, 32) || '?'}\`.`);
    if (PRIVILEGED.has(sub) && !hasManageGuild(interaction)) {
      throw new UserError('You need the **Manage Server** permission to do that.');
    }
    await handler({ i: interaction, deps, guildId: interaction.guildId });
  } catch (err) {
    await replyError(interaction, err, deps.log, `/watch ${sub}`);
  }
}

export async function handleAutocomplete(interaction: AutocompleteInteraction, deps: CommandDeps): Promise<void> {
  try {
    if (!interaction.inGuild() || !interaction.guildId) {
      await interaction.respond([]);
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
    const host = m[2].toLowerCase().replace(/\.+$/, '');
    const parsed = parseWatchInput(`https://${host}/`);
    if (!parsed || !isUnderDomain(parsed.host, parent.rootDomain)) throw new UserError('This button is no longer valid.');
    const existing = store.findWatchByUrl(guildId, `${parsed.host}/`);
    if (existing) {
      throw new UserError(`Already watching **${escapeMarkdown(parsed.host)}** as **#${existing.id} ${nameOf(existing)}**.`);
    }
    checkWatchLimit(deps, guildId);
    const label = parsed.host.split('.')[0] || parsed.host;
    const created = store.createWatch({
      guildId,
      channelId: parent.channelId,
      name: uniqueName(deps, guildId, `${truncate(parent.name, 60)} (${truncate(label, 30)})`),
      url: parsed.url,
      host: parsed.host,
      rootDomain: parsed.rootDomain,
      createdBy: interaction.user.id,
      intervalSec: parent.intervalSec,
      sweepSec: parent.sweepSec,
      maxPages: parent.maxPages,
      pingRoleId: parent.pingRoleId,
      features: { ...parent.features, subdomains: false },
      ignorePatterns: parent.ignorePatterns,
      maskNumbers: parent.maskNumbers,
    });
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
