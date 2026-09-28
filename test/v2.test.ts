import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileUrlPattern, inScope, isPathGlob } from '../src/extract/url.js';
import { formatAlerts, ignoreSuggestions, IGNORE_PATH_PREFIX } from '../src/discord/format.js';
import { validatePattern } from '../src/discord/commands.js';
import { Store } from '../src/db/store.js';
import { testConfig } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import { PanelManager, parseBackup, toBackup } from '../src/discord/backup.js';
import { BUILD_ID, DISPLAY_VERSION } from '../src/version.js';
import { DEFAULT_FEATURES, type Watch } from '../src/types.js';

const watch: Watch = {
  id: 7, guildId: 'g', channelId: 'c', name: 'Usepaid', url: 'https://usepaid.app/', host: 'usepaid.app', rootDomain: 'usepaid.app',
  intervalSec: 2, sweepSec: 120, maxPages: 150, pingRoleId: null, features: DEFAULT_FEATURES, ignorePatterns: [], excludePatterns: [],
  extraUrls: [], scopePath: null, maskNumbers: false, paused: false, baselineDone: true, createdBy: 'u', createdAt: 0,
};

describe('path-glob skip rules', () => {
  it('matches everything under the folder, nothing else', () => {
    const re = compileUrlPattern('/profile/*')!;
    expect(isPathGlob('/profile/*')).toBe(true);
    expect(re.test('https://usepaid.app/profile/teslaaibot')).toBe(true);
    expect(re.test('https://usepaid.app/profile/a/b?x=1')).toBe(true);
    expect(re.test('https://usepaid.app/profile')).toBe(false);
    expect(re.test('https://usepaid.app/profiles/x')).toBe(false);
    expect(compileUrlPattern('/u/*/posts')!.test('https://x.io/u/bob/posts')).toBe(true);
    expect(compileUrlPattern('/u/*/posts')!.test('https://x.io/u/bob/likes')).toBe(false);
    // Plain regexes keep their old substring semantics.
    expect(isPathGlob('/blog/')).toBe(false);
    expect(compileUrlPattern('/blog/')!.test('https://x.io/blog/a')).toBe(true);
    expect(isPathGlob('/docs/.*')).toBe(false);
  });

  it('is honoured by inScope and accepted by validation', () => {
    const w = { ...watch, excludePatterns: ['/profile/*'] };
    expect(inScope('https://usepaid.app/profile/teslaaibot', w)).toBe(false);
    expect(inScope('https://usepaid.app/pricing', w)).toBe(true);
    expect(validatePattern('/profile/*', 'exclude')).toBe('/profile/*');
    expect(() => validatePattern('/**', 'exclude')).toThrow(/every URL/);
  });
});

describe('new-page alert ignore buttons', () => {
  it('suggests the folder of new pages and renders a button', () => {
    expect(ignoreSuggestions(watch, ['https://usepaid.app/profile/a', 'https://usepaid.app/profile/b', 'https://usepaid.app/pricing'])).toEqual(['/profile/*']);
    expect(ignoreSuggestions({ ...watch, excludePatterns: ['/profile/*'] }, ['https://usepaid.app/profile/a'])).toEqual([]);
    const [p] = formatAlerts(watch, [{ kind: 'new_pages', pages: [{ url: 'https://usepaid.app/profile/teslaaibot', title: 'Optimus - UsePaid', source: 'link' }] }]);
    const buttons = (p.components ?? []).flatMap((r) => r.components) as Array<{ custom_id?: string; label?: string }>;
    expect(buttons.map((b) => b.custom_id)).toEqual([`${IGNORE_PATH_PREFIX}7:/profile/*`]);
    expect(buttons[0].label).toBe('Ignore /profile/*');
  });
});

describe('update announcement', () => {
  afterEach(() => vi.restoreAllMocks());

  function setup(store: Store) {
    const sent: Array<{ channel: string; payload: any }> = [];
    const channel = (id: string) => ({ id, isTextBased: () => true, isDMBased: () => false, isSendable: () => true, send: async (payload: unknown) => { sent.push({ channel: id, payload }); return { id: 'm', url: 'u', pin: async () => {} }; }, messages: {} });
    const client = { user: { id: 'bot' }, guilds: { cache: new Map() }, channels: { fetch: async (id: string) => channel(id) } };
    const pm = new PanelManager({ client: client as never, store, config: testConfig({ announceUpdates: true }), log: silentLogger, getMonitor: () => null, onRestored: () => {} });
    return { pm, sent };
  }

  it('announces once per build in servers that use the bot', async () => {
    const store = new Store(':memory:');
    store.createWatch({ guildId: 'g1', channelId: 'alerts', name: 'A', url: 'https://a.io/', host: 'a.io', rootDomain: 'a.io', createdBy: 'u' });
    store.setGuildSettings('g1', { panelChannelId: 'dash', panelMessageId: 'm1' });
    const { pm, sent } = setup(store);
    expect(await pm.announceUpdate('g1')).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe('dash');
    expect(sent[0].payload.content).toBe(`🚀 **Ver ${DISPLAY_VERSION} has been updated!** Enjoy 🎉`);
    expect(store.getGuildSettings('g1')?.announcedVersion).toBe(BUILD_ID);
    expect(await pm.announceUpdate('g1')).toBe(false); // same build again → silent
    expect(sent).toHaveLength(1);
    pm.stop();
  });

  it('stays quiet in servers without sites or a dashboard', async () => {
    const store = new Store(':memory:');
    const { pm, sent } = setup(store);
    expect(await pm.announceUpdate('g2')).toBe(false);
    expect(sent).toHaveLength(0);
    expect(store.getGuildSettings('g2')).toBeUndefined(); // must not block a later restore scan
    pm.stop();
  });

  it('carries the announced build through the backup file', () => {
    const file = toBackup('g1', [], new Date(), 'x+abc');
    expect(parseBackup(JSON.stringify(file))?.announcedVersion).toBe('x+abc');
    expect(parseBackup(JSON.stringify({ ...file, announcedVersion: undefined }))?.announcedVersion).toBeNull();
  });
});
