/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Gemini CLI's own slash commands that ACP does not carry, offered under
// the same names so a terminal user finds them: /rewind, /plan and
// /permissions. Their handlers are the chat's (chatController.ts); /resume,
// /chat, /compress, /context and /stats sit with the features they open.

import * as vscode from 'vscode';
import type { SlashCommand } from '../../acp/slashCommands';

/** /rewind: the picker Esc Esc opens. */
export function rewindCommand(): SlashCommand {
	return { name: 'rewind', description: vscode.l10n.t("Go back to before one of your messages: the conversation, the code, or both"), source: 'app' };
}

/** /plan [goal], /plan copy. */
export function planCommand(): SlashCommand {
	return { name: 'plan', description: vscode.l10n.t("Switch to Plan mode, with a goal to plan; /plan copy copies the latest plan"), source: 'app' };
}

/** /permissions trust: the folder trust dialog. */
export function permissionsCommand(): SlashCommand {
	return { name: 'permissions', description: vscode.l10n.t("Trust this folder for the CLI (/permissions trust)"), source: 'app' };
}
