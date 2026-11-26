/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { configSection } from '../configuration';
import type { TryChoice } from '../panelProtocol';
import type { TryChoiceStrings } from '../panelStrings';

/**
 * What the Try button does with the work of an agent on its own branch:
 * try it in the user's checkout, merge the branch with a commit, or open a
 * merge request from it. The button's chevron offers the three in a menu of
 * the page's own (webview-src/tryChoiceMenu.ts); the pick is remembered per
 * repository, so the button then does what the user last chose there.
 */
export type { TryChoice };

const choicesKey = 'gemini.tries.choices';

export class TryChoices {

	constructor(private readonly state: vscode.Memento) { }

	/** The choice remembered for `repository`; until one is, Merge Back where the removed `gemini.agents.mergeBack` still says "commit", else Try. */
	get(repository: string): TryChoice {
		const remembered = this.state.get<Record<string, TryChoice>>(choicesKey)?.[repository];
		if (remembered) {
			return remembered;
		}
		return vscode.workspace.getConfiguration(configSection).get<string>('agents.mergeBack') === 'commit' ? 'merge' : 'try';
	}

	async set(repository: string, choice: TryChoice): Promise<void> {
		const all = { ...this.state.get<Record<string, TryChoice>>(choicesKey) };
		all[repository] = choice;
		await this.state.update(choicesKey, all);
	}
}

/** Whether a page's message names a choice. */
export function isTryChoice(value: unknown): value is TryChoice {
	return value === 'try' || value === 'merge' || value === 'mr';
}

/** The chevron menu's words, for each page that shows it. */
export function tryChoiceStrings(): TryChoiceStrings {
	return {
		title: vscode.l10n.t("How to take the agent's work"),
		tryIn: vscode.l10n.t("Try in Workspace"),
		tryInDetail: vscode.l10n.t("Copy the changes into your workspace as unstaged files, following the agent's later turns, until you keep them or take them back."),
		mergeBack: vscode.l10n.t("Merge Back"),
		mergeBackDetail: vscode.l10n.t("Commit the work on its branch and merge the branch into yours."),
		openMr: vscode.l10n.t("Open Merge Request..."),
		openMrDetail: vscode.l10n.t("Push the branch and open a merge request with a title and description Gemini drafts."),
	};
}
