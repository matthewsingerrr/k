import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApplicationCommandOptionType,
  ChannelType,
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  LINK_COMMAND_NAME,
  MAX_LINKS_PER_GUILD,
  cleanLinkLabel,
  handleLinkAutocomplete,
  handleLinkCommand,
  linkApiBaseUrl,
  linkCommandDefinition,
} from '../src/discord/link.js';
import { commandDefinitions, handleAutocomplete, handleChatInput, renderHelp, type CommandDeps } from '../src/discord/commands.js';
import { testConfig, type Config } from '../src/config.js';
import { LINK_TOKEN_PREFIX, Store, hashLinkToken } from '../src/db/store.js';
import type { Monitor } from '../src/monitor/scheduler.js';
import type { Logger } from '../src/types.js';

const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const CHANNEL = '200000000000000001';
const ALERTS = '200000000000000002';
const USER = '300000000000000001';
const PUBLIC = 'https://site-watcher-production.up.railway.app';

// ---------------------------------------------------------------------------
// Fakes (same shape as test/commands.test.ts)
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

interface ChatOpts {
  sub: string;
  command?: string;
  options?: Record<string, unknown>;
  guildId?: string | null;
  channelId?: string;
  manage?: boolean;
  /** Make reply() reject (Discord refused the message / the interaction expired). */
  replyFails?: boolean;
}

function fakeChat(o: ChatOpts) {
  const calls: Call[] = [];
  const opts = o.options ?? {};
  const get = (name: string) => (opts[name] === undefined ? null : opts[name]);
  const i = {
    commandName: o.command ?? LINK_COMMAND_NAME,
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
      if (o.replyFails) throw Object.assign(new Error('Unknown interaction'), { code: 10062 });
      this.replied = true;
      calls.push({ type: 'reply', payload });
    },
    async deferReply(payload: unknown) {
      if (this.deferred || this.replied) throw new Error('InteractionAlreadyReplied');
      this.deferred = true;
      calls.push({ type: 'defer', payload });
    },
    async editReply(payload: unknown) {
      if (!this.deferred && !this.replied) throw new Error('InteractionNotReplied');
      this.replied = true;
      calls.push({ type: 'edit', payload });
    },
    async followUp(payload: unknown) {
      if (!this.deferred && !this.replied) throw new Error('InteractionNotReplied');
      calls.push({ type: 'followUp', payload });
    },
  };
  return { i: i as unknown as ChatInputCommandInteraction, calls };
}

function fakeAutocomplete(value: string, o: { guildId?: string | null; manage?: boolean; command?: string } = {}) {
  const calls: Call[] = [];
  const guildId = o.guildId === undefined ? GUILD : o.guildId;
  const i = {
    commandName: o.command ?? LINK_COMMAND_NAME,
    guildId,
    responded: false,
    memberPermissions: { has: (p: bigint) => o.manage !== false && p === PermissionFlagsBits.ManageGuild },
    inGuild: () => guildId !== null,
    options: { getFocused: (full?: boolean) => (full ? { name: 'label', value } : value) },
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
const TOKEN_RE = new RegExp(`${LINK_TOKEN_PREFIX}[A-Za-z0-9_-]{40,}`);

// ---------------------------------------------------------------------------

let store: Store;
let log: SpyLogger;
let config: Config;
let deps: CommandDeps;

function withConfig(over: Partial<Config>): void {
  config = testConfig(over);
  deps = { ...deps, config };
}

async function run(o: ChatOpts) {
  const f = fakeChat(o);
  await handleLinkCommand(f.i, deps);
  return f;
}

async function create(label: string, more: Partial<ChatOpts> = {}) {
  const { options, ...rest } = more;
  const f = await run({ ...rest, sub: 'create', options: { label, ...(options ?? {}) } });
  const token = TOKEN_RE.exec(textOf(last(f.calls)))?.[0] ?? null;
  return { ...f, token };
}

beforeEach(() => {
  store = new Store(':memory:');
  log = spyLogger();
  config = testConfig({ publicUrl: PUBLIC });
  deps = { store, monitor: {} as unknown as Monitor, config, log };
});

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

describe('/link definition', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = linkCommandDefinition() as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subs = new Map<string, any>(def.options.map((o: any) => [o.name, o]));

  it('is registered next to /watch and /panel, guild-only and gated by Manage Server', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defs = commandDefinitions({ minIntervalSec: 10 }) as any[];
    expect(defs.map((d) => d.name).sort()).toEqual(['link', 'panel', 'watch']);
    expect(defs[0].name).toBe('watch');
    const link = defs.find((d) => d.name === 'link');
    expect(link).toEqual(def);
    expect(JSON.parse(JSON.stringify(link))).toEqual(link);
    expect(link.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
    expect(link.dm_permission).toBe(false);
    expect(link.contexts).toEqual([0]);
  });

  it('has create / list / revoke with the documented options', () => {
    expect([...subs.keys()]).toEqual(['create', 'list', 'revoke']);
    for (const s of subs.values()) expect(s.type).toBe(ApplicationCommandOptionType.Subcommand);
    const opt = (sub: string, name: string) => subs.get(sub).options?.find((o: any) => o.name === name); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(subs.get('create').options.map((o: any) => o.name)).toEqual(['label', 'channel']); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(opt('create', 'label')).toMatchObject({ type: ApplicationCommandOptionType.String, required: true, max_length: 40 });
    expect(opt('create', 'channel').type).toBe(ApplicationCommandOptionType.Channel);
    expect(opt('create', 'channel').required ?? false).toBe(false);
    expect(opt('create', 'channel').channel_types).toEqual([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
    expect(subs.get('list').options ?? []).toEqual([]);
    expect(opt('revoke', 'label')).toMatchObject({ type: ApplicationCommandOptionType.String, required: true, autocomplete: true });
  });

  it('respects Discord naming and size limits', () => {
    let chars = 0;
    const visit = (o: any, depth: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(o.name).toMatch(/^[-_\p{Ll}\p{N}]{1,32}$/u);
      expect(o.description.length).toBeGreaterThan(0);
      expect(o.description.length).toBeLessThanOrEqual(100);
      chars += o.name.length + o.description.length;
      const opts = o.options ?? [];
      expect(opts.length).toBeLessThanOrEqual(25);
      if (depth > 0) {
        const firstOptional = opts.findIndex((x: any) => !x.required); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (firstOptional >= 0) expect(opts.slice(firstOptional).every((x: any) => !x.required)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
      }
      const names = opts.map((x: any) => x.name); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(new Set(names).size).toBe(names.length);
      for (const c of opts) visit(c, depth + 1);
    };
    visit(def, 0);
    expect(chars).toBeLessThanOrEqual(8000);
  });

  it('the help (also shown by the dashboard) mentions /link', () => {
    const help = renderHelp();
    const text = [help.description, ...(help.fields ?? []).map((f) => f.value)].join('\n');
    expect(text).toContain('/link create');
    for (const f of help.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('/link create', () => {
  it('replies ephemerally with the API URL, the token (once), the channel and setup steps; stores only the hash', async () => {
    const { calls, token } = await create('Matt’s Chrome');
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('reply');
    expect(isEphemeral(calls[0])).toBe(true);
    expect(token).toMatch(TOKEN_RE);

    const text = textOf(calls[0]);
    expect(text).toContain('🔗 Link created');
    expect(text).toContain(`${PUBLIC}/api/v1`);
    expect(text).toContain('```\n' + token + '\n```');
    expect(text).toContain('shown only once');
    expect(text).toContain(`<#${CHANNEL}>`);
    expect(text).toContain('Discord tracker');
    expect(text).toContain('Test connection');
    expect(text).toContain('Add to Discord tracker');
    expect(text).not.toContain('Generate Domain');
    expect(calls[0].payload.allowedMentions).toEqual({ parse: [] });

    const [rec] = store.listLinkTokens(GUILD);
    expect(rec).toMatchObject({ guildId: GUILD, channelId: CHANNEL, label: 'Matt’s Chrome', createdBy: USER, lastUsedAt: null });
    expect(rec.tokenHash).toBe(hashLinkToken(token!));
    expect(rec.tokenHash).not.toContain(token!);
    expect(JSON.stringify(rec)).not.toContain(token!);
    expect(store.findLinkToken(token!)?.id).toBe(rec.id);
    // The token is never logged.
    expect(JSON.stringify(log.entries)).not.toContain(token!);
    expect(log.entries.some((e) => e.msg === 'link token created')).toBe(true);
  });

  it('never puts the token into a deferred reply that may be public: it goes out as an ephemeral follow-up', async () => {
    for (const ephemeral of [false, null]) {
      const f = fakeChat({ sub: 'create', options: { label: `Deferred ${String(ephemeral)}` } });
      Object.assign(f.i, { deferred: true, ephemeral });
      await handleLinkCommand(f.i, deps);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].type).toBe('followUp');
      expect(isEphemeral(f.calls[0])).toBe(true);
      expect(textOf(f.calls[0])).toMatch(TOKEN_RE);
    }
    // An ephemeral deferral is edited in place.
    const f = fakeChat({ sub: 'create', options: { label: 'Deferred eph' } });
    Object.assign(f.i, { deferred: true, ephemeral: true });
    await handleLinkCommand(f.i, deps);
    expect(f.calls.map((c) => c.type)).toEqual(['edit']);
    expect(textOf(f.calls[0])).toMatch(TOKEN_RE);
  });

  it('uses the channel option for alerts', async () => {
    const { token } = await create('Laptop', { options: { channel: ALERTS } });
    expect(store.findLinkToken(token!)?.channelId).toBe(ALERTS);
  });

  it('explains how to get a public domain when the service has none (and the token still works)', async () => {
    withConfig({ publicUrl: null });
    const { calls, token } = await create('Chrome');
    const text = textOf(last(calls));
    expect(isEphemeral(last(calls))).toBe(true);
    expect(text).toContain('no public domain');
    expect(text).toContain('Settings');
    expect(text).toContain('Networking');
    expect(text).toContain('Generate Domain');
    expect(text).toContain('redeploy');
    expect(text).not.toContain('undefined');
    expect(store.findLinkToken(token!)).toBeDefined();
  });

  it('warns when the Link API is turned off and when PUBLIC_URL is plain http', async () => {
    withConfig({ publicUrl: 'http://watcher.example.com', linkApi: false });
    const text = textOf(last((await create('Chrome')).calls));
    expect(text).toContain('LINK_API=false');
    expect(text).toContain('http://watcher.example.com/api/v1');
    expect(text).toContain('unencrypted');
  });

  it('rejects a duplicate label (case-insensitive)', async () => {
    await create('Chrome');
    const { calls, token } = await create('  chrome ');
    expect(token).toBeNull();
    expect(isEphemeral(last(calls))).toBe(true);
    expect(textOf(last(calls))).toContain('already exists');
    expect(store.listLinkTokens(GUILD)).toHaveLength(1);
  });

  it(`allows at most ${MAX_LINKS_PER_GUILD} links per server (other servers are separate)`, async () => {
    for (let n = 1; n <= MAX_LINKS_PER_GUILD; n++) expect((await create(`Device ${n}`)).token).not.toBeNull();
    const { calls, token } = await create('One too many');
    expect(token).toBeNull();
    expect(textOf(last(calls))).toContain(`${MAX_LINKS_PER_GUILD} links (the limit)`);
    expect(store.listLinkTokens(GUILD)).toHaveLength(MAX_LINKS_PER_GUILD);
    expect((await create('Elsewhere', { guildId: OTHER_GUILD })).token).not.toBeNull();
  });

  it('validates the label', async () => {
    for (const bad of ['   ', '\n\t']) {
      const { calls } = await create(bad);
      expect(textOf(last(calls))).toContain('cannot be empty');
    }
    const long = await create('x'.repeat(41));
    expect(textOf(last(long.calls))).toContain('too long');
    expect(store.listLinkTokens(GUILD)).toHaveLength(0);
    expect(cleanLinkLabel('  My \n Chrome ')).toBe('My Chrome');
  });

  it('revokes the token again when Discord refuses the reply (nobody saw it)', async () => {
    const { calls } = await create('Chrome', { replyFails: true });
    expect(calls).toHaveLength(0);
    expect(store.listLinkTokens(GUILD)).toHaveLength(0);
    expect(log.entries.some((e) => e.level === 'warn' && /revoked/.test(e.msg))).toBe(true);
    expect((await create('Chrome')).token).not.toBeNull(); // the label is free again
  });
});

// ---------------------------------------------------------------------------
// list / revoke
// ---------------------------------------------------------------------------

describe('/link list', () => {
  it('explains how to create one when there are none', async () => {
    const { calls } = await run({ sub: 'list' });
    expect(isEphemeral(last(calls))).toBe(true);
    expect(textOf(last(calls))).toContain('/link create');
  });

  it('lists label · channel · created · last used, plus the API URL — never tokens', async () => {
    const a = await create('Chrome');
    await create('Server bot', { options: { channel: ALERTS } });
    await create('Other', { guildId: OTHER_GUILD });
    const rec = store.findLinkToken(a.token!)!;
    store.touchLinkToken(rec.id, 1_759_673_000_000);

    const { calls } = await run({ sub: 'list' });
    const text = textOf(last(calls));
    expect(isEphemeral(last(calls))).toBe(true);
    expect(text).toContain(`Links (2/${MAX_LINKS_PER_GUILD})`);
    expect(text).toContain(`${PUBLIC}/api/v1`);
    expect(text).toMatch(new RegExp(`\\*\\*Chrome\\*\\* · <#${CHANNEL}> · created <t:\\d+:R> · last used <t:1759673000:R>`));
    expect(text).toMatch(new RegExp(`\\*\\*Server bot\\*\\* · <#${ALERTS}> · created <t:\\d+:R> · last used never`));
    expect(text).not.toContain('Other');
    expect(text).not.toMatch(TOKEN_RE);
  });

  it('shows the public-domain hint when there is no PUBLIC_URL', async () => {
    withConfig({ publicUrl: null });
    await create('Chrome');
    expect(textOf(last((await run({ sub: 'list' })).calls))).toContain('Generate Domain');
  });
});

describe('/link revoke', () => {
  it('revokes by label (case-insensitive): the token stops working at once', async () => {
    const { token } = await create('Chrome');
    await create('Keep me');
    const { calls } = await run({ sub: 'revoke', options: { label: 'CHROME' } });
    expect(isEphemeral(last(calls))).toBe(true);
    expect(textOf(last(calls))).toContain('Revoked **Chrome**');
    expect(store.findLinkToken(token!)).toBeUndefined();
    expect(store.listLinkTokens(GUILD).map((t) => t.label)).toEqual(['Keep me']);
  });

  it('accepts "#id", resolves number-like labels by label first, and only touches this server', async () => {
    const a = await create('2024');
    const b = await create('Chrome');
    const idB = store.findLinkToken(b.token!)!.id;
    await run({ sub: 'revoke', options: { label: `#${idB}` } });
    expect(store.findLinkToken(b.token!)).toBeUndefined();
    await run({ sub: 'revoke', options: { label: '2024' } });
    expect(store.findLinkToken(a.token!)).toBeUndefined();

    const other = await create('Chrome', { guildId: OTHER_GUILD });
    const { calls } = await run({ sub: 'revoke', options: { label: 'Chrome' } });
    expect(textOf(last(calls))).toContain('No link named');
    expect(store.findLinkToken(other.token!)).toBeDefined();
  });

  it('reports an unknown label', async () => {
    const { calls } = await run({ sub: 'revoke', options: { label: 'nope' } });
    expect(isEphemeral(last(calls))).toBe(true);
    expect(textOf(last(calls))).toContain('No link named `nope`');
  });
});

// ---------------------------------------------------------------------------
// Guards, routing, autocomplete
// ---------------------------------------------------------------------------

describe('guards and routing', () => {
  it('rejects members without Manage Server for every subcommand', async () => {
    const { token } = await create('Chrome');
    for (const [sub, options] of [
      ['create', { label: 'Sneaky' }],
      ['list', {}],
      ['revoke', { label: 'Chrome' }],
    ] as const) {
      const { calls } = await run({ sub, options, manage: false });
      expect(isEphemeral(last(calls))).toBe(true);
      expect(textOf(last(calls))).toContain('Manage Server');
      expect(textOf(last(calls))).not.toMatch(TOKEN_RE);
    }
    expect(store.listLinkTokens(GUILD).map((t) => t.label)).toEqual(['Chrome']);
    expect(store.findLinkToken(token!)).toBeDefined();
  });

  it('only works inside a server', async () => {
    const { calls } = await run({ sub: 'list', guildId: null });
    expect(textOf(last(calls))).toContain('only works inside a server');
    expect(isEphemeral(last(calls))).toBe(true);
  });

  it('handleChatInput routes /link (and still answers /watch)', async () => {
    const f = fakeChat({ sub: 'create', options: { label: 'Routed' } });
    await handleChatInput(f.i, deps);
    expect(textOf(last(f.calls))).toMatch(TOKEN_RE);
    expect(store.listLinkTokens(GUILD)).toHaveLength(1);

    const nonAdmin = fakeChat({ sub: 'list', manage: false });
    await handleChatInput(nonAdmin.i, deps);
    expect(textOf(last(nonAdmin.calls))).toContain('Manage Server');

    const watch = fakeChat({ sub: 'help', command: 'watch' });
    await handleChatInput(watch.i, deps);
    expect(textOf(last(watch.calls))).toContain('/link create');
  });

  it('autocompletes this server’s labels for admins only (also via handleAutocomplete)', async () => {
    await create('Chrome');
    await create('Server bot');
    await create('Elsewhere', { guildId: OTHER_GUILD });

    let f = fakeAutocomplete('');
    await handleLinkAutocomplete(f.i, deps);
    const all = last(f.calls).payload as Array<{ name: string; value: string }>;
    expect(all.map((c) => c.value)).toEqual(['Chrome', 'Server bot']);
    expect(all[0].name).toMatch(/^Chrome · created \d{4}-\d\d-\d\d · never used$/);

    f = fakeAutocomplete('serv');
    await handleAutocomplete(f.i, deps);
    expect((last(f.calls).payload as Array<{ value: string }>).map((c) => c.value)).toEqual(['Server bot']);

    f = fakeAutocomplete('', { manage: false });
    await handleLinkAutocomplete(f.i, deps);
    expect(last(f.calls).payload).toEqual([]);
  });
});

describe('linkApiBaseUrl', () => {
  it.each([
    [null, null],
    ['', null],
    ['https://bot.up.railway.app', 'https://bot.up.railway.app/api/v1'],
    ['https://bot.up.railway.app/', 'https://bot.up.railway.app/api/v1'],
    ['bot.example.com', 'https://bot.example.com/api/v1'],
    ['https://example.com/watcher/', 'https://example.com/watcher/api/v1'],
    ['ftp://example.com', null],
  ])('%s → %s', (publicUrl, expected) => {
    expect(linkApiBaseUrl({ publicUrl })).toBe(expected);
  });
});
