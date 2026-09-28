import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApplicationCommandOptionType,
  ChannelType,
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  commandDefinitions,
  handleAutocomplete,
  handleButton,
  handleChatInput,
  hasNestedQuantifier,
  parseScope,
  regexIsFast,
  REPLY_DEADLINE_MS,
  resolvePageUrl,
  type CommandDeps,
} from '../src/discord/commands.js';
import { testConfig, type Config } from '../src/config.js';
import { Store } from '../src/db/store.js';
import type { BaselineSummary, Monitor, TickSummary, WatchRuntimeInfo } from '../src/monitor/scheduler.js';
import { defaultWatchState, type Alert, type Logger, type PageRecord, type SubdomainRecord, type Watch } from '../src/types.js';

const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const CHANNEL = '200000000000000001';
const ALERTS = '200000000000000002';
const USER = '300000000000000001';
const ROLE = '400000000000000001';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type CallType = 'reply' | 'defer' | 'edit' | 'followUp' | 'respond';
interface Call {
  type: CallType;
  payload: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface SpyLogger extends Logger {
  entries: Array<{ level: string; msg: string; meta?: Record<string, unknown> }>;
}

function spyLogger(): SpyLogger {
  const entries: SpyLogger['entries'] = [];
  const log: SpyLogger = {
    entries,
    debug: (msg, meta) => entries.push({ level: 'debug', msg, meta }),
    info: (msg, meta) => entries.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => entries.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => entries.push({ level: 'error', msg, meta }),
    child: () => log,
  };
  return log;
}

function summaryFor(id: number, over: Partial<BaselineSummary> = {}): BaselineSummary {
  return {
    watchId: id,
    pagesTracked: 12,
    pagesKnown: 40,
    files: 2,
    subdomains: 5,
    buildId: 'KU79abcdefghijklmnop',
    assets: 23,
    homeStatus: 200,
    homeBlocked: false,
    durationMs: 4200,
    ...over,
  };
}

function fakeMonitor(store: Store, timeline: string[]) {
  const calls = {
    baseline: [] as number[],
    added: [] as Watch[],
    removed: [] as number[],
    updated: [] as Watch[],
    checkNow: [] as Array<[number, { full?: boolean } | undefined]>,
  };
  const m = {
    calls,
    baselineImpl: async (id: number): Promise<BaselineSummary> => {
      store.updateWatch(id, { baselineDone: true });
      return summaryFor(id);
    },
    checkNowImpl: async (id: number): Promise<TickSummary> => ({ watchId: id, alerts: [], durationMs: 1200, error: null }),
    runtimeImpl: (): WatchRuntimeInfo => ({ running: true, lastTickAt: 1, lastTickMs: 850, nextTickAt: Date.now() + 30_000, baselineRunning: false }),
    async runBaseline(id: number) {
      calls.baseline.push(id);
      timeline.push('baseline');
      return m.baselineImpl(id);
    },
    onWatchAdded(w: Watch) {
      calls.added.push(w);
      timeline.push('added');
    },
    onWatchRemoved(id: number) {
      calls.removed.push(id);
    },
    onWatchUpdated(w: Watch) {
      calls.updated.push(w);
    },
    checkNow(id: number, opts?: { full?: boolean }) {
      calls.checkNow.push([id, opts]);
      return m.checkNowImpl(id);
    },
    runtimeInfo(): WatchRuntimeInfo {
      return m.runtimeImpl();
    },
    lastActivityAt: () => null,
  };
  return m;
}

interface ChatOpts {
  sub: string;
  options?: Record<string, unknown>;
  guildId?: string | null;
  channelId?: string;
  manage?: boolean;
}

/** Minimal ChatInputCommandInteraction: only the members the handlers use, with discord.js' reply-state rules. */
function fakeChat(o: ChatOpts, timeline: string[] = []) {
  const calls: Call[] = [];
  const opts = o.options ?? {};
  const get = (name: string) => (opts[name] === undefined ? null : opts[name]);
  const i = {
    guildId: o.guildId === undefined ? GUILD : o.guildId,
    channelId: o.channelId ?? CHANNEL,
    user: { id: USER },
    deferred: false,
    replied: false,
    memberPermissions: { has: (p: bigint) => o.manage !== false && p === PermissionFlagsBits.ManageGuild },
    inGuild() {
      return this.guildId !== null;
    },
    options: {
      getSubcommand: () => o.sub,
      getString(name: string, required?: boolean) {
        const v = get(name);
        if (v === null && required) throw new TypeError(`Required option "${name}" not found.`);
        return v === null ? null : String(v);
      },
      getInteger: (name: string) => (get(name) === null ? null : Number(get(name))),
      getBoolean: (name: string) => (get(name) === null ? null : Boolean(get(name))),
      getChannel: (name: string) => (get(name) === null ? null : { id: String(get(name)), type: ChannelType.GuildText }),
      getRole: (name: string) => (get(name) === null ? null : { id: String(get(name)) }),
    },
    async reply(payload: unknown) {
      if (this.deferred || this.replied) throw new Error('InteractionAlreadyReplied');
      this.replied = true;
      calls.push({ type: 'reply', payload });
      timeline.push('reply');
    },
    async deferReply(payload: unknown) {
      if (this.deferred || this.replied) throw new Error('InteractionAlreadyReplied');
      this.deferred = true;
      calls.push({ type: 'defer', payload });
      timeline.push('defer');
    },
    async editReply(payload: unknown) {
      if (!this.deferred && !this.replied) throw new Error('InteractionNotReplied');
      this.replied = true;
      calls.push({ type: 'edit', payload });
      timeline.push('edit');
    },
    async followUp(payload: unknown) {
      if (!this.deferred && !this.replied) throw new Error('InteractionNotReplied');
      calls.push({ type: 'followUp', payload });
    },
  };
  return { i: i as unknown as ChatInputCommandInteraction, calls, raw: i };
}

function fakeButton(customId: string, o: { guildId?: string | null; manage?: boolean } = {}) {
  const calls: Call[] = [];
  const i = {
    customId,
    guildId: o.guildId === undefined ? GUILD : o.guildId,
    channelId: CHANNEL,
    user: { id: USER },
    deferred: false,
    replied: false,
    memberPermissions: { has: (p: bigint) => o.manage !== false && p === PermissionFlagsBits.ManageGuild },
    inGuild() {
      return this.guildId !== null;
    },
    async reply(payload: unknown) {
      if (this.deferred || this.replied) throw new Error('InteractionAlreadyReplied');
      this.replied = true;
      calls.push({ type: 'reply', payload });
    },
    async deferReply(payload: unknown) {
      this.deferred = true;
      calls.push({ type: 'defer', payload });
    },
    async editReply(payload: unknown) {
      if (!this.deferred && !this.replied) throw new Error('InteractionNotReplied');
      this.replied = true;
      calls.push({ type: 'edit', payload });
    },
    async followUp(payload: unknown) {
      calls.push({ type: 'followUp', payload });
    },
  };
  return { i: i as unknown as ButtonInteraction, calls };
}

function fakeAutocomplete(focused: { name: string; value: string }, guildId: string | null = GUILD) {
  const calls: Call[] = [];
  const i = {
    guildId,
    responded: false,
    inGuild: () => guildId !== null,
    options: { getFocused: (full?: boolean) => (full ? focused : focused.value) },
    async respond(choices: unknown) {
      this.responded = true;
      calls.push({ type: 'respond', payload: choices });
    },
  };
  return { i: i as unknown as AutocompleteInteraction, calls };
}

/** All human-visible text of a reply payload. */
function textOf(call: Call | undefined): string {
  if (!call) return '';
  const p = call.payload ?? {};
  const parts: string[] = [p.content ?? ''];
  for (const e of p.embeds ?? []) {
    parts.push(e.title ?? '', e.description ?? '');
    for (const f of e.fields ?? []) parts.push(`${f.name}: ${f.value}`);
    if (e.footer) parts.push(e.footer.text);
  }
  return parts.join('\n');
}

const isEphemeral = (call: Call | undefined) => Boolean(call && (call.payload?.flags ?? 0) & 64);
const last = (calls: Call[]) => calls[calls.length - 1];

function page(watchId: number, url: string, over: Partial<PageRecord> = {}): PageRecord {
  return {
    watchId,
    url,
    kind: 'page',
    tracked: true,
    title: null,
    text: 'hello',
    textHash: 'abc',
    etag: null,
    lastModified: null,
    contentLength: null,
    contentType: 'text/html',
    status: 200,
    failCount: 0,
    gone: false,
    maskNumbers: false,
    numericChangeTimes: [],
    flapCount: 0,
    dynamic: false,
    pendingHash: null,
    pendingSince: null,
    hashHistory: [],
    changeTimes: [],
    maskedLines: [],
    source: 'link',
    depth: 1,
    firstSeen: 1,
    lastChecked: 1,
    lastChanged: null,
    ...over,
  };
}

function subdomain(watchId: number, host: string, alive: boolean, over: Partial<SubdomainRecord> = {}): SubdomainRecord {
  return { watchId, host, sources: ['ct'], firstSeen: 1, lastSeen: 1, alive, lastProbe: 1, dns: null, http: null, ...over };
}

// ---------------------------------------------------------------------------

let store: Store;
let timeline: string[];
let mon: ReturnType<typeof fakeMonitor>;
let log: SpyLogger;
let config: Config;
let deps: CommandDeps;

function makeWatch(url = 'https://unpeg.io/', over: Partial<Parameters<Store['createWatch']>[0]> = {}): Watch {
  const u = new URL(url);
  const w = store.createWatch({
    guildId: GUILD,
    channelId: ALERTS,
    name: 'Unpeg',
    url,
    host: u.hostname,
    rootDomain: 'unpeg.io',
    createdBy: USER,
    ...over,
  });
  return store.updateWatch(w.id, { baselineDone: true });
}

async function run(o: ChatOpts) {
  const f = fakeChat(o, timeline);
  await handleChatInput(f.i, deps);
  return f;
}

beforeEach(() => {
  store = new Store(':memory:');
  timeline = [];
  mon = fakeMonitor(store, timeline);
  log = spyLogger();
  config = testConfig({ minIntervalSec: 10, defaultIntervalSec: 30 });
  deps = { store, monitor: mon as unknown as Monitor, config, log };
});

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

describe('commandDefinitions', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const defs = commandDefinitions({ minIntervalSec: 10 }) as any[];
  const cmd = defs[0];
  const subs = new Map<string, any>(cmd.options.map((o: any) => [o.name, o])); // eslint-disable-line @typescript-eslint/no-explicit-any

  it('is one guild-only /watch command gated by Manage Server', () => {
    expect(defs).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(defs))).toEqual(defs);
    expect(cmd.name).toBe('watch');
    expect(cmd.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
    expect(cmd.dm_permission).toBe(false);
    expect(cmd.contexts).toEqual([0]);
  });

  it('has every subcommand', () => {
    expect([...subs.keys()].sort()).toEqual(
      ['add', 'addpage', 'check', 'exclude', 'help', 'history', 'ignore', 'info', 'list', 'pages', 'pause', 'remove', 'resume', 'set', 'subdomains'].sort(),
    );
    for (const s of subs.values()) expect(s.type).toBe(ApplicationCommandOptionType.Subcommand);
  });

  it('respects Discord naming and size limits', () => {
    let chars = 0;
    const visit = (o: any, depth: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(o.name).toMatch(/^[-_\p{Ll}\p{N}]{1,32}$/u);
      expect(o.description.length).toBeGreaterThan(0);
      expect(o.description.length).toBeLessThanOrEqual(100);
      chars += o.name.length + o.description.length;
      for (const c of o.choices ?? []) chars += c.name.length + String(c.value).length;
      const opts = o.options ?? [];
      expect(opts.length).toBeLessThanOrEqual(25);
      if (depth > 0) {
        // required options first
        const firstOptional = opts.findIndex((x: any) => !x.required); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (firstOptional >= 0) expect(opts.slice(firstOptional).every((x: any) => !x.required)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
      }
      const names = opts.map((x: any) => x.name); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(new Set(names).size).toBe(names.length);
      for (const c of opts) visit(c, depth + 1);
    };
    visit(cmd, 0);
    expect(chars).toBeLessThanOrEqual(8000);
  });

  it('declares the documented options', () => {
    const opt = (sub: string, name: string) => subs.get(sub).options?.find((o: any) => o.name === name); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(opt('add', 'url')).toMatchObject({ type: ApplicationCommandOptionType.String, required: true });
    expect(opt('add', 'interval')).toMatchObject({ type: ApplicationCommandOptionType.Integer, min_value: 10, max_value: 3600 });
    expect(opt('add', 'channel').channel_types).toEqual([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
    expect(opt('add', 'ping').type).toBe(ApplicationCommandOptionType.Role);
    expect(opt('add', 'max_pages')).toMatchObject({ min_value: 1, max_value: 1000 });
    for (const s of ['name', 'crawl', 'scope', 'subdomains']) expect(opt('add', s), s).toBeDefined();
    expect(opt('add', 'crawl').type).toBe(ApplicationCommandOptionType.Boolean);
    for (const sub of ['remove', 'info', 'check', 'pause', 'resume', 'set', 'ignore', 'exclude', 'addpage', 'pages', 'subdomains', 'history']) {
      expect(opt(sub, 'site')).toMatchObject({ required: true, autocomplete: true, type: ApplicationCommandOptionType.String });
    }
    expect(opt('set', 'sweep')).toMatchObject({ min_value: 30, max_value: 86_400 });
    for (const f of ['deploy', 'text', 'pages', 'subdomains', 'files', 'status', 'code_intel', 'ignore_numbers', 'clear_ping']) {
      expect(opt('set', f)?.type).toBe(ApplicationCommandOptionType.Boolean);
    }
    expect(opt('ignore', 'pattern')).toMatchObject({ required: true });
    expect(opt('addpage', 'url')).toMatchObject({ required: true });
    expect(opt('history', 'limit')).toMatchObject({ min_value: 1, max_value: 25 });
    expect(opt('check', 'full').type).toBe(ApplicationCommandOptionType.Boolean);
  });

  it('keeps interval bounds valid for odd configs', () => {
    const d = commandDefinitions({ minIntervalSec: 99_999 })[0] as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const interval = d.options.find((o: any) => o.name === 'add').options.find((o: any) => o.name === 'interval'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(interval.min_value).toBeLessThanOrEqual(interval.max_value);
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe('guards', () => {
  it('requires a guild', async () => {
    const f = await run({ sub: 'list', guildId: null });
    expect(textOf(last(f.calls))).toContain('only works inside a server');
    expect(isEphemeral(last(f.calls))).toBe(true);
  });

  it('requires Manage Server for mutating subcommands but not for views', async () => {
    makeWatch();
    for (const sub of ['add', 'remove', 'set', 'pause', 'resume', 'ignore', 'exclude', 'addpage', 'check']) {
      const f = await run({ sub, manage: false, options: { site: 'Unpeg', url: 'x.io', pattern: 'x' } });
      expect(textOf(last(f.calls))).toContain('Manage Server');
      expect(isEphemeral(last(f.calls))).toBe(true);
    }
    expect(store.listWatches()).toHaveLength(1);
    const f = await run({ sub: 'list', manage: false });
    expect(textOf(last(f.calls))).toContain('Unpeg');
  });

  it('unknown sites give the documented message', async () => {
    const other = store.createWatch({ guildId: OTHER_GUILD, channelId: 'c', name: 'Else', url: 'https://else.io/', host: 'else.io', rootDomain: 'else.io', createdBy: 'u' });
    for (const site of ['nope', String(other.id), 'else.io']) {
      const f = await run({ sub: 'info', options: { site } });
      expect(last(f.calls).payload.content).toBe('⚠️ Unknown site. Use /watch list.');
      expect(isEphemeral(last(f.calls))).toBe(true);
    }
    expect(log.entries.filter((e) => e.level === 'error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe('/watch add', () => {
  it('creates, defers publicly, runs the baseline, edits the reply, then starts the watch', async () => {
    const f = await run({ sub: 'add', options: { url: 'unpeg.io', channel: ALERTS } });
    const [w] = store.listWatches(GUILD);
    expect(w).toMatchObject({ url: 'https://unpeg.io/', host: 'unpeg.io', rootDomain: 'unpeg.io', name: 'Unpeg', channelId: ALERTS, intervalSec: 30, createdBy: USER });
    expect(timeline).toEqual(['defer', 'baseline', 'edit', 'added']);
    expect(isEphemeral(f.calls[0])).toBe(false);
    expect(mon.calls.baseline).toEqual([w.id]);
    expect(mon.calls.added[0]).toMatchObject({ id: w.id, baselineDone: true });
    const text = textOf(last(f.calls));
    expect(text).toContain('✅ Watching Unpeg');
    expect(text).toContain(`https://unpeg.io/ in <#${ALERTS}> — every 30s`);
    expect(text).toContain('Baseline: 12 pages, 2 files, 5 subdomains, build `KU79abcd…`');
    expect(text).not.toContain('⚠️');
    expect(last(f.calls).payload.allowedMentions).toEqual({ parse: [] });
  });

  it('applies options: name, interval, ping, subdomains, scope, max_pages', async () => {
    await run({
      sub: 'add',
      options: { url: 'https://unpeg.io/docs', name: '  Unpeg   Docs ', interval: 60, ping: ROLE, subdomains: false, scope: 'docs/', max_pages: 20 },
    });
    const [w] = store.listWatches(GUILD);
    expect(w).toMatchObject({
      url: 'https://unpeg.io/docs',
      name: 'Unpeg Docs',
      channelId: CHANNEL,
      intervalSec: 60,
      pingRoleId: ROLE,
      scopePath: '/docs',
      maxPages: 20,
    });
    expect(w.features.subdomains).toBe(false);
    expect(w.features.pages).toBe(true);
  });

  it('crawl:false tracks only the start URL', async () => {
    await run({ sub: 'add', options: { url: 'unpeg.io', crawl: false, max_pages: 50 } });
    const [w] = store.listWatches(GUILD);
    expect(w.features.pages).toBe(false);
    expect(w.maxPages).toBe(1);
  });

  it.each([
    ['not a url at all', "doesn't look like a website URL"],
    ['ftp://unpeg.io', "doesn't look like a website URL"],
    ['javascript:alert(1)', "doesn't look like a website URL"],
    ['localhostx', "doesn't look like a website URL"],
  ])('rejects %s', async (url, msg) => {
    const f = await run({ sub: 'add', options: { url } });
    expect(textOf(last(f.calls))).toContain(msg);
    expect(isEphemeral(last(f.calls))).toBe(true);
    expect(store.listWatches()).toHaveLength(0);
    expect(mon.calls.baseline).toHaveLength(0);
  });

  it('rejects duplicates, including the other scheme', async () => {
    await run({ sub: 'add', options: { url: 'unpeg.io' } });
    for (const url of ['https://unpeg.io', 'http://unpeg.io/', 'UNPEG.IO/']) {
      const f = await run({ sub: 'add', options: { url } });
      expect(textOf(last(f.calls))).toContain('Already watching https://unpeg.io/');
      expect(isEphemeral(last(f.calls))).toBe(true);
    }
    expect(store.listWatches()).toHaveLength(1);
  });

  it('names a second watch of the same site after its path or subdomain', async () => {
    await run({ sub: 'add', options: { url: 'unpeg.io' } });
    await run({ sub: 'add', options: { url: 'unpeg.io/docs' } });
    await run({ sub: 'add', options: { url: 'unpeg.io/2026' } });
    expect(store.listWatches(GUILD).map((w) => w.name)).toEqual(['Unpeg', 'Unpeg docs', 'Unpeg 2']);
    const f = await run({ sub: 'add', options: { url: 'unpeg.io/blog', name: 'unpeg' } });
    expect(textOf(last(f.calls))).toContain('already exists');
  });

  it.each([
    [{ interval: 5 }, '`interval` must be between 10 and 3600s'],
    [{ interval: 3601 }, '`interval` must be between 10 and 3600s'],
    [{ max_pages: 0 }, '`max_pages` must be between 1 and 1000'],
    [{ name: '123' }, 'cannot be just a number'],
    [{ name: '   ' }, 'cannot be empty'],
    [{ scope: '/has space' }, 'path prefix'],
  ])('validates %o', async (extra, msg) => {
    const f = await run({ sub: 'add', options: { url: 'unpeg.io', ...extra } });
    expect(textOf(last(f.calls))).toContain(msg);
    expect(isEphemeral(last(f.calls))).toBe(true);
    expect(store.listWatches()).toHaveLength(0);
  });

  it('keeps the watch when the baseline fails and still starts it', async () => {
    mon.baselineImpl = async () => {
      throw new Error('ECONNRESET');
    };
    const f = await run({ sub: 'add', options: { url: 'unpeg.io' } });
    expect(store.listWatches()).toHaveLength(1);
    expect(textOf(last(f.calls))).toContain('The first scan failed (ECONNRESET)');
    expect(mon.calls.added).toHaveLength(1);
  });

  it('warns about blocked / unreachable homepages and non-persistent storage', async () => {
    mon.baselineImpl = async (id) => summaryFor(id, { homeBlocked: true, homeStatus: 403 });
    deps.config = testConfig({ minIntervalSec: 10, dataDirPersistent: false });
    let f = await run({ sub: 'add', options: { url: 'unpeg.io' } });
    let text = textOf(last(f.calls));
    expect(text).toContain('bot challenge to the watcher (HTTP 403)');
    expect(text).toContain('nothing can be checked until it stops');
    expect(text).toContain('Storage is not persistent');
    expect(text).toContain('DATA_DIR');

    mon.baselineImpl = async (id) => summaryFor(id, { homeStatus: 0, buildId: null });
    f = await run({ sub: 'add', options: { url: 'b.unpeg.io' } });
    text = textOf(last(f.calls));
    expect(text).toContain('homepage was unreachable');
    expect(text).toContain('23 bundles');
  });

  it('handles a watch removed while its baseline was running', async () => {
    mon.baselineImpl = async (id) => {
      store.deleteWatch(id);
      return summaryFor(id);
    };
    const f = await run({ sub: 'add', options: { url: 'unpeg.io' } });
    expect(textOf(last(f.calls))).toContain('was removed while its first scan was running');
    expect(mon.calls.added).toHaveLength(0);
  });

  it('a second watch of a site whose subdomains are already tracked gets subdomains off, with a note', async () => {
    await run({ sub: 'add', options: { url: 'unpeg.io' } });
    const f = await run({ sub: 'add', options: { url: 'docs.unpeg.io' } });
    const [first, second] = store.listWatches(GUILD);
    expect(second).toMatchObject({ name: 'Unpeg docs', host: 'docs.unpeg.io' });
    expect(second.features.subdomains).toBe(false);
    const text = textOf(last(f.calls));
    expect(text).toContain(`already tracked by **#${first.id} Unpeg**`);

    // Explicit subdomains:true is honoured; a different site is unaffected.
    await run({ sub: 'add', options: { url: 'app.unpeg.io', subdomains: true } });
    await run({ sub: 'add', options: { url: 'other.io' } });
    const byHost = Object.fromEntries(store.listWatches(GUILD).map((w) => [w.host, w.features.subdomains]));
    expect(byHost['app.unpeg.io']).toBe(true);
    expect(byHost['other.io']).toBe(true);
  });

  it('warns when another watch already covers the same host (duplicate redeploy/uptime alerts)', async () => {
    await run({ sub: 'add', options: { url: 'unpeg.io' } });
    const f = await run({ sub: 'add', options: { url: 'unpeg.io/docs' } });
    expect(textOf(last(f.calls))).toContain('Redeploy and uptime alerts for unpeg.io already come from **#1 Unpeg**');
  });

  it('refuses more watches than the per-server limit', async () => {
    deps.config = testConfig({ minIntervalSec: 10, maxWatchesPerGuild: 2 });
    await run({ sub: 'add', options: { url: 'a.io' } });
    await run({ sub: 'add', options: { url: 'b.io' } });
    const f = await run({ sub: 'add', options: { url: 'c.io' } });
    expect(textOf(last(f.calls))).toContain('already watches 2 sites (the limit)');
    expect(store.listWatches(GUILD)).toHaveLength(2);
  });

  it('says so when the start URL redirected to another host', async () => {
    mon.baselineImpl = async (id) => {
      store.updateWatch(id, { baselineDone: true, url: 'https://www.unpeg.io/', host: 'www.unpeg.io' });
      return summaryFor(id, { redirectedTo: { from: 'unpeg.io', to: 'www.unpeg.io', adopted: true } });
    };
    let f = await run({ sub: 'add', options: { url: 'unpeg.io' } });
    expect(textOf(last(f.calls))).toContain('unpeg.io redirects to **www.unpeg.io** — watching that.');
    mon.baselineImpl = async (id) => summaryFor(id, { redirectedTo: { from: 'old.io', to: 'new.example', adopted: false } });
    f = await run({ sub: 'add', options: { url: 'old.io' } });
    expect(textOf(last(f.calls))).toContain('only the start page can be checked');
  });

  it('replies before the interaction token expires when the first scan runs very long, and starts the watch later', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (s: BaselineSummary) => void;
      mon.baselineImpl = (id) => new Promise<BaselineSummary>((r) => (finish = r)).then((s) => ({ ...s, watchId: id }));
      const pending = run({ sub: 'add', options: { url: 'unpeg.io' } });
      await vi.advanceTimersByTimeAsync(REPLY_DEADLINE_MS + 1000);
      const f = await pending;
      expect(textOf(last(f.calls))).toContain('Still scanning');
      expect(mon.calls.added).toHaveLength(0);
      finish(summaryFor(0));
      await vi.advanceTimersByTimeAsync(10);
      expect(mon.calls.added).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives an expired interaction (defer/edit failures)', async () => {
    const f = fakeChat({ sub: 'add', options: { url: 'unpeg.io' } }, timeline);
    f.raw.deferReply = async () => {
      throw new Error('Unknown interaction');
    };
    await handleChatInput(f.i, deps);
    expect(store.listWatches()).toHaveLength(1);
    expect(mon.calls.added).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Other subcommands
// ---------------------------------------------------------------------------

describe('delivery problems', () => {
  it('info, check and list warn when the alert channel was deleted', async () => {
    makeWatch();
    const withGuild = async (o: ChatOpts) => {
      const f = fakeChat(o, timeline);
      (f.raw as unknown as Record<string, unknown>).guild = { channels: { cache: new Map([['999', {}]]) }, members: { me: {} } };
      await handleChatInput(f.i, deps);
      return f;
    };
    expect(textOf(last((await withGuild({ sub: 'info', options: { site: 'Unpeg' } })).calls))).toContain(`alert channel <#${ALERTS}> no longer exists`);
    expect(textOf(last((await withGuild({ sub: 'check', options: { site: 'Unpeg' } })).calls))).toContain('no longer exists');
    expect(textOf(last((await withGuild({ sub: 'list' })).calls))).toContain(`<#${ALERTS}> ⚠️`);
  });
});

describe('/watch remove, list, pause, resume', () => {
  it('remove deletes the watch and stops its loops', async () => {
    const w = makeWatch();
    const f = await run({ sub: 'remove', options: { site: String(w.id) } });
    expect(store.getWatch(w.id)).toBeUndefined();
    expect(mon.calls.removed).toEqual([w.id]);
    expect(last(f.calls).payload.content).toBe('🗑️ Stopped watching **Unpeg** (<https://unpeg.io/>).');
    expect(isEphemeral(last(f.calls))).toBe(false);
  });

  it('list shows every guild watch publicly', async () => {
    makeWatch();
    const b = makeWatch('https://beta.unpeg.io/', { name: 'Beta_Site', intervalSec: 60, features: { text: false } });
    store.updateWatch(b.id, { paused: true });
    store.createWatch({ guildId: OTHER_GUILD, channelId: 'c', name: 'Hidden', url: 'https://x.io/', host: 'x.io', rootDomain: 'x.io', createdBy: 'u' });
    const f = await run({ sub: 'list' });
    const text = textOf(last(f.calls));
    expect(isEphemeral(last(f.calls))).toBe(false);
    expect(text).toContain('Watched sites (2)');
    expect(text).toContain(`**#1 Unpeg** — https://unpeg.io/ · every 30s · <#${ALERTS}> · all checks`);
    expect(text).toContain('**#2 Beta\\_Site** — https://beta.unpeg.io/ · every 60s');
    expect(text).toContain('⏸️ paused');
    expect(text).not.toContain('text changes,');
    expect(text).not.toContain('Hidden');
  });

  it('list with no watches explains how to add one', async () => {
    const f = await run({ sub: 'list' });
    expect(textOf(last(f.calls))).toContain('/watch add');
  });

  it('pause / resume update the watch and the monitor', async () => {
    const w = makeWatch();
    let f = await run({ sub: 'pause', options: { site: 'unpeg' } });
    expect(store.getWatch(w.id)!.paused).toBe(true);
    expect(mon.calls.updated.at(-1)).toMatchObject({ id: w.id, paused: true });
    expect(textOf(last(f.calls))).toContain('Paused **Unpeg**');

    f = await run({ sub: 'pause', options: { site: 'unpeg' } });
    expect(textOf(last(f.calls))).toContain('already paused');
    expect(isEphemeral(last(f.calls))).toBe(true);
    expect(mon.calls.updated).toHaveLength(1);

    f = await run({ sub: 'resume', options: { site: 'https://unpeg.io' } });
    expect(store.getWatch(w.id)!.paused).toBe(false);
    expect(mon.calls.updated.at(-1)).toMatchObject({ paused: false });
    expect(textOf(last(f.calls))).toContain('Resumed **Unpeg**');
  });
});

describe('/watch info, pages, subdomains, history, help', () => {
  it('info shows settings, counts, state and runtime (ephemeral)', async () => {
    const w = makeWatch('https://unpeg.io/', { pingRoleId: ROLE, ignorePatterns: ['Last updated.*'], extraUrls: ['https://unpeg.io/secret'] });
    store.upsertPages([
      page(w.id, 'https://unpeg.io/', { title: 'Home' }),
      page(w.id, 'https://unpeg.io/docs', { dynamic: true }),
      page(w.id, 'https://unpeg.io/old', { gone: true }),
      page(w.id, 'https://unpeg.io/known', { tracked: false }),
      page(w.id, 'https://unpeg.io/w.pdf', { kind: 'file', text: null }),
    ]);
    store.upsertSubdomains([subdomain(w.id, 'a.unpeg.io', true), subdomain(w.id, 'b.unpeg.io', false)]);
    const state = defaultWatchState();
    state.deploy = { assets: ['a', 'b'], buildId: 'KU79xyz', generator: 'Next.js', sig: 's', seenAt: 1 };
    state.lastCheckAt = 1_700_000_000_000;
    state.lastError = 'boom `x`';
    store.saveState(w.id, state);

    const f = await run({ sub: 'info', options: { site: 'Unpeg' } });
    expect(isEphemeral(last(f.calls))).toBe(true);
    const text = textOf(last(f.calls));
    expect(text).toContain(`#${w.id} Unpeg`);
    expect(text).toContain(`Channel: <#${ALERTS}>`);
    expect(text).toContain('Schedule: every 30s · all pages ~2m');
    expect(text).toContain('Pages: 3 tracked (max 150) · 4 known\n1 files · 1 gone · 1 too dynamic');
    expect(text).toContain('Subdomains: 2 known · 1 live');
    expect(text).toContain('`KU79xyz` · 2 bundles · Next.js');
    expect(text).toContain('Last check: <t:1700000000:R>');
    expect(text).toContain('Last change: never');
    expect(text).toContain(`Ping: <@&${ROLE}>`);
    expect(text).toContain('Last error: `boom ˋxˋ`');
    expect(text).toContain('Ignored text: `Last updated.*`');
    expect(text).toContain('Extra pages: https://unpeg.io/secret');
    expect(text).toContain('Runtime: running · last check took 850ms · next <t:');
    expect(text).toContain('✅ redeploys');
  });

  it('info survives a monitor without runtime info', async () => {
    makeWatch();
    mon.runtimeImpl = () => {
      throw new Error('not implemented');
    };
    const f = await run({ sub: 'info', options: { site: 'Unpeg' } });
    expect(textOf(last(f.calls))).toContain('Runtime: unknown');
  });

  it('pages lists tracked pages with counts (ephemeral)', async () => {
    const w = makeWatch();
    store.upsertPages([
      page(w.id, 'https://unpeg.io/', { title: 'Home *page*', depth: 0 }),
      page(w.id, 'https://unpeg.io/docs', { dynamic: true }),
      page(w.id, 'https://unpeg.io/known', { tracked: false }),
      page(w.id, 'https://unpeg.io/w.pdf', { kind: 'file', text: null }),
    ]);
    const f = await run({ sub: 'pages', options: { site: 'Unpeg' } });
    expect(isEphemeral(last(f.calls))).toBe(true);
    const text = textOf(last(f.calls));
    expect(text).toContain('**2** tracked · **3** known · **1** files · **0** gone · **1** too dynamic to diff');
    expect(text).toContain('`/` · Home \\*page\\*');
    expect(text).toContain('`/docs` · _dynamic_');
    expect(text).toContain('Files: `/w.pdf`');
  });

  it('pages caps the list at 40', async () => {
    const w = makeWatch();
    store.upsertPages(Array.from({ length: 55 }, (_, n) => page(w.id, `https://unpeg.io/p${n}`)));
    const f = await run({ sub: 'pages', options: { site: 'Unpeg' } });
    const desc: string = last(f.calls).payload.embeds[0].description;
    expect(desc.split('\n').filter((l) => l.startsWith('`/p'))).toHaveLength(40);
    expect(desc).toContain('…and 15 more');
  });

  it('subdomains lists live hosts first (ephemeral)', async () => {
    const w = makeWatch();
    store.upsertSubdomains([
      subdomain(w.id, 'a.unpeg.io', false, { sources: ['dns'] }),
      subdomain(w.id, 'b.unpeg.io', true, { sources: ['ct', 'code'] }),
    ]);
    const f = await run({ sub: 'subdomains', options: { site: 'Unpeg' } });
    expect(isEphemeral(last(f.calls))).toBe(true);
    const text = textOf(last(f.calls));
    expect(text).toContain('**2** known · **1** live');
    expect(text.indexOf('🟢 `b.unpeg.io` · CT, code')).toBeLessThan(text.indexOf('⚪ `a.unpeg.io` · DNS'));
  });

  it('history shows newest first and honours limit', async () => {
    const w = makeWatch();
    store.addEvent(w.id, 'deploy', 'redeployed: build a → b', 1_700_000_000_000);
    store.addEvent(w.id, 'text', 'text changed on /docs', 1_700_000_100_000);
    store.addEvent(w.id, 'new_pages', '1 new page: /x_y', 1_700_000_200_000);
    const f = await run({ sub: 'history', options: { site: 'Unpeg', limit: 2 } });
    expect(isEphemeral(last(f.calls))).toBe(true);
    expect(last(f.calls).payload.embeds[0].description).toBe(
      '<t:1700000200:R> 🆕 1 new page: /x\\_y\n<t:1700000100:R> 📝 text changed on /docs',
    );
    const empty = await run({ sub: 'history', options: { site: 'Unpeg', limit: 30 } });
    expect(textOf(last(empty.calls))).toContain('between 1 and 25');
  });

  it('help is an ephemeral embed', async () => {
    const f = await run({ sub: 'help' });
    expect(isEphemeral(last(f.calls))).toBe(true);
    const text = textOf(last(f.calls));
    expect(text).toContain('Redeploys');
    expect(text).toContain('/watch add');
  });
});

describe('/watch check', () => {
  it('defers ephemerally and reports no changes', async () => {
    const w = makeWatch();
    const f = await run({ sub: 'check', options: { site: 'Unpeg', full: true } });
    expect(f.calls[0].type).toBe('defer');
    expect(isEphemeral(f.calls[0])).toBe(true);
    expect(mon.calls.checkNow).toEqual([[w.id, { full: true }]]);
    expect(last(f.calls).payload.content).toBe('✅ No changes on **Unpeg** (full check) — took 1s.');
  });

  it('reports sent alerts and errors', async () => {
    makeWatch();
    const alerts: Alert[] = [{ kind: 'info', message: 'a' }, { kind: 'info', message: 'b' }, { kind: 'text', changes: [], groups: [] }];
    mon.checkNowImpl = async (id) => ({ watchId: id, alerts, durationMs: 300, error: 'HTTP 502 on /docs' });
    const f = await run({ sub: 'check', options: { site: 'Unpeg' } });
    const text = textOf(last(f.calls));
    expect(text).toContain(`📣 Found 3 changes (notes, text changes) — posted to <#${ALERTS}>`);
    expect(text).toContain('⚠️ HTTP 502 on /docs');
  });

  it('a check that did not complete is not reported as "No changes"', async () => {
    makeWatch();
    mon.checkNowImpl = async (id) => ({ watchId: id, alerts: [], durationMs: 120_000, error: 'check timed out after 120s' });
    const f = await run({ sub: 'check', options: { site: 'Unpeg' } });
    const text = textOf(last(f.calls));
    expect(text).not.toContain('✅');
    expect(text).not.toContain('No changes');
    expect(text).toContain("didn't complete");
    expect(text).toContain('check timed out after 120s');
  });

  it('labels alert kinds for humans', async () => {
    makeWatch();
    mon.checkNowImpl = async (id) => ({ watchId: id, alerts: [{ kind: 'new_pages', pages: [] }], durationMs: 10, error: null });
    const f = await run({ sub: 'check', options: { site: 'Unpeg' } });
    expect(textOf(last(f.calls))).toContain('(new pages)');
    expect(textOf(last(f.calls))).not.toContain('new_pages');
  });

  it('answers before the interaction token expires when a check runs very long', async () => {
    vi.useFakeTimers();
    try {
      makeWatch();
      let finish!: (t: TickSummary) => void;
      mon.checkNowImpl = (id) => new Promise<TickSummary>((r) => (finish = r)).then((t) => ({ ...t, watchId: id }));
      const pending = run({ sub: 'check', options: { site: 'Unpeg' } });
      await vi.advanceTimersByTimeAsync(REPLY_DEADLINE_MS + 1000);
      const f = await pending;
      expect(textOf(last(f.calls))).toContain('Still checking');
      finish({ watchId: 0, alerts: [], durationMs: 1, error: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns a crashing check into an error reply and logs it', async () => {
    makeWatch();
    mon.checkNowImpl = async () => {
      throw new Error('boom');
    };
    const f = await run({ sub: 'check', options: { site: 'Unpeg' } });
    expect(last(f.calls)).toMatchObject({ type: 'edit' });
    expect(last(f.calls).payload.content).toBe('⚠️ boom');
    expect(log.entries.some((e) => e.level === 'error' && e.msg.includes('/watch check'))).toBe(true);
  });
});

describe('/watch set', () => {
  it('applies and reports changes', async () => {
    const w = makeWatch();
    const f = await run({
      sub: 'set',
      options: { site: 'Unpeg', interval: 60, sweep: 600, text: false, code_intel: false, ping: ROLE, ignore_numbers: true, scope: '/docs/', channel: CHANNEL, name: 'Unpeg Main', max_pages: 300 },
    });
    const updated = store.getWatch(w.id)!;
    expect(updated).toMatchObject({ intervalSec: 60, sweepSec: 600, pingRoleId: ROLE, maskNumbers: true, scopePath: '/docs', channelId: CHANNEL, name: 'Unpeg Main', maxPages: 300 });
    expect(updated.features).toMatchObject({ text: false, codeIntel: false, deploy: true, subdomains: true });
    expect(mon.calls.updated).toHaveLength(1);
    const text = textOf(last(f.calls));
    expect(isEphemeral(last(f.calls))).toBe(false);
    for (const s of ['interval: 30s → 60s', 'full sweep: 120s → 600s', 'text changes: off', 'code intel: off', `ping: none → <@&${ROLE}>`, 'scope: whole site → `/docs`', `channel: <#${ALERTS}> → <#${CHANNEL}>`, 'name: **Unpeg** → **Unpeg Main**', 'max pages: 150 → 300', 'ignore number-only changes: on']) {
      expect(text).toContain(s);
    }
  });

  it('clears ping and scope', async () => {
    const w = makeWatch('https://unpeg.io/', { pingRoleId: ROLE, scopePath: '/docs' });
    await run({ sub: 'set', options: { site: 'Unpeg', clear_ping: true, scope: 'none' } });
    expect(store.getWatch(w.id)).toMatchObject({ pingRoleId: null, scopePath: null });
  });

  it('rejects conflicting / invalid / empty input', async () => {
    const w = makeWatch();
    makeWatch('https://beta.unpeg.io/', { name: 'Beta' });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ping: ROLE, clear_ping: true }, 'not both'],
      [{ sweep: 10 }, '`sweep` must be between 30 and 86400s'],
      [{ interval: 9 }, '`interval` must be between 10 and 3600s'],
      [{ name: 'beta' }, 'already exists'],
      [{}, 'Nothing to change'],
      [{ text: true, interval: 30 }, 'Nothing to change'],
    ];
    for (const [options, msg] of cases) {
      const f = await run({ sub: 'set', options: { site: String(w.id), ...options } });
      expect(textOf(last(f.calls))).toContain(msg);
      expect(isEphemeral(last(f.calls))).toBe(true);
    }
    expect(mon.calls.updated).toHaveLength(0);
  });
});

describe('/watch ignore & exclude', () => {
  it('adds a valid ignore pattern, resets page noise and re-baselines', async () => {
    const w = makeWatch();
    store.upsertPage(page(w.id, 'https://unpeg.io/', { dynamic: true, flapCount: 3 }));
    const f = await run({ sub: 'ignore', options: { site: 'Unpeg', pattern: 'Last updated.*' } });
    expect(store.getWatch(w.id)!.ignorePatterns).toEqual(['Last updated.*']);
    const p = store.getPage(w.id, 'https://unpeg.io/')!;
    expect(p).toMatchObject({ dynamic: false, flapCount: 0, textHash: null });
    expect(mon.calls.updated.at(-1)?.ignorePatterns).toEqual(['Last updated.*']);
    expect(textOf(last(f.calls))).toContain('now ignores text matching `Last updated.*`');
  });

  it.each([
    ['(', 'Invalid regex'],
    ['(a+)+$', 'nested repetition'],
    ['(\\w*)*', 'nested repetition'],
    ['(a|a)*$', 'too slow'],
    ['a*a*a*a*b', 'too slow'],
    ['.*', 'matches whole lines'],
    ['[\\s\\S]+', 'matches whole lines'],
    ['x'.repeat(301), 'too long'],
  ])('rejects ignore pattern %s', async (pattern, msg) => {
    const w = makeWatch();
    const f = await run({ sub: 'ignore', options: { site: 'Unpeg', pattern } });
    expect(textOf(last(f.calls))).toContain(msg);
    expect(isEphemeral(last(f.calls))).toBe(true);
    expect(store.getWatch(w.id)!.ignorePatterns).toEqual([]);
  });

  it('removes patterns and rejects duplicates / unknown ones / too many', async () => {
    const w = makeWatch('https://unpeg.io/', { ignorePatterns: ['a\\d+'] });
    let f = await run({ sub: 'ignore', options: { site: 'Unpeg', pattern: 'a\\d+' } });
    expect(textOf(last(f.calls))).toContain('already in the list');
    f = await run({ sub: 'ignore', options: { site: 'Unpeg', pattern: 'zzz', remove: true } });
    expect(textOf(last(f.calls))).toContain('is not in the list');
    f = await run({ sub: 'ignore', options: { site: 'Unpeg', pattern: 'a\\d+', remove: true } });
    expect(store.getWatch(w.id)!.ignorePatterns).toEqual([]);
    expect(textOf(last(f.calls))).toContain('no longer ignores');

    store.updateWatch(w.id, { ignorePatterns: Array.from({ length: 25 }, (_, n) => `p${n}`) });
    f = await run({ sub: 'ignore', options: { site: 'Unpeg', pattern: 'one-more' } });
    expect(textOf(last(f.calls))).toContain('At most 25 patterns');
  });

  it('exclude validates URL patterns and warns when the start URL matches', async () => {
    const w = makeWatch();
    let f = await run({ sub: 'exclude', options: { site: 'Unpeg', pattern: '/blog/' } });
    expect(store.getWatch(w.id)!.excludePatterns).toEqual(['/blog/']);
    expect(textOf(last(f.calls))).toContain('now skips URLs matching `/blog/`');
    f = await run({ sub: 'exclude', options: { site: 'Unpeg', pattern: '.' } });
    expect(textOf(last(f.calls))).toContain('matches every URL');
    f = await run({ sub: 'exclude', options: { site: 'Unpeg', pattern: 'unpeg\\.io/$' } });
    expect(textOf(last(f.calls))).toContain('also matches the start URL');
    f = await run({ sub: 'exclude', options: { site: 'Unpeg', pattern: '/blog/', remove: true } });
    expect(store.getWatch(w.id)!.excludePatterns).toEqual(['unpeg\\.io/$']);
  });
});

describe('/watch addpage', () => {
  it('resolves relative paths and host-like inputs, rejects bad schemes', async () => {
    const w = makeWatch();
    await run({ sub: 'addpage', options: { site: 'Unpeg', url: '/docs/secret/' } });
    await run({ sub: 'addpage', options: { site: 'Unpeg', url: 'unpeg.io/airdrop' } });
    await run({ sub: 'addpage', options: { site: 'Unpeg', url: 'https://cdn.other.io/paper.pdf' } });
    expect(store.getWatch(w.id)!.extraUrls).toEqual(['https://unpeg.io/docs/secret', 'https://unpeg.io/airdrop', 'https://cdn.other.io/paper.pdf']);
    expect(mon.calls.updated).toHaveLength(3);

    for (const url of ['javascript:alert(1)', 'ftp://unpeg.io/x', 'has space']) {
      const f = await run({ sub: 'addpage', options: { site: 'Unpeg', url } });
      expect(textOf(last(f.calls))).toContain('not a valid http(s) URL');
    }
    let f = await run({ sub: 'addpage', options: { site: 'Unpeg', url: 'https://unpeg.io/airdrop/' } });
    expect(textOf(last(f.calls))).toContain('already tracked');
    f = await run({ sub: 'addpage', options: { site: 'Unpeg', url: '/airdrop', remove: true } });
    expect(store.getWatch(w.id)!.extraUrls).not.toContain('https://unpeg.io/airdrop');
    expect(textOf(last(f.calls))).toContain('Stopped tracking <https://unpeg.io/airdrop>');
    f = await run({ sub: 'addpage', options: { site: 'Unpeg', url: '/nope', remove: true } });
    expect(textOf(last(f.calls))).toContain('is not an extra page');
  });
});

// ---------------------------------------------------------------------------
// Autocomplete & buttons
// ---------------------------------------------------------------------------

describe('autocomplete', () => {
  it('filters guild watches by id / name / host', async () => {
    makeWatch();
    makeWatch('https://beta.unpeg.io/', { name: 'Beta' });
    makeWatch('https://docs.example.com/', { name: 'Example Docs', rootDomain: 'example.com' });
    store.createWatch({ guildId: OTHER_GUILD, channelId: 'c', name: 'Unpeg Other', url: 'https://unpeg.xyz/', host: 'unpeg.xyz', rootDomain: 'unpeg.xyz', createdBy: 'u' });

    let f = fakeAutocomplete({ name: 'site', value: 'unp' });
    await handleAutocomplete(f.i, deps);
    expect(f.calls[0].payload).toEqual([
      { name: 'Unpeg — unpeg.io', value: '1' },
      { name: 'Beta — beta.unpeg.io', value: '2' },
    ]);

    f = fakeAutocomplete({ name: 'site', value: '#3' });
    await handleAutocomplete(f.i, deps);
    expect(f.calls[0].payload[0]).toEqual({ name: 'Example Docs — docs.example.com', value: '3' });

    f = fakeAutocomplete({ name: 'site', value: '' });
    await handleAutocomplete(f.i, deps);
    expect(f.calls[0].payload).toHaveLength(3);
  });

  it('caps at 25 choices of ≤ 100 chars and ignores other options', async () => {
    for (let n = 0; n < 30; n++) makeWatch(`https://s${n}.unpeg.io/`, { name: `Site ${n} ${'x'.repeat(120)}` });
    let f = fakeAutocomplete({ name: 'site', value: 'site' });
    await handleAutocomplete(f.i, deps);
    expect(f.calls[0].payload).toHaveLength(25);
    for (const c of f.calls[0].payload) expect(c.name.length).toBeLessThanOrEqual(100);
    f = fakeAutocomplete({ name: 'pattern', value: 'x' });
    await handleAutocomplete(f.i, deps);
    expect(f.calls[0].payload).toEqual([]);
    f = fakeAutocomplete({ name: 'site', value: 'x' }, null);
    await handleAutocomplete(f.i, deps);
    expect(f.calls[0].payload).toEqual([]);
  });
});

describe('watchsub button', () => {
  it('creates a watch for the subdomain in the parent channel', async () => {
    const parent = makeWatch('https://unpeg.io/', { pingRoleId: ROLE, intervalSec: 45, features: { files: false }, ignorePatterns: ['x+'] });
    const f = fakeButton(`watchsub:${parent.id}:beta.unpeg.io`);
    await handleButton(f.i, deps);
    const child = store.listWatches(GUILD).find((w) => w.host === 'beta.unpeg.io')!;
    expect(child).toMatchObject({
      url: 'https://beta.unpeg.io/',
      channelId: parent.channelId,
      name: 'Unpeg (beta)',
      rootDomain: 'unpeg.io',
      pingRoleId: ROLE,
      intervalSec: 45,
      ignorePatterns: ['x+'],
      createdBy: USER,
    });
    expect(child.features).toEqual({ ...parent.features, subdomains: false });
    expect(f.calls[0].type).toBe('defer');
    expect(isEphemeral(f.calls[0])).toBe(true);
    expect(mon.calls.baseline).toEqual([child.id]);
    expect(mon.calls.added.map((w) => w.id)).toEqual([child.id]);
    expect(textOf(last(f.calls))).toContain(`✅ Now watching **beta.unpeg.io** as **#${child.id} Unpeg (beta)**`);

    const again = fakeButton(`watchsub:${parent.id}:beta.unpeg.io`);
    await handleButton(again.i, deps);
    expect(textOf(last(again.calls))).toContain('Already watching **beta.unpeg.io**');
    expect(isEphemeral(last(again.calls))).toBe(true);
    expect(store.listWatches(GUILD)).toHaveLength(2);
  });

  it('rejects missing permission, foreign parents, forged hosts and junk ids', async () => {
    const parent = makeWatch();
    const foreign = store.createWatch({ guildId: OTHER_GUILD, channelId: 'c', name: 'F', url: 'https://f.io/', host: 'f.io', rootDomain: 'f.io', createdBy: 'u' });
    const cases: Array<[string, { manage?: boolean; guildId?: string | null }, string]> = [
      [`watchsub:${parent.id}:beta.unpeg.io`, { manage: false }, 'Manage Server'],
      [`watchsub:${parent.id}:beta.unpeg.io`, { guildId: null }, 'only works inside a server'],
      [`watchsub:${foreign.id}:a.f.io`, {}, 'no longer exists'],
      [`watchsub:999:beta.unpeg.io`, {}, 'no longer exists'],
      [`watchsub:${parent.id}:evil.com`, {}, 'no longer valid'],
      [`watchsub:${parent.id}:`, {}, 'no longer valid'],
      ['watchsub:abc:beta.unpeg.io', {}, 'no longer valid'],
      [`watchsub:${parent.id}:beta unpeg.io`, {}, 'no longer valid'],
    ];
    for (const [id, o, msg] of cases) {
      const f = fakeButton(id, o);
      await handleButton(f.i, deps);
      expect(textOf(last(f.calls))).toContain(msg);
      expect(isEphemeral(last(f.calls))).toBe(true);
    }
    expect(store.listWatches(GUILD)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('helpers', () => {
  it('hasNestedQuantifier', () => {
    for (const p of ['(a+)+', '(\\w*)*', '(?:x{2,})+', '((a+))+', '(a*b)*', '(?<n>\\d+){2,}']) expect(hasNestedQuantifier(p), p).toBe(true);
    for (const p of ['(a|b)+', 'a+b+', '[(a+)]+', '\\(a+\\)+', 'Last updated.*', '(\\d+)', '(a)+', 'v\\d+\\.\\d+', '(?:foo|bar)?']) {
      expect(hasNestedQuantifier(p), p).toBe(false);
    }
  });

  it('regexIsFast accepts ordinary patterns and interrupts runaway ones', () => {
    for (const p of ['Last updated.*', '\\d+ (views|likes)', '^Copyright', 'v\\d+\\.\\d+\\.\\d+', '/blog/', '[a-z]+-[0-9a-f]{8}']) {
      expect(regexIsFast(p, 'gi'), p).toBe(true);
    }
    const t0 = Date.now();
    expect(regexIsFast('(x+x+)+y', 'gi')).toBe(false);
    expect(regexIsFast('(a|a)*$', 'i')).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('parseScope', () => {
    expect(parseScope(null)).toBeUndefined();
    expect(parseScope('/')).toBeNull();
    expect(parseScope(' none ')).toBeNull();
    expect(parseScope('docs/')).toBe('/docs');
    expect(parseScope('//docs//guides/')).toBe('/docs/guides');
    expect(parseScope('https://unpeg.io/docs/')).toBe('/docs');
    expect(() => parseScope('/a b')).toThrow(/path prefix/);
    expect(() => parseScope('/a?b')).toThrow(/path prefix/);
  });

  it('resolvePageUrl', () => {
    const w = { url: 'https://unpeg.io/docs/intro', host: 'unpeg.io', rootDomain: 'unpeg.io' };
    expect(resolvePageUrl('/a', w)).toBe('https://unpeg.io/a');
    expect(resolvePageUrl('guides', w)).toBe('https://unpeg.io/docs/guides');
    expect(resolvePageUrl('readme.md', w)).toBe('https://unpeg.io/docs/readme.md');
    expect(resolvePageUrl('page.html', w)).toBe('https://unpeg.io/docs/page.html');
    expect(resolvePageUrl('unpeg.io/x', w)).toBe('https://unpeg.io/x');
    expect(resolvePageUrl('docs.unpeg.io/x', w)).toBe('https://docs.unpeg.io/x');
    expect(resolvePageUrl('other.com/page', w)).toBe('https://other.com/page');
    expect(resolvePageUrl('//cdn.io/a.pdf', w)).toBe('https://cdn.io/a.pdf');
    expect(resolvePageUrl('<https://unpeg.io/y/>', w)).toBe('https://unpeg.io/y');
    expect(resolvePageUrl('http://localhost:8080/a', w)).toBe('http://localhost:8080/a');
    expect(resolvePageUrl('mailto:a@b.c', w)).toBeNull();
    expect(resolvePageUrl('', w)).toBeNull();
  });
});
