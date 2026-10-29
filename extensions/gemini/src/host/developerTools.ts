/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Whether `gemini.developer.showTools` is on: the benchmark, the trace
 * recorder, the status menu's Audit, Trace and Benchmark entries, Check Agent
 * Connection, Sync Design System, Agent Setup's Measure buttons and Home's
 * startup card show only then. The palette entries read the same setting
 * through their `when` clauses.
 */
export function developerToolsOn(): boolean {
	return vscode.workspace.getConfiguration('gemini').get<boolean>('developer.showTools', false);
}
