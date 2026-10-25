/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run on a reply's shell blocks: where the command runs, whether it asks
// first, and how it ended. The chat page sends the block as it is; the
// commands in it, the risk check and the folder are worked out here, so the
// page stays small. A block's state is posted back by its text.

import * as os from 'node:os';
import * as vscode from 'vscode';
import type { Attachment } from '../../acp/attachments';
import { RunRisk, runRisk } from '../../acp/riskyCommand';
import { blockCommands, commandAttachment, FinishedCommand, placeFor, RunPlace } from '../../acp/runCommands';
import type { FromWebview, RunMode, RunState, ToWebview } from '../chatProtocol';
import { configSection } from '../configuration';
import { tildify } from '../displayText';
import type { ChatControllerOptions } from './chatOptions';

const runSetting = 'chat.runCommands';

/** The most finished commands kept for Send Output to Gemini. */
const keptOutputs = 20;

export class ChatRun implements vscode.Disposable {
	/** Each block's last finished command, by the block's text. */
	private readonly outputs = new Map<string, FinishedCommand>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly options: ChatControllerOptions,
		private readonly isAttached: () => boolean,
		private readonly post: (message: ToWebview) => void,
		private readonly attach: (attachments: readonly Attachment[]) => void,
	) {
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration(`${configSection}.${runSetting}`) && this.postView()));
	}

	private get mode(): RunMode {
		const mode = vscode.workspace.getConfiguration(configSection).get<RunMode>(runSetting, 'askWhenRisky');
		return this.options.terminal && (mode === 'alwaysAsk' || mode === 'off') ? mode : this.options.terminal ? 'askWhenRisky' : 'off';
	}

	/** Tells the page whether shell blocks get Run, and where it can run. */
	postView(): void {
		if (this.isAttached()) {
			this.post({ type: 'run', run: { mode: this.mode, places: this.options.terminal?.places().map(place => place.name) ?? [] } });
		}
	}

	onMessage(message: Extract<FromWebview, { type: 'runCommand' | 'sendRunOutput' }>): void {
		if (message.type === 'sendRunOutput') {
			const finished = this.outputs.get(message.text);
			if (finished) {
				this.attach([commandAttachment(finished)]);
			}
			return;
		}
		void this.run(message);
	}

	private async run(message: Extract<FromWebview, { type: 'runCommand' }>): Promise<void> {
		const terminal = this.options.terminal;
		const command = blockCommands(message.language, message.text);
		const state = (value: RunState) => this.post({ type: 'runState', text: message.text, state: value });
		if (!terminal || this.mode === 'off' || !command) {
			state({ kind: 'idle' });
			return;
		}
		const places = terminal.places();
		const place = message.place !== undefined ? places.find(each => each.name === message.place) : placeFor(command, places);
		if (!place) {
			state({ kind: 'pick', action: message.action });
			return;
		}
		if (message.action === 'insert') {
			// Nothing runs until the user presses Return in the terminal; the block keeps its last result.
			terminal.insert(place, command);
			return;
		}
		if (!message.confirmed) {
			const risk = runRisk(command, place.folder, os.homedir());
			if (risk || terminal.alwaysAsk || this.mode === 'alwaysAsk') {
				state({ kind: 'confirm', text: confirmText(risk, place, places.length > 1), ...message.place !== undefined ? { place: message.place } : {} });
				return;
			}
		}
		state({ kind: 'running' });
		const outcome = await terminal.run(place, command, message.action === 'newTerminal').catch(() => undefined);
		if (outcome?.command) {
			this.outputs.delete(message.text);
			this.outputs.set(message.text, outcome.command);
			if (this.outputs.size > keptOutputs) {
				this.outputs.delete(this.outputs.keys().next().value!);
			}
		}
		state(outcome?.exitCode !== undefined || outcome?.ms !== undefined ? { kind: 'done', exitCode: outcome.exitCode, ms: outcome.ms } : { kind: 'idle' });
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

/** What a block (or ⌘I's suggestion) asks before it runs: what the command does, and where. */
export function confirmText(risk: RunRisk | undefined, place: RunPlace, several: boolean): string {
	const where = several ? vscode.l10n.t("{0} ({1})", place.name, tildify(place.folder)) : tildify(place.folder);
	switch (risk?.kind) {
		case 'deletes':
			return vscode.l10n.t("This deletes files or branches in {0}. Run it?", where);
		case 'cleans':
			return risk.ignored ? vscode.l10n.t("This deletes untracked and ignored files in {0}. Run it?", where) : vscode.l10n.t("This deletes untracked files in {0}. Run it?", where);
		case 'discards':
			return vscode.l10n.t("This throws away uncommitted changes in {0}. Run it?", where);
		case 'forcePush':
			return vscode.l10n.t("This force-pushes from {0}, which can overwrite or delete work on the remote. Run it?", where);
		case 'root':
			return vscode.l10n.t("This runs as an administrator (root), in {0}. Run it?", where);
		case 'runsDownload':
			return vscode.l10n.t("This downloads a script and runs it, in {0}. Run it?", where);
		case 'disk':
			return vscode.l10n.t("This writes to a disk directly, from {0}. Run it?", where);
		case 'outside':
			return vscode.l10n.t("This writes {0}, outside {1}. Run it?", risk.path, where);
		case 'several':
			return vscode.l10n.t("This runs {0} commands in {1}, one after another. Run them?", risk.count, where);
		case 'unreadable':
			return vscode.l10n.t("A quote in this command is never closed, so what it runs can't be read. Run it in {0}?", where);
		default:
			return vscode.l10n.t("Run this in {0}?", where);
	}
}
