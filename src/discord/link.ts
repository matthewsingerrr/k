/**
 * `/link` command: issue / list / revoke API tokens that let the browser extension (or another bot) add sites to this
 * server's tracker. STUB — to be implemented. Keep the exported API exactly as declared.
 */
import type { ChatInputCommandInteraction, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import type { CommandDeps } from './commands.js';

export const LINK_COMMAND_NAME = 'link';

export function linkCommandDefinition(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  throw new Error('not implemented');
}

export async function handleLinkCommand(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
  throw new Error('not implemented');
}
