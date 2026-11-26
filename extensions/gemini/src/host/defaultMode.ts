/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The mode a new agent starts in, as GeminiCode's own setting names it. Kept
// apart from the agents view so the pages' bundle (Agent Setup shows it) takes
// no copy of that view's state.

import * as vscode from 'vscode';
import { configSection } from './configuration';

/** `gemini.agents.defaultMode` as the user set it; undefined when nobody did, so the CLI's own default applies. */
export function configuredDefaultMode(): string | undefined {
	const info = vscode.workspace.getConfiguration(configSection).inspect<string>('agents.defaultMode');
	const value = info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue;
	return typeof value === 'string' ? value : undefined;
}
