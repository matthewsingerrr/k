/**
 * Discord's view of one server for the Link API (GET /guild, the channel / role checks of management writes, the card's
 * delivery status), built from the gateway cache only: no REST calls, no channels.fetch.
 *
 * - channels: text and announcement channels, in Discord's display order (uncategorized first, then by category
 *   position; inside a category by channel position, then id), with the bot's missing permissions as missingChannelPerms
 *   judges them (View Channel, Send Messages, Embed Links).
 * - otherChannels: every other cached text-capable channel (threads, chats of voice channels) — alerts may already post
 *   there (a watch added with /watch add inside a thread), but they are never offered as a new alert channel.
 * - roles: highest first, @everyone (id = the guild id) last.
 */

import { ChannelType, type Guild } from 'discord.js';
import type { GuildSnapshot } from '../link/api.js';
import { missingChannelPerms } from './commands.js';

type CachedChannel = {
  id: string;
  name?: string | null;
  type: ChannelType;
  rawPosition?: number;
  parent?: { name?: string | null; rawPosition?: number } | null;
  isTextBased?: () => boolean;
};

type CachedRole = {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  color?: number;
  colors?: { primaryColor?: number } | null;
};

/** Snowflakes compare as numbers: shorter strings are smaller. */
function bySnowflake(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** The server as the Link API sees it, or null when it isn't cached / available. Never throws. */
export function guildSnapshot(guild: Guild | null | undefined): GuildSnapshot | null {
  try {
    if (!guild || guild.available === false) return null;
    const channels: Array<GuildSnapshot['channels'][number] & { order: [number, number] }> = [];
    const otherChannels: NonNullable<GuildSnapshot['otherChannels']> = [];
    for (const raw of guild.channels.cache.values()) {
      const ch = raw as unknown as CachedChannel;
      const type = ch.type === ChannelType.GuildText ? 'text' : ch.type === ChannelType.GuildAnnouncement ? 'announcement' : null;
      const name = String(ch.name ?? ch.id);
      if (type) {
        const missing = missingChannelPerms({ guild }, ch.id);
        channels.push({
          id: ch.id,
          name,
          type,
          category: ch.parent?.name ?? null,
          canPost: missing.length === 0,
          missing,
          order: [ch.parent ? Number(ch.parent.rawPosition ?? 0) : -1, Number(ch.rawPosition ?? 0)],
        });
      } else if (ch.type !== ChannelType.GuildCategory && typeof ch.isTextBased === 'function' && ch.isTextBased()) {
        otherChannels.push({ id: ch.id, name, missing: missingChannelPerms({ guild }, ch.id) });
      }
    }
    channels.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || bySnowflake(a.id, b.id));
    const roles = [...guild.roles.cache.values()]
      .map((r) => r as unknown as CachedRole)
      .sort((a, b) => Number(a.id === guild.id) - Number(b.id === guild.id) || b.position - a.position || bySnowflake(a.id, b.id))
      .map((r) => ({
        id: r.id,
        name: r.id === guild.id ? '@everyone' : r.name,
        everyone: r.id === guild.id,
        managed: Boolean(r.managed),
        color: Number(r.colors?.primaryColor ?? r.color ?? 0) || 0,
      }));
    return {
      guild: { id: guild.id, name: guild.name },
      channels: channels.map(({ order: _order, ...c }) => c),
      roles,
      otherChannels,
    };
  } catch {
    return null;
  }
}
