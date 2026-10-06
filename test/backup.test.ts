import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import { Store } from '../src/db/store.js';
import { testConfig } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import { BACKUP_FILENAME, MAX_BACKUP_LINKS, PanelManager, parseBackup, toBackup } from '../src/discord/backup.js';
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

describe('backup file: link tokens', () => {
  const CH = '200000000000000001';

  it('carries token hashes only and round-trips them', () => {
    const store = new Store(':memory:');
    addWatch(store, 'g1', 'https://unpeg.io/');
    const a = store.createLinkToken({ guildId: 'g1', channelId: CH, label: 'Arkham', createdBy: 'u1' });
    const b = store.createLinkToken({ guildId: 'g1', channelId: CH, label: 'Other bot', createdBy: 'u2' });
    store.createLinkToken({ guildId: 'g2', channelId: CH, label: 'Elsewhere', createdBy: 'u3' });
    store.touchLinkToken(a.record.id, 123);
    const file = toBackup('g1', store.listWatches('g1'), new Date(), null, store.listLinkTokens('g1'));
    const text = JSON.stringify(file);
    expect(text).not.toContain(a.token);
    expect(text).not.toContain(b.token);
    expect(text).not.toContain('lastUsedAt');
    const parsed = parseBackup(text)!;
    expect(parsed.links).toEqual([
      { label: 'Arkham', channelId: CH, tokenHash: a.record.tokenHash, createdBy: 'u1', createdAt: a.record.createdAt },
      { label: 'Other bot', channelId: CH, tokenHash: b.record.tokenHash, createdBy: 'u2', createdAt: b.record.createdAt },
    ]);
    expect(parsed.links!.every((l) => /^[0-9a-f]{64}$/.test(l.tokenHash))).toBe(true);
    // Backups written before link tokens existed.
    expect(parseBackup(JSON.stringify({ ...file, links: undefined }))?.links).toEqual([]);
  });

  it('drops invalid link entries', () => {
    const hash = 'ab'.repeat(32);
    const ok = { label: 'Arkham', channelId: CH, tokenHash: hash, createdBy: 'u1', createdAt: 5 };
    const parsed = parseBackup(
      JSON.stringify({
        version: 1,
        guildId: 'g1',
        watches: [],
        links: [
          ok,
          { ...ok }, // duplicate hash
          { ...ok, tokenHash: 'ab'.repeat(31) }, // too short
          { ...ok, tokenHash: 'zz'.repeat(32) }, // not hex
          { ...ok, tokenHash: 'swb_plaintoken' },
          { ...ok, tokenHash: 'CD'.repeat(32), label: '  Upper\ncase  ' }, // hex in caps is fine, label cleaned
          { ...ok, tokenHash: 'ef'.repeat(32), label: '' },
          { ...ok, tokenHash: 'ef'.repeat(32), channelId: 'c1' },
          { ...ok, tokenHash: 'ef'.repeat(32), channelId: 42 },
          { ...ok, tokenHash: '01'.repeat(32), createdBy: '', createdAt: 'yesterday' },
          null,
          'x',
        ],
      }),
    )!;
    expect(parsed.links!.map((l) => l.tokenHash)).toEqual([hash, 'cd'.repeat(32), '01'.repeat(32)]);
    expect(parsed.links![1].label).toBe('Upper case');
    expect(parsed.links![2].createdBy).toBe('restore');
    expect(typeof parsed.links![2].createdAt).toBe('number');
    const many = Array.from({ length: MAX_BACKUP_LINKS + 5 }, (_, i) => ({ ...ok, tokenHash: i.toString(16).padStart(64, '0') }));
    expect(parseBackup(JSON.stringify({ version: 1, watches: [], links: many }))!.links).toHaveLength(MAX_BACKUP_LINKS);
    expect(parseBackup(JSON.stringify({ version: 1, watches: [], links: 'nope' }))!.links).toEqual([]);
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

  it('re-imports link tokens from the backup into the restoring guild, so linked clients keep working', async () => {
    const CH = '200000000000000001';
    const source = new Store(':memory:');
    addWatch(source, 'g1', 'https://unpeg.io/');
    const link = source.createLinkToken({ guildId: 'g1', channelId: CH, label: 'Arkham', createdBy: 'u1' });
    // The guild id comes from the Discord guild being restored, never from the file.
    const backup = { ...toBackup('g1', source.listWatches('g1'), new Date(), null, source.listLinkTokens('g1')), guildId: 'someone-else' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(backup), { status: 200 }));

    const store = new Store(':memory:');
    const guild = fakeGuild([attachmentMessage('bot', 100)]);
    const client = { user: { id: 'bot' }, guilds: { cache: new Map([['g1', guild]]) }, channels: { fetch: async () => null } };
    const pm = new PanelManager({ client: client as never, store, config: testConfig(), log: silentLogger, getMonitor: () => null, onRestored: () => {} });
    await pm.start();
    pm.stop();

    const found = store.findLinkToken(link.token);
    expect(found).toMatchObject({ guildId: 'g1', channelId: CH, label: 'Arkham', createdBy: 'u1', createdAt: link.record.createdAt, lastUsedAt: null });
    expect(store.listLinkTokens('someone-else')).toEqual([]);
    expect(store.listWatches('g1')).toHaveLength(1);
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

describe('PanelManager backup refresh with link tokens', () => {
  const CH = '200000000000000001';

  function fakeClient() {
    const sent: Array<{ channel: string; payload: any }> = [];
    const edits: any[] = [];
    let attachments: Array<{ name: string }> = [];
    const message = {
      id: 'm1',
      url: 'https://discord.com/channels/g1/c/m1',
      pin: async () => {},
      get attachments() {
        return { some: (fn: (a: { name: string }) => boolean) => attachments.some(fn) };
      },
      edit: async (payload: any) => {
        edits.push(payload);
        if (payload.files) attachments = [{ name: BACKUP_FILENAME }];
        return message;
      },
    };
    const channel = (id: string) => ({
      id,
      isTextBased: () => true,
      isDMBased: () => false,
      isSendable: () => true,
      send: async (payload: any) => {
        sent.push({ channel: id, payload });
        attachments = [{ name: BACKUP_FILENAME }];
        return message;
      },
      messages: { fetch: async () => message },
    });
    const client = { user: { id: 'bot' }, guilds: { cache: new Map() }, channels: { fetch: async (id: string) => channel(id) } };
    return { client, sent, edits };
  }

  async function backupIn(payload: any): Promise<ReturnType<typeof parseBackup>> {
    const file = payload.files?.[0];
    const data = file?.attachment ?? file?.data;
    return parseBackup(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
  }

  it('backs up a server that only has link tokens, and re-uploads the file when tokens change', async () => {
    const store = new Store(':memory:');
    const { client, sent, edits } = fakeClient();
    const pm = new PanelManager({ client: client as never, store, config: testConfig(), log: silentLogger, getMonitor: () => null, onRestored: () => {} });
    const internals = pm as unknown as { checked: Set<string>; syncOnce(g: string): Promise<void> };
    internals.checked.add('g1');

    const first = store.createLinkToken({ guildId: 'g1', channelId: CH, label: 'Arkham', createdBy: 'u1' });
    await internals.syncOnce('g1');
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe(CH);
    expect((await backupIn(sent[0].payload))?.links?.map((l) => l.tokenHash)).toEqual([first.record.tokenHash]);

    // Nothing changed → no edit; token use alone doesn't change the backup either.
    store.touchLinkToken(first.record.id, Date.now());
    await internals.syncOnce('g1');
    expect(edits).toHaveLength(0);

    const second = store.createLinkToken({ guildId: 'g1', channelId: CH, label: 'Other', createdBy: 'u1' });
    await internals.syncOnce('g1');
    expect(edits).toHaveLength(1);
    expect((await backupIn(edits[0]))?.links?.map((l) => l.tokenHash)).toEqual([first.record.tokenHash, second.record.tokenHash]);

    store.revokeLinkToken('g1', 'Arkham');
    await internals.syncOnce('g1');
    expect(edits).toHaveLength(2);
    expect((await backupIn(edits[1]))?.links?.map((l) => l.label)).toEqual(['Other']);
    pm.stop();
  });
});
