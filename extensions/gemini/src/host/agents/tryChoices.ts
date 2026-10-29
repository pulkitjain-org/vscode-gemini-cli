/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { configSection } from '../configuration';

/**
 * What the Try button does with the work of an agent on its own branch:
 * try it in the user's checkout, merge the branch with a commit, or open a
 * merge request from it. The button's chevron offers the three; the pick is
 * remembered per repository, so the button then does what the user last
 * chose there.
 */
export type TryChoice = 'try' | 'merge' | 'mr';

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
