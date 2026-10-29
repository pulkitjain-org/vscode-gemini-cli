/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { configSection } from './configuration';

/** `gemini.agents.branchDefaults`: what every agent started on a branch gets unless something closer says otherwise. */
export interface BranchDefaults {
	/** The branch name's prefix, `gemini/` unless set. */
	readonly prefix: string;
	readonly model?: string;
	readonly planFirst: boolean;
}

export const defaultBranchPrefix = 'gemini/';

/** The defaults for a branch in `folder`'s workspace (the setting is per window; a folder picks its workspace's). */
export function branchDefaults(folder?: string): BranchDefaults {
	const scope = folder ? vscode.Uri.file(folder) : undefined;
	const value = vscode.workspace.getConfiguration(configSection, scope).get<{ readonly prefix?: unknown; readonly model?: unknown; readonly planFirst?: unknown }>('agents.branchDefaults') ?? {};
	const prefix = typeof value.prefix === 'string' && value.prefix.trim() ? value.prefix.trim() : defaultBranchPrefix;
	return {
		prefix: prefix.endsWith('/') || prefix.endsWith('-') ? prefix : `${prefix}/`,
		...typeof value.model === 'string' && value.model.trim() ? { model: value.model.trim() } : {},
		planFirst: value.planFirst === true,
	};
}
