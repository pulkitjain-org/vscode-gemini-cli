/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** A folder as people read it, with the home folder as ~. */
export function tildify(folder: string): string {
	const home = os.homedir();
	return folder === home || folder.startsWith(home + path.sep) ? `~${folder.slice(home.length)}` : folder;
}

/** "now", "5m", "3h", "2d", "6w": short, like the screenshot's session list. */
export function relativeTime(then: number, now: number): string {
	const minutes = Math.floor(Math.max(0, now - then) / 60_000);
	if (minutes < 1) {
		return vscode.l10n.t("now");
	}
	if (minutes < 60) {
		return vscode.l10n.t("{0}m", minutes);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return vscode.l10n.t("{0}h", hours);
	}
	const days = Math.floor(hours / 24);
	return days < 7 ? vscode.l10n.t("{0}d", days) : vscode.l10n.t("{0}w", Math.floor(days / 7));
}
