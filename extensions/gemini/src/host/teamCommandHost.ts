/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a team command's @{file} and !{command} may do in this window: read a
// file the agent's own file rules allow, and run a command only when shell
// access is on and the user says yes.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { checkFileAccess } from '../acp/fileAccess';
import { ExpansionHost, runShellCommand } from '../acp/teamCommandExpansion';
import { getApprovalPolicy } from './configuration';
import { tildify } from './displayText';
import { getFileAccessPolicy } from './workspaceFileSystem';

/** A file pulled in with @{...} is context, not a codebase: larger ones are refused. */
const maxFileBytes = 256 * 1024;

export function teamCommandHost(name: string, cwd: string): ExpansionHost {
	return {
		platform: process.platform,
		readFile: async pathText => {
			const policy = getFileAccessPolicy();
			const roots = [cwd, ...policy.roots];
			const candidates = path.isAbsolute(pathText) ? [pathText] : roots.map(root => path.resolve(root, pathText));
			let found: string | undefined;
			for (const candidate of candidates) {
				if (await fs.access(candidate).then(() => true, () => false)) {
					found = candidate;
					break;
				}
			}
			if (!found) {
				throw new Error(vscode.l10n.t("not found in the workspace"));
			}
			const refused = await checkFileAccess(found, 'read', { ...policy, roots });
			if (refused) {
				throw new Error(refused);
			}
			const stat = await fs.stat(found);
			if (stat.isDirectory()) {
				throw new Error(vscode.l10n.t("is a folder; name a file instead"));
			}
			if (stat.size > maxFileBytes) {
				throw new Error(vscode.l10n.t("is larger than {0} KB", maxFileBytes / 1024));
			}
			return fs.readFile(found, 'utf8');
		},
		confirm: async commands => {
			if (!getApprovalPolicy().allowShell) {
				throw new Error(vscode.l10n.t("/{0} runs shell commands, and shell access is turned off (gemini.tools.allowShell).", name));
			}
			const run = vscode.l10n.t("Run");
			const choice = await vscode.window.showWarningMessage(
				vscode.l10n.t("/{0} runs {1} before it sends its prompt", name, commands.length === 1 ? vscode.l10n.t("a command") : vscode.l10n.t("{0} commands", commands.length)),
				{ modal: true, detail: `${commands.join('\n')}\n\n${vscode.l10n.t("They run in {0} with your permissions, and their output goes to Gemini.", tildify(cwd))}` },
				run);
			return choice === run;
		},
		runShell: command => runShellCommand(command, cwd, process.env),
	};
}
