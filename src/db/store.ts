/**
 * Persistence layer (SQLite via better-sqlite3, synchronous API).
 *
 * - `new Store(file)`: file path or ":memory:". Parent dir is created if needed. PRAGMAs: journal_mode=WAL (not for :memory:),
 *   synchronous=NORMAL, foreign_keys=ON, busy_timeout=5000.
 * - Schema versioning via PRAGMA user_version with forward-only migrations (MIGRATIONS[i] upgrades i → i+1). Idempotent on reopen.
 * - JSON columns round-trip exactly; booleans are stored as 0/1 and returned as booleans; missing feature keys are filled from
 *   DEFAULT_FEATURES; getState() deep-merges stored JSON over defaultWatchState() so fields added later get defaults.
 * - Page `text` is capped at MAX_STORED_TEXT_CHARS (silently truncated).
 * - Multi-row writes run in a transaction; prepared statements are cached per SQL string.
 * - Writes for a watch that no longer exists (deleted while a check was in flight) are silent no-ops instead of FK errors,
 *   so a racing tick can never throw out of the store.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  DEFAULT_FEATURES,
  defaultWatchState,
  type AlertKind,
  type DeployFingerprint,
  type DnsInfo,
  type EventRecord,
  type HttpProbe,
  type JsAnalysis,
  type NewWatchInput,
  type PageKind,
  type PageRecord,
  type PageSource,
  type SubdomainRecord,
  type SubdomainSource,
  type Watch,
  type WatchFeatures,
  type WatchPatch,
  type WatchState,
} from '../types.js';

export interface StoreDefaults {
  intervalSec: number;
  sweepSec: number;
  maxPages: number;
}

/** Stored page text is capped at this many chars. */
export const MAX_STORED_TEXT_CHARS = 500_000;
/** Event summaries are capped at this many chars. */
const MAX_EVENT_SUMMARY_CHARS = 4000;
/** Current schema version (= number of migrations). */
export const SCHEMA_VERSION = 3;

const BUILTIN_DEFAULTS: StoreDefaults = { intervalSec: 2, sweepSec: 120, maxPages: 150 };

type Db = Database.Database;
type Stmt = Database.Statement;

/** MIGRATIONS[i] upgrades the schema from version i to i + 1. Never edit a shipped migration; append a new one. */
const MIGRATIONS: Array<(db: Db) => void> = [
  // v1: initial schema
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS watches (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id       TEXT    NOT NULL,
        channel_id     TEXT    NOT NULL,
        name           TEXT    NOT NULL,
        url            TEXT    NOT NULL,
        host           TEXT    NOT NULL,
        root_domain    TEXT    NOT NULL,
        interval_sec   INTEGER NOT NULL,
        sweep_sec      INTEGER NOT NULL,
        max_pages      INTEGER NOT NULL,
        ping_role_id   TEXT,
        features_json  TEXT    NOT NULL DEFAULT '{}',
        ignore_json    TEXT    NOT NULL DEFAULT '[]',
        exclude_json   TEXT    NOT NULL DEFAULT '[]',
        extra_json     TEXT    NOT NULL DEFAULT '[]',
        scope_path     TEXT,
        mask_numbers   INTEGER NOT NULL DEFAULT 0,
        paused         INTEGER NOT NULL DEFAULT 0,
        baseline_done  INTEGER NOT NULL DEFAULT 0,
        created_by     TEXT    NOT NULL DEFAULT '',
        created_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS watches_guild ON watches(guild_id, id);

      CREATE TABLE IF NOT EXISTS watch_state (
        watch_id    INTEGER PRIMARY KEY REFERENCES watches(id) ON DELETE CASCADE,
        state_json  TEXT    NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pages (
        watch_id        INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
        url             TEXT    NOT NULL,
        kind            TEXT    NOT NULL,
        tracked         INTEGER NOT NULL DEFAULT 0,
        title           TEXT,
        text            TEXT,
        text_hash       TEXT,
        etag            TEXT,
        last_modified   TEXT,
        content_length  INTEGER,
        content_type    TEXT,
        status          INTEGER,
        fail_count      INTEGER NOT NULL DEFAULT 0,
        gone            INTEGER NOT NULL DEFAULT 0,
        mask_numbers    INTEGER NOT NULL DEFAULT 0,
        numeric_json    TEXT    NOT NULL DEFAULT '[]',
        flap_count      INTEGER NOT NULL DEFAULT 0,
        dynamic         INTEGER NOT NULL DEFAULT 0,
        source          TEXT    NOT NULL,
        depth           INTEGER NOT NULL DEFAULT 0,
        first_seen      INTEGER NOT NULL,
        last_checked    INTEGER NOT NULL DEFAULT 0,
        last_changed    INTEGER,
        PRIMARY KEY (watch_id, url)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS subdomains (
        watch_id      INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
        host          TEXT    NOT NULL,
        sources_json  TEXT    NOT NULL DEFAULT '[]',
        first_seen    INTEGER NOT NULL,
        last_seen     INTEGER NOT NULL,
        alive         INTEGER NOT NULL DEFAULT 0,
        last_probe    INTEGER NOT NULL DEFAULT 0,
        dns_json      TEXT,
        http_json     TEXT,
        PRIMARY KEY (watch_id, host)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS js_cache (
        url         TEXT    PRIMARY KEY,
        paths_json  TEXT    NOT NULL,
        hosts_json  TEXT    NOT NULL,
        fetched_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS js_cache_fetched ON js_cache(fetched_at);

      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_id    INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
        kind        TEXT    NOT NULL,
        summary     TEXT    NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_watch ON events(watch_id, id DESC);
      CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
    `);
  },
  // v2: text-noise bookkeeping per page (held number-only change, recent hashes for flip-flops, recent change times,
  //     lines whose numbers tick)
  (db) => {
    const cols = new Set((db.prepare(`PRAGMA table_info(pages)`).all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('pending_hash')) db.exec(`ALTER TABLE pages ADD COLUMN pending_hash TEXT`);
    if (!cols.has('pending_since')) db.exec(`ALTER TABLE pages ADD COLUMN pending_since INTEGER`);
    if (!cols.has('hash_history_json')) db.exec(`ALTER TABLE pages ADD COLUMN hash_history_json TEXT NOT NULL DEFAULT '[]'`);
    if (!cols.has('change_times_json')) db.exec(`ALTER TABLE pages ADD COLUMN change_times_json TEXT NOT NULL DEFAULT '[]'`);
    if (!cols.has('masked_lines_json')) db.exec(`ALTER TABLE pages ADD COLUMN masked_lines_json TEXT NOT NULL DEFAULT '[]'`);
  },
  // v3: per-guild dashboard/backup message location; watches still on the old 30s default move to the new 2s default
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        panel_channel_id TEXT,
        panel_message_id TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      UPDATE watches SET interval_sec = 2 WHERE interval_sec = 30;
    `);
  },
];

export interface GuildSettings {
  guildId: string;
  panelChannelId: string | null;
  panelMessageId: string | null;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface WatchRow {
  id: number;
  guild_id: string;
  channel_id: string;
  name: string;
  url: string;
  host: string;
  root_domain: string;
  interval_sec: number;
  sweep_sec: number;
  max_pages: number;
  ping_role_id: string | null;
  features_json: string;
  ignore_json: string;
  exclude_json: string;
  extra_json: string;
  scope_path: string | null;
  mask_numbers: number;
  paused: number;
  baseline_done: number;
  created_by: string;
  created_at: number;
}

interface PageRow {
  watch_id: number;
  url: string;
  kind: string;
  tracked: number;
  title: string | null;
  text: string | null;
  text_hash: string | null;
  etag: string | null;
  last_modified: string | null;
  content_length: number | null;
  content_type: string | null;
  status: number | null;
  fail_count: number;
  gone: number;
  mask_numbers: number;
  numeric_json: string;
  flap_count: number;
  dynamic: number;
  pending_hash: string | null;
  pending_since: number | null;
  hash_history_json: string | null;
  change_times_json: string | null;
  masked_lines_json: string | null;
  source: string;
  depth: number;
  first_seen: number;
  last_checked: number;
  last_changed: number | null;
}

interface SubdomainRow {
  watch_id: number;
  host: string;
  sources_json: string;
  first_seen: number;
  last_seen: number;
  alive: number;
  last_probe: number;
  dns_json: string | null;
  http_json: string | null;
}

interface EventRow {
  id: number;
  watch_id: number;
  kind: string;
  summary: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Value helpers (defensive: rows may come from older versions or manual edits)
// ---------------------------------------------------------------------------

function parseJson(raw: string | null | undefined): unknown {
  if (raw == null || raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function numberArray(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [];
}

function finite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function b01(v: unknown): number {
  return v ? 1 : 0;
}

function capText(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  if (typeof s !== 'string') s = String(s);
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

function mergeFeatures(base: WatchFeatures, patch: unknown): WatchFeatures {
  const out: WatchFeatures = { ...base };
  if (isPlainObject(patch)) {
    for (const key of Object.keys(DEFAULT_FEATURES) as Array<keyof WatchFeatures>) {
      const v = patch[key];
      if (typeof v === 'boolean') out[key] = v;
    }
  }
  return out;
}

/**
 * Deep-merge a stored value over its default. Plain-object defaults recurse (unknown stored keys are kept for
 * forward compatibility); `null` defaults accept any stored value; otherwise the stored value must have the same
 * JSON type as the default (arrays must be arrays, numbers finite numbers, ...) or the default wins.
 */
function mergeOverDefault(def: unknown, stored: unknown): unknown {
  if (stored === undefined) return def;
  if (def === null) return stored;
  if (Array.isArray(def)) return Array.isArray(stored) ? stored : def;
  if (isPlainObject(def)) {
    if (!isPlainObject(stored)) return def;
    const out: Record<string, unknown> = { ...stored };
    for (const [k, v] of Object.entries(def)) out[k] = mergeOverDefault(v, stored[k]);
    return out;
  }
  if (typeof def === 'number') return typeof stored === 'number' && Number.isFinite(stored) ? stored : def;
  return typeof stored === typeof def ? stored : def;
}

function sanitizeDeploy(v: unknown): DeployFingerprint | null {
  if (!isPlainObject(v)) return null;
  return {
    ...v,
    assets: stringArray(v.assets),
    buildId: strOrNull(v.buildId),
    generator: strOrNull(v.generator),
    sig: typeof v.sig === 'string' ? v.sig : '',
    seenAt: finite(v.seenAt, 0),
  } as DeployFingerprint;
}

function hashHistory(v: unknown): Array<{ hash: string; at: number }> {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isPlainObject)
    .filter((h) => typeof h.hash === 'string')
    .map((h) => ({ hash: h.hash as string, at: finite(h.at, 0) }));
}

function sanitizeWildcard(v: unknown): WatchState['wildcard'] {
  if (!isPlainObject(v)) return null;
  const answers = stringArray(v.answers);
  if (answers.length === 0) return null;
  return { answers, rotating: v.rotating === true, ...(v.spread === true ? { spread: true } : {}), at: finite(v.at, 0) };
}

function sanitizeDns(v: unknown): DnsInfo | null {
  if (!isPlainObject(v)) return null;
  return { a: stringArray(v.a), aaaa: stringArray(v.aaaa), cname: stringArray(v.cname) };
}

function sanitizeHttp(v: unknown): HttpProbe | null {
  if (!isPlainObject(v)) return null;
  return {
    status: finite(v.status, 0),
    title: strOrNull(v.title),
    finalUrl: strOrNull(v.finalUrl),
    server: strOrNull(v.server),
  };
}

/**
 * Simple local URL identity for watch lookups: lowercase scheme/host (via WHATWG URL), default port dropped, fragment
 * dropped, trailing slash stripped (except the root path). `withScheme=false` compares scheme-less keys.
 */
function urlKey(raw: string, withScheme: boolean): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  let u: URL;
  try {
    u = new URL(hasScheme ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let p = u.pathname.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '') || '/';
  const hostPort = u.host.toLowerCase().replace(/\.(?=:|$)/, '');
  const key = `${hostPort}${p}${u.search}`;
  return withScheme ? `${u.protocol}//${key}` : key;
}

function hasScheme(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s.trim());
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  private readonly db: Db;
  private readonly defaults: StoreDefaults;
  private readonly stmts = new Map<string, Stmt>();

  constructor(file: string, defaults?: Partial<StoreDefaults>) {
    const memory = file === ':memory:' || file === '';
    if (!memory) {
      const dir = path.dirname(path.resolve(file));
      fs.mkdirSync(dir, { recursive: true });
    }
    this.defaults = {
      intervalSec: positiveInt(defaults?.intervalSec, BUILTIN_DEFAULTS.intervalSec),
      sweepSec: positiveInt(defaults?.sweepSec, BUILTIN_DEFAULTS.sweepSec),
      maxPages: positiveInt(defaults?.maxPages, BUILTIN_DEFAULTS.maxPages),
    };
    this.db = new Database(memory ? ':memory:' : file);
    try {
      if (!memory) this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      this.migrate();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  /** Schema version of the open database (PRAGMA user_version). */
  schemaVersion(): number {
    return Number(this.db.pragma('user_version', { simple: true })) || 0;
  }

  private migrate(): void {
    const current = this.schemaVersion();
    // A newer database (e.g. after rolling back a deploy) is left alone: migrations are additive, so older code keeps working.
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        MIGRATIONS[v](this.db);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  private readonly watchListeners = new Set<(guildId: string) => void>();

  /** Subscribe to watch-list changes (create / update / delete) of a guild. Returns an unsubscribe function. */
  onWatchesChanged(cb: (guildId: string) => void): () => void {
    this.watchListeners.add(cb);
    return () => this.watchListeners.delete(cb);
  }

  private emitWatchesChanged(guildId: string): void {
    for (const cb of this.watchListeners) {
      try {
        cb(guildId);
      } catch {
        // listeners must never break a write
      }
    }
  }

  // --- guild settings (dashboard / backup message) ---------------------------

  getGuildSettings(guildId: string): GuildSettings | undefined {
    const row = this.stmt(`SELECT guild_id, panel_channel_id, panel_message_id, updated_at FROM guild_settings WHERE guild_id = ?`).get(
      String(guildId),
    ) as { guild_id: string; panel_channel_id: string | null; panel_message_id: string | null; updated_at: number } | undefined;
    if (!row) return undefined;
    return { guildId: row.guild_id, panelChannelId: row.panel_channel_id, panelMessageId: row.panel_message_id, updatedAt: row.updated_at };
  }

  setGuildSettings(guildId: string, patch: { panelChannelId?: string | null; panelMessageId?: string | null }): GuildSettings {
    const cur = this.getGuildSettings(guildId);
    const next: GuildSettings = {
      guildId: String(guildId),
      panelChannelId: patch.panelChannelId !== undefined ? patch.panelChannelId : (cur?.panelChannelId ?? null),
      panelMessageId: patch.panelMessageId !== undefined ? patch.panelMessageId : (cur?.panelMessageId ?? null),
      updatedAt: Date.now(),
    };
    this.stmt(
      `INSERT INTO guild_settings (guild_id, panel_channel_id, panel_message_id, updated_at) VALUES (@guildId, @panelChannelId, @panelMessageId, @updatedAt)
       ON CONFLICT(guild_id) DO UPDATE SET panel_channel_id = excluded.panel_channel_id, panel_message_id = excluded.panel_message_id,
         updated_at = excluded.updated_at`,
    ).run(next);
    return next;
  }

  private stmt(sql: string): Stmt {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  close(): void {
    if (!this.db.open) return;
    this.stmts.clear();
    try {
      if (!this.db.memory) this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // best effort
    }
    this.db.close();
  }

  // --- watches -------------------------------------------------------------

  /** Insert a watch (defaults applied for omitted fields; features merged over DEFAULT_FEATURES) and an empty default state row. */
  createWatch(input: NewWatchInput): Watch {
    const now = Date.now();
    const features = mergeFeatures(DEFAULT_FEATURES, input.features);
    const id = this.db.transaction(() => {
      const info = this.stmt(
        `INSERT INTO watches (guild_id, channel_id, name, url, host, root_domain, interval_sec, sweep_sec, max_pages, ping_role_id,
           features_json, ignore_json, exclude_json, extra_json, scope_path, mask_numbers, paused, baseline_done, created_by, created_at)
         VALUES (@guildId, @channelId, @name, @url, @host, @rootDomain, @intervalSec, @sweepSec, @maxPages, @pingRoleId,
           @features, @ignore, @exclude, @extra, @scopePath, @maskNumbers, 0, 0, @createdBy, @createdAt)`,
      ).run({
        guildId: String(input.guildId),
        channelId: String(input.channelId),
        name: String(input.name),
        url: String(input.url),
        host: String(input.host).toLowerCase(),
        rootDomain: String(input.rootDomain).toLowerCase(),
        intervalSec: positiveInt(input.intervalSec, this.defaults.intervalSec),
        sweepSec: positiveInt(input.sweepSec, this.defaults.sweepSec),
        maxPages: positiveInt(input.maxPages, this.defaults.maxPages),
        pingRoleId: input.pingRoleId ?? null,
        features: JSON.stringify(features),
        ignore: JSON.stringify(stringArray(input.ignorePatterns)),
        exclude: JSON.stringify(stringArray(input.excludePatterns)),
        extra: JSON.stringify(stringArray(input.extraUrls)),
        scopePath: input.scopePath ?? null,
        maskNumbers: b01(input.maskNumbers),
        createdBy: String(input.createdBy ?? ''),
        createdAt: now,
      });
      const newId = Number(info.lastInsertRowid);
      this.stmt(`INSERT INTO watch_state (watch_id, state_json, updated_at) VALUES (?, ?, ?)`).run(
        newId,
        JSON.stringify(defaultWatchState()),
        now,
      );
      return newId;
    })();
    const w = this.getWatch(id);
    if (!w) throw new Error(`watch ${id} vanished right after insert`);
    this.emitWatchesChanged(w.guildId);
    return w;
  }

  getWatch(id: number): Watch | undefined {
    if (!Number.isSafeInteger(id)) return undefined;
    const row = this.stmt(`SELECT * FROM watches WHERE id = ?`).get(id) as WatchRow | undefined;
    return row ? rowToWatch(row) : undefined;
  }

  /** All watches (optionally only for one guild), ordered by id. */
  listWatches(guildId?: string): Watch[] {
    const rows =
      guildId === undefined
        ? (this.stmt(`SELECT * FROM watches ORDER BY id`).all() as WatchRow[])
        : (this.stmt(`SELECT * FROM watches WHERE guild_id = ? ORDER BY id`).all(String(guildId)) as WatchRow[]);
    return rows.map(rowToWatch);
  }

  /**
   * Find a watch in a guild by: exact id (numeric string), exact case-insensitive name, exact host, or normalized-URL equality.
   * Returns undefined when nothing (or more than one by name) matches.
   *
   * Order: id ("12" or "#12") → name (ambiguous name → undefined) → URL (scheme-less input matches either scheme) → host
   * (only when exactly one watch has that host).
   */
  findWatch(guildId: string, query: string): Watch | undefined {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) return undefined;

    const idMatch = /^#?(\d{1,15})$/.exec(q);
    if (idMatch) {
      const w = this.getWatch(Number(idMatch[1]));
      if (w && w.guildId === String(guildId)) return w;
    }

    const watches = this.listWatches(guildId);
    if (watches.length === 0) return undefined;

    const lower = q.toLowerCase();
    const byName = watches.filter((w) => w.name.trim().toLowerCase() === lower);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) return undefined;

    const withScheme = hasScheme(q);
    const qKey = urlKey(q, withScheme);
    if (qKey) {
      const byUrl = watches.filter((w) => urlKey(w.url, withScheme) === qKey);
      if (byUrl.length === 1) return byUrl[0];
      if (byUrl.length > 1) {
        // Scheme-less query matching both http:// and https:// watches: prefer https.
        const https = byUrl.filter((w) => w.url.toLowerCase().startsWith('https:'));
        if (https.length === 1) return https[0];
        return undefined;
      }
    }

    const hostQ = lower.replace(/\.$/, '');
    const byHost = watches.filter((w) => w.host.toLowerCase() === hostQ);
    if (byHost.length === 1) return byHost[0];
    return undefined;
  }

  /** Existing watch in the guild with the same normalized url, if any. */
  findWatchByUrl(guildId: string, url: string): Watch | undefined {
    if (typeof url !== 'string') return undefined;
    const withScheme = hasScheme(url);
    const key = urlKey(url, withScheme);
    if (!key) return undefined;
    const matches = this.listWatches(guildId).filter((w) => urlKey(w.url, withScheme) === key);
    if (matches.length <= 1) return matches[0];
    return matches.find((w) => w.url.toLowerCase().startsWith('https:')) ?? matches[0];
  }

  /** Apply a patch (features patch is merged over existing features). Returns the updated watch. Throws if not found. */
  updateWatch(id: number, patch: WatchPatch): Watch {
    const cur = this.getWatch(id);
    if (!cur) throw new Error(`watch ${id} not found`);
    const p = (patch ?? {}) as WatchPatch;
    const next: Watch = {
      ...cur,
      channelId: p.channelId !== undefined ? String(p.channelId) : cur.channelId,
      name: p.name !== undefined ? String(p.name) : cur.name,
      url: typeof p.url === 'string' && p.url ? p.url : cur.url,
      host: typeof p.host === 'string' && p.host ? p.host.toLowerCase() : cur.host,
      intervalSec: positiveInt(p.intervalSec, cur.intervalSec),
      sweepSec: positiveInt(p.sweepSec, cur.sweepSec),
      maxPages: positiveInt(p.maxPages, cur.maxPages),
      pingRoleId: p.pingRoleId !== undefined ? p.pingRoleId : cur.pingRoleId,
      features: p.features !== undefined ? mergeFeatures(cur.features, p.features) : cur.features,
      ignorePatterns: p.ignorePatterns !== undefined ? stringArray(p.ignorePatterns) : cur.ignorePatterns,
      excludePatterns: p.excludePatterns !== undefined ? stringArray(p.excludePatterns) : cur.excludePatterns,
      extraUrls: p.extraUrls !== undefined ? stringArray(p.extraUrls) : cur.extraUrls,
      scopePath: p.scopePath !== undefined ? p.scopePath : cur.scopePath,
      maskNumbers: p.maskNumbers !== undefined ? Boolean(p.maskNumbers) : cur.maskNumbers,
      paused: p.paused !== undefined ? Boolean(p.paused) : cur.paused,
      baselineDone: p.baselineDone !== undefined ? Boolean(p.baselineDone) : cur.baselineDone,
    };
    this.stmt(
      `UPDATE watches SET url = @url, host = @host, channel_id = @channelId, name = @name, interval_sec = @intervalSec, sweep_sec = @sweepSec,
         max_pages = @maxPages, ping_role_id = @pingRoleId, features_json = @features, ignore_json = @ignore,
         exclude_json = @exclude, extra_json = @extra, scope_path = @scopePath, mask_numbers = @maskNumbers,
         paused = @paused, baseline_done = @baselineDone
       WHERE id = @id`,
    ).run({
      id,
      url: next.url,
      host: next.host,
      channelId: next.channelId,
      name: next.name,
      intervalSec: next.intervalSec,
      sweepSec: next.sweepSec,
      maxPages: next.maxPages,
      pingRoleId: next.pingRoleId ?? null,
      features: JSON.stringify(next.features),
      ignore: JSON.stringify(next.ignorePatterns),
      exclude: JSON.stringify(next.excludePatterns),
      extra: JSON.stringify(next.extraUrls),
      scopePath: next.scopePath ?? null,
      maskNumbers: b01(next.maskNumbers),
      paused: b01(next.paused),
      baselineDone: b01(next.baselineDone),
    });
    const updated = this.getWatch(id) ?? next;
    this.emitWatchesChanged(updated.guildId);
    return updated;
  }

  /** Delete a watch and all of its rows (cascade). */
  deleteWatch(id: number): void {
    if (!Number.isSafeInteger(id)) return;
    const guildId = this.getWatch(id)?.guildId;
    this.stmt(`DELETE FROM watches WHERE id = ?`).run(id);
    if (guildId !== undefined) this.emitWatchesChanged(guildId);
  }

  // --- state ---------------------------------------------------------------

  getState(watchId: number): WatchState {
    const row = Number.isSafeInteger(watchId)
      ? (this.stmt(`SELECT state_json FROM watch_state WHERE watch_id = ?`).get(watchId) as { state_json: string } | undefined)
      : undefined;
    const stored = parseJson(row?.state_json);
    const merged = mergeOverDefault(defaultWatchState(), stored) as WatchState;
    merged.deploy = sanitizeDeploy(merged.deploy);
    merged.deployHistory = (merged.deployHistory as unknown[])
      .filter(isPlainObject)
      .filter((h) => typeof h.sig === 'string')
      .map((h) => ({ sig: h.sig as string, at: finite(h.at, 0) }));
    merged.codePaths = stringArray(merged.codePaths);
    merged.codeHosts = stringArray(merged.codeHosts);
    merged.wildcard = sanitizeWildcard(merged.wildcard);
    merged.seenAssets = (merged.seenAssets as unknown[])
      .filter(isPlainObject)
      .filter((a) => typeof a.url === 'string')
      .map((a) => ({ url: a.url as string, at: finite(a.at, 0) }));
    merged.unstableQueryPaths = stringArray(merged.unstableQueryPaths);
    if (merged.ctCursor !== null && typeof merged.ctCursor !== 'string') merged.ctCursor = String(merged.ctCursor);
    if (merged.lastError !== null && typeof merged.lastError !== 'string') merged.lastError = null;
    const st = merged.status;
    if (st.lastError !== null && typeof st.lastError !== 'string') st.lastError = null;
    if (st.downSince !== null && !(typeof st.downSince === 'number' && Number.isFinite(st.downSince))) st.downSince = null;
    return merged;
  }

  /** Persist a watch's state. No-op if the watch no longer exists. */
  saveState(watchId: number, state: WatchState): void {
    if (!Number.isSafeInteger(watchId)) return;
    this.stmt(
      `INSERT INTO watch_state (watch_id, state_json, updated_at)
       SELECT id, ?, ? FROM watches WHERE id = ?
       ON CONFLICT(watch_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    ).run(JSON.stringify(state), Date.now(), watchId);
  }

  // --- pages / files -------------------------------------------------------

  getPage(watchId: number, url: string): PageRecord | undefined {
    const row = this.stmt(`SELECT * FROM pages WHERE watch_id = ? AND url = ?`).get(watchId, String(url)) as PageRow | undefined;
    return row ? rowToPage(row) : undefined;
  }

  /** All page rows for a watch, optionally filtered by kind and/or tracked flag; ordered by depth, then firstSeen, then url. */
  listPages(watchId: number, filter?: { kind?: PageKind; tracked?: boolean }): PageRecord[] {
    const { where, params } = pageFilter(watchId, filter);
    const rows = this.stmt(`SELECT * FROM pages WHERE ${where} ORDER BY depth, first_seen, url`).all(...params) as PageRow[];
    return rows.map(rowToPage);
  }

  /** Set of every known URL (tracked or not, any kind) for a watch. */
  knownUrls(watchId: number): Set<string> {
    const rows = this.stmt(`SELECT url FROM pages WHERE watch_id = ?`).pluck().all(watchId) as string[];
    return new Set(rows);
  }

  countPages(watchId: number, filter?: { kind?: PageKind; tracked?: boolean }): number {
    const { where, params } = pageFilter(watchId, filter);
    return Number(this.stmt(`SELECT COUNT(*) FROM pages WHERE ${where}`).pluck().get(...params)) || 0;
  }

  /** Insert or replace a page row. No-op if the watch no longer exists. */
  upsertPage(rec: PageRecord): void {
    this.stmt(UPSERT_PAGE_SQL).run(pageParams(rec));
  }

  upsertPages(recs: PageRecord[]): void {
    if (!Array.isArray(recs) || recs.length === 0) return;
    const stmt = this.stmt(UPSERT_PAGE_SQL);
    this.db.transaction((list: PageRecord[]) => {
      for (const rec of list) stmt.run(pageParams(rec));
    })(recs);
  }

  deletePage(watchId: number, url: string): void {
    this.stmt(`DELETE FROM pages WHERE watch_id = ? AND url = ?`).run(watchId, String(url));
  }

  /**
   * Reset text-noise flags (flapCount=0, dynamic=false, numericChangeTimes=[], maskNumbers=false, no held change, empty
   * hash/change history and masked lines) and textHash=null for all pages of a watch (after ignore-pattern changes). Only kind='page' rows:
   * file hashes are byte hashes that ignore patterns don't affect, and resetting them would silently re-baseline (and so
   * miss) a concurrent file change. The scheduler re-hashes the stored texts under the new rules right after (see
   * rehashPages), so a page does not have to be re-fetched to be compared again.
   */
  resetPageNoise(watchId: number): void {
    this.stmt(
      `UPDATE pages SET flap_count = 0, dynamic = 0, numeric_json = '[]', mask_numbers = 0, text_hash = NULL,
         pending_hash = NULL, pending_since = NULL, hash_history_json = '[]', change_times_json = '[]', masked_lines_json = '[]'
       WHERE watch_id = ? AND kind = 'page'`,
    ).run(watchId);
  }

  // --- subdomains ------------------------------------------------------------

  /** Ordered by host. */
  listSubdomains(watchId: number): SubdomainRecord[] {
    const rows = this.stmt(`SELECT * FROM subdomains WHERE watch_id = ? ORDER BY host`).all(watchId) as SubdomainRow[];
    return rows.map(rowToSubdomain);
  }

  getSubdomain(watchId: number, host: string): SubdomainRecord | undefined {
    const row = this.stmt(`SELECT * FROM subdomains WHERE watch_id = ? AND host = ?`).get(
      watchId,
      String(host).toLowerCase(),
    ) as SubdomainRow | undefined;
    return row ? rowToSubdomain(row) : undefined;
  }

  /** Insert or replace a subdomain row. No-op if the watch no longer exists. */
  upsertSubdomain(rec: SubdomainRecord): void {
    this.stmt(UPSERT_SUBDOMAIN_SQL).run(subdomainParams(rec));
  }

  upsertSubdomains(recs: SubdomainRecord[]): void {
    if (!Array.isArray(recs) || recs.length === 0) return;
    const stmt = this.stmt(UPSERT_SUBDOMAIN_SQL);
    this.db.transaction((list: SubdomainRecord[]) => {
      for (const rec of list) stmt.run(subdomainParams(rec));
    })(recs);
  }

  // --- js analysis cache (hashed bundle URLs are immutable) ------------------

  getJsAnalysis(url: string): JsAnalysis | undefined {
    const row = this.stmt(`SELECT paths_json, hosts_json FROM js_cache WHERE url = ?`).get(String(url)) as
      | { paths_json: string; hosts_json: string }
      | undefined;
    if (!row) return undefined;
    return { paths: stringArray(parseJson(row.paths_json)), hosts: stringArray(parseJson(row.hosts_json)) };
  }

  putJsAnalysis(url: string, analysis: JsAnalysis, now: number): void {
    this.stmt(
      `INSERT INTO js_cache (url, paths_json, hosts_json, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET paths_json = excluded.paths_json, hosts_json = excluded.hosts_json,
         fetched_at = excluded.fetched_at`,
    ).run(
      String(url),
      JSON.stringify(stringArray(analysis?.paths)),
      JSON.stringify(stringArray(analysis?.hosts)),
      finite(now, Date.now()),
    );
  }

  /** Keep only the newest `keep` rows by fetched_at. */
  pruneJsCache(keep: number): void {
    const n = Math.max(0, Math.floor(finite(keep, 0)));
    this.stmt(
      `DELETE FROM js_cache WHERE rowid NOT IN (SELECT rowid FROM js_cache ORDER BY fetched_at DESC, rowid DESC LIMIT ?)`,
    ).run(n);
  }

  // --- events (history) ------------------------------------------------------

  /** Append a history event. No-op if the watch no longer exists. */
  addEvent(watchId: number, kind: AlertKind, summary: string, now: number): void {
    this.stmt(
      `INSERT INTO events (watch_id, kind, summary, created_at) SELECT id, ?, ?, ? FROM watches WHERE id = ?`,
    ).run(String(kind), capText(String(summary ?? ''), MAX_EVENT_SUMMARY_CHARS) ?? '', finite(now, Date.now()), watchId);
  }

  /** Newest first. */
  listEvents(watchId: number, limit: number): EventRecord[] {
    const n = Math.max(0, Math.floor(finite(limit, 0)));
    if (n === 0) return [];
    const rows = this.stmt(`SELECT * FROM events WHERE watch_id = ? ORDER BY id DESC LIMIT ?`).all(watchId, n) as EventRow[];
    return rows.map((r) => ({
      id: r.id,
      watchId: r.watch_id,
      kind: r.kind as AlertKind,
      summary: r.summary,
      createdAt: r.created_at,
    }));
  }

  /** Delete events older than `olderThan` (ms epoch). */
  pruneEvents(olderThan: number): void {
    if (!Number.isFinite(olderThan)) return;
    this.stmt(`DELETE FROM events WHERE created_at < ?`).run(olderThan);
  }
}

// ---------------------------------------------------------------------------
// Row <-> record mapping
// ---------------------------------------------------------------------------

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

function rowToWatch(r: WatchRow): Watch {
  return {
    id: r.id,
    guildId: r.guild_id,
    channelId: r.channel_id,
    name: r.name,
    url: r.url,
    host: r.host,
    rootDomain: r.root_domain,
    intervalSec: r.interval_sec,
    sweepSec: r.sweep_sec,
    maxPages: r.max_pages,
    pingRoleId: r.ping_role_id ?? null,
    features: mergeFeatures(DEFAULT_FEATURES, parseJson(r.features_json)),
    ignorePatterns: stringArray(parseJson(r.ignore_json)),
    excludePatterns: stringArray(parseJson(r.exclude_json)),
    extraUrls: stringArray(parseJson(r.extra_json)),
    scopePath: r.scope_path ?? null,
    maskNumbers: r.mask_numbers === 1,
    paused: r.paused === 1,
    baselineDone: r.baseline_done === 1,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

const PAGE_KINDS: readonly PageKind[] = ['page', 'file'];
const PAGE_SOURCES: readonly PageSource[] = ['start', 'link', 'sitemap', 'extra', 'code', 'redirect'];
const SUB_SOURCES: readonly SubdomainSource[] = ['ct', 'crtsh', 'dns', 'link', 'code'];

function pageFilter(watchId: number, filter?: { kind?: PageKind; tracked?: boolean }): { where: string; params: unknown[] } {
  let where = 'watch_id = ?';
  const params: unknown[] = [watchId];
  if (filter?.kind !== undefined) {
    where += ' AND kind = ?';
    params.push(filter.kind);
  }
  if (filter?.tracked !== undefined) {
    where += ' AND tracked = ?';
    params.push(b01(filter.tracked));
  }
  return { where, params };
}

const PAGE_COLUMNS = [
  'watch_id',
  'url',
  'kind',
  'tracked',
  'title',
  'text',
  'text_hash',
  'etag',
  'last_modified',
  'content_length',
  'content_type',
  'status',
  'fail_count',
  'gone',
  'mask_numbers',
  'numeric_json',
  'flap_count',
  'dynamic',
  'pending_hash',
  'pending_since',
  'hash_history_json',
  'change_times_json',
  'masked_lines_json',
  'source',
  'depth',
  'first_seen',
  'last_checked',
  'last_changed',
] as const;

// INSERT … SELECT FROM watches makes the write a no-op when the watch was deleted concurrently (instead of an FK error).
const UPSERT_PAGE_SQL = `INSERT INTO pages (${PAGE_COLUMNS.join(', ')})
  SELECT ${PAGE_COLUMNS.map((c) => (c === 'watch_id' ? 'id' : '@' + c)).join(', ')} FROM watches WHERE id = @watch_id
  ON CONFLICT(watch_id, url) DO UPDATE SET
  ${PAGE_COLUMNS.filter((c) => c !== 'watch_id' && c !== 'url')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')}`;

function pageParams(rec: PageRecord): Record<(typeof PAGE_COLUMNS)[number], unknown> {
  return {
    watch_id: rec.watchId,
    url: String(rec.url),
    kind: PAGE_KINDS.includes(rec.kind) ? rec.kind : 'page',
    tracked: b01(rec.tracked),
    title: typeof rec.title === 'string' ? rec.title : null,
    text: capText(rec.text, MAX_STORED_TEXT_CHARS),
    text_hash: typeof rec.textHash === 'string' ? rec.textHash : null,
    etag: typeof rec.etag === 'string' ? rec.etag : null,
    last_modified: typeof rec.lastModified === 'string' ? rec.lastModified : null,
    content_length: finiteOrNull(rec.contentLength),
    content_type: typeof rec.contentType === 'string' ? rec.contentType : null,
    status: finiteOrNull(rec.status),
    fail_count: finite(rec.failCount, 0),
    gone: b01(rec.gone),
    mask_numbers: b01(rec.maskNumbers),
    numeric_json: JSON.stringify(numberArray(rec.numericChangeTimes)),
    flap_count: finite(rec.flapCount, 0),
    dynamic: b01(rec.dynamic),
    pending_hash: typeof rec.pendingHash === 'string' ? rec.pendingHash : null,
    pending_since: typeof rec.pendingHash === 'string' ? finiteOrNull(rec.pendingSince) : null,
    hash_history_json: JSON.stringify(hashHistory(rec.hashHistory)),
    change_times_json: JSON.stringify(numberArray(rec.changeTimes)),
    masked_lines_json: JSON.stringify(stringArray(rec.maskedLines)),
    source: typeof rec.source === 'string' ? rec.source : 'link',
    depth: finite(rec.depth, 0),
    first_seen: finite(rec.firstSeen, Date.now()),
    last_checked: finite(rec.lastChecked, 0),
    last_changed: finiteOrNull(rec.lastChanged),
  };
}

function rowToPage(r: PageRow): PageRecord {
  return {
    watchId: r.watch_id,
    url: r.url,
    kind: PAGE_KINDS.includes(r.kind as PageKind) ? (r.kind as PageKind) : 'page',
    tracked: r.tracked === 1,
    title: r.title,
    text: r.text,
    textHash: r.text_hash,
    etag: r.etag,
    lastModified: r.last_modified,
    contentLength: r.content_length,
    contentType: r.content_type,
    status: r.status,
    failCount: r.fail_count ?? 0,
    gone: r.gone === 1,
    maskNumbers: r.mask_numbers === 1,
    numericChangeTimes: numberArray(parseJson(r.numeric_json)),
    flapCount: r.flap_count ?? 0,
    dynamic: r.dynamic === 1,
    pendingHash: typeof r.pending_hash === 'string' ? r.pending_hash : null,
    pendingSince: typeof r.pending_hash === 'string' ? finiteOrNull(r.pending_since) : null,
    hashHistory: hashHistory(parseJson(r.hash_history_json)),
    changeTimes: numberArray(parseJson(r.change_times_json)),
    maskedLines: stringArray(parseJson(r.masked_lines_json)),
    source: PAGE_SOURCES.includes(r.source as PageSource) ? (r.source as PageSource) : 'link',
    depth: r.depth ?? 0,
    firstSeen: r.first_seen ?? 0,
    lastChecked: r.last_checked ?? 0,
    lastChanged: r.last_changed ?? null,
  };
}

const UPSERT_SUBDOMAIN_SQL = `INSERT INTO subdomains
    (watch_id, host, sources_json, first_seen, last_seen, alive, last_probe, dns_json, http_json)
  SELECT id, @host, @sources_json, @first_seen, @last_seen, @alive, @last_probe, @dns_json, @http_json
  FROM watches WHERE id = @watch_id
  ON CONFLICT(watch_id, host) DO UPDATE SET sources_json = excluded.sources_json, first_seen = excluded.first_seen,
    last_seen = excluded.last_seen, alive = excluded.alive, last_probe = excluded.last_probe, dns_json = excluded.dns_json,
    http_json = excluded.http_json`;

function subdomainParams(rec: SubdomainRecord): Record<string, unknown> {
  const now = Date.now();
  return {
    watch_id: rec.watchId,
    host: String(rec.host).toLowerCase(),
    sources_json: JSON.stringify(stringArray(rec.sources)),
    first_seen: finite(rec.firstSeen, now),
    last_seen: finite(rec.lastSeen, now),
    alive: b01(rec.alive),
    last_probe: finite(rec.lastProbe, 0),
    dns_json: rec.dns ? JSON.stringify(rec.dns) : null,
    http_json: rec.http ? JSON.stringify(rec.http) : null,
  };
}

function rowToSubdomain(r: SubdomainRow): SubdomainRecord {
  return {
    watchId: r.watch_id,
    host: r.host,
    sources: stringArray(parseJson(r.sources_json)).filter((s): s is SubdomainSource =>
      SUB_SOURCES.includes(s as SubdomainSource),
    ),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    alive: r.alive === 1,
    lastProbe: r.last_probe ?? 0,
    dns: sanitizeDns(parseJson(r.dns_json)),
    http: sanitizeHttp(parseJson(r.http_json)),
  };
}
