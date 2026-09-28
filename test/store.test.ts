import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_STORED_TEXT_CHARS, SCHEMA_VERSION, Store } from '../src/db/store.js';
import {
  DEFAULT_FEATURES,
  defaultWatchState,
  type NewWatchInput,
  type PageRecord,
  type SubdomainRecord,
  type WatchState,
} from '../src/types.js';

function watchInput(over: Partial<NewWatchInput> = {}): NewWatchInput {
  return {
    guildId: 'g1',
    channelId: 'c1',
    name: 'Unpeg',
    url: 'https://unpeg.io/',
    host: 'unpeg.io',
    rootDomain: 'unpeg.io',
    createdBy: 'u1',
    ...over,
  };
}

function page(watchId: number, url: string, over: Partial<PageRecord> = {}): PageRecord {
  return {
    watchId,
    url,
    kind: 'page',
    tracked: true,
    title: null,
    text: null,
    textHash: null,
    etag: null,
    lastModified: null,
    contentLength: null,
    contentType: null,
    status: null,
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
    firstSeen: 1000,
    lastChecked: 0,
    lastChanged: null,
    ...over,
  };
}

function sub(watchId: number, host: string, over: Partial<SubdomainRecord> = {}): SubdomainRecord {
  return {
    watchId,
    host,
    sources: ['ct'],
    firstSeen: 1000,
    lastSeen: 2000,
    alive: false,
    lastProbe: 0,
    dns: null,
    http: null,
    ...over,
  };
}

let tmpDir: string;
const stores: Store[] = [];
function open(file = ':memory:', defaults?: ConstructorParameters<typeof Store>[1]): Store {
  const s = new Store(file, defaults);
  stores.push(s);
  return s;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
});

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Store: opening & migrations', () => {
  it('opens in memory', () => {
    const s = open();
    expect(s.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(s.listWatches()).toEqual([]);
  });

  it('creates parent directories, uses WAL and persists across reopen', () => {
    const file = path.join(tmpDir, 'nested', 'deeper', 'watcher.db');
    const s1 = open(file);
    const w = s1.createWatch(watchInput());
    s1.upsertPage(page(w.id, 'https://unpeg.io/docs', { text: 'hello', textHash: 'h1' }));
    s1.addEvent(w.id, 'deploy', 'redeployed', 5);
    s1.close();

    const raw = new Database(file, { readonly: true });
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    raw.close();

    const s2 = open(file);
    expect(s2.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(s2.getWatch(w.id)).toEqual(w);
    expect(s2.getPage(w.id, 'https://unpeg.io/docs')?.text).toBe('hello');
    expect(s2.listEvents(w.id, 10)).toHaveLength(1);
    s2.close();

    // third open: migrations stay idempotent and data is untouched
    const s3 = open(file);
    expect(s3.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(s3.listWatches()).toHaveLength(1);
  });

  it('enables foreign keys and the pragma settings', () => {
    const file = path.join(tmpDir, 'p.db');
    open(file);
    // settings are per-connection; verify via the effect instead: cascade works (see cascade test) and busy timeout is set
    const raw = new Database(file);
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal'); // WAL is persistent in the file
    raw.close();
  });

  it('close() is idempotent', () => {
    const s = new Store(':memory:');
    s.close();
    expect(() => s.close()).not.toThrow();
  });

  it('upgrades a v1 database: page rows get the text-noise columns with defaults', () => {
    const file = path.join(tmpDir, 'v1.db');
    const s1 = open(file);
    const w = s1.createWatch(watchInput());
    s1.upsertPage(page(w.id, 'https://unpeg.io/docs', { text: 'hello', textHash: 'h1' }));
    s1.close();
    const raw = new Database(file);
    for (const col of ['pending_hash', 'hash_history_json', 'change_times_json']) raw.exec(`ALTER TABLE pages DROP COLUMN ${col}`);
    raw.pragma('user_version = 1');
    raw.close();

    const s2 = open(file);
    expect(s2.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(s2.getPage(w.id, 'https://unpeg.io/docs')).toMatchObject({ text: 'hello', textHash: 'h1', pendingHash: null, hashHistory: [], changeTimes: [] });
    s2.upsertPage(page(w.id, 'https://unpeg.io/docs', { pendingHash: 'p', hashHistory: [{ hash: 'a', at: 1 }], changeTimes: [5] }));
    expect(s2.getPage(w.id, 'https://unpeg.io/docs')).toMatchObject({ pendingHash: 'p', hashHistory: [{ hash: 'a', at: 1 }], changeTimes: [5] });
  });

  it('leaves a database from a newer schema version alone', () => {
    const file = path.join(tmpDir, 'newer.db');
    const s1 = open(file);
    s1.createWatch(watchInput());
    s1.close();
    const raw = new Database(file);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 5}`);
    raw.close();
    const s2 = open(file);
    expect(s2.schemaVersion()).toBe(SCHEMA_VERSION + 5);
    expect(s2.listWatches()).toHaveLength(1);
  });
});

describe('Store: watches', () => {
  it('creates a watch with defaults and a default state row', () => {
    const s = open();
    const before = Date.now();
    const w = s.createWatch(watchInput());
    expect(w).toMatchObject({
      guildId: 'g1',
      channelId: 'c1',
      name: 'Unpeg',
      url: 'https://unpeg.io/',
      host: 'unpeg.io',
      rootDomain: 'unpeg.io',
      intervalSec: 30,
      sweepSec: 120,
      maxPages: 150,
      pingRoleId: null,
      features: DEFAULT_FEATURES,
      ignorePatterns: [],
      excludePatterns: [],
      extraUrls: [],
      scopePath: null,
      maskNumbers: false,
      paused: false,
      baselineDone: false,
      createdBy: 'u1',
    });
    expect(w.id).toBeGreaterThan(0);
    expect(w.createdAt).toBeGreaterThanOrEqual(before);
    expect(s.getState(w.id)).toEqual(defaultWatchState());
  });

  it('applies constructor defaults and explicit input over them', () => {
    const s = open(':memory:', { intervalSec: 45, sweepSec: 600, maxPages: 20 });
    const a = s.createWatch(watchInput());
    expect([a.intervalSec, a.sweepSec, a.maxPages]).toEqual([45, 600, 20]);
    const b = s.createWatch(
      watchInput({
        url: 'https://unpeg.io/docs',
        intervalSec: 10,
        sweepSec: 60,
        maxPages: 5,
        pingRoleId: 'r1',
        features: { subdomains: false, codeIntel: false },
        ignorePatterns: ['\\d+ online'],
        excludePatterns: ['/blog/'],
        extraUrls: ['https://unpeg.io/hidden'],
        scopePath: '/docs',
        maskNumbers: true,
      }),
    );
    expect(b).toMatchObject({
      intervalSec: 10,
      sweepSec: 60,
      maxPages: 5,
      pingRoleId: 'r1',
      features: { ...DEFAULT_FEATURES, subdomains: false, codeIntel: false },
      ignorePatterns: ['\\d+ online'],
      excludePatterns: ['/blog/'],
      extraUrls: ['https://unpeg.io/hidden'],
      scopePath: '/docs',
      maskNumbers: true,
    });
  });

  it('lists watches by id, optionally per guild', () => {
    const s = open();
    const a = s.createWatch(watchInput({ guildId: 'g1', name: 'A' }));
    const b = s.createWatch(watchInput({ guildId: 'g2', name: 'B' }));
    const c = s.createWatch(watchInput({ guildId: 'g1', name: 'C' }));
    expect(s.listWatches().map((w) => w.id)).toEqual([a.id, b.id, c.id]);
    expect(s.listWatches('g1').map((w) => w.name)).toEqual(['A', 'C']);
    expect(s.listWatches('nope')).toEqual([]);
    expect(s.getWatch(999)).toBeUndefined();
    expect(s.getWatch(Number.NaN)).toBeUndefined();
  });

  it('fills missing feature keys from DEFAULT_FEATURES when reading old rows', () => {
    const file = path.join(tmpDir, 'features.db');
    const s1 = open(file);
    const w = s1.createWatch(watchInput());
    s1.close();
    const raw = new Database(file);
    raw.prepare(`UPDATE watches SET features_json = ?, ignore_json = 'not json' WHERE id = ?`).run(
      JSON.stringify({ deploy: false, bogus: true, text: 'yes' }),
      w.id,
    );
    raw.close();
    const s2 = open(file);
    const got = s2.getWatch(w.id)!;
    expect(got.features).toEqual({ ...DEFAULT_FEATURES, deploy: false });
    expect(got.ignorePatterns).toEqual([]);
  });

  it('updates fields, merges features and can clear nullable fields', () => {
    const s = open();
    const w = s.createWatch(watchInput({ pingRoleId: 'r1', scopePath: '/docs' }));
    const u = s.updateWatch(w.id, {
      name: 'Renamed',
      channelId: 'c2',
      intervalSec: 15,
      features: { text: false },
      ignorePatterns: ['foo'],
      paused: true,
      baselineDone: true,
      maskNumbers: true,
    });
    expect(u).toMatchObject({
      name: 'Renamed',
      channelId: 'c2',
      intervalSec: 15,
      sweepSec: 120,
      features: { ...DEFAULT_FEATURES, text: false },
      ignorePatterns: ['foo'],
      paused: true,
      baselineDone: true,
      maskNumbers: true,
      pingRoleId: 'r1',
      scopePath: '/docs',
    });
    const u2 = s.updateWatch(w.id, { features: { deploy: false }, pingRoleId: null, scopePath: null });
    expect(u2.features).toEqual({ ...DEFAULT_FEATURES, text: false, deploy: false });
    expect(u2.pingRoleId).toBeNull();
    expect(u2.scopePath).toBeNull();
    expect(s.getWatch(w.id)).toEqual(u2);

    // explicit undefined leaves the field untouched
    const u3 = s.updateWatch(w.id, { name: undefined, paused: undefined });
    expect(u3.name).toBe('Renamed');
    expect(u3.paused).toBe(true);

    expect(() => s.updateWatch(12345, { name: 'x' })).toThrow(/not found/);
  });

  describe('findWatch', () => {
    let s: Store;
    let unpeg: ReturnType<Store['createWatch']>;
    let docs: ReturnType<Store['createWatch']>;
    let local: ReturnType<Store['createWatch']>;
    beforeEach(() => {
      s = open();
      unpeg = s.createWatch(watchInput());
      docs = s.createWatch(watchInput({ name: 'Unpeg Docs', url: 'https://docs.unpeg.io/', host: 'docs.unpeg.io' }));
      local = s.createWatch(
        watchInput({ name: 'Local', url: 'http://localhost:8080/app', host: 'localhost', rootDomain: 'localhost' }),
      );
      s.createWatch(watchInput({ guildId: 'g2', name: 'Other', url: 'https://other.io/', host: 'other.io' }));
    });

    it('by id (plain or #-prefixed), only within the guild', () => {
      expect(s.findWatch('g1', String(docs.id))?.id).toBe(docs.id);
      expect(s.findWatch('g1', `#${docs.id}`)?.id).toBe(docs.id);
      expect(s.findWatch('g2', String(docs.id))).toBeUndefined();
    });

    it('by case-insensitive name', () => {
      expect(s.findWatch('g1', 'unpeg')?.id).toBe(unpeg.id);
      expect(s.findWatch('g1', '  UNPEG docs ')?.id).toBe(docs.id);
      expect(s.findWatch('g1', 'Other')).toBeUndefined();
    });

    it('returns undefined when the name is ambiguous', () => {
      s.createWatch(watchInput({ name: 'Local', url: 'https://local.dev/', host: 'local.dev', rootDomain: 'local.dev' }));
      expect(s.findWatch('g1', 'local')).toBeUndefined();
    });

    it('by host', () => {
      expect(s.findWatch('g1', 'docs.unpeg.io')?.id).toBe(docs.id);
      expect(s.findWatch('g1', 'DOCS.UNPEG.IO')?.id).toBe(docs.id);
      expect(s.findWatch('g1', 'localhost')?.id).toBe(local.id);
    });

    it('by normalized url', () => {
      expect(s.findWatch('g1', 'https://unpeg.io')?.id).toBe(unpeg.id);
      expect(s.findWatch('g1', 'HTTPS://UNPEG.IO/')?.id).toBe(unpeg.id);
      expect(s.findWatch('g1', 'https://unpeg.io/#top')?.id).toBe(unpeg.id);
      expect(s.findWatch('g1', 'https://unpeg.io:443/')?.id).toBe(unpeg.id);
      expect(s.findWatch('g1', 'http://localhost:8080/app/')?.id).toBe(local.id);
      expect(s.findWatch('g1', 'localhost:8080/app')?.id).toBe(local.id);
      expect(s.findWatch('g1', 'https://unpeg.io/other')).toBeUndefined();
    });

    it('returns undefined for unknown or empty queries', () => {
      expect(s.findWatch('g1', '')).toBeUndefined();
      expect(s.findWatch('g1', '   ')).toBeUndefined();
      expect(s.findWatch('g1', 'nothing here')).toBeUndefined();
      expect(s.findWatch('g1', '999999')).toBeUndefined();
      expect(s.findWatch('g3', 'unpeg')).toBeUndefined();
      expect(s.findWatch('g1', undefined as unknown as string)).toBeUndefined();
    });

    it('host lookup is ambiguous when several watches share the host', () => {
      s.createWatch(watchInput({ name: 'Unpeg blog', url: 'https://unpeg.io/blog' }));
      // "unpeg.io" still resolves through URL equality to the root watch
      expect(s.findWatch('g1', 'unpeg.io')?.id).toBe(unpeg.id);
      expect(s.findWatch('g1', 'unpeg.io/blog')?.name).toBe('Unpeg blog');
    });
  });

  it('findWatchByUrl compares normalized urls within a guild', () => {
    const s = open();
    const w = s.createWatch(watchInput({ url: 'https://unpeg.io/docs', name: 'Docs' }));
    expect(s.findWatchByUrl('g1', 'https://unpeg.io/docs')?.id).toBe(w.id);
    expect(s.findWatchByUrl('g1', 'https://UNPEG.io/docs/')?.id).toBe(w.id);
    expect(s.findWatchByUrl('g1', 'https://unpeg.io/docs#x')?.id).toBe(w.id);
    expect(s.findWatchByUrl('g1', 'unpeg.io/docs')?.id).toBe(w.id);
    expect(s.findWatchByUrl('g1', 'http://unpeg.io/docs')).toBeUndefined();
    expect(s.findWatchByUrl('g1', 'https://unpeg.io/')).toBeUndefined();
    expect(s.findWatchByUrl('g2', 'https://unpeg.io/docs')).toBeUndefined();
    expect(s.findWatchByUrl('g1', 'not a url')).toBeUndefined();
  });

  it('deleteWatch cascades to state, pages, subdomains and events only for that watch', () => {
    const file = path.join(tmpDir, 'cascade.db');
    const s = open(file);
    const a = s.createWatch(watchInput());
    const b = s.createWatch(watchInput({ name: 'B', url: 'https://b.io/', host: 'b.io', rootDomain: 'b.io' }));
    for (const w of [a, b]) {
      s.saveState(w.id, { ...defaultWatchState(), lastCheckAt: 42 });
      s.upsertPages([page(w.id, 'https://x/1'), page(w.id, 'https://x/2')]);
      s.upsertSubdomain(sub(w.id, 'api.x.io'));
      s.addEvent(w.id, 'text', 'changed', 1);
    }
    s.deleteWatch(a.id);

    expect(s.getWatch(a.id)).toBeUndefined();
    expect(s.listPages(a.id)).toEqual([]);
    expect(s.listSubdomains(a.id)).toEqual([]);
    expect(s.listEvents(a.id, 10)).toEqual([]);
    expect(s.getState(a.id)).toEqual(defaultWatchState());

    expect(s.listPages(b.id)).toHaveLength(2);
    expect(s.listSubdomains(b.id)).toHaveLength(1);
    expect(s.listEvents(b.id, 10)).toHaveLength(1);
    expect(s.getState(b.id).lastCheckAt).toBe(42);

    const raw = new Database(file, { readonly: true });
    for (const table of ['watch_state', 'pages', 'subdomains', 'events']) {
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE watch_id = ?`).get(a.id)).toEqual({ n: 0 });
    }
    raw.close();

    expect(() => s.deleteWatch(a.id)).not.toThrow();
  });

  it('writes for a deleted watch are silent no-ops', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    s.deleteWatch(w.id);
    expect(() => s.saveState(w.id, defaultWatchState())).not.toThrow();
    expect(() => s.upsertPage(page(w.id, 'https://x/'))).not.toThrow();
    expect(() => s.upsertPages([page(w.id, 'https://x/a'), page(w.id, 'https://x/b')])).not.toThrow();
    expect(() => s.upsertSubdomain(sub(w.id, 'a.x.io'))).not.toThrow();
    expect(() => s.addEvent(w.id, 'info', 'x', 1)).not.toThrow();
    expect(s.countPages(w.id)).toBe(0);
    expect(s.listSubdomains(w.id)).toEqual([]);
    expect(s.listEvents(w.id, 5)).toEqual([]);
    // a new watch never inherits rows from the deleted id
    const w2 = s.createWatch(watchInput());
    expect(w2.id).not.toBe(w.id);
  });
});

describe('Store: state', () => {
  it('round-trips a full state exactly', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    const state: WatchState = {
      ...defaultWatchState(),
      deploy: {
        assets: ['https://unpeg.io/_next/static/chunks/a.js', 'https://unpeg.io/_next/static/css/b.css'],
        buildId: 'KU79abc',
        generator: 'Next.js',
        sig: 'abc123',
        seenAt: 1700,
      },
      deployHistory: [
        { sig: 'old', at: 1 },
        { sig: 'abc123', at: 2 },
      ],
      codePaths: ['/docs/points', '/api/v1/claim'],
      codeHosts: ['api.unpeg.io'],
      status: {
        up: false,
        consecutiveFailures: 3,
        consecutiveBlocked: 1,
        lastError: 'HTTP 502',
        downSince: 1234,
        alertedDown: true,
        alertedBlocked: false,
        consecutiveRateLimited: 2,
        alertedRateLimited: false,
      },
      ctCursor: '98765',
      ctLastPoll: 10,
      crtshLastPoll: 11,
      dnsLastScan: 12,
      sitemapLastScan: 13,
      lastCheckAt: 14,
      lastChangeAt: 15,
      lastError: 'boom',
      baselineAt: 16,
      ctBackfill: true,
      ctPolledOk: true,
      subdomainsBaselined: true,
      sitemapComplete: true,
      wildcard: { answers: ['A:203.0.113.1', 'A:203.0.113.2'], rotating: true, at: 17 },
      seenAssets: [{ url: 'https://unpeg.io/app.js?ver=1', at: 18 }],
      unstableQueryPaths: ['https://unpeg.io/widget.js'],
    };
    s.saveState(w.id, state);
    expect(s.getState(w.id)).toEqual(state);
    // saving again overwrites
    s.saveState(w.id, { ...state, lastCheckAt: 99 });
    expect(s.getState(w.id).lastCheckAt).toBe(99);
  });

  it('updates the url and host of a watch (redirect adoption)', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    const u = s.updateWatch(w.id, { url: 'https://www.unpeg.io/', host: 'WWW.unpeg.io' });
    expect(u).toMatchObject({ url: 'https://www.unpeg.io/', host: 'www.unpeg.io', rootDomain: w.rootDomain });
    expect(s.updateWatch(w.id, { name: 'X' })).toMatchObject({ url: 'https://www.unpeg.io/', host: 'www.unpeg.io' });
  });

  it('deep-merges defaults into partial / old state rows', () => {
    const file = path.join(tmpDir, 'state.db');
    const s1 = open(file);
    const w = s1.createWatch(watchInput());
    s1.close();

    const raw = new Database(file);
    raw.prepare(`UPDATE watch_state SET state_json = ? WHERE watch_id = ?`).run(
      JSON.stringify({
        lastCheckAt: 777,
        status: { up: false, consecutiveFailures: 2 },
        deploy: { sig: 'x', buildId: 'b1' },
        codePaths: 'not-an-array',
        ctCursor: null,
        someFutureField: { keep: true },
      }),
      w.id,
    );
    raw.close();

    const s2 = open(file);
    const st = s2.getState(w.id);
    const def = defaultWatchState();
    expect(st.lastCheckAt).toBe(777);
    expect(st.status).toEqual({ ...def.status, up: false, consecutiveFailures: 2 });
    expect(st.deploy).toEqual({ sig: 'x', buildId: 'b1', assets: [], generator: null, seenAt: 0 });
    expect(st.codePaths).toEqual([]);
    expect(st.codeHosts).toEqual([]);
    expect(st.deployHistory).toEqual([]);
    expect(st.ctCursor).toBeNull();
    expect(st.baselineAt).toBe(0);
    expect(st.lastError).toBeNull();
    expect((st as unknown as Record<string, unknown>).someFutureField).toEqual({ keep: true });
  });

  it('falls back to defaults for corrupt or missing state rows', () => {
    const file = path.join(tmpDir, 'corrupt.db');
    const s1 = open(file);
    const a = s1.createWatch(watchInput());
    const b = s1.createWatch(watchInput({ name: 'B', url: 'https://b.io/' }));
    s1.close();
    const raw = new Database(file);
    raw.prepare(`UPDATE watch_state SET state_json = '{not json' WHERE watch_id = ?`).run(a.id);
    raw.prepare(`DELETE FROM watch_state WHERE watch_id = ?`).run(b.id);
    raw.prepare(`INSERT INTO watches (guild_id, channel_id, name, url, host, root_domain, interval_sec, sweep_sec, max_pages, created_at)
                 VALUES ('g1','c1','Arr','https://arr.io/','arr.io','arr.io',30,120,150,1)`).run();
    const arrId = Number(raw.prepare(`SELECT id FROM watches WHERE name = 'Arr'`).pluck().get());
    raw.prepare(`INSERT INTO watch_state (watch_id, state_json, updated_at) VALUES (?, '[1,2]', 0)`).run(arrId);
    raw.close();

    const s2 = open(file);
    expect(s2.getState(a.id)).toEqual(defaultWatchState());
    expect(s2.getState(b.id)).toEqual(defaultWatchState());
    expect(s2.getState(arrId)).toEqual(defaultWatchState());
    expect(s2.getState(424242)).toEqual(defaultWatchState());
    // saveState recreates a missing row
    s2.saveState(b.id, { ...defaultWatchState(), lastChangeAt: 5 });
    expect(s2.getState(b.id).lastChangeAt).toBe(5);
  });

  it('returns independent objects (mutating one read does not affect the next)', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    const st = s.getState(w.id);
    st.status.up = false;
    st.codePaths.push('/x');
    expect(s.getState(w.id)).toEqual(defaultWatchState());
  });
});

describe('Store: pages', () => {
  it('round-trips every field, including booleans and JSON', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    const rec = page(w.id, 'https://unpeg.io/docs', {
      kind: 'page',
      tracked: true,
      title: 'Docs – Unpeg',
      text: '# Docs\nline 2 ✓',
      textHash: 'abc',
      etag: 'W/"123"',
      lastModified: 'Mon, 28 Sep 2026 10:00:00 GMT',
      contentLength: 1234,
      contentType: 'text/html; charset=utf-8',
      status: 200,
      failCount: 1,
      gone: true,
      maskNumbers: true,
      numericChangeTimes: [1, 2, 3],
      flapCount: 2,
      dynamic: true,
      source: 'sitemap',
      depth: 2,
      firstSeen: 111,
      lastChecked: 222,
      lastChanged: 333,
    });
    s.upsertPage(rec);
    expect(s.getPage(w.id, rec.url)).toEqual(rec);

    const file = page(w.id, 'https://unpeg.io/whitepaper.pdf', { kind: 'file', source: 'link', status: 0 });
    s.upsertPage(file);
    expect(s.getPage(w.id, file.url)).toEqual(file);
    expect(s.getPage(w.id, 'https://unpeg.io/missing')).toBeUndefined();
  });

  it('upsert replaces an existing row', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    const url = 'https://unpeg.io/a';
    s.upsertPage(page(w.id, url, { textHash: 'one', lastChecked: 1 }));
    s.upsertPage(page(w.id, url, { textHash: 'two', lastChecked: 2, tracked: false }));
    expect(s.getPage(w.id, url)).toMatchObject({ textHash: 'two', lastChecked: 2, tracked: false });
    expect(s.countPages(w.id)).toBe(1);
  });

  it('lists by depth, then firstSeen, then url, with filters', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    const other = s.createWatch(watchInput({ name: 'Other', url: 'https://o.io/' }));
    s.upsertPages([
      page(w.id, 'https://unpeg.io/z', { depth: 1, firstSeen: 5 }),
      page(w.id, 'https://unpeg.io/', { depth: 0, firstSeen: 9, source: 'start' }),
      page(w.id, 'https://unpeg.io/b', { depth: 1, firstSeen: 5 }),
      page(w.id, 'https://unpeg.io/a', { depth: 1, firstSeen: 7 }),
      page(w.id, 'https://unpeg.io/deep', { depth: 3, firstSeen: 1, tracked: false }),
      page(w.id, 'https://unpeg.io/doc.pdf', { depth: 1, firstSeen: 2, kind: 'file' }),
      page(w.id, 'https://unpeg.io/old.md', { depth: 2, firstSeen: 2, kind: 'file', tracked: false }),
      page(other.id, 'https://o.io/', { depth: 0 }),
    ]);
    expect(s.listPages(w.id).map((p) => p.url)).toEqual([
      'https://unpeg.io/',
      'https://unpeg.io/doc.pdf',
      'https://unpeg.io/b',
      'https://unpeg.io/z',
      'https://unpeg.io/a',
      'https://unpeg.io/old.md',
      'https://unpeg.io/deep',
    ]);
    expect(s.listPages(w.id, { kind: 'page' }).map((p) => p.url)).toEqual([
      'https://unpeg.io/',
      'https://unpeg.io/b',
      'https://unpeg.io/z',
      'https://unpeg.io/a',
      'https://unpeg.io/deep',
    ]);
    expect(s.listPages(w.id, { kind: 'page', tracked: true }).map((p) => p.url)).toEqual([
      'https://unpeg.io/',
      'https://unpeg.io/b',
      'https://unpeg.io/z',
      'https://unpeg.io/a',
    ]);
    expect(s.listPages(w.id, { tracked: false }).map((p) => p.url)).toEqual([
      'https://unpeg.io/old.md',
      'https://unpeg.io/deep',
    ]);
    expect(s.listPages(w.id, { kind: 'file' })).toHaveLength(2);
    expect(s.listPages(w.id, {})).toHaveLength(7);

    expect(s.countPages(w.id)).toBe(7);
    expect(s.countPages(w.id, { kind: 'page' })).toBe(5);
    expect(s.countPages(w.id, { kind: 'page', tracked: true })).toBe(4);
    expect(s.countPages(w.id, { kind: 'file', tracked: false })).toBe(1);
    expect(s.countPages(other.id)).toBe(1);
    expect(s.countPages(9999)).toBe(0);
  });

  it('knownUrls returns every url of the watch', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    const other = s.createWatch(watchInput({ name: 'Other', url: 'https://o.io/' }));
    s.upsertPages([
      page(w.id, 'https://unpeg.io/a'),
      page(w.id, 'https://unpeg.io/b', { tracked: false }),
      page(w.id, 'https://unpeg.io/c.pdf', { kind: 'file' }),
      page(other.id, 'https://o.io/x'),
    ]);
    expect(s.knownUrls(w.id)).toEqual(new Set(['https://unpeg.io/a', 'https://unpeg.io/b', 'https://unpeg.io/c.pdf']));
    expect(s.knownUrls(12345)).toEqual(new Set());
  });

  it('deletePage removes one row', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    s.upsertPages([page(w.id, 'https://unpeg.io/a'), page(w.id, 'https://unpeg.io/b')]);
    s.deletePage(w.id, 'https://unpeg.io/a');
    expect([...s.knownUrls(w.id)]).toEqual(['https://unpeg.io/b']);
    expect(() => s.deletePage(w.id, 'https://unpeg.io/nope')).not.toThrow();
  });

  it('caps stored text at MAX_STORED_TEXT_CHARS', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    s.upsertPage(page(w.id, 'https://unpeg.io/huge', { text: 'x'.repeat(MAX_STORED_TEXT_CHARS + 1000) }));
    expect(s.getPage(w.id, 'https://unpeg.io/huge')?.text).toHaveLength(MAX_STORED_TEXT_CHARS);
    const exact = 'y'.repeat(MAX_STORED_TEXT_CHARS);
    s.upsertPage(page(w.id, 'https://unpeg.io/exact', { text: exact }));
    expect(s.getPage(w.id, 'https://unpeg.io/exact')?.text).toBe(exact);
  });

  it('upsertPages writes many rows in one transaction', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    const recs = Array.from({ length: 2000 }, (_, i) => page(w.id, `https://unpeg.io/p/${i}`, { firstSeen: i }));
    const t = performance.now();
    s.upsertPages(recs);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(s.countPages(w.id)).toBe(2000);
    expect(() => s.upsertPages([])).not.toThrow();
  });

  it('upsertPages is atomic: a failing row rolls back the batch', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    const bad = page(w.id, 'https://unpeg.io/bad', { url: undefined as unknown as string });
    // String(undefined) is a valid key, so force a real failure with a non-bindable value instead
    (bad as unknown as Record<string, unknown>).watchId = { not: 'bindable' };
    expect(() => s.upsertPages([page(w.id, 'https://unpeg.io/ok'), bad])).toThrow();
    expect(s.countPages(w.id)).toBe(0);
  });

  it('resetPageNoise clears noise flags and hashes of pages of one watch', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    const other = s.createWatch(watchInput({ name: 'Other', url: 'https://o.io/' }));
    const noisy = {
      textHash: 'h',
      text: 'keep me',
      flapCount: 3,
      dynamic: true,
      numericChangeTimes: [1, 2, 3],
      maskNumbers: true,
      pendingHash: 'p',
      hashHistory: [{ hash: 'h', at: 5 }],
      changeTimes: [4, 5],
    } satisfies Partial<PageRecord>;
    s.upsertPages([
      page(w.id, 'https://unpeg.io/a', noisy),
      page(w.id, 'https://unpeg.io/f.pdf', { kind: 'file', textHash: 'bytes' }),
      page(other.id, 'https://o.io/a', noisy),
    ]);
    s.resetPageNoise(w.id);
    expect(s.getPage(w.id, 'https://unpeg.io/a')).toMatchObject({
      textHash: null,
      text: 'keep me',
      flapCount: 0,
      dynamic: false,
      numericChangeTimes: [],
      maskNumbers: false,
      pendingHash: null,
      hashHistory: [],
      changeTimes: [],
    });
    // file byte-hashes are not affected by ignore patterns and are kept
    expect(s.getPage(w.id, 'https://unpeg.io/f.pdf')?.textHash).toBe('bytes');
    expect(s.getPage(other.id, 'https://o.io/a')).toMatchObject({ textHash: 'h', dynamic: true, flapCount: 3 });
  });
});

describe('Store: subdomains', () => {
  it('round-trips, orders by host and updates on upsert', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    const api = sub(w.id, 'api.unpeg.io', {
      sources: ['ct', 'dns'],
      alive: true,
      lastProbe: 50,
      dns: { a: ['1.2.3.4'], aaaa: [], cname: ['x.vercel-dns.com'] },
      http: { status: 200, title: 'API', finalUrl: 'https://api.unpeg.io/', server: 'cloudflare' },
    });
    s.upsertSubdomains([sub(w.id, 'zeta.unpeg.io'), api, sub(w.id, 'app.unpeg.io', { sources: ['code', 'link'] })]);
    expect(s.listSubdomains(w.id).map((r) => r.host)).toEqual(['api.unpeg.io', 'app.unpeg.io', 'zeta.unpeg.io']);
    expect(s.getSubdomain(w.id, 'api.unpeg.io')).toEqual(api);
    expect(s.getSubdomain(w.id, 'API.unpeg.io')).toEqual(api);
    expect(s.getSubdomain(w.id, 'app.unpeg.io')?.sources).toEqual(['code', 'link']);
    expect(s.getSubdomain(w.id, 'nope.unpeg.io')).toBeUndefined();

    s.upsertSubdomain({ ...api, alive: false, dns: null, http: null, lastSeen: 9999, sources: ['ct'] });
    expect(s.getSubdomain(w.id, 'api.unpeg.io')).toMatchObject({ alive: false, dns: null, http: null, lastSeen: 9999, sources: ['ct'] });
    expect(s.listSubdomains(w.id)).toHaveLength(3);
    expect(() => s.upsertSubdomains([])).not.toThrow();
  });

  it('keeps subdomains per watch', () => {
    const s = open();
    const a = s.createWatch(watchInput());
    const b = s.createWatch(watchInput({ name: 'B', url: 'https://b.io/' }));
    s.upsertSubdomain(sub(a.id, 'x.unpeg.io'));
    s.upsertSubdomain(sub(b.id, 'x.unpeg.io', { alive: true }));
    expect(s.getSubdomain(a.id, 'x.unpeg.io')?.alive).toBe(false);
    expect(s.getSubdomain(b.id, 'x.unpeg.io')?.alive).toBe(true);
  });
});

describe('Store: js cache', () => {
  it('stores, replaces and prunes by fetched_at', () => {
    const s = open();
    expect(s.getJsAnalysis('https://unpeg.io/a.js')).toBeUndefined();
    s.putJsAnalysis('https://unpeg.io/a.js', { paths: ['/docs', '/api/v1/claim'], hosts: ['api.unpeg.io'] }, 100);
    expect(s.getJsAnalysis('https://unpeg.io/a.js')).toEqual({ paths: ['/docs', '/api/v1/claim'], hosts: ['api.unpeg.io'] });
    s.putJsAnalysis('https://unpeg.io/a.js', { paths: [], hosts: [] }, 101);
    expect(s.getJsAnalysis('https://unpeg.io/a.js')).toEqual({ paths: [], hosts: [] });

    for (let i = 0; i < 10; i++) s.putJsAnalysis(`https://unpeg.io/${i}.js`, { paths: [`/p${i}`], hosts: [] }, 200 + i);
    s.pruneJsCache(3);
    expect(s.getJsAnalysis('https://unpeg.io/9.js')).toBeDefined();
    expect(s.getJsAnalysis('https://unpeg.io/8.js')).toBeDefined();
    expect(s.getJsAnalysis('https://unpeg.io/7.js')).toBeDefined();
    expect(s.getJsAnalysis('https://unpeg.io/6.js')).toBeUndefined();
    expect(s.getJsAnalysis('https://unpeg.io/a.js')).toBeUndefined();

    s.pruneJsCache(100);
    expect(s.getJsAnalysis('https://unpeg.io/9.js')).toBeDefined();
    s.pruneJsCache(0);
    expect(s.getJsAnalysis('https://unpeg.io/9.js')).toBeUndefined();
  });

  it('is global (not tied to a watch) and survives watch deletion', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    s.putJsAnalysis('https://unpeg.io/x.js', { paths: ['/a'], hosts: [] }, 1);
    s.deleteWatch(w.id);
    expect(s.getJsAnalysis('https://unpeg.io/x.js')).toEqual({ paths: ['/a'], hosts: [] });
  });
});

describe('Store: events', () => {
  it('lists newest first with a limit and prunes by age', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    const other = s.createWatch(watchInput({ name: 'Other', url: 'https://o.io/' }));
    s.addEvent(w.id, 'deploy', 'first', 100);
    s.addEvent(w.id, 'text', 'second', 200);
    s.addEvent(other.id, 'status', 'other', 150);
    s.addEvent(w.id, 'subdomain', 'third', 300);

    const all = s.listEvents(w.id, 10);
    expect(all.map((e) => e.summary)).toEqual(['third', 'second', 'first']);
    expect(all[0]).toMatchObject({ watchId: w.id, kind: 'subdomain', summary: 'third', createdAt: 300 });
    expect(all[0].id).toBeGreaterThan(all[1].id);
    expect(s.listEvents(w.id, 2).map((e) => e.summary)).toEqual(['third', 'second']);
    expect(s.listEvents(w.id, 0)).toEqual([]);
    expect(s.listEvents(w.id, -1)).toEqual([]);

    s.pruneEvents(200);
    expect(s.listEvents(w.id, 10).map((e) => e.summary)).toEqual(['third', 'second']);
    expect(s.listEvents(other.id, 10)).toEqual([]);
  });

  it('orders by insertion even when timestamps tie or go backwards', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    s.addEvent(w.id, 'info', 'a', 500);
    s.addEvent(w.id, 'info', 'b', 500);
    s.addEvent(w.id, 'info', 'c', 400);
    expect(s.listEvents(w.id, 5).map((e) => e.summary)).toEqual(['c', 'b', 'a']);
  });

  it('caps very long summaries', () => {
    const s = open();
    const w = s.createWatch(watchInput());
    s.addEvent(w.id, 'info', 'z'.repeat(100_000), 1);
    expect(s.listEvents(w.id, 1)[0].summary.length).toBeLessThanOrEqual(4000);
  });
});
