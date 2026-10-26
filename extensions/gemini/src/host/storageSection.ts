/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Project Helpers' Storage section (settingsPage.ts): how much each place
// GeminiCode keeps data holds, measured the first time the section scrolls
// into view, Clean Up, which lists what it removes and asks first, and how
// long logs are kept. Runs in the pages bundle (src/pages.ts), so what it
// needs of the agents comes through `StorageHost`.

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../acp/errors';
import { cleanupPlan, entriesIn, foldersTwoDown, keepLogsDays, measureStorage, runCleanup, storageAreas, storageGroups, type CleanupItem, type CleanupReason, type StorageGroup, type WorktreeCandidate } from '../acp/storageUsage';
import type { AgentWorktree } from '../acp/worktrees';
import { configSection } from './configuration';
import { formatBytes, tildify } from './displayText';
import type { StorageRowView, StorageView } from './panelProtocol';

/** What the Storage section takes from the extension's own bundle. */
export interface StorageHost {
	/** The extension's global storage folder. */
	readonly globalStorage: string;
	/** Every agent's id, and the threads merged back. */
	agents(): { readonly all: ReadonlySet<string>; readonly merged: ReadonlySet<string> };
	/** The worktrees Clean Up may offer, with what git says of each. */
	worktrees(): Promise<readonly WorktreeCandidate[]>;
	/** Removes one worktree Clean Up listed, under its repository's git lock. */
	removeWorktree(repository: string, worktree: AgentWorktree, item: CleanupItem): Promise<void>;
	/** The version of the Gemini CLI the agent runs, once it has said. */
	cliVersion(): string | undefined;
}

const keepLogsSetting = 'storage.keepLogsDays';
const keepLogsChoices = [7, 30, 90, 365, 0];

export class StorageSection {

	private state: StorageView['state'] = 'waiting';
	private rows: readonly StorageRowView[] = [];
	private plan: readonly CleanupItem[] = [];
	private error: string | undefined;

	/** `changed` draws the page again. */
	constructor(private readonly host: StorageHost, private readonly changed: () => void, private readonly home: string = os.homedir()) { }

	view(): StorageView {
		const days = keepLogsDays(vscode.workspace.getConfiguration(configSection).get<number>(keepLogsSetting));
		const label = (value: number) => value === 0 ? vscode.l10n.t("Keep everything") : value === 90 ? vscode.l10n.t("Keep for {0} days (default)", value) : vscode.l10n.t("Keep for {0} days", value);
		const values = keepLogsChoices.includes(days) ? keepLogsChoices : [...keepLogsChoices, days];
		return {
			state: this.state,
			rows: this.state === 'ready' ? this.rows : this.placeholderRows(),
			...this.state === 'ready' && this.plan.length ? { cleanup: vscode.l10n.t("Clean Up {0}...", this.plan.length) } : {},
			keepLogs: { value: String(days), choices: values.map(value => ({ value: String(value), label: label(value) })) },
			...this.error ? { error: this.error } : {},
		};
	}

	/** Measures every area and works out Clean Up's list; once at a time. */
	async measure(): Promise<void> {
		if (this.state === 'measuring') {
			return;
		}
		this.state = 'measuring';
		this.error = undefined;
		this.changed();
		try {
			const geminicode = path.join(this.home, '.geminicode');
			const [sizes, worktrees, worktreeFolders, reviewFolders, indexes, checkpoints] = await Promise.all([
				measureStorage(storageAreas(this.host.globalStorage, this.home)),
				this.host.worktrees(),
				foldersTwoDown(path.join(geminicode, 'worktrees')),
				// Merge request reviews' checkouts, apart from the agents' own.
				foldersTwoDown(path.join(geminicode, 'reviews')),
				entriesIn(path.join(geminicode, 'index', 'code')),
				entriesIn(path.join(this.host.globalStorage, 'checkpoints'), '.json'),
			]);
			this.plan = await this.cleanupPlan(worktrees);
			const bytes = new Map(storageGroups(sizes).map(group => [group.group, group.bytes]));
			const offered = this.plan.filter(item => item.area === 'worktrees').length;
			const where = tildify(path.join(geminicode, 'worktrees'));
			const reviewsWhere = tildify(path.join(geminicode, 'reviews'));
			const folders = worktreeFolders.length + reviewFolders.length;
			const details: Record<StorageGroup, string> = {
				worktrees: offered
					? vscode.l10n.t("{0} folders in {1} and {2} · {3} belong to merged or removed agents", folders, where, reviewsWhere, offered)
					: vscode.l10n.t("{0} folders in {1} and {2}", folders, where, reviewsWhere),
				index: vscode.l10n.t("{0} folders · unused ones are deleted after 30 days", indexes),
				cli: this.host.cliVersion() ? vscode.l10n.t("{0} in use", this.host.cliVersion()!) : vscode.l10n.t("Copies GeminiCode installed"),
				checkpoints: vscode.l10n.t("Checkpoints for {0} agents · removed when a thread is merged", checkpoints),
				chats: vscode.l10n.t("Saved chats, reviews and team flows"),
				logs: vscode.l10n.t("The audit log, performance traces and the Gemini CLI's debug logs"),
			};
			this.rows = this.placeholderRows().map(row => ({ ...row, detail: details[row.id], size: formatBytes(bytes.get(row.id) ?? 0) }));
			this.state = 'ready';
		} catch (err) {
			this.state = 'ready';
			this.error = vscode.l10n.t("Couldn't measure: {0}", errorMessage(err));
		}
		this.changed();
	}

	/** Clean Up: lists what it removes, asks, removes it, then measures again. */
	async cleanUp(): Promise<void> {
		const plan = await this.cleanupPlan(await this.host.worktrees());
		if (!plan.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Nothing to clean up."));
			return this.measure();
		}
		const freed = formatBytes(plan.reduce((sum, item) => sum + item.bytes, 0));
		const clean = vscode.l10n.t("Clean Up");
		const detail = [
			...cleanupLines(plan),
			'',
			vscode.l10n.t("Worktrees with uncommitted changes or commits no other branch has are never removed. Branches stay."),
		].join('\n');
		if (await vscode.window.showWarningMessage(vscode.l10n.t("Remove {0} items, freeing {1}?", plan.length, freed), { modal: true, detail }, clean) !== clean) {
			return;
		}
		const failed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Cleaning up...") },
			() => runCleanup(plan, (repository, worktree, item) => this.host.removeWorktree(repository, worktree, item)));
		if (failed.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t("Couldn't remove {0} of {1} items: {2}", failed.length, plan.length, failed[0].error));
		} else {
			void vscode.window.showInformationMessage(vscode.l10n.t("Freed {0}.", freed));
		}
		await this.measure();
	}

	/** The logs row's menu: `gemini.storage.keepLogsDays`, for this machine. */
	async setKeepLogs(value: string): Promise<void> {
		const days = Number(value);
		if (!Number.isInteger(days) || days < 0) {
			return;
		}
		await vscode.workspace.getConfiguration(configSection).update(keepLogsSetting, days, vscode.ConfigurationTarget.Global);
		if (this.state === 'ready') {
			await this.measure();
		}
	}

	async action(action: 'showIndex' | 'openFolder'): Promise<void> {
		if (action === 'showIndex') {
			await vscode.commands.executeCommand('gemini.index.open');
		} else {
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(this.host.globalStorage));
		}
	}

	private cleanupPlan(worktrees: readonly WorktreeCandidate[]): Promise<CleanupItem[]> {
		const agents = this.host.agents();
		return cleanupPlan({
			globalStorage: this.host.globalStorage,
			agents: agents.all,
			merged: agents.merged,
			keepLogsDays: keepLogsDays(vscode.workspace.getConfiguration(configSection).get<number>(keepLogsSetting)),
			now: new Date(),
			worktrees,
		});
	}

	/** The rows before they are measured. */
	private placeholderRows(): StorageRowView[] {
		return [
			{ id: 'worktrees', label: vscode.l10n.t("Agent worktrees"), detail: '', size: '' },
			{ id: 'index', label: vscode.l10n.t("Workspace indexes"), detail: '', size: '', action: { kind: 'showIndex', label: vscode.l10n.t("Show") } },
			{ id: 'cli', label: vscode.l10n.t("Gemini CLI copies"), detail: '', size: '' },
			{ id: 'checkpoints', label: vscode.l10n.t("Undo history"), detail: '', size: '' },
			{ id: 'chats', label: vscode.l10n.t("Chats and reviews"), detail: '', size: '' },
			{ id: 'logs', label: vscode.l10n.t("Logs and audit records"), detail: '', size: '', action: { kind: 'openFolder', label: vscode.l10n.t("Open Folder") } },
		];
	}
}

/** Clean Up's list, for its dialog: each worktree by name and whose it is, the rest counted by why they go. */
function cleanupLines(plan: readonly CleanupItem[]): string[] {
	const kinds: Partial<Record<CleanupReason, string>> = {
		mergedWorktree: vscode.l10n.t("merged thread"),
		reviewWorktree: vscode.l10n.t("ended review, with its reviewer agent"),
		removedWorktree: vscode.l10n.t("removed agent"),
	};
	const worktrees = plan.filter(item => item.worktree).map(item => `${item.worktree!.worktree.branch || path.basename(item.path)} (${kinds[item.reason] ?? ''}, ${formatBytes(item.bytes)})`);
	const count = (reason: CleanupReason) => plan.filter(item => item.reason === reason).length;
	const counted: [CleanupReason, (n: number) => string][] = [
		['orphaned', n => vscode.l10n.t("Saved chats and undo history of {0} removed agents", n)],
		['merged', n => vscode.l10n.t("Undo history of {0} merged threads", n)],
		['oldLog', n => vscode.l10n.t("{0} days of logs older than the days kept", n)],
		['trace', n => vscode.l10n.t("{0} performance trace files", n)],
		['broken', n => vscode.l10n.t("{0} damaged files moved aside", n)],
		['oldDebugLog', n => vscode.l10n.t("{0} debug logs of closed windows", n)],
	];
	return [
		...worktrees.length ? [vscode.l10n.t("Worktrees: {0}", worktrees.join(', '))] : [],
		...counted.filter(([reason]) => count(reason)).map(([reason, text]) => text(count(reason))),
	];
}
