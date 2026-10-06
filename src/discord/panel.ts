/**
 * Control-panel UI: the persistent dashboard message (rendered here, posted/edited/pinned by backup.ts via PanelHost) and
 * every click on it.
 *
 * Dashboard (one message per server):
 *   embed "🛰️ Site Watcher" — summary ("Watching **3** sites · alerts in #alerts", up/down/paused counts) and one line per
 *   site (status emoji, name, host, interval, channel; ≤ 25 lines then "+N more"), brand colour, timestamp.
 *   rows: string select(s) "Manage a site…" (≤ 25 options each, up to 3 selects), then [➕ Add site] [🔄 Refresh] [📖 Help].
 *
 * Every click is answered ephemerally to the clicker, so the shared dashboard never changes because of a click. Picking a site
 * opens its card (ephemeral); buttons on the card update that card in place:
 *   card:     [⚡ Check now] [⏸️ Pause | ▶️ Resume] [⚙️ Settings] [🗑️ Remove]
 *             [🧩 Features] [🚫 Rules] [📄 Pages] [🛰️ Subdomains] [🕘 History]
 *   features: one toggle per check (green = on), [◀ Back]
 *   pages / subdomains / history: the list, [◀ Back]
 *   remove:   confirmation [Remove] [Cancel]
 * Settings, Rules and Add site open modals (Label components with channel/role selects). Modal submits from a card update
 * that card in place with a one-line banner of what changed; validation problems reply "⚠️ …" ephemerally.
 *
 * custom_ids ("panel:" prefix, ≤ 100 chars) carry everything a click needs — no in-memory state, so buttons keep working
 * across restarts. Toggle/pause buttons carry the desired state, so a stale card can't flip a switch the wrong way.
 * Anything that changes a watch (or starts network work) re-checks Manage Server.
 */

import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  MessageFlags,
  SelectMenuDefaultValueType,
  TextInputStyle,
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type APIComponentInLabel,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APILabelComponent,
  type APIModalInteractionResponseCallbackData,
  type APISelectMenuOption,
  type APITextInputComponent,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { Watch, WatchPatch } from '../types.js';
import {
  FEATURE_TOGGLES,
  MAX_INTERVAL_SEC,
  MAX_NAME_CHARS,
  MAX_PAGES_LIMIT,
  MAX_PATTERNS,
  MAX_SCOPE_CHARS,
  NO_MENTIONS,
  SWEEP_MAX_SEC,
  SWEEP_MIN_SEC,
  UserError,
  channelMention,
  cleanName,
  defaultInterval,
  defer,
  errMessage,
  finishAdd,
  minInterval,
  nameOf,
  nameTaken,
  notifyUpdated,
  parseScope,
  permsWarning,
  prepareAdd,
  removeWatch,
  renderHelp,
  renderHistory,
  renderPages,
  renderSiteInfo,
  renderSubdomains,
  replyError,
  requireManageGuild,
  resolveExtraPages,
  respond,
  roleMention,
  runCheck,
  safeState,
  siteStatus,
  toggleValue,
  validateNewPatterns,
  validatePattern,
  type CommandDeps,
  type ToggleKey,
} from './commands.js';
import { clampEmbed, codeSpan, escapeMarkdown, formatDuration, truncate } from './format.js';
import { compileUrlPattern } from '../extract/url.js';

/**
 * Implemented in src/discord/backup.ts (not by the panel): owns the ONE persistent panel message per guild
 * (posting, editing, pinning, and attaching the watch-list backup JSON). The panel code only renders & handles clicks.
 */
export interface PanelHost {
  /** (Re)post the persistent panel in `channelId` (removing the previous one). Resolves to the new message URL. */
  placePanel(guildId: string, channelId: string): Promise<string>;
  /** Schedule a debounced refresh of the guild's panel message (store changes already trigger this automatically). */
  refresh(guildId: string): void;
}

export interface PanelMessage {
  embeds: APIEmbed[];
  components: Array<APIActionRowComponent<APIComponentInMessageActionRow>>;
}

export const PANEL_PREFIX = 'panel:';
/** Brand colour of the dashboard and its views. */
export const PANEL_COLOR = 0x6366f1;
/** Site lines listed on the dashboard before "+N more". */
export const PANEL_MAX_LINES = 25;
/** Options per select menu (Discord limit) and select menus on the dashboard (75 sites reachable). */
export const SELECT_MAX_OPTIONS = 25;
export const PANEL_MAX_SELECTS = 3;
/** Discord's text input value limit. */
const TEXT_INPUT_MAX = 4000;
/** Room for the dashboard description (Discord allows 4096; keep space for the "+N more" line). */
const DESCRIPTION_BUDGET = 4000;
const ALERT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

type Row = APIActionRowComponent<APIComponentInMessageActionRow>;
type ComponentInteraction = ButtonInteraction | StringSelectMenuInteraction | AnySelectMenuInteraction;
type PanelInteraction = ComponentInteraction | ModalSubmitInteraction;

interface View {
  content?: string;
  embeds: APIEmbed[];
  components: Row[];
}

/** custom_ids. Component ids and modal ids live in separate namespaces ("panel:m:…" for modals). */
export const PanelIds = {
  add: 'panel:add',
  refresh: 'panel:refresh',
  help: 'panel:help',
  pick: (n: number) => `panel:pick:${n}`,
  site: (id: number) => `panel:site:${id}`,
  check: (id: number) => `panel:check:${id}`,
  pause: (id: number, paused: boolean) => `panel:pause:${id}:${paused ? 1 : 0}`,
  settings: (id: number) => `panel:settings:${id}`,
  remove: (id: number) => `panel:remove:${id}`,
  removeConfirm: (id: number) => `panel:rmyes:${id}`,
  features: (id: number) => `panel:features:${id}`,
  toggle: (id: number, key: ToggleKey, on: boolean) => `panel:toggle:${id}:${key}:${on ? 1 : 0}`,
  rules: (id: number) => `panel:rules:${id}`,
  pages: (id: number) => `panel:pages:${id}`,
  subdomains: (id: number) => `panel:subs:${id}`,
  history: (id: number) => `panel:history:${id}`,
  addModal: 'panel:m:add',
  settingsModal: (id: number) => `panel:m:settings:${id}`,
  rulesModal: (id: number) => `panel:m:rules:${id}`,
} as const;

/** True if a component/modal custom_id belongs to the panel ("panel:" prefix). */
export function isPanelCustomId(customId: string): boolean {
  return customId.startsWith(PANEL_PREFIX);
}

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

function button(customId: string, label: string, style: ButtonStyle = ButtonStyle.Secondary, emoji?: string): APIButtonComponentWithCustomId {
  const b: APIButtonComponentWithCustomId = { type: ComponentType.Button, custom_id: customId, style: style as APIButtonComponentWithCustomId['style'], label: truncate(label, 80) };
  if (emoji) b.emoji = { name: emoji };
  return b;
}

function row(...components: APIComponentInMessageActionRow[]): Row {
  return { type: ComponentType.ActionRow, components };
}

function label(text: string, description: string | undefined, component: APIComponentInLabel): APILabelComponent {
  const l: APILabelComponent = { type: ComponentType.Label, label: truncate(text, 45), component };
  if (description) l.description = truncate(description, 100);
  return l;
}

function textInput(customId: string, o: { paragraph?: boolean; value?: string; placeholder?: string; required?: boolean; maxLength?: number }): APITextInputComponent {
  const t: APITextInputComponent = {
    type: ComponentType.TextInput,
    custom_id: customId,
    style: o.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short,
    required: o.required ?? false,
    max_length: Math.min(TEXT_INPUT_MAX, o.maxLength ?? TEXT_INPUT_MAX),
  };
  if (o.value) t.value = truncate(o.value, t.max_length ?? TEXT_INPUT_MAX);
  if (o.placeholder) t.placeholder = truncate(o.placeholder, 100);
  return t;
}

const isSnowflake = (id: string | null | undefined): id is string => typeof id === 'string' && /^\d{5,25}$/.test(id);

function channelSelect(customId: string, current: string | null): APIComponentInLabel {
  return {
    type: ComponentType.ChannelSelect,
    custom_id: customId,
    channel_types: ALERT_CHANNEL_TYPES,
    min_values: 0,
    max_values: 1,
    required: false,
    placeholder: 'Pick a text or announcement channel',
    ...(isSnowflake(current) ? { default_values: [{ id: current, type: SelectMenuDefaultValueType.Channel }] } : {}),
  };
}

function roleSelect(customId: string, current: string | null): APIComponentInLabel {
  return {
    type: ComponentType.RoleSelect,
    custom_id: customId,
    min_values: 0,
    max_values: 1,
    required: false,
    placeholder: 'No ping',
    ...(isSnowflake(current) ? { default_values: [{ id: current, type: SelectMenuDefaultValueType.Role }] } : {}),
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function panelHost(deps: CommandDeps) {
  try {
    return deps.panel ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** Render the persistent dashboard for a guild (pure: reads store + monitor.runtimeInfo only). */
export function buildPanelMessage(
  deps: Pick<CommandDeps, 'store' | 'config'> & { monitor?: CommandDeps['monitor'] | null },
  guildId: string,
  now: Date = new Date(),
): PanelMessage {
  const watches = deps.store.listWatches(guildId);
  const items = watches.map((w) => ({ w, st: siteStatus(w, safeState(deps.store, w.id)) }));

  const embed: APIEmbed = { title: '🛰️ Site Watcher', color: PANEL_COLOR, timestamp: now.toISOString() };
  if (!items.length) {
    embed.description = [
      'No sites yet — press **Add site** to start watching one.',
      '',
      'I post an alert the moment a watched site redeploys, changes its text, adds pages, subdomains or files, or goes down.',
    ].join('\n');
    embed.footer = { text: 'Only members with Manage Server can change settings' };
  } else {
    const channels = [...new Set(watches.map((w) => w.channelId))];
    const where = channels.length === 1 ? `alerts in ${channelMention(channels[0])}` : `alerts in ${channels.length} channels`;
    const counts = new Map<string, number>();
    for (const { st } of items) counts.set(st.emoji, (counts.get(st.emoji) ?? 0) + 1);
    const tally = [
      ['🟢', 'up'],
      ['🔴', 'down'],
      ['🛡️', 'blocked'],
      ['⏸️', 'paused'],
      ['⏳', 'scanning'],
    ]
      .filter(([emoji]) => counts.get(emoji))
      .map(([emoji, word]) => `${emoji} ${counts.get(emoji)} ${word}`)
      .join(' · ');
    const head = [`Watching **${items.length}** ${items.length === 1 ? 'site' : 'sites'} · ${where}`, tally, ''].join('\n');
    // At most PANEL_MAX_LINES lines, and never more than fits the description (escaped names can be long).
    const budget = DESCRIPTION_BUDGET - head.length;
    const lines: string[] = [];
    let used = 0;
    for (const { w, st } of items) {
      if (lines.length >= PANEL_MAX_LINES) break;
      const line = `${st.emoji} **${nameOf(w, 40)}** · ${escapeMarkdown(truncate(w.host, 60))} · every ${formatInterval(w.intervalSec)} · ${channelMention(w.channelId)}`;
      if (used + line.length + 1 > budget) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (items.length > lines.length) lines.push(`+${items.length - lines.length} more`);
    embed.description = `${head}\n${lines.join('\n')}`;
    embed.footer = { text: 'Pick a site below to manage it · Only members with Manage Server can change settings' };
  }

  const components: Row[] = [];
  const selects = Math.min(PANEL_MAX_SELECTS, Math.ceil(items.length / SELECT_MAX_OPTIONS));
  for (let n = 0; n < selects; n++) {
    const chunk = items.slice(n * SELECT_MAX_OPTIONS, (n + 1) * SELECT_MAX_OPTIONS);
    const options: APISelectMenuOption[] = chunk.map(({ w, st }) => ({
      label: truncate(w.name.replace(/[\r\n]+/g, ' ').trim() || w.host, 100),
      description: truncate(`${w.host} · every ${formatInterval(w.intervalSec)}`, 100),
      value: String(w.id),
      emoji: { name: st.emoji },
    }));
    const first = n * SELECT_MAX_OPTIONS + 1;
    const placeholder =
      items.length > SELECT_MAX_OPTIONS ? `Manage a site… (${first}–${first + chunk.length - 1} of ${items.length})` : 'Manage a site…';
    components.push(
      row({ type: ComponentType.StringSelect, custom_id: PanelIds.pick(n), placeholder: truncate(placeholder, 150), min_values: 1, max_values: 1, options }),
    );
  }
  components.push(
    row(
      button(PanelIds.add, 'Add site', ButtonStyle.Primary, '➕'),
      button(PanelIds.refresh, 'Refresh', ButtonStyle.Secondary, '🔄'),
      button(PanelIds.help, 'Help', ButtonStyle.Secondary, '📖'),
    ),
  );
  return { embeds: [clampEmbed(embed)], components };
}

function formatInterval(sec: number): string {
  return sec < 120 ? `${sec}s` : formatDuration(sec * 1000);
}

// ---------------------------------------------------------------------------
// Card views
// ---------------------------------------------------------------------------

function cardView(deps: CommandDeps, w: Watch, i: PanelInteraction, banner?: string): View {
  return {
    content: banner,
    embeds: [renderSiteInfo(deps, w, i)],
    components: [
      row(
        button(PanelIds.check(w.id), 'Check now', ButtonStyle.Primary, '⚡'),
        w.paused ? button(PanelIds.pause(w.id, false), 'Resume', ButtonStyle.Success, '▶️') : button(PanelIds.pause(w.id, true), 'Pause', ButtonStyle.Secondary, '⏸️'),
        button(PanelIds.settings(w.id), 'Settings', ButtonStyle.Secondary, '⚙️'),
        button(PanelIds.remove(w.id), 'Remove', ButtonStyle.Danger, '🗑️'),
      ),
      row(
        button(PanelIds.features(w.id), 'Features', ButtonStyle.Secondary, '🧩'),
        button(PanelIds.rules(w.id), 'Rules', ButtonStyle.Secondary, '🚫'),
        button(PanelIds.pages(w.id), 'Pages', ButtonStyle.Secondary, '📄'),
        button(PanelIds.subdomains(w.id), 'Subdomains', ButtonStyle.Secondary, '🛰️'),
        button(PanelIds.history(w.id), 'History', ButtonStyle.Secondary, '🕘'),
      ),
    ],
  };
}

const backButton = (w: Watch) => button(PanelIds.site(w.id), 'Back', ButtonStyle.Secondary, '◀️');

function featuresView(w: Watch, banner?: string): View {
  const toggles = FEATURE_TOGGLES.map((t) => {
    const on = toggleValue(w, t.key);
    return button(PanelIds.toggle(w.id, t.key, !on), t.label, on ? ButtonStyle.Success : ButtonStyle.Secondary, t.emoji);
  });
  const list = FEATURE_TOGGLES.map((t) => `${toggleValue(w, t.key) ? '🟢' : '⚪'} ${t.emoji} **${t.label}** — ${t.hint}`);
  return {
    content: banner,
    embeds: [
      {
        title: `🧩 Checks — ${nameOf(w)}`,
        url: w.url,
        color: PANEL_COLOR,
        description: [
          'Green = on, grey = off. Click a switch to flip it; it applies right away.',
          '',
          ...list,
          '',
          '_Switching a check on re-baselines only what it covers, silently._',
        ].join('\n'),
        footer: { text: `#${w.id} · ${w.host}` },
      },
    ],
    components: [row(...toggles.slice(0, 5)), row(...toggles.slice(5), backButton(w))],
  };
}

function listView(embed: APIEmbed, w: Watch): View {
  return { embeds: [embed], components: [row(backButton(w))] };
}

function confirmRemoveView(w: Watch): View {
  return {
    embeds: [
      {
        title: `🗑️ Remove ${nameOf(w)}?`,
        url: w.url,
        color: 0xef4444,
        description: `Stop watching ${truncate(w.url, 500)}?\nIts tracked pages, subdomains and alert history are deleted. This can't be undone.`,
      },
    ],
    components: [row(button(PanelIds.removeConfirm(w.id), 'Remove', ButtonStyle.Danger, '🗑️'), button(PanelIds.site(w.id), 'Cancel', ButtonStyle.Secondary))],
  };
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function addModal(deps: CommandDeps, channelId: string | null, channelType: ChannelType | undefined): APIModalInteractionResponseCallbackData {
  const def = defaultInterval(deps.config);
  const min = minInterval(deps.config);
  // Pre-select the dashboard's channel when it can receive alerts.
  const preset = channelType === undefined || ALERT_CHANNEL_TYPES.includes(channelType) ? channelId : null;
  return {
    custom_id: PanelIds.addModal,
    title: 'Add a site to watch',
    components: [
      label('Website URL', 'e.g. unpeg.io or https://unpeg.io/docs', textInput('url', { required: true, maxLength: 2000, placeholder: 'unpeg.io' })),
      label('Name', 'Optional — defaults to a name from the domain', textInput('name', { maxLength: MAX_NAME_CHARS, placeholder: 'Unpeg' })),
      label('Check interval (seconds)', `Optional — ${min}–${MAX_INTERVAL_SEC}, default ${def}`, textInput('interval', { maxLength: 6, placeholder: String(def) })),
      label('Alert channel', 'Where alerts are posted (default: this channel)', channelSelect('channel', preset)),
      label('Ping role', 'Optional — role to mention on every alert', roleSelect('role', null)),
    ],
  };
}

function settingsModal(deps: CommandDeps, w: Watch): APIModalInteractionResponseCallbackData {
  const min = minInterval(deps.config);
  const everyone = w.pingRoleId !== null && w.pingRoleId === w.guildId;
  return {
    custom_id: PanelIds.settingsModal(w.id),
    title: truncate(`Settings — ${w.name.replace(/[\r\n]+/g, ' ')}`, 45),
    components: [
      label('Name', undefined, textInput('name', { value: w.name, required: true, maxLength: MAX_NAME_CHARS })),
      label('Check interval (seconds)', `${min}–${MAX_INTERVAL_SEC} · homepage, redeploys and uptime`, textInput('interval', { value: String(w.intervalSec), required: true, maxLength: 6 })),
      label(
        'Full page sweep (seconds)',
        `${SWEEP_MIN_SEC}–${SWEEP_MAX_SEC} · every tracked page is re-checked within this time`,
        textInput('sweep', { value: String(w.sweepSec), required: true, maxLength: 6 }),
      ),
      label('Alert channel', 'Where alerts are posted', channelSelect('channel', w.channelId)),
      label('Ping role', everyone ? 'Currently @everyone — leave empty to stop pinging' : 'Leave empty for no ping', roleSelect('role', everyone ? null : w.pingRoleId)),
    ],
  };
}

/** Prefill for a one-per-line list; lists too long for a text input are left empty (and kept when submitted empty). */
function listInput(customId: string, list: string[]): APITextInputComponent {
  const joined = list.join('\n');
  if (joined.length <= TEXT_INPUT_MAX) return textInput(customId, { paragraph: true, value: joined, placeholder: 'One per line' });
  return textInput(customId, { paragraph: true, placeholder: `${list.length} entries (too long to show) — leave empty to keep them` });
}

function rulesModal(w: Watch): APIModalInteractionResponseCallbackData {
  return {
    custom_id: PanelIds.rulesModal(w.id),
    title: truncate(`Rules — ${w.name.replace(/[\r\n]+/g, ' ')}`, 45),
    components: [
      label('Ignore text (regex, one per line)', 'Matching text is removed before pages are compared, e.g. Last updated.*', listInput('ignore', w.ignorePatterns)),
      label('Skip URLs (one per line)', 'Never crawl/track/alert these, e.g. /profile/* or a regex', listInput('exclude', w.excludePatterns)),
      label('Extra pages (one per line)', 'Always tracked, even if nothing links to them — URLs or paths like /secret', listInput('extra', w.extraUrls)),
      label('Only crawl under this path', 'e.g. /docs — leave empty to crawl the whole site', textInput('scope', { value: w.scopePath ?? '', maxLength: MAX_SCOPE_CHARS, placeholder: '/docs' })),
      label('Max tracked pages', `1–${MAX_PAGES_LIMIT} · pages whose text is compared`, textInput('max_pages', { value: String(w.maxPages), required: true, maxLength: 4 })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Responding
// ---------------------------------------------------------------------------

/** Update the clicked ephemeral message in place when possible, otherwise reply ephemerally. */
async function show(i: PanelInteraction, view: View, deps: CommandDeps): Promise<void> {
  if (canUpdate(i)) {
    const payload = {
      content: truncate(view.content ?? '', 2000),
      embeds: view.embeds.map(clampEmbed),
      components: view.components,
      allowedMentions: NO_MENTIONS,
    };
    try {
      if (i.isModalSubmit()) {
        if (i.isFromMessage()) {
          await i.update(payload);
          return;
        }
      } else {
        await i.update(payload);
        return;
      }
    } catch (err) {
      deps.log.warn('updating the panel view failed — replying instead', { err: errMessage(err) });
    }
  }
  await respond(i, view, true, deps.log);
}

/** Only ever update an ephemeral message (a card); the shared dashboard is never edited by a click. */
function canUpdate(i: PanelInteraction): boolean {
  if (i.deferred || i.replied) return false;
  if (i.isModalSubmit() && !i.isFromMessage()) return false;
  const flags = i.message?.flags;
  if (!flags || typeof flags.has !== 'function') return true;
  return flags.has(MessageFlags.Ephemeral);
}

function siteFrom(deps: CommandDeps, guildId: string, raw: string | undefined): Watch {
  if (!raw || !/^\d{1,15}$/.test(raw)) throw new UserError('This button is no longer valid.');
  const w = deps.store.getWatch(Number(raw));
  if (!w || w.guildId !== guildId) throw new UserError('That site is no longer watched — it may have been removed.');
  return w;
}

// ---------------------------------------------------------------------------
// Component clicks
// ---------------------------------------------------------------------------

export async function handlePanelComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction | AnySelectMenuInteraction,
  deps: CommandDeps,
): Promise<void> {
  const { log } = deps;
  try {
    if (!interaction.inGuild() || !interaction.guildId) throw new UserError('This only works inside a server.');
    const guildId = interaction.guildId;
    const parts = interaction.customId.split(':');
    const action = parts[1] ?? '';

    // Dashboard controls (the shared message): always answered with a new ephemeral message.
    switch (action) {
      case 'add': {
        requireManageGuild(interaction);
        const channelType = (interaction.channel as { type?: ChannelType } | null | undefined)?.type;
        await interaction.showModal(addModal(deps, interaction.channelId, channelType));
        return;
      }
      case 'refresh': {
        const host = panelHost(deps);
        if (!host) throw new UserError("The dashboard can't be refreshed right now — try again in a few seconds.");
        host.refresh(guildId);
        await interaction.deferUpdate();
        return;
      }
      case 'help':
        await respond(interaction, { embeds: [renderHelp()] }, true, log);
        return;
      case 'pick': {
        const value = interaction.isStringSelectMenu() ? interaction.values[0] : undefined;
        const w = siteFrom(deps, guildId, value);
        await respond(interaction, cardView(deps, w, interaction), true, log);
        // Re-render the dashboard so its menu doesn't stay stuck on the picked site.
        try {
          panelHost(deps)?.refresh(guildId);
        } catch (err) {
          log.debug('panel refresh failed', { err: errMessage(err) });
        }
        return;
      }
    }

    // Card controls (an ephemeral message only the clicker sees).
    const w = siteFrom(deps, guildId, parts[2]);
    switch (action) {
      case 'site':
        await show(interaction, cardView(deps, w, interaction), deps);
        return;
      case 'pages':
        await show(interaction, listView(renderPages(deps, w), w), deps);
        return;
      case 'subs':
        await show(interaction, listView(renderSubdomains(deps, w), w), deps);
        return;
      case 'history':
        await show(interaction, listView(renderHistory(deps, w, 15), w), deps);
        return;
      case 'check': {
        requireManageGuild(interaction);
        await defer(interaction, true, log);
        const content = await runCheck(deps, w, false, interaction);
        await respond(interaction, { content }, true, log);
        return;
      }
      case 'pause': {
        requireManageGuild(interaction);
        const paused = parts[3] === '1';
        let current = w;
        let banner: string;
        if (w.paused === paused) {
          banner = `ℹ️ **${nameOf(w)}** is already ${paused ? 'paused' : 'running'}.`;
        } else {
          current = deps.store.updateWatch(w.id, { paused });
          notifyUpdated(deps, current);
          log.info(paused ? 'watch paused' : 'watch resumed', { watchId: w.id, by: interaction.user.id });
          banner = paused ? `⏸️ Paused **${nameOf(w)}** — no checks until you resume it.` : `▶️ Resumed **${nameOf(w)}**.`;
        }
        await show(interaction, cardView(deps, current, interaction, banner), deps);
        return;
      }
      case 'exclude': {
        // "🚫 Ignore /folder/*" on a new-page alert (a public message): answer privately, never edit the alert.
        requireManageGuild(interaction);
        const pattern = validatePattern(parts.slice(3).join(':'), 'exclude');
        const where = `**${nameOf(w)}**`;
        if (w.excludePatterns.includes(pattern)) {
          await respond(interaction, { content: `ℹ️ ${codeSpan(pattern, 100)} is already ignored on ${where}.` }, true, log);
          return;
        }
        if (w.excludePatterns.length >= MAX_PATTERNS) throw new UserError(`${where} already has ${MAX_PATTERNS} skip rules — remove one in the dashboard (Rules) first.`);
        const re = compileUrlPattern(pattern);
        if (re?.test(w.url)) throw new UserError(`${codeSpan(pattern, 100)} would also skip the start page of ${where}.`);
        const dropped = deps.store.listPages(w.id, { kind: 'page', tracked: true }).filter((r) => re?.test(r.url)).length;
        const updated = deps.store.updateWatch(w.id, { excludePatterns: [...w.excludePatterns, pattern] });
        notifyUpdated(deps, updated);
        log.info('path ignored from alert button', { watchId: w.id, pattern, by: interaction.user.id });
        await respond(
          interaction,
          {
            content:
              `🚫 Pages under ${codeSpan(pattern, 100)} on ${where} won't be announced or tracked anymore` +
              (dropped ? ` (${dropped} tracked ${dropped === 1 ? 'page' : 'pages'} dropped)` : '') +
              '. Undo it in the dashboard → **Rules**.',
          },
          true,
          log,
        );
        return;
      }
      case 'settings':
        requireManageGuild(interaction);
        await interaction.showModal(settingsModal(deps, w));
        return;
      case 'rules':
        requireManageGuild(interaction);
        await interaction.showModal(rulesModal(w));
        return;
      case 'features':
        requireManageGuild(interaction);
        await show(interaction, featuresView(w), deps);
        return;
      case 'toggle': {
        requireManageGuild(interaction);
        const t = FEATURE_TOGGLES.find((x) => x.key === parts[3]);
        if (!t || (parts[4] !== '0' && parts[4] !== '1')) throw new UserError('This button is no longer valid.');
        const on = parts[4] === '1';
        let current = w;
        if (toggleValue(w, t.key) !== on) {
          const patch: WatchPatch = t.key === 'maskNumbers' ? { maskNumbers: on } : { features: { ...w.features, [t.key]: on } };
          current = deps.store.updateWatch(w.id, patch);
          notifyUpdated(deps, current);
          log.info('watch updated', { watchId: w.id, by: interaction.user.id, changes: [t.key] });
        }
        await show(interaction, featuresView(current, `${on ? '✅' : '⬜'} **${t.label}** ${on ? 'on' : 'off'} for **${nameOf(current)}**.`), deps);
        return;
      }
      case 'remove':
        requireManageGuild(interaction);
        await show(interaction, confirmRemoveView(w), deps);
        return;
      case 'rmyes':
        requireManageGuild(interaction);
        removeWatch(deps, w, interaction.user.id);
        await show(interaction, { content: `🗑️ Stopped watching **${nameOf(w)}** (<${w.url}>).`, embeds: [], components: [] }, deps);
        return;
      default:
        throw new UserError('This button is no longer valid.');
    }
  } catch (err) {
    await replyError(interaction, err, log, `panel ${truncate(interaction.customId ?? '', 60)}`);
  }
}

// ---------------------------------------------------------------------------
// Modal submits
// ---------------------------------------------------------------------------

/** A text input's value, or null when the modal has no such field. */
function readText(i: ModalSubmitInteraction, id: string): string | null {
  try {
    return i.fields.getTextInputValue(id) ?? '';
  } catch {
    return null;
  }
}

/** Ids picked in a channel/role select, or null when the modal has no such field. */
function readSelected(i: ModalSubmitInteraction, id: string, kind: 'channel' | 'role'): string[] | null {
  try {
    const picked = kind === 'channel' ? i.fields.getSelectedChannels(id) : i.fields.getSelectedRoles(id);
    return picked ? [...picked.keys()] : [];
  } catch {
    return null;
  }
}

function parseSeconds(raw: string, what: string, min: number, max: number): number {
  const s = raw.trim().replace(/\s*(s|secs?|seconds?)$/i, '');
  if (!/^\d{1,7}$/.test(s)) throw new UserError(`${what} must be a whole number of seconds (${min}–${max}).`);
  const n = Number(s);
  if (n < min || n > max) throw new UserError(`${what} must be between ${min} and ${max} seconds.`);
  return n;
}

function uniqueLines(raw: string): string[] {
  return [...new Set(raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
}

/** One-per-line list from a modal; null = keep the current list (field missing, or too long to prefill and left empty). */
function readList(i: ModalSubmitInteraction, id: string, current: string[]): string[] | null {
  const raw = readText(i, id);
  if (raw === null) return null;
  const lines = uniqueLines(raw);
  if (!lines.length && current.join('\n').length > TEXT_INPUT_MAX) return null;
  return lines;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, n) => v === b[n]);

export async function handlePanelModal(interaction: ModalSubmitInteraction, deps: CommandDeps): Promise<void> {
  const { log } = deps;
  try {
    if (!interaction.inGuild() || !interaction.guildId) throw new UserError('This only works inside a server.');
    const guildId = interaction.guildId;
    const parts = interaction.customId.split(':');
    if (parts[1] !== 'm') throw new UserError('This form is no longer valid.');
    requireManageGuild(interaction);
    switch (parts[2]) {
      case 'add':
        await submitAdd(interaction, deps, guildId);
        return;
      case 'settings':
        await submitSettings(interaction, deps, siteFrom(deps, guildId, parts[3]));
        return;
      case 'rules':
        await submitRules(interaction, deps, siteFrom(deps, guildId, parts[3]));
        return;
      default:
        throw new UserError('This form is no longer valid.');
    }
  } catch (err) {
    await replyError(interaction, err, log, `panel form ${truncate(interaction.customId ?? '', 60)}`);
  }
}

async function submitAdd(i: ModalSubmitInteraction, deps: CommandDeps, guildId: string): Promise<void> {
  const url = (readText(i, 'url') ?? '').trim();
  if (!url) throw new UserError('Enter the website URL, e.g. `unpeg.io`.');
  const rawName = (readText(i, 'name') ?? '').trim();
  const rawInterval = (readText(i, 'interval') ?? '').trim();
  const intervalSec = rawInterval ? parseSeconds(rawInterval, 'The check interval', minInterval(deps.config), MAX_INTERVAL_SEC) : null;
  const channelId = readSelected(i, 'channel', 'channel')?.[0] ?? i.channelId;
  if (!channelId) throw new UserError('Pick a channel for the alerts.');
  const pingRoleId = readSelected(i, 'role', 'role')?.[0] ?? null;
  // Validate + insert synchronously (before any await) so a double submit can't create two watches.
  const prepared = prepareAdd(deps, { guildId, channelId, userId: i.user.id, url, name: rawName || null, intervalSec, pingRoleId });
  await defer(i, true, deps.log);
  await finishAdd(deps, prepared, (body) => respond(i, body, true, deps.log), i);
}

async function submitSettings(i: ModalSubmitInteraction, deps: CommandDeps, w: Watch): Promise<void> {
  const patch: WatchPatch = {};
  const changes: string[] = [];

  const rawName = readText(i, 'name');
  if (rawName !== null) {
    const name = cleanName(rawName) as string;
    if (name !== w.name) {
      if (nameTaken(deps, w.guildId, name, w.id)) throw new UserError(`A site named **${escapeMarkdown(name)}** already exists.`);
      patch.name = name;
      changes.push(`name → **${escapeMarkdown(name)}**`);
    }
  }
  const rawInterval = readText(i, 'interval');
  if (rawInterval !== null) {
    const v = parseSeconds(rawInterval, 'The check interval', minInterval(deps.config), MAX_INTERVAL_SEC);
    if (v !== w.intervalSec) {
      patch.intervalSec = v;
      changes.push(`interval ${w.intervalSec}s → ${v}s`);
    }
  }
  const rawSweep = readText(i, 'sweep');
  if (rawSweep !== null) {
    const v = parseSeconds(rawSweep, 'The full page sweep', SWEEP_MIN_SEC, SWEEP_MAX_SEC);
    if (v !== w.sweepSec) {
      patch.sweepSec = v;
      changes.push(`full sweep ${w.sweepSec}s → ${v}s`);
    }
  }
  const channel = readSelected(i, 'channel', 'channel')?.[0];
  if (channel && channel !== w.channelId) {
    patch.channelId = channel;
    changes.push(`channel → ${channelMention(channel)}`);
  }
  const roles = readSelected(i, 'role', 'role');
  if (roles !== null) {
    const role = roles[0] ?? null;
    if (role !== w.pingRoleId) {
      patch.pingRoleId = role;
      changes.push(`ping → ${roleMention(role, w.guildId)}`);
    }
  }

  if (!changes.length) {
    await show(i, cardView(deps, w, i, 'ℹ️ Nothing changed.'), deps);
    return;
  }
  const updated = deps.store.updateWatch(w.id, patch);
  notifyUpdated(deps, updated);
  deps.log.info('watch updated', { watchId: w.id, by: i.user.id, changes: Object.keys(patch) });
  const lines = [`⚙️ Saved — ${changes.join(' · ')}`];
  if (patch.channelId) {
    const perms = permsWarning(i, patch.channelId);
    if (perms) lines.push(perms);
  }
  await show(i, cardView(deps, updated, i, lines.join('\n')), deps);
}

async function submitRules(i: ModalSubmitInteraction, deps: CommandDeps, w: Watch): Promise<void> {
  const patch: WatchPatch = {};
  const changes: string[] = [];
  const warnings: string[] = [];

  const ignore = readList(i, 'ignore', w.ignorePatterns);
  if (ignore && !sameList(ignore, w.ignorePatterns)) {
    validateNewPatterns(ignore, w.ignorePatterns, 'ignore');
    patch.ignorePatterns = ignore;
    changes.push(plural(ignore.length, 'ignore pattern'));
  }
  const exclude = readList(i, 'exclude', w.excludePatterns);
  if (exclude && !sameList(exclude, w.excludePatterns)) {
    validateNewPatterns(exclude, w.excludePatterns, 'exclude');
    patch.excludePatterns = exclude;
    changes.push(plural(exclude.length, 'skipped URL pattern'));
    for (const p of exclude) {
      try {
        if (!w.excludePatterns.includes(p) && compileUrlPattern(p)?.test(w.url)) warnings.push(`⚠️ ${codeSpan(p, 100)} also matches the start URL.`);
      } catch {
        // validated above
      }
    }
  }
  const extraRaw = readList(i, 'extra', w.extraUrls);
  if (extraRaw) {
    const extra = resolveExtraPages(extraRaw, w);
    if (!sameList(extra, w.extraUrls)) {
      patch.extraUrls = extra;
      changes.push(plural(extra.length, 'extra page'));
    }
  }
  const rawScope = readText(i, 'scope');
  if (rawScope !== null) {
    const scope = parseScope(rawScope) ?? null;
    if (scope !== w.scopePath) {
      patch.scopePath = scope;
      changes.push(`scope ${scope ? codeSpan(scope, 100) : 'whole site'}`);
    }
  }
  const rawMax = readText(i, 'max_pages');
  if (rawMax !== null) {
    const s = rawMax.trim();
    const n = /^\d{1,7}$/.test(s) ? Number(s) : NaN;
    if (!(n >= 1 && n <= MAX_PAGES_LIMIT)) throw new UserError(`Max tracked pages must be a whole number between 1 and ${MAX_PAGES_LIMIT}.`);
    if (n !== w.maxPages) {
      patch.maxPages = n;
      changes.push(`max ${n} pages`);
    }
  }

  if (!changes.length) {
    await show(i, cardView(deps, w, i, 'ℹ️ Nothing changed.'), deps);
    return;
  }
  // Ignore patterns change the compared text: clear the noise heuristics so pages are re-judged under the new rules.
  if (patch.ignorePatterns) deps.store.resetPageNoise(w.id);
  const updated = deps.store.updateWatch(w.id, patch);
  notifyUpdated(deps, updated);
  deps.log.info('watch rules updated', { watchId: w.id, by: i.user.id, changes: Object.keys(patch) });
  const banner = [`🚫 Rules saved — ${changes.join(' · ')}. Affected pages are re-baselined silently.`, ...warnings].join('\n');
  await show(i, cardView(deps, updated, i, banner), deps);
}
