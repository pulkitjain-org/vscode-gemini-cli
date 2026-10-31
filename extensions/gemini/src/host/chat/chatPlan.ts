/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Plan mode, from the chat's side: the plan a Plan mode turn writes, its
// Review Plan chip, Approve Plan (which leaves Plan mode and asks the agent to
// carry the plan out), the CLI's /plan command, and a plan file written again
// when the CLI deleted it.

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChatTranscript, TranscriptItem } from '../../acp/chatTranscript';
import { buildModeAfterPlan, planBuildChoice, planBuildModels } from '../../acp/chatTurns';
import { projectTempDirName } from '../../acp/cli/formats';
import { cliHome, readSessionMessages } from '../../acp/cliSessions';
import { sessionFolder } from '../../acp/sessionFolder';
import { knownModes } from '../../acp/sessionSettings';
import type { ModelTokens } from '../../acp/turnUsage';
import { extensionChunk } from '../lazyFeature';
import { isFile } from './chatFiles';
import type { ChatControllerOptions, ChatHost } from './chatOptions';
import type { ChatSettings } from './chatSettings';

/** What a turn end's Approve Plan offers. */
export type TurnEndBuild = NonNullable<Extract<TranscriptItem, { readonly kind: 'turnEnd' }>['build']>;

/** What Plan mode needs of its chat. */
export interface PlanHost {
	isBusy(): boolean;
	/** The turnEnd item that offers Retry, and with it Approve Plan. */
	retryItemId(): string | undefined;
	/** Sends `text` as if typed in the view. */
	send(text: string): Promise<void>;
	/** Starts `text`'s turn, the chat being idle. */
	startPrompt(text: string): Promise<void>;
}

export class ChatPlan {

	/** The Markdown file the running Plan mode turn wrote last: its plan. */
	private turnPlanFile: string | undefined;

	constructor(
		private readonly service: Pick<ChatHost, 'client'>,
		private readonly transcript: ChatTranscript,
		private readonly settings: ChatSettings,
		private readonly options: Pick<ChatControllerOptions, 'reviewPlan' | 'planReviewFolder'>,
		private readonly host: PlanHost,
	) { }

	/** A tool call completed with `diffs`: in Plan mode, the last Markdown file among them is the turn's plan, for its Review Plan. */
	noteEdits(diffs: readonly { readonly path: string }[]): void {
		const plan = this.service.client.settings.mode?.currentId === 'plan' ? diffs.map(diff => diff.path).findLast(file => /\.(md|markdown)$/i.test(file)) : undefined;
		if (plan) {
			this.turnPlanFile = plan;
		}
	}

	/** The plan the ending turn wrote, if any; the next turn starts without one. */
	takeTurnPlanFile(): string | undefined {
		const file = this.turnPlanFile;
		this.turnPlanFile = undefined;
		return file;
	}

	/**
	 * The CLI's /plan: with a goal, switches to Plan mode and sends it; with
	 * `copy`, copies the latest plan to the clipboard; alone, switches to Plan
	 * mode.
	 */
	async planCommand(rest: string): Promise<void> {
		if (rest === 'copy') {
			const item = [...this.transcript.items].reverse().find(each => each.kind === 'turnEnd' && each.planFile);
			const file = item?.kind === 'turnEnd' ? item.planFile : undefined;
			const text = file ? await vscode.workspace.fs.readFile(vscode.Uri.file(file)).then(bytes => new TextDecoder().decode(bytes), () => undefined) : undefined;
			if (!text) {
				this.transcript.addNotice(vscode.l10n.t("There is no plan to copy yet: ask for one in Plan mode first."), 'info');
				return;
			}
			await vscode.env.clipboard.writeText(text);
			this.transcript.addNotice(vscode.l10n.t("The plan was copied to the clipboard."), 'info');
			return;
		}
		const mode = this.service.client.settings.mode;
		if (!mode?.available.some(choice => choice.id === knownModes.plan)) {
			this.transcript.addNotice(vscode.l10n.t("Plan mode is not available here: the CLI does not offer it, or policy turns it off."), 'error');
			return;
		}
		if (mode.currentId !== knownModes.plan) {
			await this.settings.change(() => this.service.client.setMode(knownModes.plan));
		}
		if (rest) {
			await this.host.startPrompt(rest);
		}
	}

	/** Switches a session in Plan mode to Default, as a project's coordinator needs before each wake. */
	async leavePlanMode(): Promise<void> {
		const mode = buildModeAfterPlan(this.service.client.settings);
		if (mode) {
			await this.settings.change(() => this.service.client.setMode(mode));
		}
	}

	/** Leaves Plan mode and carries out the plan, as the latest turn's Build button does; false when it offers none. */
	async approvePlan(): Promise<boolean> {
		const retryItemId = this.host.retryItemId();
		if (!retryItemId || !this.build()) {
			return false;
		}
		await this.buildPlan(retryItemId);
		return true;
	}

	/**
	 * How Approve Plan builds, while the chat is in Plan mode: in the mode
	 * the chat was in before Plan, with the other choice on its chevron, and the
	 * models when the build's differs from the plan's (`planUsage`, the plan
	 * turn's token counts).
	 */
	build(planUsage?: readonly ModelTokens[]): TurnEndBuild | undefined {
		const settings = this.service.client.settings;
		const choice = planBuildChoice(settings, this.settings.modeBeforePlan);
		if (!choice) {
			return undefined;
		}
		const models = planBuildModels(planUsage, settings.model?.currentId);
		return { ...choice, ...models ? { models } : {} };
	}

	/** The latest turn's Approve Plan, again: the model or the modes changed since the turn ended. */
	refreshBuild(): void {
		const item = this.transcript.items.find(each => each.id === this.host.retryItemId());
		if (item?.kind !== 'turnEnd' || !item.buildPlan) {
			return;
		}
		const build = this.build(item.usage);
		if (JSON.stringify(build) !== JSON.stringify(item.build)) {
			this.transcript.updateTurnEnd(item.id, build ? { buildPlan: true, build } : { buildPlan: undefined, build: undefined });
		}
	}

	/** Leaves Plan mode and asks the agent to carry out the plan it just wrote: in `picked` (the chevron's other choice), else the mode before Plan. */
	async buildPlan(itemId: string, picked?: string, text = vscode.l10n.t("Carry out the plan above.")): Promise<boolean> {
		const choice = this.build();
		const mode = picked && (picked === choice?.mode || picked === choice?.other) ? picked : choice?.mode;
		if (this.host.isBusy() || itemId !== this.host.retryItemId() || !mode) {
			return false;
		}
		const item = this.transcript.items.find(each => each.id === itemId);
		if (item?.kind === 'turnEnd' && item.planFile) {
			// The agent reads its plan to carry it out.
			await this.rebuildPlan(item.planFile);
		}
		await this.settings.change(() => this.service.client.setMode(mode));
		if (this.service.client.settings.mode?.currentId === mode) {
			await this.host.send(text);
			return true;
		}
		return false;
	}

	/** Whether the latest turn ended in Plan mode and offers Approve Plan, for Plan Review. */
	get canBuildPlan(): boolean {
		const retryItemId = this.host.retryItemId();
		const item = retryItemId ? this.transcript.items.find(each => each.id === retryItemId) : undefined;
		return !this.host.isBusy() && item?.kind === 'turnEnd' && !!item.buildPlan;
	}

	/** Approve Plan on the latest turn, from Plan Review, telling the agent `text`; resolves whether it started. */
	buildLatestPlan(text: string): Promise<boolean> {
		const retryItemId = this.host.retryItemId();
		return this.canBuildPlan && retryItemId ? this.buildPlan(retryItemId, undefined, text) : Promise.resolve(false);
	}

	/**
	 * Writes plan `file` again when the CLI deleted it, as it did on reopening
	 * a session before GeminiCode kept sessions' plans (src/acp/sessionFolder.ts):
	 * from Plan Review's copy, else the session's saved calls (sessionReplay.ts).
	 */
	async rebuildPlan(file: string): Promise<void> {
		const home = cliHome();
		const cwd = this.service.client.cwd;
		if (file.startsWith(path.join(home, projectTempDirName) + path.sep) && !await isFile(file)) {
			const rebuilt = await extensionChunk<typeof import('../../onDemand')>('onDemand')().rebuildSessionFile(cwd, file, {
				home,
				folder: id => sessionFolder(cwd, id, home),
				messages: async id => (await readSessionMessages(cwd, id, home))?.messages,
				reviews: this.options.planReviewFolder,
			}).catch(() => undefined);
			if (rebuilt === 'history') {
				this.transcript.addNotice(vscode.l10n.t("The plan file was gone, so it was rebuilt from the session's history. It may differ a little from the one the agent wrote."), 'info');
			}
		}
	}

	/** Plan mode's plan, opened from its chip: in Plan Review when there is one; false otherwise. */
	reviewPlanFile(file: string): boolean {
		if (!this.options.reviewPlan || this.service.client.settings.mode?.currentId !== 'plan') {
			return false;
		}
		this.options.reviewPlan(file);
		return true;
	}
}
