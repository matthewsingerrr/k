/**
 * The persistent dashboard message per guild — and the watch-list backup that rides on it.
 *
 * Railway containers start with a fresh filesystem on every deploy unless a volume is attached. So the watch list
 * (sites + their settings, not the crawl state) is also kept in Discord itself: the pinned dashboard message carries
 * a JSON attachment with every watch of the guild. When the bot starts with no record of a guild's dashboard
 * (fresh database), it looks for its own latest backup message in the guild's channels and restores the watches from
 * it; restored watches run a silent baseline first, so a redeploy never floods the channel.
 *
 * Link API tokens (/link create) ride along as sha256 hashes only — the attachment is visible to everyone in the
 * channel, and a hash of a 256-bit random token can't be turned back into a usable token — so linked browser
 * extensions keep working after a redeploy without a volume.
 *
 * Safety: nothing is ever posted or edited for a guild before its restore check finished, so an empty fresh database
 * can never overwrite a good backup.
 */

import { createHash } from 'node:crypto';
import { AttachmentBuilder, ChannelType, type Client, type Guild, type Message } from 'discord.js';
import type { Config } from '../config.js';
import type { LinkToken, Store } from '../db/store.js';
import type { Monitor } from '../monitor/scheduler.js';
import type { Logger, Watch, WatchFeatures } from '../types.js';
import { buildPanelMessage, PANEL_COLOR, type PanelHost, type PanelMessage } from './panel.js';
import { BUILD_ID, COMMIT_MESSAGE, COMMIT_SHORT, DISPLAY_VERSION, APP_VERSION } from '../version.js';

export const BACKUP_FILENAME = 'site-watcher-backup.json';
const BACKUP_VERSION = 1;
const REFRESH_DEBOUNCE_MS = 2_000;
/** Periodic re-render so status emojis (down/up, paused) stay current even without watch-list changes. */
const PERIODIC_REFRESH_MS = 60_000;
/** Channels scanned per guild when looking for a backup (pins first, then recent history). */
const MAX_SCAN_CHANNELS = 100;
const HISTORY_SCAN_LIMIT = 50;
const RESTORE_RETRY_MS = [10_000, 60_000, 300_000];

/** Watch settings that survive a redeploy (crawl state is rebuilt by a silent baseline). */
export interface BackupWatch {
  name: string;
  url: string;
  host: string;
  rootDomain: string;
  channelId: string;
  intervalSec: number;
  sweepSec: number;
  maxPages: number;
  pingRoleId: string | null;
  features: WatchFeatures;
  ignorePatterns: string[];
  excludePatterns: string[];
  extraUrls: string[];
  scopePath: string | null;
  maskNumbers: boolean;
  paused: boolean;
  createdBy: string;
  createdAt: number;
}

/** A Link API token as backed up: its sha256 hash only, never the token itself. */
export interface BackupLink {
  label: string;
  channelId: string;
  /** sha256 hex of the token (64 lowercase hex chars). */
  tokenHash: string;
  createdBy: string;
  createdAt: number;
}

export interface BackupFile {
  version: number;
  guildId: string;
  exportedAt: string;
  /** BUILD_ID last announced in the guild, so a fresh container doesn't re-announce the same deploy. */
  announcedVersion?: string | null;
  watches: BackupWatch[];
  /** Link API tokens (hashes). Optional: older backups have none, and older code ignores the field. */
  links?: BackupLink[];
}

/** Most link tokens restored from one backup (a guild normally has a handful). */
export const MAX_BACKUP_LINKS = 100;
const MAX_LINK_LABEL_CHARS = 100;
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;
const SNOWFLAKE_RE = /^\d{1,25}$/;

export function toBackup(
  guildId: string,
  watches: Watch[],
  now = new Date(),
  announcedVersion: string | null = null,
  links: ReadonlyArray<Pick<LinkToken, 'label' | 'channelId' | 'tokenHash' | 'createdBy' | 'createdAt'>> = [],
): BackupFile {
  return {
    version: BACKUP_VERSION,
    guildId,
    exportedAt: now.toISOString(),
    announcedVersion,
    links: links.map((l) => ({
      label: l.label,
      channelId: l.channelId,
      tokenHash: l.tokenHash,
      createdBy: l.createdBy,
      createdAt: l.createdAt,
    })),
    watches: watches.map((w) => ({
      name: w.name,
      url: w.url,
      host: w.host,
      rootDomain: w.rootDomain,
      channelId: w.channelId,
      intervalSec: w.intervalSec,
      sweepSec: w.sweepSec,
      maxPages: w.maxPages,
      pingRoleId: w.pingRoleId,
      features: w.features,
      ignorePatterns: w.ignorePatterns,
      excludePatterns: w.excludePatterns,
      extraUrls: w.extraUrls,
      scopePath: w.scopePath,
      maskNumbers: w.maskNumbers,
      paused: w.paused,
      createdBy: w.createdBy,
      createdAt: w.createdAt,
    })),
  };
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const posInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

/** Parse & validate a backup file; invalid entries are dropped. Returns null for anything that isn't a backup. */
export function parseBackup(text: string): BackupFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== 'number' || r.version > BACKUP_VERSION || !Array.isArray(r.watches)) return null;
  const watches: BackupWatch[] = [];
  for (const e of r.watches as unknown[]) {
    if (!e || typeof e !== 'object') continue;
    const w = e as Record<string, unknown>;
    if (!str(w.url) || !str(w.host) || !str(w.channelId) || !str(w.name)) continue;
    watches.push({
      name: w.name,
      url: w.url,
      host: w.host,
      rootDomain: str(w.rootDomain) ? w.rootDomain : w.host,
      channelId: w.channelId,
      intervalSec: posInt(w.intervalSec) ?? 0,
      sweepSec: posInt(w.sweepSec) ?? 0,
      maxPages: posInt(w.maxPages) ?? 0,
      pingRoleId: str(w.pingRoleId) ? w.pingRoleId : null,
      features: (w.features && typeof w.features === 'object' ? w.features : {}) as WatchFeatures,
      ignorePatterns: strArr(w.ignorePatterns),
      excludePatterns: strArr(w.excludePatterns),
      extraUrls: strArr(w.extraUrls),
      scopePath: str(w.scopePath) ? w.scopePath : null,
      maskNumbers: w.maskNumbers === true,
      paused: w.paused === true,
      createdBy: str(w.createdBy) ? w.createdBy : 'restore',
      createdAt: typeof w.createdAt === 'number' ? w.createdAt : Date.now(),
    });
  }
  return {
    version: r.version,
    guildId: str(r.guildId) ? r.guildId : '',
    exportedAt: str(r.exportedAt) ? r.exportedAt : '',
    announcedVersion: str(r.announcedVersion) ? r.announcedVersion : null,
    watches,
    links: parseLinks(r.links),
  };
}

/** Valid link entries (64-hex hash, numeric channel id, non-empty label), deduped by hash, at most MAX_BACKUP_LINKS. */
function parseLinks(raw: unknown): BackupLink[] {
  if (!Array.isArray(raw)) return [];
  const out: BackupLink[] = [];
  const seen = new Set<string>();
  for (const e of raw as unknown[]) {
    if (out.length >= MAX_BACKUP_LINKS) break;
    if (!e || typeof e !== 'object') continue;
    const l = e as Record<string, unknown>;
    const hash = typeof l.tokenHash === 'string' ? l.tokenHash.trim().toLowerCase() : '';
    if (!TOKEN_HASH_RE.test(hash) || seen.has(hash)) continue;
    if (typeof l.channelId !== 'string' || !SNOWFLAKE_RE.test(l.channelId)) continue;
    const label = typeof l.label === 'string' ? l.label.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_LINK_LABEL_CHARS) : '';
    if (!label) continue;
    seen.add(hash);
    out.push({
      label,
      channelId: l.channelId,
      tokenHash: hash,
      createdBy: str(l.createdBy) ? l.createdBy.slice(0, 100) : 'restore',
      createdAt: typeof l.createdAt === 'number' && Number.isFinite(l.createdAt) ? l.createdAt : Date.now(),
    });
  }
  return out;
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/** Stable fingerprint of what the dashboard shows (ignores the render timestamp). */
function panelFingerprint(msg: PanelMessage): string {
  return sha1(JSON.stringify({ e: msg.embeds.map((e) => ({ ...e, timestamp: undefined })), c: msg.components }));
}

function errCode(err: unknown): number | undefined {
  const c = (err as { code?: unknown })?.code;
  return typeof c === 'number' ? c : undefined;
}

type Sendable = { id: string; send: (opts: unknown) => Promise<Message>; messages: Message['channel']['messages'] };

export interface PanelManagerDeps {
  client: Client;
  store: Store;
  config: Config;
  log: Logger;
  getMonitor: () => Monitor | null;
  /** Called for every watch created by a restore (the caller starts monitoring it). */
  onRestored: (watch: Watch) => void;
}

export class PanelManager implements PanelHost {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly syncing = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  /** Guilds whose next sync must edit the message even if nothing changed (resets the "Manage a site…" menu). */
  private readonly forced = new Set<string>();
  /** Guilds whose restore check finished (successfully found nothing, restored, or had a dashboard already). */
  private readonly checked = new Set<string>();
  private readonly lastBackupHash = new Map<string, string>();
  private readonly lastPanelHash = new Map<string, string>();
  private periodic: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly deps: PanelManagerDeps) {}

  private startDone = false;
  private readonly bornAt = Date.now();

  /**
   * True until every guild the bot is in finished its restore check after this start (link API answers 503 meanwhile).
   * Capped at 5 minutes so a stuck restore can't hide a genuinely revoked token forever.
   */
  restoring(): boolean {
    if (this.stopped || Date.now() - this.bornAt > 5 * 60_000) return false;
    if (!this.startDone) return true;
    for (const id of this.deps.client.guilds.cache.keys()) if (!this.checked.has(id)) return true;
    return false;
  }

  /** Call once the Discord client is ready: restore missing guilds, then keep dashboards in sync. */
  async start(): Promise<void> {
    this.unsubscribe = this.deps.store.onWatchesChanged((guildId) => this.schedule(guildId, false));
    try {
      for (const guild of this.deps.client.guilds.cache.values()) await this.ensureRestored(guild);
    } finally {
      this.startDone = true;
    }
    for (const guild of this.deps.client.guilds.cache.values()) {
      await this.announceUpdate(guild.id).catch((err) =>
        this.deps.log.warn('update announcement failed', { guildId: guild.id, err: String(err) }),
      );
    }
    this.periodic = setInterval(() => {
      for (const guild of this.deps.client.guilds.cache.values()) {
        if (this.deps.store.getGuildSettings(guild.id)?.panelMessageId) this.schedule(guild.id, false);
      }
    }, PERIODIC_REFRESH_MS);
    this.periodic.unref();
  }

  /** A guild the bot just joined (or re-joined). */
  async onGuildAvailable(guild: Guild): Promise<void> {
    await this.ensureRestored(guild);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.periodic) clearInterval(this.periodic);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Explicit refresh (Refresh button, site picked): always re-renders the message. */
  refresh(guildId: string): void {
    this.schedule(guildId, true);
  }

  private schedule(guildId: string, force: boolean): void {
    if (this.stopped) return;
    if (force) this.forced.add(guildId);
    const existing = this.timers.get(guildId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(guildId);
      void this.sync(guildId);
    }, REFRESH_DEBOUNCE_MS);
    t.unref();
    this.timers.set(guildId, t);
  }

  async placePanel(guildId: string, channelId: string): Promise<string> {
    const guild = await this.deps.client.guilds.fetch(guildId);
    await this.ensureRestored(guild);
    const channel = await this.sendableChannel(channelId);
    if (!channel) throw new Error('I can’t post in that channel — check that I can view it and send messages there.');
    const old = this.deps.store.getGuildSettings(guildId);
    const msg = await this.post(guildId, channel);
    if (old?.panelChannelId && old.panelMessageId && old.panelMessageId !== msg.id) {
      await this.deleteMessage(old.panelChannelId, old.panelMessageId);
    }
    return msg.url;
  }

  // ---------------------------------------------------------------------------

  private async ensureRestored(guild: Guild): Promise<void> {
    if (this.checked.has(guild.id)) return;
    const { store, log } = this.deps;
    if (store.getGuildSettings(guild.id)?.panelMessageId || store.listWatches(guild.id).length > 0) {
      this.checked.add(guild.id);
      this.schedule(guild.id, false);
      return;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const found = await this.findBackup(guild);
        if (found) this.restore(guild.id, found.channelId, found.messageId, found.backup);
        this.checked.add(guild.id);
        if (this.dirty.delete(guild.id) || found) this.schedule(guild.id, false);
        return;
      } catch (err) {
        const wait = RESTORE_RETRY_MS[attempt];
        log.warn('looking for a watch-list backup failed', { guildId: guild.id, attempt: attempt + 1, err: String(err) });
        if (wait === undefined || this.stopped) {
          // Give up but never block the guild forever; a later add simply starts a fresh dashboard.
          this.checked.add(guild.id);
          return;
        }
        await new Promise((r) => setTimeout(r, wait).unref());
      }
    }
  }

  private restore(guildId: string, channelId: string, messageId: string, backup: BackupFile): void {
    const { store, config, log } = this.deps;
    store.setGuildSettings(guildId, { panelChannelId: channelId, panelMessageId: messageId, announcedVersion: backup.announcedVersion ?? null });
    let restored = 0;
    for (const b of backup.watches) {
      if (store.findWatchByUrl(guildId, b.url)) continue;
      try {
        let watch = store.createWatch({
          guildId,
          channelId: b.channelId,
          name: b.name,
          url: b.url,
          host: b.host,
          rootDomain: b.rootDomain,
          createdBy: b.createdBy,
          intervalSec: b.intervalSec || config.defaultIntervalSec,
          sweepSec: b.sweepSec || config.defaultSweepSec,
          maxPages: b.maxPages || config.defaultMaxPages,
          pingRoleId: b.pingRoleId,
          features: b.features,
          ignorePatterns: b.ignorePatterns,
          excludePatterns: b.excludePatterns,
          extraUrls: b.extraUrls,
          scopePath: b.scopePath,
          maskNumbers: b.maskNumbers,
        });
        if (b.paused) watch = store.updateWatch(watch.id, { paused: true });
        this.deps.onRestored(watch);
        restored++;
      } catch (err) {
        log.warn('could not restore a watch from the backup', { guildId, url: b.url, err: String(err) });
      }
    }
    let links = 0;
    for (const l of backup.links ?? []) {
      try {
        store.importLinkToken({ guildId, channelId: l.channelId, label: l.label, tokenHash: l.tokenHash, createdBy: l.createdBy, createdAt: l.createdAt, lastUsedAt: null });
        links++;
      } catch (err) {
        log.warn('could not restore a link token from the backup', { guildId, label: l.label, err: String(err) });
      }
    }
    log.info(`restored ${restored} watch(es) and ${links} link token(s) from the Discord backup`, { guildId, exportedAt: backup.exportedAt });
  }

  /** Newest backup message authored by this bot in the guild (pinned messages first, then recent history). */
  private async findBackup(guild: Guild): Promise<{ channelId: string; messageId: string; backup: BackupFile } | null> {
    const me = this.deps.client.user?.id;
    if (!me) throw new Error('client not ready');
    const channels = (await guild.channels.fetch())
      .filter((c): c is NonNullable<typeof c> => !!c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement))
      .filter((c) => c.viewable)
      .first(MAX_SCAN_CHANNELS);
    // Prefer channels that already have a watch pointing at them (cheapest hit on a partially restored guild).
    let best: Message | null = null;
    const consider = (m: Message) => {
      if (m.author?.id !== me || !m.attachments.some((a) => a.name === BACKUP_FILENAME)) return;
      const ts = m.editedTimestamp ?? m.createdTimestamp;
      if (!best || ts > (best.editedTimestamp ?? best.createdTimestamp)) best = m;
    };
    for (const ch of channels) {
      if (!('messages' in ch)) continue;
      try {
        const pins = await ch.messages.fetchPins();
        for (const p of pins.items) consider(p.message as Message);
      } catch (err) {
        if (errCode(err) !== 50001 && errCode(err) !== 50013) throw err;
      }
      try {
        const recent = await ch.messages.fetch({ limit: HISTORY_SCAN_LIMIT });
        for (const m of recent.values()) consider(m as Message);
      } catch (err) {
        if (errCode(err) !== 50001 && errCode(err) !== 50013) throw err;
      }
    }
    const found = best as Message | null;
    if (!found) return null;
    const att = found.attachments.find((a) => a.name === BACKUP_FILENAME);
    if (!att) return null;
    const res = await fetch(att.url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`backup download failed: HTTP ${res.status}`);
    const backup = parseBackup(await res.text());
    if (!backup) {
      this.deps.log.warn('found a backup message but its file is not a valid backup', { guildId: guild.id, messageId: found.id });
      return null;
    }
    return { channelId: found.channelId, messageId: found.id, backup };
  }

  private async sync(guildId: string): Promise<void> {
    if (this.stopped) return;
    if (!this.checked.has(guildId)) {
      this.dirty.add(guildId);
      return;
    }
    const inflight = this.syncing.get(guildId);
    if (inflight) {
      this.dirty.add(guildId);
      return;
    }
    const run = this.syncOnce(guildId)
      .catch((err) => this.deps.log.warn('updating the dashboard failed', { guildId, err: String(err) }))
      .finally(() => {
        this.syncing.delete(guildId);
        if (this.dirty.delete(guildId)) this.schedule(guildId, false);
      });
    this.syncing.set(guildId, run);
    await run;
  }

  private async syncOnce(guildId: string): Promise<void> {
    const { store } = this.deps;
    const settings = store.getGuildSettings(guildId);
    const watches = store.listWatches(guildId);
    if (settings?.panelChannelId && settings.panelMessageId) {
      const channel = await this.sendableChannel(settings.panelChannelId);
      if (channel) {
        try {
          const msg = await channel.messages.fetch(settings.panelMessageId);
          await this.edit(guildId, msg);
          return;
        } catch (err) {
          if (errCode(err) !== 10008) throw err; // 10008 Unknown Message: someone deleted it → post a new one
        }
        await this.post(guildId, channel);
        return;
      }
    }
    // No dashboard yet (or its channel is gone): put it where the first site's alerts go — or, for a server that only
    // has link tokens so far, where the first link posts (so the tokens are backed up too).
    const candidates = [...new Set([...watches.map((w) => w.channelId), ...store.listLinkTokens(guildId).map((l) => l.channelId)])];
    for (const channelId of candidates) {
      const channel = await this.sendableChannel(channelId);
      if (channel) {
        await this.post(guildId, channel);
        return;
      }
    }
  }

  private render(guildId: string): PanelMessage {
    return buildPanelMessage({ store: this.deps.store, config: this.deps.config, monitor: this.deps.getMonitor() }, guildId);
  }

  private backupFile(guildId: string): { json: string; hash: string } {
    const { store } = this.deps;
    const announced = store.getGuildSettings(guildId)?.announcedVersion ?? null;
    const backup = toBackup(guildId, store.listWatches(guildId), new Date(), announced, store.listLinkTokens(guildId));
    const json = JSON.stringify(backup, null, 2);
    // Token create/revoke changes the hash (lastUsedAt is not backed up, so token use does not).
    return { json, hash: sha1(JSON.stringify([backup.announcedVersion, backup.watches, backup.links ?? []])) };
  }

  /**
   * After a deploy of new code: "🚀 Ver 2.0 has been updated! Enjoy 🎉" in the dashboard channel (or the first alert channel).
   * Only for servers that already use the bot (a dashboard or at least one site) and only once per build — the build id is
   * stored in the database and in the Discord backup, so restarts and fresh containers don't repeat it.
   */
  async announceUpdate(guildId: string): Promise<boolean> {
    const { store, config, log } = this.deps;
    const settings = store.getGuildSettings(guildId);
    const watches = store.listWatches(guildId);
    if (settings?.announcedVersion === BUILD_ID) return false;
    const record = () => {
      store.setGuildSettings(guildId, { announcedVersion: BUILD_ID });
      this.schedule(guildId, false); // carry the new marker into the backup
    };
    if (!config.announceUpdates || (!settings?.panelMessageId && watches.length === 0)) {
      if (settings || watches.length) record();
      return false;
    }
    const candidates = [settings?.panelChannelId, ...watches.map((w) => w.channelId)].filter((c): c is string => !!c);
    for (const channelId of [...new Set(candidates)]) {
      const channel = await this.sendableChannel(channelId);
      if (!channel) continue;
      const lines = [`**Site Watcher v${APP_VERSION}** is live and watching **${watches.length}** ${watches.length === 1 ? 'site' : 'sites'}.`];
      if (COMMIT_MESSAGE) lines.push('', `**What's new:** ${COMMIT_MESSAGE}`);
      await channel.send({
        content: `🚀 **Ver ${DISPLAY_VERSION} has been updated!** Enjoy 🎉`,
        embeds: [
          {
            color: PANEL_COLOR,
            description: lines.join('\n'),
            footer: { text: COMMIT_SHORT ? `build ${COMMIT_SHORT}` : `v${APP_VERSION}` },
            timestamp: new Date().toISOString(),
          },
        ],
        allowedMentions: { parse: [] },
      });
      record();
      log.info('announced update', { guildId, build: BUILD_ID });
      return true;
    }
    return false;
  }

  private async post(guildId: string, channel: Sendable): Promise<Message> {
    const panel = this.render(guildId);
    const { json, hash } = this.backupFile(guildId);
    const msg = await channel.send({
      ...panel,
      files: [new AttachmentBuilder(Buffer.from(json), { name: BACKUP_FILENAME, description: 'Watch-list backup (restored automatically after redeploys)' })],
      allowedMentions: { parse: [] },
    });
    this.deps.store.setGuildSettings(guildId, { panelChannelId: channel.id, panelMessageId: msg.id });
    this.lastBackupHash.set(guildId, hash);
    this.lastPanelHash.set(guildId, panelFingerprint(panel));
    try {
      await msg.pin();
    } catch (err) {
      this.deps.log.info('could not pin the dashboard (grant the bot "Pin Messages" to keep it pinned)', { guildId, err: String(err) });
    }
    return msg;
  }

  private async edit(guildId: string, msg: Message): Promise<void> {
    const panel = this.render(guildId);
    const { json, hash } = this.backupFile(guildId);
    const panelHash = panelFingerprint(panel);
    const hasFile = msg.attachments.some((a) => a.name === BACKUP_FILENAME);
    const backupChanged = !hasFile || this.lastBackupHash.get(guildId) !== hash;
    const force = this.forced.delete(guildId);
    if (!force && !backupChanged && this.lastPanelHash.get(guildId) === panelHash) return;
    await msg.edit({
      ...panel,
      ...(backupChanged
        ? {
            attachments: [],
            files: [new AttachmentBuilder(Buffer.from(json), { name: BACKUP_FILENAME, description: 'Watch-list backup (restored automatically after redeploys)' })],
          }
        : {}),
      allowedMentions: { parse: [] },
    });
    this.lastBackupHash.set(guildId, hash);
    this.lastPanelHash.set(guildId, panelHash);
  }

  private async sendableChannel(channelId: string): Promise<Sendable | null> {
    try {
      const ch = await this.deps.client.channels.fetch(channelId);
      if (!ch || !ch.isTextBased() || !('send' in ch) || ch.isDMBased()) return null;
      if ('isSendable' in ch && typeof ch.isSendable === 'function' && !ch.isSendable()) return null;
      return ch as unknown as Sendable;
    } catch {
      return null;
    }
  }

  private async deleteMessage(channelId: string, messageId: string): Promise<void> {
    try {
      const ch = await this.sendableChannel(channelId);
      const m = await ch?.messages.fetch(messageId);
      await m?.delete();
    } catch {
      // best effort
    }
  }
}
