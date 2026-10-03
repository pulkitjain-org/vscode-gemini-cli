/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tells the user when a newer GeminiCode is out. Off the startup path: the
// first look is a minute after activation, then at most once a day across all
// windows, and it is one small request to the download page. The notice only
// links to the page; GeminiCode downloads and installs nothing itself.

import * as vscode from 'vscode';
import { appUpdateToOffer, latestReleaseUrl, shouldCheckForAppUpdate } from '../acp/appUpdates';
import { errorMessage } from '../acp/errors';
import { configSection, productInfo } from './configuration';

const lastCheckKey = 'gemini.app.lastUpdateCheck';
const firstCheckDelay = 60 * 1000;
/** How often a long-running window looks again whether a day has passed; the check itself is a timestamp comparison. */
const checkPoll = 60 * 60 * 1000;
const fetchTimeout = 15 * 1000;

export class AppUpdateNotice implements vscode.Disposable {

	private readonly firstCheck: ReturnType<typeof setTimeout>;
	private readonly poll: ReturnType<typeof setInterval>;

	constructor(private readonly globalState: vscode.Memento, private readonly log: vscode.LogOutputChannel) {
		this.firstCheck = setTimeout(() => void this.check(), firstCheckDelay);
		this.poll = setInterval(() => void this.check(), checkPoll);
	}

	dispose(): void {
		clearTimeout(this.firstCheck);
		clearInterval(this.poll);
	}

	private async check(): Promise<void> {
		const { version: current, downloadPageUrl } = productInfo;
		const now = Date.now();
		if (!downloadPageUrl || !shouldCheckForAppUpdate({
			enabled: vscode.workspace.getConfiguration(configSection).get<boolean>('app.checkForUpdates', true),
			currentVersion: current,
			downloadPageUrl,
			lastCheck: this.globalState.get<number>(lastCheckKey),
			now,
		})) {
			return;
		}
		// Stored first, so other windows skip this day's check.
		await this.globalState.update(lastCheckKey, now);
		let latest: unknown;
		try {
			const response = await fetch(latestReleaseUrl(downloadPageUrl), { signal: AbortSignal.timeout(fetchTimeout), headers: { accept: 'application/json' } });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			latest = await response.json();
		} catch (err) {
			this.log.info(`Could not check for a newer GeminiCode: ${errorMessage(err)}`);
			return;
		}
		const offer = appUpdateToOffer(current, latest, downloadPageUrl);
		this.log.info(`GeminiCode update check: running ${current}, latest ${(latest as { version?: unknown } | null)?.version ?? 'unknown'}`);
		if (!offer) {
			return;
		}
		const download = vscode.l10n.t("Download");
		const releaseNotes = vscode.l10n.t("Release Notes");
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t("GeminiCode {0} is available. You have {1}.", offer.version, current ?? ''), download, releaseNotes);
		if (choice === download) {
			await vscode.env.openExternal(vscode.Uri.parse(offer.downloadUrl));
		} else if (choice === releaseNotes) {
			await vscode.env.openExternal(vscode.Uri.parse(offer.notesUrl));
		}
	}
}
