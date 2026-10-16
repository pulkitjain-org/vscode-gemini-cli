/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tells the user when a newer GeminiCode is out. Off the startup path: the
// first look is a minute after activation, then every few hours across all
// windows, and it is one small request to the download page. "Check for
// Updates..." (`gemini.app.checkForUpdates`) looks at once and always answers.
// The notice only links to the page; GeminiCode downloads and installs
// nothing itself.

import * as vscode from 'vscode';
import { appUpdateToOffer, latestReleaseUrl, shouldCheckForAppUpdate } from '../acp/appUpdates';
import { isVersion } from '../acp/cliResolution';
import { errorMessage } from '../acp/errors';
import { configSection, productInfo } from './configuration';

export const checkForAppUpdatesCommand = 'gemini.app.checkForUpdates';

const lastCheckKey = 'gemini.app.lastUpdateCheck';
/** When a window last started a background read, so windows that start together read once. */
const claimKey = 'gemini.app.updateCheckClaim';
const firstCheckDelay = 60 * 1000;
/** How often a long-running window looks again whether a check is due; the check itself is a timestamp comparison. */
const checkPoll = 60 * 60 * 1000;
const fetchTimeout = 15 * 1000;
/** Another window that read `latest.json` this recently counts for this one too; it covers windows that start together. */
const claimWindow = 2 * 60 * 1000;

export class AppUpdateNotice implements vscode.Disposable {

	private readonly firstCheck: ReturnType<typeof setTimeout>;
	private readonly poll: ReturnType<typeof setInterval>;
	private readonly command: vscode.Disposable;
	private checking: Promise<void> | undefined;

	constructor(private readonly globalState: vscode.Memento, private readonly log: vscode.LogOutputChannel) {
		this.firstCheck = setTimeout(() => void this.check(), firstCheckDelay);
		this.poll = setInterval(() => void this.check(), checkPoll);
		this.command = vscode.commands.registerCommand(checkForAppUpdatesCommand, () => this.checkNow());
	}

	dispose(): void {
		clearTimeout(this.firstCheck);
		clearInterval(this.poll);
		this.command.dispose();
	}

	/** The background check: quiet unless there is a newer release. */
	private async check(): Promise<void> {
		const { version: current, downloadPageUrl } = productInfo;
		const now = Date.now();
		const lastCheck = this.globalState.get<number>(lastCheckKey);
		if (!downloadPageUrl || this.checking || !shouldCheckForAppUpdate({
			enabled: vscode.workspace.getConfiguration(configSection).get<boolean>('app.checkForUpdates', true),
			currentVersion: current,
			downloadPageUrl,
			lastCheck,
			now,
		})) {
			return;
		}
		const claim = this.globalState.get<number>(claimKey);
		if (claim !== undefined && claim <= now && now - claim < claimWindow) {
			// Another window is reading it right now.
			return;
		}
		await this.globalState.update(claimKey, now);
		let latest: unknown;
		try {
			latest = await this.readLatest(downloadPageUrl);
		} catch (err) {
			// The time is saved only after a successful read, so a failed check (offline, say) is retried at the next poll.
			this.log.info(`Could not check for a newer GeminiCode: ${errorMessage(err)}`);
			return;
		}
		await this.offer(latest, downloadPageUrl, false);
	}

	/** "Check for Updates...": looks now, whatever the setting and the last check, and always says what it found. */
	private checkNow(): Promise<void> {
		this.checking ??= this.runCheckNow().finally(() => this.checking = undefined);
		return this.checking;
	}

	private async runCheckNow(): Promise<void> {
		const { version: current, downloadPageUrl } = productInfo;
		if (!downloadPageUrl || !current || !isVersion(current)) {
			void vscode.window.showInformationMessage(vscode.l10n.t("This is a development build of GeminiCode, so there are no updates to check for."));
			return;
		}
		let latest: unknown;
		try {
			latest = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Checking for GeminiCode updates...") },
				() => this.readLatest(downloadPageUrl));
		} catch (err) {
			this.log.info(`Could not check for a newer GeminiCode: ${errorMessage(err)}`);
			const retry = vscode.l10n.t("Try Again");
			if (await vscode.window.showWarningMessage(vscode.l10n.t("Could not check for updates. Check your connection and try again."), retry) === retry) {
				void this.checkNow();
			}
			return;
		}
		await this.offer(latest, downloadPageUrl, true);
	}

	/** Reads `latest.json`; on success, saves when, so other windows skip their next check. */
	private async readLatest(downloadPageUrl: string): Promise<unknown> {
		const response = await fetch(latestReleaseUrl(downloadPageUrl), { signal: AbortSignal.timeout(fetchTimeout), headers: { accept: 'application/json' } });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const latest: unknown = await response.json();
		await this.globalState.update(lastCheckKey, Date.now());
		this.log.info(`GeminiCode update check: running ${productInfo.version}, latest ${(latest as { version?: unknown } | null)?.version ?? 'unknown'}`);
		return latest;
	}

	/** Offers the newer release in `latest`; with `upToDate`, also says when there is none. */
	private async offer(latest: unknown, downloadPageUrl: string, upToDate: boolean): Promise<void> {
		const current = productInfo.version;
		const offer = appUpdateToOffer(current, latest, downloadPageUrl);
		if (!offer) {
			if (upToDate) {
				void vscode.window.showInformationMessage(vscode.l10n.t("GeminiCode {0} is up to date.", current ?? ''));
			}
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
