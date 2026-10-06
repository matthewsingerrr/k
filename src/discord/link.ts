/**
 * `/link` command: issue / list / revoke API tokens that let the browser extension (or another bot) add sites to this
 * server's tracker over the Link API (src/link/api.ts, documented in INTEGRATION.md).
 *
 *   /link create label(req, ≤ 40) channel(optional, text/announcement; default = here)
 *       → store.createLinkToken; EPHEMERAL embed with the API base URL (or how to give the Railway service a public domain),
 *         the token in a code block (shown once — only its sha256 is stored), the alert channel and the extension setup steps.
 *         Max MAX_LINKS_PER_GUILD per server; labels are unique per server (case-insensitive). If Discord refuses that reply,
 *         the token is revoked at once so no credential exists that nobody has seen.
 *   /link list   → ephemeral: label · channel · created <t:…:R> · last used <t:…:R>|never.
 *   /link revoke label(req, autocomplete) → store.revokeLinkToken; ephemeral confirmation.
 * Every subcommand requires Manage Server (re-checked here; default_member_permissions only hides the command).
 * The token is never logged.
 *
 * Note: this module and commands.ts import each other. Only use commands.ts exports inside functions (never at module top
 * level) so either module can be loaded first.
 */
import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type APIEmbed,
  type APIEmbedField,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Config } from '../config.js';
import type { LinkToken } from '../db/store.js';
import { LINK_API_PREFIX } from '../link/types.js';
import {
  NO_MENTIONS,
  UserError,
  channelMention,
  errMessage,
  hasManageGuild,
  linesWithin,
  permsWarning,
  replyError,
  requireManageGuild,
  respond,
  when,
  type Body,
  type CommandDeps,
} from './commands.js';
import { clampEmbed, codeSpan, escapeMarkdown, truncate } from './format.js';

export const LINK_COMMAND_NAME = 'link';
/** Tokens per Discord server. */
export const MAX_LINKS_PER_GUILD = 10;
export const MAX_LINK_LABEL_CHARS = 40;

const LINK_COLOR = 0x5865f2;

/** `<PUBLIC_URL>/api/v1`, or null when the service has no public URL. Accepts a PUBLIC_URL without scheme ("bot.example.com"). */
export function linkApiBaseUrl(config: Pick<Config, 'publicUrl'>): string | null {
  const raw = typeof config?.publicUrl === 'string' ? config.publicUrl.trim() : '';
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}${LINK_API_PREFIX}`;
  } catch {
    return null;
  }
}

function isLocalHost(base: string): boolean {
  try {
    const h = new URL(base).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** What to tell an admin when the API URL is unknown. */
export const NO_PUBLIC_DOMAIN =
  '⚠️ This bot has **no public domain yet**, so the extension can’t reach it. In Railway: open the bot’s service → **Settings** → ' +
  '**Networking** → **Generate Domain**, then redeploy (or set `PUBLIC_URL`). The API URL is then `https://<that domain>/api/v1` — ' +
  '`/link list` shows it. The token below already works; you don’t need a new one.';

function apiUrlValue(config: Config): string {
  const base = linkApiBaseUrl(config);
  if (!base) return NO_PUBLIC_DOMAIN;
  let value = '```\n' + base + '\n```';
  if (base.startsWith('http://') && !isLocalHost(base)) {
    value += '⚠️ `PUBLIC_URL` is plain **http** — the token would travel unencrypted. Use the https:// address.';
  }
  return value;
}

/** Trimmed single-line label (1..MAX_LINK_LABEL_CHARS chars). */
export function cleanLinkLabel(raw: string | null | undefined): string {
  const label = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!label) throw new UserError('The label cannot be empty — use something like `Matt’s Chrome`.');
  if (label.length > MAX_LINK_LABEL_CHARS) throw new UserError(`The label is too long (max ${MAX_LINK_LABEL_CHARS} characters).`);
  return label;
}

function labelKey(label: string): string {
  return label.replace(/\s+/g, ' ').trim().toLowerCase();
}

function labelOf(t: Pick<LinkToken, 'label'>): string {
  return escapeMarkdown(truncate(t.label.replace(/[\r\n]+/g, ' '), 100));
}

/** A link of this guild by label (case-insensitive), or by id ("3" / "#3") when no label matches. */
function findLink(tokens: LinkToken[], raw: string): LinkToken | undefined {
  const key = labelKey(raw);
  const byLabel = tokens.find((t) => labelKey(t.label) === key);
  if (byLabel) return byLabel;
  const m = /^#?(\d{1,15})$/.exec(raw.trim());
  return m ? tokens.find((t) => t.id === Number(m[1])) : undefined;
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export function linkCommandDefinition(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName(LINK_COMMAND_NAME)
    .setDescription('Connect the browser extension (or another bot) to this server’s site tracker')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Create an API token for the extension or another bot (shown once)')
        .addStringOption((o) =>
          o.setName('label').setDescription('Name for this link, e.g. "Matt’s Chrome"').setRequired(true).setMaxLength(MAX_LINK_LABEL_CHARS),
        )
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Where sites added through this link post alerts (default: this channel)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show this server’s links and when they were last used'))
    .addSubcommand((s) =>
      s
        .setName('revoke')
        .setDescription('Revoke a link — its token stops working immediately')
        .addStringOption((o) => o.setName('label').setDescription('The link to revoke').setRequired(true).setAutocomplete(true).setMaxLength(100)),
    )
    .toJSON();
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

interface LinkCtx {
  i: ChatInputCommandInteraction;
  deps: CommandDeps;
  guildId: string;
}

/**
 * Like respond(), but always ephemeral and throws when Discord refuses the message (so a token nobody saw can be revoked).
 * A deferral that isn't known to be ephemeral is never edited (that would show the token to the whole channel): the
 * token goes out as an ephemeral follow-up instead.
 */
async function replyOrThrow(i: ChatInputCommandInteraction, body: Body): Promise<void> {
  const embeds = body.embeds?.map(clampEmbed);
  if (i.deferred && i.ephemeral !== true) {
    await i.followUp({ content: body.content, embeds, allowedMentions: NO_MENTIONS, flags: MessageFlags.Ephemeral });
  } else if (i.deferred) {
    await i.editReply({ content: body.content ?? '', embeds: embeds ?? [], components: [], allowedMentions: NO_MENTIONS });
  } else if (i.replied) {
    await i.followUp({ content: body.content, embeds, allowedMentions: NO_MENTIONS, flags: MessageFlags.Ephemeral });
  } else {
    await i.reply({ content: body.content, embeds, allowedMentions: NO_MENTIONS, flags: MessageFlags.Ephemeral });
  }
}

export function renderLinkCreated(config: Config, record: LinkToken, token: string, warning: string | null): APIEmbed {
  const fields: APIEmbedField[] = [
    { name: 'API URL', value: apiUrlValue(config) },
    {
      name: 'Token — shown only once',
      value:
        '```\n' +
        token +
        '\n```' +
        'Copy it now: only a hash is stored, so it can’t be shown again (lost it? `/link revoke` it and create a new one). ' +
        'Anyone with this token can add and remove sites here — never post it in a channel.',
    },
    { name: 'Alert channel', value: `${channelMention(record.channelId)}${warning ? `\n${warning}` : ''}` },
    {
      name: 'Set up the extension',
      value: [
        '**1.** Open the extension’s options → **Discord tracker**.',
        '**2.** Paste the API URL and the token, then press **Test connection**.',
        '**3.** On any site, open the Site Watcher panel → **🔎 Scan** or **➕ Add to Discord tracker**.',
      ].join('\n'),
    },
  ];
  if (!config.linkApi) {
    fields.push({
      name: '⚠️ The Link API is turned off',
      value: 'This bot runs with `LINK_API=false`, so `/api/v1` isn’t served. Remove that variable (or set it to `true`) and redeploy.',
    });
  }
  return {
    title: '🔗 Link created',
    color: LINK_COLOR,
    description: `**${labelOf(record)}** can now scan sites and add them to this server’s tracker. Sites it adds post their alerts in ${channelMention(record.channelId)}.`,
    fields,
    footer: { text: `Link #${record.id} · revoke anytime with /link revoke · other bots: see INTEGRATION.md` },
  };
}

async function linkCreate({ i, deps, guildId }: LinkCtx): Promise<void> {
  const { store, config, log } = deps;
  const label = cleanLinkLabel(i.options.getString('label', true));
  const channelId = i.options.getChannel('channel')?.id ?? i.channelId;
  // Checks and insert are synchronous (no await in between): a double-submitted command can't create two links.
  const existing = store.listLinkTokens(guildId);
  const dup = existing.find((t) => labelKey(t.label) === labelKey(label));
  if (dup) {
    throw new UserError(
      `A link named **${labelOf(dup)}** already exists. Pick another label, or revoke it first with \`/link revoke label:${truncate(dup.label, 40)}\`.`,
    );
  }
  if (existing.length >= MAX_LINKS_PER_GUILD) {
    throw new UserError(`This server already has ${MAX_LINKS_PER_GUILD} links (the limit). Revoke one you no longer use with \`/link revoke\` first.`);
  }
  const { token, record } = store.createLinkToken({ guildId, channelId, label, createdBy: i.user.id });
  log.info('link token created', { guildId, linkId: record.id, label, channelId, by: i.user.id });

  const embed = renderLinkCreated(config, record, token, permsWarning(i, channelId));
  try {
    await replyOrThrow(i, { embeds: [embed] });
  } catch (err) {
    // Nobody saw the token: don't leave a working credential (and a taken label) behind.
    try {
      store.revokeLinkToken(guildId, record.id);
    } catch (revokeErr) {
      log.error('could not revoke an undelivered link token', { linkId: record.id, err: errMessage(revokeErr) });
    }
    log.warn('could not show a new link token — revoked it', { guildId, linkId: record.id, err: errMessage(err) });
  }
}

export function renderLinkList(config: Config, tokens: LinkToken[]): APIEmbed {
  const base = linkApiBaseUrl(config);
  const head = base ? `API URL: ${codeSpan(base, 300)}` : NO_PUBLIC_DOMAIN.replace(' The token below already works; you don’t need a new one.', '');
  const off = config.linkApi ? '' : '\n⚠️ The Link API is turned off (`LINK_API=false`) — tokens can’t be used until it’s on.';
  const lines = tokens.map(
    (t) =>
      `**${labelOf(t)}** · ${channelMention(t.channelId)} · by ${/^\d{5,25}$/.test(t.createdBy) ? `<@${t.createdBy}>` : 'unknown'} · created ${when(t.createdAt)} · last used ${when(t.lastUsedAt)}`,
  );
  return {
    title: `🔗 Links (${tokens.length}/${MAX_LINKS_PER_GUILD})`,
    color: LINK_COLOR,
    description: `${head}${off}\n\n${linesWithin(lines, MAX_LINKS_PER_GUILD + 5, 3600)}`,
    footer: { text: 'Tokens are shown only once, at /link create · revoke with /link revoke' },
  };
}

async function linkList({ i, deps, guildId }: LinkCtx): Promise<void> {
  const tokens = deps.store.listLinkTokens(guildId);
  if (!tokens.length) {
    await respond(
      i,
      {
        content:
          'No links yet. Create one with `/link create label:My Chrome`, then paste the API URL and token into the extension’s options → **Discord tracker**.',
      },
      true,
      deps.log,
    );
    return;
  }
  await respond(i, { embeds: [renderLinkList(deps.config, tokens)] }, true, deps.log);
}

async function linkRevoke({ i, deps, guildId }: LinkCtx): Promise<void> {
  const raw = i.options.getString('label', true);
  const t = findLink(deps.store.listLinkTokens(guildId), raw);
  if (!t) throw new UserError(`No link named ${codeSpan(raw, 60)} in this server. See \`/link list\`.`);
  deps.store.revokeLinkToken(guildId, t.id);
  deps.log.info('link token revoked', { guildId, linkId: t.id, label: t.label, by: i.user.id });
  await respond(
    i,
    {
      content:
        `🗑️ Revoked **${labelOf(t)}** — its token stops working immediately (the extension will ask to re-link). ` +
        'Sites it added stay watched; remove them with `/watch remove` or on the dashboard.',
    },
    true,
    deps.log,
  );
}

const SUBCOMMANDS: Record<string, (ctx: LinkCtx) => Promise<void>> = {
  create: linkCreate,
  list: linkList,
  revoke: linkRevoke,
};

export async function handleLinkCommand(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
  let sub = '';
  try {
    sub = interaction.options.getSubcommand(false) ?? '';
    if (!interaction.inGuild() || !interaction.guildId) {
      await respond(interaction, { content: 'This command only works inside a server.' }, true, deps.log);
      return;
    }
    requireManageGuild(interaction);
    const handler = SUBCOMMANDS[sub];
    if (!handler) throw new UserError(`Unknown subcommand \`${truncate(sub, 32) || '?'}\` — use \`/link create\`, \`/link list\` or \`/link revoke\`.`);
    await handler({ i: interaction, deps, guildId: interaction.guildId });
  } catch (err) {
    await replyError(interaction, err, deps.log, `/${LINK_COMMAND_NAME} ${sub}`.trim());
  }
}

/** Autocomplete for `/link revoke label`: this server's links (Manage Server only), value = label. */
export async function handleLinkAutocomplete(interaction: AutocompleteInteraction, deps: CommandDeps): Promise<void> {
  try {
    if (!interaction.inGuild() || !interaction.guildId || !hasManageGuild(interaction)) {
      await interaction.respond([]);
      return;
    }
    const q = labelKey(String(interaction.options.getFocused() ?? '')).replace(/^#/, '');
    const day = (ms: number | null) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null);
    const choices = deps.store
      .listLinkTokens(interaction.guildId)
      .filter((t) => !q || labelKey(t.label).includes(q) || String(t.id) === q)
      .slice(0, 25)
      .map((t) => {
        const used = day(t.lastUsedAt);
        const name = `${t.label.replace(/[\r\n]+/g, ' ')} · created ${day(t.createdAt) ?? '?'} · ${used ? `last used ${used}` : 'never used'}`;
        return { name: truncate(name, 100), value: t.label.length <= 100 ? t.label : `#${t.id}` };
      });
    await interaction.respond(choices);
  } catch (err) {
    deps.log.warn('link autocomplete failed', { err: errMessage(err) });
    try {
      if (!interaction.responded) await interaction.respond([]);
    } catch {
      // expired
    }
  }
}
