/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Gemini from the terminal. Send to Gemini (a selection) and Send Last
// Command to Gemini attach what the terminal shows to a chat's composer, where
// it waits to be sent: an agent's own terminal sends to that agent, any other
// to the chat in front. A failed command offers Ask Gemini as a quick fix. ⌘I
// in a terminal turns words into a command, which is shown before it runs and
// asks like Run does when it is risky.

import * as os from 'node:os';
import * as vscode from 'vscode';
import type { Attachment } from '../acp/attachments';
import { runRisk } from '../acp/riskyCommand';
import { commandAttachment, commandFromReply, selectionReport } from '../acp/runCommands';
import type { AgentTerminals } from './agentTerminals';
import { confirmText } from './chat/chatRun';
import { configSection } from './configuration';

/** What these commands need of the rest of the extension. */
export interface TerminalGeminiHost {
	readonly terminals: AgentTerminals;
	/** Adds attachments to agent `id`'s composer, opening its tab. */
	attachTo(id: string, attachments: readonly Attachment[]): Promise<void>;
	/** Adds attachments to the chat in front, else the most recent, else a new agent's. */
	attachToFront(attachments: readonly Attachment[]): Promise<void>;
	/** One quick request to the model, as inline edit makes; undefined when those are off or failed. */
	direct(request: { readonly system: string; readonly prompt: string }): Promise<string | undefined>;
}

const suggestSystem = 'You turn a request into one shell command. Answer with the command only, in one fenced code block, with no explanation. Prefer a single line; use common tools that exist on the user\'s platform. Never add sudo unless the request needs it.';

export class TerminalGemini implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[];

	constructor(private readonly host: TerminalGeminiHost) {
		this.disposables = [
			vscode.commands.registerCommand('gemini.terminal.sendSelection', () => this.sendSelection()),
			vscode.commands.registerCommand('gemini.terminal.sendLastCommand', () => this.sendLastCommand()),
			// The failed command's ✨ quick fix; the workbench runs it without arguments, on the terminal in front.
			vscode.commands.registerCommand('gemini.terminal.askAboutFailure', () => this.sendLastCommand()),
			vscode.commands.registerCommand('gemini.terminal.suggestCommand', () => this.suggestCommand()),
			vscode.window.registerTerminalQuickFixProvider('gemini.askAboutFailure', {
				provideTerminalQuickFixes: () => ({ command: 'gemini.terminal.askAboutFailure', title: vscode.l10n.t("Ask Gemini About This Failure") }),
			}),
		];
	}

	private async send(terminal: vscode.Terminal, attachments: readonly Attachment[]): Promise<void> {
		const agent = this.host.terminals.agentOf(terminal);
		await (agent ? this.host.attachTo(agent, attachments) : this.host.attachToFront(attachments));
	}

	private async sendSelection(): Promise<void> {
		const terminal = vscode.window.activeTerminal;
		const selection = terminal?.selection;
		if (!terminal || !selection?.trim()) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Select text in a terminal first."));
			return;
		}
		await this.send(terminal, [{ kind: 'document', name: vscode.l10n.t("Terminal selection"), mimeType: 'text/plain', text: selectionReport(selection) }]);
	}

	/** The last command of the active terminal. */
	private async sendLastCommand(): Promise<void> {
		const terminal = vscode.window.activeTerminal;
		const last = terminal && this.host.terminals.lastCommand(terminal);
		if (!terminal || !last) {
			void vscode.window.showInformationMessage(terminal?.shellIntegration
				? vscode.l10n.t("No command has finished in this terminal since GeminiCode started watching it. Run the command again, then send it.")
				: vscode.l10n.t("This terminal doesn't report its commands: its shell has no shell integration. Select the output and use Send to Gemini instead."));
			return;
		}
		await this.send(terminal, [commandAttachment(last)]);
	}

	/** ⌘I in a terminal: words to a command, shown before anything runs. */
	private async suggestCommand(): Promise<void> {
		const terminal = vscode.window.activeTerminal;
		if (!terminal) {
			return;
		}
		const request = await vscode.window.showInputBox({
			title: vscode.l10n.t("Ask Gemini for a Command"),
			placeHolder: vscode.l10n.t("Describe what to do, for example \"find the 10 largest files here\""),
			ignoreFocusOut: true,
		});
		if (!request?.trim()) {
			terminal.show();
			return;
		}
		const cwd = terminal.shellIntegration?.cwd?.fsPath ?? cwdOf(terminal) ?? os.homedir();
		const shell = vscode.env.shell.split(/[\\/]/).pop() || 'sh';
		const reply = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Asking Gemini for a command") }, () =>
			this.host.direct({ system: suggestSystem, prompt: `Platform: ${process.platform}. Shell: ${shell}. Folder: ${cwd}.\nRequest: ${request.trim()}` }));
		const command = reply && commandFromReply(reply);
		if (!command) {
			const open = vscode.l10n.t("Open Setting");
			const answer = await vscode.window.showWarningMessage(reply === undefined && !vscode.workspace.getConfiguration(configSection).get<boolean>('inlineEdit.enabled', true)
				? vscode.l10n.t("Ask Gemini for a Command uses the same quick requests as inline edit, which is turned off.")
				: vscode.l10n.t("Gemini didn't suggest a command. Try describing it another way."), ...reply === undefined ? [open] : []);
			if (answer === open) {
				void vscode.commands.executeCommand('workbench.action.openSettings', `${configSection}.inlineEdit.enabled`);
			}
			terminal.show();
			return;
		}
		const risk = runRisk(command, cwd, os.homedir());
		const run: vscode.QuickPickItem = { label: `$(play) ${risk ? vscode.l10n.t("Run Anyway") : vscode.l10n.t("Run")}` };
		const insert: vscode.QuickPickItem = { label: `$(insert) ${vscode.l10n.t("Insert Without Running")}` };
		const picked = await vscode.window.showQuickPick(risk ? [insert, run] : [run, insert], {
			title: command,
			placeHolder: risk ? confirmText(risk, { name: '', folder: cwd }, false) : vscode.l10n.t("Gemini suggests this command. Run it, or insert it to edit first."),
			ignoreFocusOut: true,
		});
		terminal.show();
		if (picked) {
			terminal.sendText(command, picked === run);
		}
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

function cwdOf(terminal: vscode.Terminal): string | undefined {
	// An extension's own terminal (ExtensionTerminalOptions) has no cwd, so this reads as undefined.
	const cwd = (terminal.creationOptions as vscode.TerminalOptions).cwd;
	return typeof cwd === 'string' ? cwd : cwd?.fsPath;
}
