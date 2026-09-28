import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import { Store } from '../src/db/store.js';
import { testConfig } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import { BACKUP_FILENAME, PanelManager, parseBackup, toBackup } from '../src/discord/backup.js';
import type { Watch } from '../src/types.js';

function addWatch(store: Store, guildId: string, url: string, extra: Partial<Parameters<Store['createWatch']>[0]> = {}): Watch {
  const host = new URL(url).hostname;
  return store.createWatch({ guildId, channelId: 'c1', name: host, url, host, rootDomain: host, createdBy: 'u1', ...extra });
}

describe('backup file', () => {
  it('round-trips watch settings and drops junk entries', () => {
    const store = new Store(':memory:');
    const w = addWatch(store, 'g1', 'https://unpeg.io/', { intervalSec: 2, ignorePatterns: ['Last updated.*'], pingRoleId: 'r1' });
    store.updateWatch(w.id, { paused: true, features: { subdomains: false } });
    const file = toBackup('g1', store.listWatches('g1'));
    const text = JSON.stringify({ ...file, watches: [...file.watches, { nope: true }, 'x'] });
    const parsed = parseBackup(text)!;
    expect(parsed.watches).toHaveLength(1);
    expect(parsed.watches[0]).toMatchObject({
      url: 'https://unpeg.io/',
      intervalSec: 2,
      ignorePatterns: ['Last updated.*'],
      pingRoleId: 'r1',
      paused: true,
    });
    expect(parsed.watches[0].features.subdomains).toBe(false);
    expect(parseBackup('not json')).toBeNull();
    expect(parseBackup(JSON.stringify({ version: 99, watches: [] }))).toBeNull();
  });
});

describe('store watch-change events & guild settings', () => {
  it('emits for create/update/delete and persists dashboard location', () => {
    const store = new Store(':memory:');
    const seen: string[] = [];
    const off = store.onWatchesChanged((g) => seen.push(g));
    const w = addWatch(store, 'g9', 'https://a.io/');
    store.updateWatch(w.id, { name: 'A' });
    store.deleteWatch(w.id);
    off();
    addWatch(store, 'g9', 'https://b.io/');
    expect(seen).toEqual(['g9', 'g9', 'g9']);
    expect(store.getGuildSettings('g9')).toBeUndefined();
    store.setGuildSettings('g9', { panelChannelId: 'c', panelMessageId: 'm' });
    store.setGuildSettings('g9', { panelMessageId: 'm2' });
    expect(store.getGuildSettings('g9')).toMatchObject({ panelChannelId: 'c', panelMessageId: 'm2' });
  });
});

describe('PanelManager restore', () => {
  afterEach(() => vi.restoreAllMocks());

  function fakeGuild(messages: unknown[]) {
    const channel = {
      id: 'c1',
      type: ChannelType.GuildText,
      viewable: true,
      messages: {
        fetchPins: async () => ({ hasMore: false, items: messages.map((m) => ({ message: m, pinnedTimestamp: 0 })) }),
        fetch: async () => new Map(),
      },
    };
    const channels = {
      filter(fn: (c: unknown) => boolean) {
        const list = [channel].filter(fn);
        return { filter: (fn2: (c: unknown) => boolean) => ({ first: () => list.filter(fn2) }) };
      },
    };
    return { id: 'g1', channels: { fetch: async () => channels } };
  }

  function attachmentMessage(authorId: string, ts: number) {
    const att = { name: BACKUP_FILENAME, url: `https://cdn.discordapp.com/attachments/${ts}/${BACKUP_FILENAME}` };
    return {
      id: `m${ts}`,
      channelId: 'c1',
      author: { id: authorId },
      createdTimestamp: ts,
      editedTimestamp: null,
      attachments: { some: (fn: (a: typeof att) => boolean) => fn(att), find: (fn: (a: typeof att) => boolean) => (fn(att) ? att : undefined) },
    };
  }

  it('restores watches from the newest backup authored by the bot into an empty database', async () => {
    const source = new Store(':memory:');
    addWatch(source, 'g1', 'https://unpeg.io/', { intervalSec: 2 });
    const w2 = addWatch(source, 'g1', 'https://docs.x.io/');
    source.updateWatch(w2.id, { paused: true });
    const good = JSON.stringify(toBackup('g1', source.listWatches('g1')));
    const stale = JSON.stringify(toBackup('g1', [source.listWatches('g1')[0]]));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      new Response(String(url).includes('/200/') ? good : stale, { status: 200 }),
    );

    const store = new Store(':memory:');
    const restored: Watch[] = [];
    const guild = fakeGuild([attachmentMessage('bot', 100), attachmentMessage('bot', 200), attachmentMessage('someone-else', 300)]);
    const client = { user: { id: 'bot' }, guilds: { cache: new Map([['g1', guild]]) }, channels: { fetch: async () => null } };
    const pm = new PanelManager({
      client: client as never,
      store,
      config: testConfig(),
      log: silentLogger,
      getMonitor: () => null,
      onRestored: (w) => restored.push(w),
    });
    await pm.start();
    pm.stop();

    expect(restored.map((w) => w.url).sort()).toEqual(['https://docs.x.io/', 'https://unpeg.io/']);
    const list = store.listWatches('g1');
    expect(list).toHaveLength(2);
    expect(list.every((w) => !w.baselineDone)).toBe(true); // restored sites re-baseline silently
    expect(list.find((w) => w.url === 'https://docs.x.io/')?.paused).toBe(true);
    expect(list.find((w) => w.url === 'https://unpeg.io/')?.intervalSec).toBe(2);
    expect(store.getGuildSettings('g1')).toMatchObject({ panelChannelId: 'c1', panelMessageId: 'm200' });
  });

  it('does not scan or restore when the database already knows the guild', async () => {
    const store = new Store(':memory:');
    addWatch(store, 'g1', 'https://unpeg.io/');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const guild = { id: 'g1', channels: { fetch: async () => { throw new Error('should not scan'); } } };
    const client = { user: { id: 'bot' }, guilds: { cache: new Map([['g1', guild]]) }, channels: { fetch: async () => null } };
    const restored: Watch[] = [];
    const pm = new PanelManager({ client: client as never, store, config: testConfig(), log: silentLogger, getMonitor: () => null, onRestored: (w) => restored.push(w) });
    await pm.start();
    pm.stop();
    expect(restored).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
