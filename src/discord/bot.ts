/**
 * Discord client wiring + DiscordNotifier.
 *
 * - Client intents: [GatewayIntentBits.Guilds] only (no privileged intents).
 * - On ClientReady: log "Logged in as <tag>", log the invite URL:
 *   https://discord.com/oauth2/authorize?client_id=<appId>&scope=bot%20applications.commands&permissions=<perms>
 *   with perms = ViewChannel|SendMessages|EmbedLinks|ReadMessageHistory|MentionEveryone (as a bigint string).
 *   Register commands: if config.discordGuildId → only that guild; else for every guild in the cache
 *   (guild.commands.set(defs)) — guild commands update instantly. Also on GuildCreate for newly joined guilds.
 *   Registration failures are logged, never fatal.
 * - InteractionCreate routing: chat input `/watch` → handleChatInput; autocomplete → handleAutocomplete;
 *   button with customId starting "watchsub:" → handleButton. Wrap each in try/catch; on error reply/followUp ephemeral if possible.
 * - `client.on('error'|'warn'|'shardDisconnect'|'shardReconnecting'|'shardResume')` logged.
 * - The `monitor` may be constructed before the client is ready: `startBot` accepts a factory so commands can reach it.
 * - A failed initial login is fatal (the process exits with code 1 so Railway restarts it and the logs show why): a failed
 *   discord.js login destroys its client for good, and a bot that silently never connects would drop every alert.
 *
 * DiscordNotifier.notify(watch, alerts):
 * - payloads = formatAlerts(watch, alerts); channel = await client.channels.fetch(watch.channelId) (cached);
 *   must be text-based & sendable; send each payload sequentially (discord.js handles rate limits).
 * - If the client is not ready (yet), the payloads are queued in memory and notify returns at once (a check never waits
 *   on Discord); the queue is sent when the client becomes ready (flush()) and on a backoff timer.
 * - On Missing Access / Unknown Channel / Missing Permissions (codes 50001, 10003, 50013): log a warning once per watch per hour
 *   and drop (don't throw). Other errors: retry once after 2s; if that fails too, the rest of the batch is queued and
 *   retried later (in order) instead of dropped. A payload Discord rejects as malformed (50035) is not retried as-is; a
 *   plain-text fallback is sent instead so the alert isn't lost. The queue holds at most MAX_QUEUED payloads for at most
 *   MAX_QUEUED_AGE_MS (oldest dropped first, with a warning).
 *
 * Guilds:
 * - With DISCORD_GUILD_ID set, the bot serves only that server: it leaves any other server it is invited to (and ones it
 *   was already in), and ignores interactions from elsewhere (stale command registrations).
 * - When the bot is removed from a server (GuildDelete — outages are GuildUnavailable, not this), that server's watches stop
 *   running (their rows are kept); they start again if the bot is added back.
 * - A gateway close Discord will not recover from (4004 invalid token, 4010–4014) exits the process (so the platform
 *   restarts it and the logs say why) instead of leaving a process that looks healthy but never posts.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  type Guild,
  type Interaction,
  type MessageCreateOptions,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import type { Monitor } from '../monitor/scheduler.js';
import type { Alert, Logger, Notifier, Watch } from '../types.js';
import { COMMAND_NAME, UserError, commandDefinitions, handleAutocomplete, handleButton, handleChatInput, type CommandDeps } from './commands.js';
import { WATCH_SUB_PREFIX, formatAlerts, truncate, type MessagePayload } from './format.js';

/** Permissions requested by the invite link. MentionEveryone lets the bot ping roles that aren't "mentionable". */
export const BOT_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.MentionEveryone;

export function inviteUrl(appId: string): string {
  return (
    `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}` +
    `&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS.toString()}`
  );
}

/** Discord error codes meaning "this channel can't be used" — retrying won't help. */
const ACCESS_ERROR_CODES = new Set([10003, 50001, 50013]);
const INVALID_FORM_BODY = 50035;
const ACCESS_WARN_EVERY_MS = 60 * 60 * 1000;
/** Undelivered payloads kept in memory, and for how long. */
export const MAX_QUEUED = 500;
export const MAX_QUEUED_AGE_MS = 6 * 3600_000;
const FLUSH_RETRY_MIN_MS = 30_000;
const FLUSH_RETRY_MAX_MS = 10 * 60_000;
/** Gateway close codes discord.js does not reconnect after (the process would stay up without Discord). */
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

function errorCode(err: unknown): number | string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' || typeof code === 'string' ? code : undefined;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref?.();
  });
}

type SendableChannel = { send(options: MessageCreateOptions): Promise<unknown> };

function toCreateOptions(p: MessagePayload): MessageCreateOptions {
  const out: MessageCreateOptions = { embeds: p.embeds, allowedMentions: p.allowedMentions };
  if (p.content) out.content = p.content;
  if (p.components?.length) out.components = p.components;
  return out;
}

/** Plain-text version of a payload, used when Discord rejects the rich one. */
function plainFallback(p: MessagePayload): MessageCreateOptions {
  const parts = [p.content ?? ''];
  for (const e of p.embeds) {
    if (e.title) parts.push(e.title);
    if (e.url) parts.push(`<${e.url}>`);
  }
  const content = truncate(parts.filter(Boolean).join('\n'), 1900) || '(alert could not be rendered)';
  return { content, allowedMentions: p.allowedMentions };
}

interface QueuedPayload {
  watch: Watch;
  payload: MessagePayload;
  queuedAt: number;
}

export class DiscordNotifier implements Notifier {
  /** Delay before the single retry of a failed send (ms). */
  retryDelayMs = 2000;
  /** Clock for the access-warning throttle and queue expiry (tests may replace it). */
  now: () => number = () => Date.now();
  /** Delay before a queued batch is retried after a failure (doubles up to FLUSH_RETRY_MAX_MS). */
  flushRetryMs = FLUSH_RETRY_MIN_MS;

  private readonly accessWarnedAt = new Map<number, number>();
  private readonly queue: QueuedPayload[] = [];
  private flushing: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private retryIn = FLUSH_RETRY_MIN_MS;

  constructor(
    private readonly client: Client,
    private readonly log: Logger,
  ) {}

  /** Payloads waiting for delivery. */
  get queued(): number {
    return this.queue.length;
  }

  async notify(watch: Watch, alerts: Alert[]): Promise<void> {
    if (!Array.isArray(alerts) || alerts.length === 0) return;
    try {
      const payloads = formatAlerts(watch, alerts);
      if (!payloads.length) return;
      if (!this.isClientReady() || this.queue.length > 0) {
        // Not connected (yet), or older alerts are still waiting: keep the order, send when possible.
        this.enqueue(watch, payloads);
        if (this.isClientReady()) await this.flush();
        else {
          this.log.info('Discord client not ready — alerts queued', { watchId: watch.id, kinds: alerts.map((a) => a.kind).join(','), queued: this.queue.length });
          this.scheduleFlush();
        }
        return;
      }
      const rest = await this.sendAll(watch, payloads);
      if (rest.length) {
        this.enqueue(watch, rest);
        this.scheduleFlush();
      }
    } catch (err) {
      this.log.error('notify failed', { watchId: watch?.id, err: err instanceof Error ? err : String(err) });
    }
  }

  /** Send queued payloads in order (call when the client becomes ready). Never throws; concurrent calls share one run. */
  flush(): Promise<void> {
    this.flushing ??= this.runFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async runFlush(): Promise<void> {
    try {
      this.expire();
      while (this.queue.length > 0 && this.isClientReady()) {
        const head = this.queue[0];
        // The consecutive payloads of one watch go out together (one channel lookup).
        let n = 1;
        while (n < this.queue.length && this.queue[n].watch.id === head.watch.id) n++;
        const batch = this.queue.slice(0, n).map((q) => q.payload);
        const rest = await this.sendAll(head.watch, batch);
        const sent = batch.length - rest.length;
        this.queue.splice(0, rest.length ? sent : n);
        if (rest.length) {
          this.scheduleFlush();
          return;
        }
      }
      this.retryIn = FLUSH_RETRY_MIN_MS;
      if (this.queue.length > 0) this.scheduleFlush();
    } catch (err) {
      this.log.error('flushing queued alerts failed', { err: errText(err) });
      this.scheduleFlush();
    }
  }

  private enqueue(watch: Watch, payloads: MessagePayload[]): void {
    const now = this.now();
    for (const payload of payloads) this.queue.push({ watch, payload, queuedAt: now });
    if (this.queue.length > MAX_QUEUED) {
      const dropped = this.queue.splice(0, this.queue.length - MAX_QUEUED);
      this.log.warn('alert queue full — dropping the oldest queued alerts', { dropped: dropped.length });
    }
  }

  private expire(): void {
    const now = this.now();
    const before = this.queue.length;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (now - this.queue[i].queuedAt > MAX_QUEUED_AGE_MS) this.queue.splice(i, 1);
    }
    if (this.queue.length < before) this.log.warn('dropping queued alerts that could not be delivered for hours', { dropped: before - this.queue.length });
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.queue.length === 0) return;
    const wait = Math.max(this.flushRetryMs, this.retryIn);
    this.retryIn = Math.min(FLUSH_RETRY_MAX_MS, this.retryIn * 2);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, wait);
    this.flushTimer.unref?.();
  }

  /** Clears the retry timer (shutdown / tests). */
  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /**
   * Send payloads to the watch's channel in order. Returns the payloads that should be retried later (a transient
   * failure stops the batch); payloads for an unusable channel are dropped.
   */
  private async sendAll(watch: Watch, payloads: MessagePayload[]): Promise<MessagePayload[]> {
    const channel = await this.resolveChannel(watch);
    if (channel === 'retry') return payloads;
    if (!channel) return [];
    for (let i = 0; i < payloads.length; i++) {
      const outcome = await this.send(watch, channel, payloads[i]);
      if (outcome === 'abort') return [];
      if (outcome === 'retry') return payloads.slice(i);
    }
    return [];
  }

  private isClientReady(): boolean {
    try {
      return typeof this.client.isReady === 'function' ? this.client.isReady() : true;
    } catch {
      return false;
    }
  }

  private warnAccess(watch: Watch, reason: string, err?: unknown): void {
    const now = this.now();
    const last = this.accessWarnedAt.get(watch.id);
    if (last !== undefined && now - last < ACCESS_WARN_EVERY_MS) return;
    this.accessWarnedAt.set(watch.id, now);
    this.log.warn(`cannot post alerts for "${watch.name}": ${reason} — alerts are dropped until this is fixed`, {
      watchId: watch.id,
      channelId: watch.channelId,
      guildId: watch.guildId,
      code: errorCode(err),
      err: err === undefined ? undefined : errText(err),
    });
  }

  private async resolveChannel(watch: Watch): Promise<SendableChannel | null | 'retry'> {
    let channel: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        channel = await this.client.channels.fetch(watch.channelId);
        break;
      } catch (err) {
        if (ACCESS_ERROR_CODES.has(errorCode(err) as number)) {
          this.warnAccess(watch, 'the alert channel is missing or not visible to the bot', err);
          return null;
        }
        if (attempt === 0) {
          await delay(this.retryDelayMs);
          continue;
        }
        this.log.error('failed to fetch alert channel — alerts queued for a retry', { watchId: watch.id, channelId: watch.channelId, err: errText(err) });
        return 'retry';
      }
    }
    const ch = channel as { isTextBased?: () => boolean; isSendable?: () => boolean; send?: unknown } | null;
    const textBased = Boolean(ch && typeof ch.isTextBased === 'function' && ch.isTextBased());
    const sendable = Boolean(ch && (typeof ch.isSendable === 'function' ? ch.isSendable() : typeof ch.send === 'function'));
    if (!ch || !textBased || !sendable || typeof ch.send !== 'function') {
      this.warnAccess(watch, 'the alert channel is not a text channel the bot can post in');
      return null;
    }
    return ch as SendableChannel;
  }

  private async send(watch: Watch, channel: SendableChannel, payload: MessagePayload): Promise<'ok' | 'failed' | 'abort' | 'retry'> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await channel.send(toCreateOptions(payload));
        return 'ok';
      } catch (err) {
        const code = errorCode(err);
        if (ACCESS_ERROR_CODES.has(code as number)) {
          this.warnAccess(watch, 'the bot lacks access or permissions in the alert channel', err);
          return 'abort';
        }
        if (code === INVALID_FORM_BODY) {
          this.log.error('Discord rejected an alert message — sending a plain-text fallback', { watchId: watch.id, err: errText(err) });
          try {
            await channel.send(plainFallback(payload));
          } catch (err2) {
            this.log.error('plain-text fallback failed', { watchId: watch.id, err: errText(err2) });
          }
          return 'failed';
        }
        if (attempt === 0) {
          this.log.warn('sending alert failed — retrying', { watchId: watch.id, code, err: errText(err) });
          await delay(this.retryDelayMs);
          continue;
        }
        this.log.error('sending alert failed — queued for a later retry', { watchId: watch.id, code, err: errText(err) });
        return 'retry';
      }
    }
    return 'retry';
  }
}

/** Handles a gateway close: true (and the process exits) when discord.js will not reconnect by itself. */
export function handleShardDisconnect(code: number | undefined, log: Logger, exit: (code: number) => void = (c) => process.exit(c)): boolean {
  if (typeof code !== 'number' || !FATAL_CLOSE_CODES.has(code)) return false;
  log.error(
    code === 4004
      ? 'Discord rejected DISCORD_TOKEN (gateway close 4004) — reset the bot token in the developer portal and update the Railway variable'
      : `Discord closed the gateway with ${code} and will not reconnect (check the bot's intents/settings) — exiting so the service restarts`,
    { code },
  );
  const t = setTimeout(() => exit(1), 1000);
  t.unref?.();
  return true;
}

/** Stop the watches of a server the bot was removed from (rows are kept) — or start them again when it is back. */
export function setGuildWatchesRunning(guildId: string, running: boolean, deps: { store: Store; log: Logger; getMonitor: () => Monitor }): number {
  let monitor: Monitor;
  try {
    monitor = deps.getMonitor();
  } catch {
    return 0;
  }
  let n = 0;
  for (const w of deps.store.listWatches(guildId)) {
    try {
      if (running) monitor.onWatchAdded(w);
      else monitor.onWatchRemoved(w.id);
      n++;
    } catch (err) {
      deps.log.warn('updating watch after a server change failed', { watchId: w.id, err: errText(err) });
    }
  }
  if (n) deps.log.info(running ? 'server back: its watches run again' : 'server gone: its watches are stopped (kept in storage)', { guildId, watches: n });
  return n;
}

export interface BotHandle {
  client: Client;
  notifier: DiscordNotifier;
  /** Resolves once the client is ready (commands registered). */
  ready: Promise<void>;
  isReady(): boolean;
  /** The client has been ready at least once (the token and gateway work). */
  wasEverReady(): boolean;
  destroy(): Promise<void>;
}

export interface RouteDeps {
  store: Store;
  config: Config;
  log: Logger;
  getMonitor: () => Monitor;
}

/** Command deps whose `monitor` is resolved lazily, so a not-yet-started monitor yields a friendly error, not a crash. */
function commandDeps(d: RouteDeps): CommandDeps {
  return {
    store: d.store,
    config: d.config,
    log: d.log,
    get monitor(): Monitor {
      try {
        return d.getMonitor();
      } catch {
        throw new UserError('The bot is still starting up — try again in a few seconds.');
      }
    },
  };
}

/** Dispatch one interaction to the right handler. Never throws. */
export async function routeInteraction(interaction: Interaction, d: RouteDeps): Promise<void> {
  // Locked to one server: stale command registrations elsewhere must not reach the handlers.
  if (d.config.discordGuildId && interaction.guildId !== d.config.discordGuildId) return;
  try {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === COMMAND_NAME) await handleAutocomplete(interaction, commandDeps(d));
      return;
    }
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === COMMAND_NAME) await handleChatInput(interaction, commandDeps(d));
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(WATCH_SUB_PREFIX)) {
      await handleButton(interaction, commandDeps(d));
    }
  } catch (err) {
    d.log.error('interaction handler crashed', { err: err instanceof Error ? err : String(err) });
    try {
      if (interaction.isRepliable()) {
        const body = { content: '⚠️ Something went wrong — please try again.', flags: MessageFlags.Ephemeral } as const;
        if (interaction.deferred || interaction.replied) await interaction.followUp(body);
        else await interaction.reply(body);
      }
    } catch {
      // interaction expired
    }
  }
}

/** Guild commands don't take the global-only `contexts` / `integration_types` fields. */
function guildCommandBodies(defs: RESTPostAPIChatInputApplicationCommandsJSONBody[]): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return defs.map((def) => {
    const copy = { ...def };
    delete copy.contexts;
    delete copy.integration_types;
    return copy;
  });
}

/**
 * Create the client and notifier, wire interaction handlers (which call `getMonitor()` lazily), and log in.
 * Returns immediately after login() is initiated; `ready` resolves on ClientReady.
 */
export async function startBot(deps: {
  config: Config;
  store: Store;
  log: Logger;
  getMonitor: () => Monitor;
  exit?: (code: number) => void;
}): Promise<BotHandle> {
  const { config, log } = deps;
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    // Safe default for every message the bot sends; alert payloads opt into their ping role explicitly.
    allowedMentions: { parse: [] },
  });
  const notifier = new DiscordNotifier(client, log.child({ mod: 'notifier' }));
  const defs = guildCommandBodies(commandDefinitions(config));
  let destroyed = false;

  const registerGuild = async (guild: Guild): Promise<void> => {
    try {
      await guild.commands.set(defs);
      log.info('registered slash commands', { guild: guild.name, guildId: guild.id });
    } catch (err) {
      log.warn('failed to register slash commands', { guildId: guild.id, code: errorCode(err), err: errText(err) });
    }
  };

  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  let everReady = false;

  const leaveGuild = async (guild: Guild): Promise<void> => {
    log.warn('leaving a server that is not DISCORD_GUILD_ID (this bot serves one server)', { guild: guild.name, guildId: guild.id });
    try {
      await guild.leave();
    } catch (err) {
      log.warn('leaving the server failed', { guildId: guild.id, err: errText(err) });
    }
  };

  client.once(Events.ClientReady, async (c) => {
    try {
      log.info(`Logged in as ${c.user.tag}`);
      log.info(`Invite URL: ${inviteUrl(c.application?.id ?? c.user.id)}`);
      if (config.discordGuildId) {
        for (const guild of [...c.guilds.cache.values()]) if (guild.id !== config.discordGuildId) await leaveGuild(guild);
        try {
          const guild = await c.guilds.fetch(config.discordGuildId);
          await registerGuild(guild);
        } catch (err) {
          log.warn('DISCORD_GUILD_ID is set but the bot is not in that server (use the invite URL above)', {
            guildId: config.discordGuildId,
            err: errText(err),
          });
        }
      } else {
        const guilds = [...c.guilds.cache.values()];
        if (!guilds.length) log.info('the bot is not in any server yet — use the invite URL above');
        for (const guild of guilds) await registerGuild(guild);
      }
      // Watches of servers the bot is no longer in would crawl and poll forever without anywhere to post.
      const present = new Set(c.guilds.cache.keys());
      const gone = new Set(deps.store.listWatches().map((w) => w.guildId).filter((g) => !present.has(g)));
      for (const guildId of gone) setGuildWatchesRunning(guildId, false, deps);
    } catch (err) {
      log.error('ready handler failed', { err: err instanceof Error ? err : String(err) });
    } finally {
      everReady = true;
      markReady();
      void notifier.flush();
    }
  });

  client.on(Events.GuildCreate, (guild) => {
    log.info('joined server', { guild: guild.name, guildId: guild.id });
    if (config.discordGuildId && guild.id !== config.discordGuildId) {
      void leaveGuild(guild);
      return;
    }
    void registerGuild(guild);
    setGuildWatchesRunning(guild.id, true, deps);
  });
  client.on(Events.GuildDelete, (guild) => {
    // Only a kick/leave/deletion: an outage emits GuildUnavailable instead. The watches stop (rows are kept).
    log.info('removed from server', { guildId: guild.id });
    setGuildWatchesRunning(guild.id, false, deps);
  });

  const routeDeps: RouteDeps = { store: deps.store, config, log, getMonitor: deps.getMonitor };
  client.on(Events.InteractionCreate, (interaction) => {
    void routeInteraction(interaction, routeDeps);
  });

  client.on(Events.Error, (err) => log.error('discord client error', { err }));
  client.on(Events.Warn, (msg) => log.warn('discord warning', { msg }));
  client.on(Events.ShardError, (err, shardId) => log.warn('discord shard error', { shardId, err: errText(err) }));
  client.on(Events.ShardDisconnect, (event, shardId) => {
    if (destroyed) return;
    log.warn('discord shard disconnected', { shardId, code: event?.code });
    handleShardDisconnect(event?.code, log, deps.exit);
  });
  client.on(Events.ShardReconnecting, (shardId) => log.info('discord shard reconnecting', { shardId }));
  client.on(Events.ShardResume, (shardId, replayed) => log.info('discord shard resumed', { shardId, replayed }));

  client.login(config.discordToken).catch((err: unknown) => {
    if (destroyed) return;
    const code = errorCode(err);
    const invalid = code === 'TokenInvalid' || code === 'TokenMissing';
    log.error(
      invalid
        ? 'Discord rejected DISCORD_TOKEN — reset the bot token in the developer portal and update the Railway variable'
        : 'Discord login failed — exiting so the service restarts',
      { code, err: errText(err) },
    );
    // A failed login destroys the discord.js client permanently; restart the process instead of running without Discord.
    setTimeout(() => process.exit(1), invalid ? 1000 : 10_000);
  });

  return {
    client,
    notifier,
    ready,
    isReady: () => client.isReady(),
    wasEverReady: () => everReady,
    destroy: async () => {
      destroyed = true;
      notifier.close();
      try {
        await client.destroy();
      } catch (err) {
        log.warn('error while closing the Discord client', { err: errText(err) });
      }
    },
  };
}
