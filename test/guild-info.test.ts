/**
 * guildSnapshot(): the Link API's view of a Discord server, built from (fake) gateway-cache objects only.
 */

import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { guildSnapshot } from '../src/discord/guild-info.js';

const G = '100000000000000001';

interface FakeChannelOpts {
  parent?: { name: string; rawPosition: number } | null;
  rawPosition?: number;
  denied?: bigint[];
  thread?: boolean;
  textBased?: boolean;
}

function channel(id: string, name: string, type: ChannelType, o: FakeChannelOpts = {}) {
  return {
    id,
    name,
    type,
    rawPosition: o.rawPosition ?? 0,
    parent: o.parent ?? null,
    isThread: () => Boolean(o.thread),
    isTextBased: () => o.textBased ?? true,
    permissionsFor: () => ({ has: (flag: bigint) => !(o.denied ?? []).includes(flag) }),
  };
}

function role(id: string, name: string, position: number, extra: Record<string, unknown> = {}) {
  return { id, name, position, managed: false, color: 0, ...extra };
}

function fakeGuild(over: Record<string, unknown> = {}): Guild {
  const monitoring = { name: 'MONITORING', rawPosition: 1 };
  const archive = { name: 'ARCHIVE', rawPosition: 0 };
  const channels = [
    channel('20', 'alerts', ChannelType.GuildText, { parent: monitoring, rawPosition: 2 }),
    channel('21', 'scans', ChannelType.GuildText, { parent: monitoring, rawPosition: 1 }),
    channel('22', 'news', ChannelType.GuildAnnouncement, { rawPosition: 5, denied: [PermissionFlagsBits.SendMessages] }),
    channel('23', 'general', ChannelType.GuildText, { rawPosition: 0 }),
    channel('24', 'old', ChannelType.GuildText, { parent: archive, rawPosition: 0, denied: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks] }),
    channel('25', 'Lounge', ChannelType.GuildVoice, { rawPosition: 0 }),
    channel('26', 'launch thread', ChannelType.PublicThread, { thread: true }),
    channel('27', 'MONITORING', ChannelType.GuildCategory, { textBased: false }),
    channel('28', 'Stage', ChannelType.GuildStageVoice, { textBased: false }),
  ];
  const roles = [
    role(G, '@everyone', 0),
    role('31', 'Mods', 5, { colors: { primaryColor: 0xff0000 } }),
    role('32', 'Alpha', 2, { color: 15844367 }),
    role('33', 'Site Watcher', 9, { managed: true }),
  ];
  return {
    id: G,
    name: 'Alpha Calls',
    available: true,
    members: { me: {} },
    channels: { cache: new Map(channels.map((c) => [c.id, c])) },
    roles: { cache: new Map(roles.map((r) => [r.id, r])) },
    ...over,
  } as unknown as Guild;
}

describe('guildSnapshot', () => {
  it('lists alert channels in display order with their missing permissions', () => {
    const g = guildSnapshot(fakeGuild())!;
    expect(g.guild).toEqual({ id: G, name: 'Alpha Calls' });
    expect(g.channels).toEqual([
      { id: '23', name: 'general', type: 'text', category: null, canPost: true, missing: [] },
      { id: '22', name: 'news', type: 'announcement', category: null, canPost: false, missing: ['Send Messages'] },
      { id: '24', name: 'old', type: 'text', category: 'ARCHIVE', canPost: false, missing: ['View Channel', 'Embed Links'] },
      { id: '21', name: 'scans', type: 'text', category: 'MONITORING', canPost: true, missing: [] },
      { id: '20', name: 'alerts', type: 'text', category: 'MONITORING', canPost: true, missing: [] },
    ]);
    // Voice chats and threads are known (alerts may go there already) but never offered; categories and stages are skipped.
    expect(g.otherChannels).toEqual([
      { id: '25', name: 'Lounge', missing: [] },
      { id: '26', name: 'launch thread', missing: [] },
    ]);
  });

  it('lists roles highest first with @everyone last', () => {
    const g = guildSnapshot(fakeGuild())!;
    expect(g.roles).toEqual([
      { id: '33', name: 'Site Watcher', everyone: false, managed: true, color: 0 },
      { id: '31', name: 'Mods', everyone: false, managed: false, color: 0xff0000 },
      { id: '32', name: 'Alpha', everyone: false, managed: false, color: 15844367 },
      { id: G, name: '@everyone', everyone: true, managed: false, color: 0 },
    ]);
  });

  it('is null for a missing, unavailable or broken guild', () => {
    expect(guildSnapshot(undefined)).toBeNull();
    expect(guildSnapshot(null)).toBeNull();
    expect(guildSnapshot(fakeGuild({ available: false }))).toBeNull();
    const broken = fakeGuild({
      channels: {
        get cache() {
          throw new Error('boom');
        },
      },
    });
    expect(guildSnapshot(broken)).toBeNull();
  });
});
