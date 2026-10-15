/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GEMINI-FORK: in Agents mode the group holding the agents has no tab row,
// since its tabs are drawn in the title bar, while every other group keeps
// VS Code's normal one, so a file an agent opens has its name and ×. The
// policy lives in contrib/gemini (geminiModes.ts), which the editor part can't
// import; it is handed over here.

import { Emitter, Event } from '../../../../base/common/event.js';
import { IReadonlyEditorGroupModel } from '../../../common/editor/editorGroupModel.js';

let hidesTabRow: ((model: IReadonlyEditorGroupModel) => boolean) | undefined;
const onDidChange = new Emitter<void>();

/** Fires when the policy changes, so each group checks its tab row again. */
export const onDidChangeGeminiTabRows: Event<void> = onDidChange.event;

/** Whether `model`'s group draws no tab row whatever `workbench.editor.showTabs` says. */
export function geminiHidesTabRow(model: IReadonlyEditorGroupModel): boolean {
	return hidesTabRow?.(model) ?? false;
}

export function setGeminiTabRowPolicy(policy: ((model: IReadonlyEditorGroupModel) => boolean) | undefined): void {
	hidesTabRow = policy;
	onDidChange.fire();
}

/** Asks each group to check its tab row again, after agents opened in or left a group. */
export function refreshGeminiTabRows(): void {
	onDidChange.fire();
}
