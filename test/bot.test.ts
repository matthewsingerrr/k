import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits, type Client, type Interaction } from 'discord.js';
import {
  BOT_PERMISSIONS,
  DiscordNotifier,
  MAX_QUEUED,
  handleShardDisconnect,
  inviteUrl,
  routeInteraction,
  setGuildWatchesRunning,
  type RouteDeps,
} from '../src/discord/bot.js';
import { testConfig } from '../src/config.js';
import { Store } from '../src/db/store.js';
import type { Monitor } from '../src/monitor/scheduler.js';
import { DEFAULT_FEATURES, type Alert, type Logger, type Watch } from '../src/types.js';

interface SpyLogger extends Logger {
  entries: Array<{ level: string; msg: string; meta?: Record<string, unknown> }>;
  count(level: string): number;
}

function spyLogger(): SpyLogger {
  const entries: SpyLogger['entries'] = [];
  const log: SpyLogger = {
    entries,
    count: (level) => entries.filter((e) => e.level === level).length,
    debug: (msg, meta) => entries.push({ level: 'debug', msg, meta }),
    info: (msg, meta) => entries.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => entries.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => entries.push({ level: 'error', msg, meta }),
    child: () => log,
  };
  return log;
}

function makeWatch(over: Partial<Watch> = {}): Watch {
  return {
    id: 1,
    guildId: '100000000000000001',
    channelId: '200000000000000001',
    name: 'Unpeg',
    url: 'https://unpeg.io/',
    host: 'unpeg.io',
    rootDomain: 'unpeg.io',
    intervalSec: 30,
    sweepSec: 120,
    maxPages: 150,
    pingRoleId: null,
    features: { ...DEFAULT_FEATURES },
    ignorePatterns: [],
    excludePatterns: [],
    extraUrls: [],
    scopePath: null,
    maskNumbers: false,
    paused: false,
    baselineDone: true,
    createdBy: 'u',
    createdAt: 0,
    ...over,
  };
}

const deploy: Alert = {
  kind: 'deploy',
  url: 'https://unpeg.io/',
  host: 'unpeg.io',
  buildIdOld: 'a',
  buildIdNew: 'b',
  assetsAdded: [],
  assetsRemoved: [],
  newCodePaths: [],
  newCodeHosts: [],
};
const info: Alert = { kind: 'info', message: 'hello' };
const subdomainAlert: Alert = {
  kind: 'subdomain',
  rootDomain: 'unpeg.io',
  subdomains: [{ host: 'beta.unpeg.io', sources: ['ct'], dns: { a: ['1.2.3.4'], aaaa: [], cname: [] }, http: null }],
};

function apiError(code: number, message = 'Discord error'): Error {
  return Object.assign(new Error(message), { code, status: 403 });
}

/** A channel whose send() behaviour is scripted per call (value = resolve, Error = reject). */
function fakeChannel(script: Array<Error | undefined> = [], over: Record<string, unknown> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  let call = 0;
  return {
    sent,
    attempts: () => call,
    isTextBased: () => true,
    isSendable: () => true,
    async send(options: Record<string, unknown>) {
      const outcome = script[call++];
      if (outcome instanceof Error) throw outcome;
      sent.push(options);
      return {};
    },
    ...over,
  };
}

function fakeClient(channel: unknown, o: { ready?: boolean; fetchScript?: Array<Error | undefined> } = {}) {
  let ready = o.ready ?? true;
  let fetches = 0;
  const client = {
    isReady: () => ready,
    setReady(v: boolean) {
      ready = v;
    },
    fetches: () => fetches,
    channels: {
      async fetch() {
        const outcome = o.fetchScript?.[fetches++];
        if (outcome instanceof Error) throw outcome;
        return channel;
      },
    },
  };
  return client;
}

const notifiers: DiscordNotifier[] = [];
afterEach(() => {
  for (const n of notifiers.splice(0)) n.close();
});

function notifierFor(client: ReturnType<typeof fakeClient>, log: SpyLogger): DiscordNotifier {
  const n = new DiscordNotifier(client as unknown as Client, log);
  n.retryDelayMs = 1;
  n.flushRetryMs = 60_000; // tests flush explicitly
  notifiers.push(n);
  return n;
}

describe('DiscordNotifier', () => {
  let log: SpyLogger;
  beforeEach(() => {
    log = spyLogger();
  });

  it('sends every payload in order with its allowed mentions and components', async () => {
    const channel = fakeChannel();
    const client = fakeClient(channel);
    await notifierFor(client, log).notify(makeWatch({ pingRoleId: '400000000000000001' }), [deploy, info, subdomainAlert]);
    expect(channel.sent).toHaveLength(3);
    expect(channel.sent[0].content).toBe('<@&400000000000000001> 🌐 **unpeg.io** was redeployed (site code changed).');
    expect(channel.sent[0].allowedMentions).toEqual({ roles: ['400000000000000001'] });
    expect(channel.sent[1].content).toBe('ℹ️ **Unpeg**: hello');
    expect(channel.sent[1].allowedMentions).toEqual({ parse: [] });
    expect(channel.sent[1].components).toBeUndefined();
    expect((channel.sent[2].components as unknown[]).length).toBe(1);
    expect((channel.sent[0].embeds as unknown[]).length).toBe(1);
    expect(log.count('warn') + log.count('error')).toBe(0);
  });

  it('does nothing for an empty batch', async () => {
    const client = fakeClient(fakeChannel());
    await notifierFor(client, log).notify(makeWatch(), []);
    expect(client.fetches()).toBe(0);
  });

  it('queues alerts while the client is not ready (without waiting) and sends them in order once it is', async () => {
    const channel = fakeChannel();
    const client = fakeClient(channel, { ready: false });
    const n = notifierFor(client, log);
    const t0 = Date.now();
    await n.notify(makeWatch(), [info]);
    await n.notify(makeWatch({ id: 2 }), [deploy]);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(channel.sent).toHaveLength(0);
    expect(n.queued).toBe(2);
    client.setReady(true);
    await n.flush();
    expect(channel.sent.map((m) => String(m.content).slice(0, 2))).toEqual(['ℹ️', '🌐']);
    expect(n.queued).toBe(0);
  });

  it('queued alerts go out before newer ones', async () => {
    const channel = fakeChannel();
    const client = fakeClient(channel, { ready: false });
    const n = notifierFor(client, log);
    await n.notify(makeWatch(), [info]);
    client.setReady(true);
    await n.notify(makeWatch(), [deploy]);
    expect(channel.sent.map((m) => String(m.content).slice(0, 2))).toEqual(['ℹ️', '🌐']);
  });

  it('caps the queue by dropping the oldest payloads', async () => {
    const client = fakeClient(fakeChannel(), { ready: false });
    const n = notifierFor(client, log);
    for (let i = 0; i < MAX_QUEUED + 5; i++) await n.notify(makeWatch(), [info]);
    expect(n.queued).toBe(MAX_QUEUED);
    expect(log.entries.some((e) => e.level === 'warn' && e.msg.includes('queue full'))).toBe(true);
  });

  it('warns once per watch per hour on Unknown Channel / Missing Access', async () => {
    const client = fakeClient(fakeChannel(), { fetchScript: [apiError(10003), apiError(50001), apiError(10003), apiError(10003)] });
    const n = notifierFor(client, log);
    let now = 1_000_000;
    n.now = () => now;
    await n.notify(makeWatch(), [info]);
    await n.notify(makeWatch(), [info]);
    expect(log.count('warn')).toBe(1);
    await n.notify(makeWatch({ id: 2 }), [info]);
    expect(log.count('warn')).toBe(2);
    now += 60 * 60 * 1000;
    await n.notify(makeWatch(), [info]);
    expect(log.count('warn')).toBe(3);
    expect(log.count('error')).toBe(0);
    expect(client.fetches()).toBe(4); // access errors are not retried
  });

  it('stops sending the batch on Missing Permissions', async () => {
    const channel = fakeChannel([apiError(50013)]);
    await notifierFor(fakeClient(channel), log).notify(makeWatch(), [deploy, info]);
    expect(channel.attempts()).toBe(1);
    expect(channel.sent).toHaveLength(0);
    expect(log.count('warn')).toBe(1);
  });

  it('retries a transient failure once', async () => {
    const channel = fakeChannel([new Error('ECONNRESET')]);
    await notifierFor(fakeClient(channel), log).notify(makeWatch(), [deploy]);
    expect(channel.attempts()).toBe(2);
    expect(channel.sent).toHaveLength(1);
    expect(log.count('warn')).toBe(1);
    expect(log.count('error')).toBe(0);
  });

  it('queues a payload that fails twice (and the rest of its batch), and sends them in order on the next flush', async () => {
    const channel = fakeChannel([Object.assign(new Error('500'), { code: 500 }), Object.assign(new Error('500'), { code: 500 })]);
    const n = notifierFor(fakeClient(channel), log);
    await n.notify(makeWatch(), [deploy, info]);
    expect(channel.attempts()).toBe(2);
    expect(channel.sent).toHaveLength(0);
    expect(n.queued).toBe(2);
    expect(log.count('error')).toBe(1);
    await n.flush();
    expect(channel.sent.map((m) => String(m.content).slice(0, 2))).toEqual(['🌐', 'ℹ️']);
    expect(n.queued).toBe(0);
  });

  it('does not queue alerts for a channel it has no permission to post in', async () => {
    const channel = fakeChannel([apiError(50013)]);
    const n = notifierFor(fakeClient(channel), log);
    await n.notify(makeWatch(), [deploy]);
    expect(n.queued).toBe(0);
  });

  it('sends a plain-text fallback when Discord rejects the payload shape', async () => {
    const channel = fakeChannel([apiError(50035, 'Invalid Form Body')]);
    await notifierFor(fakeClient(channel), log).notify(makeWatch(), [deploy]);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].embeds).toBeUndefined();
    expect(channel.sent[0].content).toContain('**unpeg.io** was redeployed (site code changed).');
    expect(channel.sent[0].content).toContain('<https://unpeg.io/>');
    expect(channel.sent[0].allowedMentions).toEqual({ parse: [] });
  });

  it('retries a failed channel fetch once', async () => {
    const channel = fakeChannel();
    const client = fakeClient(channel, { fetchScript: [new Error('socket hang up')] });
    await notifierFor(client, log).notify(makeWatch(), [info]);
    expect(client.fetches()).toBe(2);
    expect(channel.sent).toHaveLength(1);
  });

  it.each([
    ['a missing channel', null],
    ['a voice channel', { isTextBased: () => false, isSendable: () => false, send: async () => ({}) }],
    ['a read-only channel', { isTextBased: () => true, isSendable: () => false, send: async () => ({}) }],
  ])('drops alerts for %s', async (_label, channel) => {
    await notifierFor(fakeClient(channel), log).notify(makeWatch(), [info]);
    expect(log.count('warn')).toBe(1);
    expect(log.count('error')).toBe(0);
  });

  it('never throws, even for garbage input', async () => {
    const channel = fakeChannel();
    const n = notifierFor(fakeClient(channel), log);
    await expect(n.notify(makeWatch(), [{ kind: 'nope' } as unknown as Alert, null as unknown as Alert])).resolves.toBeUndefined();
    await expect(n.notify(null as unknown as Watch, [info])).resolves.toBeUndefined();
    await expect(n.notify(makeWatch(), undefined as unknown as Alert[])).resolves.toBeUndefined();
  });
});

describe('gateway closes and server removal', () => {
  it('exits on a gateway close Discord does not recover from (e.g. a reset token), not on ordinary ones', () => {
    vi.useFakeTimers();
    try {
      const log = spyLogger();
      const exit = vi.fn();
      expect(handleShardDisconnect(4004, log, exit)).toBe(true);
      vi.advanceTimersByTime(1500);
      expect(exit).toHaveBeenCalledWith(1);
      expect(log.entries.some((e) => e.level === 'error' && e.msg.includes('reset the bot token'))).toBe(true);
      const exit2 = vi.fn();
      expect(handleShardDisconnect(1006, log, exit2)).toBe(false);
      expect(handleShardDisconnect(undefined, log, exit2)).toBe(false);
      vi.advanceTimersByTime(5000);
      expect(exit2).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a removed server's watches (keeping them stored) and starts them again when the bot is back", () => {
    const store = new Store(':memory:');
    const a = store.createWatch({ guildId: 'g1', channelId: 'c', name: 'A', url: 'https://a.io/', host: 'a.io', rootDomain: 'a.io', createdBy: 'u' });
    store.createWatch({ guildId: 'g2', channelId: 'c', name: 'B', url: 'https://b.io/', host: 'b.io', rootDomain: 'b.io', createdBy: 'u' });
    const removed: number[] = [];
    const added: number[] = [];
    const monitor = { onWatchRemoved: (id: number) => removed.push(id), onWatchAdded: (w: Watch) => added.push(w.id) } as unknown as Monitor;
    const deps = { store, log: spyLogger(), getMonitor: () => monitor };
    expect(setGuildWatchesRunning('g1', false, deps)).toBe(1);
    expect(removed).toEqual([a.id]);
    expect(store.listWatches('g1')).toHaveLength(1);
    setGuildWatchesRunning('g1', true, deps);
    expect(added).toEqual([a.id]);
    store.close();
  });
});

describe('inviteUrl', () => {
  it('requests exactly the needed permissions', () => {
    expect(BOT_PERMISSIONS).toBe(
      PermissionFlagsBits.ViewChannel |
        PermissionFlagsBits.SendMessages |
        PermissionFlagsBits.EmbedLinks |
        PermissionFlagsBits.ReadMessageHistory |
        PermissionFlagsBits.MentionEveryone |
        PermissionFlagsBits.AttachFiles |
        PermissionFlagsBits.PinMessages,
    );
    expect(inviteUrl('123')).toBe(
      `https://discord.com/oauth2/authorize?client_id=123&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS.toString()}`,
    );
    expect(BOT_PERMISSIONS.toString()).toBe('2251799813934080');
    // The dashboard needs to attach its backup file and pin itself; nothing broader than that.
    expect(BOT_PERMISSIONS & PermissionFlagsBits.Administrator).toBe(0n);
    expect(BOT_PERMISSIONS & PermissionFlagsBits.ManageMessages).toBe(0n);
  });
});

describe('routeInteraction', () => {
  function baseInteraction(kind: 'chat' | 'auto' | 'button' | 'select' | 'modal', over: Record<string, unknown> = {}) {
    const calls: Array<{ type: string; payload: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const i = {
      commandName: 'watch',
      customId: '',
      guildId: '100000000000000001',
      channelId: '200000000000000001',
      user: { id: 'u' },
      deferred: false,
      replied: false,
      responded: false,
      memberPermissions: { has: () => true },
      inGuild: () => true,
      isAutocomplete: () => kind === 'auto',
      isChatInputCommand: () => kind === 'chat',
      isButton: () => kind === 'button',
      isAnySelectMenu: () => kind === 'select',
      isStringSelectMenu: () => kind === 'select',
      isModalSubmit: () => kind === 'modal',
      isFromMessage: () => false,
      isRepliable: () => kind !== 'auto',
      values: [] as string[],
      fields: { getTextInputValue: () => '' },
      options: {
        getSubcommand: () => 'check',
        getString: (n: string) => (n === 'site' ? 'Unpeg' : null),
        getBoolean: () => null,
        getInteger: () => null,
        getFocused: () => ({ name: 'site', value: '' }),
      },
      async reply(payload: unknown) {
        this.replied = true;
        calls.push({ type: 'reply', payload });
      },
      async deferReply(payload: unknown) {
        this.deferred = true;
        calls.push({ type: 'defer', payload });
      },
      async editReply(payload: unknown) {
        calls.push({ type: 'edit', payload });
      },
      async followUp(payload: unknown) {
        calls.push({ type: 'followUp', payload });
      },
      async respond(payload: unknown) {
        calls.push({ type: 'respond', payload });
      },
      async showModal(payload: unknown) {
        calls.push({ type: 'modal', payload });
      },
      async deferUpdate() {
        calls.push({ type: 'deferUpdate', payload: null });
      },
      ...over,
    };
    return { i: i as unknown as Interaction, calls };
  }

  function routeDeps(getMonitor: () => Monitor): RouteDeps & { store: Store } {
    const store = new Store(':memory:');
    store.createWatch({ guildId: '100000000000000001', channelId: 'c', name: 'Unpeg', url: 'https://unpeg.io/', host: 'unpeg.io', rootDomain: 'unpeg.io', createdBy: 'u' });
    return { store, config: testConfig(), log: spyLogger(), getMonitor };
  }

  it('reports a not-yet-started monitor as a friendly error', async () => {
    const d = routeDeps(() => {
      throw new Error('monitor not started yet');
    });
    const { i, calls } = baseInteraction('chat');
    await routeInteraction(i, d);
    expect(calls.at(-1)?.payload.content).toBe('⚠️ The bot is still starting up — try again in a few seconds.');
  });

  it('routes /watch, autocomplete and watchsub buttons; ignores everything else', async () => {
    let checks = 0;
    const monitor = {
      checkNow: async (id: number) => {
        checks++;
        return { watchId: id, alerts: [], durationMs: 5, error: null };
      },
    } as unknown as Monitor;
    const d = routeDeps(() => monitor);

    const chat = baseInteraction('chat');
    await routeInteraction(chat.i, d);
    expect(checks).toBe(1);
    expect(chat.calls.at(-1)?.payload.content).toContain('No changes on **Unpeg**');

    const auto = baseInteraction('auto');
    await routeInteraction(auto.i, d);
    expect(auto.calls[0]).toEqual({ type: 'respond', payload: [{ name: 'Unpeg — unpeg.io', value: '1' }] });

    const button = baseInteraction('button', { customId: 'watchsub:1:beta.unpeg.io' });
    const started: number[] = [];
    const d2 = { ...d, getMonitor: () => ({ runBaseline: async () => { throw new Error('offline'); }, onWatchAdded: (w: Watch) => started.push(w.id) }) as unknown as Monitor };
    await routeInteraction(button.i, d2);
    expect(started).toHaveLength(1);
    expect(button.calls.at(-1)?.payload.content).toContain('Now watching **beta.unpeg.io**');

    const other = baseInteraction('chat', { commandName: 'other' });
    const otherButton = baseInteraction('button', { customId: 'something:else' });
    await routeInteraction(other.i, d);
    await routeInteraction(otherButton.i, d);
    expect(other.calls).toHaveLength(0);
    expect(otherButton.calls).toHaveLength(0);
  });

  it('routes /panel, dashboard buttons, selects and modal submits to the panel', async () => {
    const placed: string[] = [];
    const refreshed: string[] = [];
    const host = {
      placePanel: async (g: string, c: string) => (placed.push(`${g}/${c}`), `https://discord.com/channels/${g}/${c}/1`),
      refresh: (g: string) => refreshed.push(g),
    };
    const monitor = { runtimeInfo: () => ({ running: true, lastTickAt: null, lastTickMs: null, nextTickAt: null, baselineRunning: false }) } as unknown as Monitor;
    const d = { ...routeDeps(() => monitor), getPanelHost: () => host };

    const panel = baseInteraction('chat', { commandName: 'panel' });
    await routeInteraction(panel.i, d);
    expect(placed).toEqual(['100000000000000001/200000000000000001']);
    expect(panel.calls.at(-1)?.payload.content).toContain('https://discord.com/channels/100000000000000001/200000000000000001/1');

    const help = baseInteraction('button', { customId: 'panel:help' });
    await routeInteraction(help.i, d);
    expect(help.calls.at(-1)?.payload.embeds[0].title).toContain('help');
    expect(help.calls.at(-1)?.payload.flags).toBe(64);

    const refresh = baseInteraction('button', { customId: 'panel:refresh' });
    await routeInteraction(refresh.i, d);
    expect(refreshed).toEqual(['100000000000000001']);
    expect(refresh.calls.at(-1)?.type).toBe('deferUpdate');

    const add = baseInteraction('button', { customId: 'panel:add' });
    await routeInteraction(add.i, d);
    expect(add.calls.at(-1)?.type).toBe('modal');

    const pick = baseInteraction('select', { customId: 'panel:pick:0', values: ['1'] });
    await routeInteraction(pick.i, d);
    expect(pick.calls.at(-1)?.payload.embeds[0].title).toContain('Unpeg');
    expect(pick.calls.at(-1)?.payload.flags).toBe(64);

    const modal = baseInteraction('modal', { customId: 'panel:m:add' });
    await routeInteraction(modal.i, d);
    expect(modal.calls.at(-1)?.payload.content).toContain('Enter the website URL');

    // Other selects / modals are not ours.
    const foreignSelect = baseInteraction('select', { customId: 'other:1' });
    const foreignModal = baseInteraction('modal', { customId: 'other' });
    await routeInteraction(foreignSelect.i, d);
    await routeInteraction(foreignModal.i, d);
    expect(foreignSelect.calls).toHaveLength(0);
    expect(foreignModal.calls).toHaveLength(0);
  });

  it('/panel without a dashboard host answers with an ephemeral error', async () => {
    const d = routeDeps(() => ({}) as Monitor);
    const { i, calls } = baseInteraction('chat', { commandName: 'panel' });
    await routeInteraction(i, d);
    expect(calls.at(-1)?.payload.content).toContain('not available right now');
    expect(calls.at(-1)?.payload.flags).toBe(64);
  });

  it('ignores interactions from other servers when locked to DISCORD_GUILD_ID', async () => {
    let checks = 0;
    const monitor = { checkNow: async (id: number) => (checks++, { watchId: id, alerts: [], durationMs: 5, error: null }) } as unknown as Monitor;
    const d = { ...routeDeps(() => monitor), config: testConfig({ discordGuildId: '100000000000000009' }) };
    const { i, calls } = baseInteraction('chat');
    await routeInteraction(i, d);
    expect(checks).toBe(0);
    expect(calls).toHaveLength(0);
    const own = baseInteraction('chat', { guildId: '100000000000000009' });
    await routeInteraction(own.i, d);
    expect(own.calls.length).toBeGreaterThan(0);
  });

  it('answers ephemerally when a handler blows up unexpectedly', async () => {
    const d = routeDeps(() => ({}) as Monitor);
    const { i, calls } = baseInteraction('chat', {
      inGuild: () => {
        throw new Error('weird');
      },
    });
    await routeInteraction(i, d);
    expect(calls.at(-1)?.payload.content).toContain('⚠️');
    expect(calls.at(-1)?.payload.flags).toBe(64);
  });
});
