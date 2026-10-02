/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Installing and switching GeminiCode's own copies of the Gemini CLI (plan
// Phase 3, runtime-resolution, cli-install). Nothing here runs on startup
// except a cleanup once the agent is ready; the network is only used when
// the user asks for an install.

import * as vscode from 'vscode';
import { fetchCliVersions, Fetch, installCli, pruneCliVersions } from '../acp/cliInstall';
import { compareVersions, listManagedVersions } from '../acp/cliResolution';
import { AgentService } from './agentService';
import { configSection, getCliResolution, getManagedCliDir } from './configuration';

export const installCliCommand = 'gemini.installCli';
export const installCliVersionCommand = 'gemini.installCliVersion';

export class CliManager implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private pruned = false;

	constructor(private readonly service: AgentService, private readonly log: vscode.LogOutputChannel) {
		this.disposables.push(
			vscode.commands.registerCommand(installCliCommand, (version?: string) => this.install(typeof version === 'string' ? version : 'latest')),
			vscode.commands.registerCommand(installCliVersionCommand, () => this.pickVersion()),
			service.onDidChangeStatus(status => {
				if (status.phase === 'ready' && !this.pruned) {
					this.pruned = true;
					// Off the startup path: the agent is already answering.
					setTimeout(() => this.prune(), 5_000);
				}
			}),
		);
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** Lets the user pick a released version; the one picked is then used until changed. */
	private async pickVersion(): Promise<void> {
		const managedDir = getManagedCliDir();
		if (!managedDir) {
			return;
		}
		const installed = new Set(listManagedVersions(managedDir));
		const running = this.service.cli?.version;
		const picked = await vscode.window.showQuickPick((async () => {
			const { versions, latest } = await fetchCliVersions({ fetch: fetch as Fetch });
			return versions.slice(0, 30).map(version => ({
				label: version,
				description: [
					version === latest ? vscode.l10n.t("latest") : undefined,
					version === running ? vscode.l10n.t("in use") : installed.has(version) ? vscode.l10n.t("installed") : undefined,
				].filter(Boolean).join(' · '),
			}));
		})().catch(err => {
			void vscode.window.showErrorMessage(vscode.l10n.t("Could not list Gemini CLI versions: {0}", errorMessage(err)));
			return [];
		}), { placeHolder: vscode.l10n.t("Gemini CLI version to install and use") });
		if (picked) {
			await this.install(picked.label, true);
		}
	}

	/** Installs `version` (or `latest`); with `pin`, also sets `gemini.cli.version` so that version is the one used. */
	private async install(version: string, pin = false): Promise<void> {
		const managedDir = getManagedCliDir();
		if (!managedDir) {
			return;
		}
		let installed: string;
		try {
			installed = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: version === 'latest' ? vscode.l10n.t("Installing the Gemini CLI") : vscode.l10n.t("Installing Gemini CLI {0}", version),
				cancellable: true,
			}, (_progress, token) => {
				const abort = new AbortController();
				token.onCancellationRequested(() => abort.abort());
				return installCli({ fetch: fetch as Fetch, managedDir, version, signal: abort.signal });
			});
		} catch (err) {
			if (!(err instanceof Error && err.name === 'AbortError')) {
				this.log.error(`Installing Gemini CLI ${version} failed: ${errorMessage(err)}`);
				void vscode.window.showErrorMessage(vscode.l10n.t("Installing the Gemini CLI failed: {0}", errorMessage(err)));
			}
			return;
		}
		this.log.info(`Installed Gemini CLI ${installed} in ${managedDir}`);
		if (pin) {
			try {
				await vscode.workspace.getConfiguration(configSection).update('cli.version', installed, vscode.ConfigurationTarget.Global);
			} catch (err) {
				// Locked by policy: the admin's version stays.
				void vscode.window.showWarningMessage(vscode.l10n.t("Gemini CLI {0} is installed, but the version in use is set by your administrator. ({1})", installed, errorMessage(err)));
				return;
			}
		}
		this.switchIfNeeded(installed);
	}

	/** Restarts the agent on the new CLI once no prompt runs, or now if the user asks. */
	private switchIfNeeded(installed: string): void {
		const next = getCliResolution();
		if (next.cliPath === this.service.cli?.cliPath || !this.service.isStarted) {
			return;
		}
		if (next.version !== installed) {
			// The setting or a pin points elsewhere; the copy waits until chosen.
			void vscode.window.showInformationMessage(vscode.l10n.t("Gemini CLI {0} is installed.", installed));
			return;
		}
		this.service.restartWhenIdle();
		if (this.service.isBusy) {
			const restartNow = vscode.l10n.t("Restart Now");
			void vscode.window.showInformationMessage(
				vscode.l10n.t("Gemini CLI {0} is installed. The agent switches to it when no agent is working.", installed), restartNow,
			).then(choice => choice === restartNow && this.service.restart());
		}
	}

	/** Keeps the CLI in use and the newest other copy, so going back stays one step. */
	private prune(): void {
		const managedDir = getManagedCliDir();
		if (!managedDir) {
			return;
		}
		const versions = listManagedVersions(managedDir).sort(compareVersions).reverse();
		const current = this.service.cli?.source === 'managed' ? this.service.cli.version : undefined;
		const keep = current ? [current, ...versions.filter(v => v !== current).slice(0, 1)] : versions.slice(0, 2);
		try {
			const removed = pruneCliVersions(managedDir, keep);
			if (removed.length) {
				this.log.info(`Removed old Gemini CLI copies: ${removed.join(', ')}`);
			}
		} catch (err) {
			this.log.warn(`Could not remove old Gemini CLI copies: ${errorMessage(err)}`);
		}
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
