/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Folder trust for agents. The Gemini CLI loads a folder's own settings,
// hooks and MCP servers (GeminiCode's tools among them), allows Auto Edit and
// runs git without asking only in folders it trusts. GeminiCode asks once per
// repository, the first time it's chosen for agents anywhere (Home, a new
// agent, a project, the Index page, a mode that needs it), before the agent
// process reads the trust file: the CLI reads it once per process. "Not Now"
// is remembered, so later starts don't ask again; Home and the mode menu say
// in place what needs trust, with Trust... asking again. A trusted
// repository's worktrees folder follows it, and GeminiCode's own folders are
// set at every launch of the agent process (`ownTrustRules`). Agent Setup
// removes the entries of folders that are gone (`staleTrustRules`). Changes made
// elsewhere (the terminal, Agent Setup, another window) reach the agents too:
// the file is watched.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../acp/errors';
import { ensureOwnTrustRules, folderTrustApplies, folderTrustState, ownTrustRules, readTrustRules, removeTrustRules, setFolderTrust, trustedFoldersPath, type TrustLevel, type TrustRule } from '../acp/trustedFolders';
import { repositoryRoot, worktreesHome } from '../acp/worktrees';
import { tildify } from './displayText';
import { showError } from './errorNotice';

/** How a folder stands for agents: trusted by its own entry, by a parent's, or not at all. */
export type FolderTrustLabel = 'trusted' | 'parent' | 'untrusted';

/** What folder trust needs of the agent service. */
export interface FolderTrustHost {
	/** How many prompts run now, in every chat. */
	runningTurns(): number;
	/** Restarts a running agent process once no prompt runs, so it reads the trust file again; nothing when none runs. */
	reloadWhenIdle(): void;
	/** Restarts a running agent process now. */
	restartNow(): void;
	log(message: string): void;
}

/** Repositories whose first-use question was answered Not Now. */
const notNowKey = 'gemini.trust.notNow';
/** The rules GeminiCode wrote, path to level, so Agent Setup can say which were added elsewhere. */
const writtenKey = 'gemini.trust.written';

export class FolderTrust implements vscode.Disposable {

	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	/** Fires when any folder's trust may have changed. */
	readonly onDidChange = this.onDidChangeEmitter.event;
	private readonly disposables: vscode.Disposable[] = [this.onDidChangeEmitter];
	/** The file as GeminiCode last wrote it, so its own writes aren't taken for another program's. */
	private written: string | undefined;
	/** Questions showing now, by repository, so two starts ask once. */
	private readonly asking = new Map<string, Promise<boolean>>();
	/** Labels read since the file last changed, by folder. */
	private readonly labels = new Map<string, Promise<FolderTrustLabel | undefined>>();

	constructor(private readonly state: vscode.Memento | undefined, private readonly host: FolderTrustHost) {
		const file = this.file;
		try {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
			this.disposables.push(watcher, watcher.onDidChange(() => void this.changedOutside()), watcher.onDidCreate(() => void this.changedOutside()), watcher.onDidDelete(() => void this.changedOutside()));
		} catch {
			// Without a watcher, changes made elsewhere reach the agents at their next start.
		}
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** The Gemini CLI's trusted-folders file. */
	get file(): string {
		return trustedFoldersPath(process.env);
	}

	/** Whether the CLI checks folder trust at all; when it doesn't, nothing asks and every folder counts as trusted. */
	applies(): Promise<boolean> {
		return folderTrustApplies(process.env).catch(() => true);
	}

	/** Whether agents in `folder` run trusted. */
	async isTrusted(folder: string): Promise<boolean> {
		return !await this.applies() || (await folderTrustState(this.file, folder)).trusted === true;
	}

	/** How `folder` stands, for Home's folder picker; undefined while folder trust is off. */
	label(folder: string): Promise<FolderTrustLabel | undefined> {
		let label = this.labels.get(folder);
		if (!label) {
			label = this.readLabel(folder);
			this.labels.set(folder, label);
		}
		return label;
	}

	private async readLabel(folder: string): Promise<FolderTrustLabel | undefined> {
		if (!await this.applies()) {
			return undefined;
		}
		const state = await folderTrustState(this.file, folder);
		const own = state.rule?.level === 'TRUST_FOLDER' ? state.rule.path : undefined;
		return state.trusted !== true ? 'untrusted' : own && await realPath(own) === await realPath(folder) ? 'trusted' : 'parent';
	}

	/**
	 * The first-use question for `folder`'s repository: Trust This Folder,
	 * Trust Everything in its parent (when the parent holds other
	 * repositories), or Not Now. Resolves whether agents there run trusted
	 * now. Not asked again after Not Now or Never Trust unless `explicit`
	 * (a Trust... button); a trusted repository's worktrees folder is trusted
	 * along with it.
	 */
	async ask(folder: string, options: { readonly explicit?: boolean } = {}): Promise<boolean> {
		if (!await this.applies()) {
			return true;
		}
		const repository = await repositoryOf(folder);
		const state = await folderTrustState(this.file, folder);
		if (state.trusted) {
			await this.follow(repository).catch(err => this.host.log(`Could not trust the worktrees of ${repository}: ${errorMessage(err)}`));
			return true;
		}
		if (!options.explicit && (state.trusted === false || this.notNow().includes(repository))) {
			return false;
		}
		let question = this.asking.get(repository);
		if (!question) {
			question = this.question(folder, repository).finally(() => this.asking.delete(repository));
			this.asking.set(repository, question);
		}
		return question;
	}

	/** Whether the first-use question for `folder` is still to be asked: trust applies, nothing decides the folder, and it wasn't answered Not Now. */
	async unanswered(folder: string): Promise<boolean> {
		return await this.applies() && (await folderTrustState(this.file, folder)).trusted === undefined && !this.notNow().includes(await repositoryOf(folder));
	}

	private async question(folder: string, repository: string): Promise<boolean> {
		const name = path.basename(repository) || repository;
		const parent = path.dirname(repository);
		const one: vscode.MessageItem = { title: vscode.l10n.t("Trust This Folder") };
		const all: vscode.MessageItem = { title: vscode.l10n.t("Trust Everything in {0}", tildify(parent)) };
		const notNow: vscode.MessageItem = { title: vscode.l10n.t("Not Now"), isCloseAffordance: true };
		const inWindow = vscode.workspace.isTrusted && (vscode.workspace.workspaceFolders ?? []).some(each => each.uri.scheme === 'file' && isInside(folder, each.uri.fsPath));
		const detail = [
			vscode.l10n.t("Trusting it lets the Gemini CLI load this repository's own Gemini settings, hooks and MCP servers, which can run programs on this Mac. Agents on their own branch, projects and Auto Edit need it."),
			...inWindow ? [vscode.l10n.t("You trusted this folder in VS Code.")] : [],
			vscode.l10n.t("The Gemini CLI remembers your choice, in GeminiCode and in the terminal. You can change it later in Settings."),
		].join('\n\n');
		const items = await hasOtherRepositories(parent, repository) ? [one, all, notNow] : [one, notNow];
		const choice = await vscode.window.showInformationMessage(vscode.l10n.t("Let agents work in {0}?", name), { modal: true, detail }, ...items);
		if (choice !== one && choice !== all) {
			await this.state?.update(notNowKey, [...new Set([...this.notNow(), repository])]);
			return false;
		}
		try {
			await this.set(repository, choice === all ? 'TRUST_PARENT' : 'TRUST_FOLDER', name);
		} catch (err) {
			void showError(vscode.l10n.t("Could not trust {0}: {1}", name, errorMessage(err)));
			return false;
		}
		return true;
	}

	/**
	 * Sets `folder`'s own entry to `level`, or removes it when undefined, then
	 * lets the agents pick it up. Trusting a repository trusts its worktrees
	 * folder too; removing it, or never trusting it, removes that.
	 * `subject` names it in the notice shown while agents work.
	 */
	async set(folder: string, level: TrustLevel | undefined, subject = path.basename(folder) || folder): Promise<void> {
		const file = this.file;
		const worktrees = worktreesHome(folder);
		const derived = level !== 'DO_NOT_TRUST' && level ? 'TRUST_FOLDER' : undefined;
		await setFolderTrust(file, folder, level);
		await this.wrote(folder, level);
		const rules = await readTrustRules(file);
		const isRepository = await fs.stat(path.join(folder, '.git')).then(() => true, () => false);
		if (isRepository && (derived || rules.some(rule => path.resolve(rule.path) === worktrees))) {
			await setFolderTrust(file, worktrees, derived);
			await this.wrote(worktrees, derived);
		}
		await this.state?.update(notNowKey, this.notNow().filter(each => each !== path.resolve(folder)));
		this.host.log(level ? `Set ${folder} to ${level} in ${file}` : `Removed ${folder} from ${file}`);
		await this.remember();
		this.changed(level && level !== 'DO_NOT_TRUST' ? subject : undefined);
	}

	/** Trusts `repository`'s worktrees folder when it isn't, as a trusted repository's agents on their own branch need. */
	private async follow(repository: string): Promise<void> {
		const worktrees = worktreesHome(repository);
		if ((await folderTrustState(this.file, worktrees)).trusted !== undefined || !await fs.stat(path.join(repository, '.git')).then(() => true, () => false)) {
			return;
		}
		await setFolderTrust(this.file, worktrees, 'TRUST_FOLDER');
		await this.wrote(worktrees, 'TRUST_FOLDER');
		this.host.log(`Trusted ${worktrees}, the worktrees of trusted ${repository}`);
		await this.remember();
		this.changed(undefined);
	}

	/** The write of GeminiCode's own entries running now, so startup and a launch write once. */
	private ensuring: Promise<boolean> | undefined;

	/** At startup: GeminiCode's own entries, so Agent Setup lists them and a review is never trusted, whenever the agent started. */
	async startup(): Promise<void> {
		if (await this.ensureOwn()) {
			this.changed(undefined);
		}
	}

	/** Removes the entries keyed `rules`, of folders that are gone (`staleTrustRules`), with no restart: no agent works in them. */
	async forget(rules: readonly string[]): Promise<void> {
		if (!await removeTrustRules(this.file, rules)) {
			return;
		}
		for (const rule of rules) {
			await this.wrote(rule, undefined);
		}
		this.host.log(`Untrusted gone folders: ${rules.join(', ')}`);
		await this.remember();
		this.labels.clear();
		this.onDidChangeEmitter.fire();
	}

	/** Before the agent process starts and reads the file: GeminiCode's own entries, with no restart. */
	async beforeLaunch(): Promise<void> {
		if (await this.ensureOwn()) {
			this.labels.clear();
			this.onDidChangeEmitter.fire();
		}
	}

	/**
	 * Writes GeminiCode's own entries where they are missing; resolves whether
	 * it wrote. A failure is logged, never in the way. The first time, the
	 * rules already there are taken as GeminiCode's: an earlier version may
	 * have written them.
	 */
	private ensureOwn(): Promise<boolean> {
		this.ensuring ??= (async () => {
			try {
				if (!await this.applies()) {
					return false;
				}
				if (this.state && !this.state.get(writtenKey)) {
					const rules = await readTrustRules(this.file).catch(() => []);
					await this.state.update(writtenKey, Object.fromEntries(rules.map(rule => [path.resolve(rule.path), rule.level])));
				}
				if (!await ensureOwnTrustRules(this.file)) {
					return false;
				}
				this.host.log(`Set GeminiCode's own folders in ${this.file}`);
				await this.remember();
				return true;
			} catch (err) {
				this.host.log(`Could not set GeminiCode's own folders in ${this.file}: ${errorMessage(err)}`);
				return false;
			}
		})().finally(() => this.ensuring = undefined);
		return this.ensuring;
	}

	/** Whether `rule` was added or changed outside GeminiCode, such as in the terminal; unknown (false) without state. */
	addedOutside(rule: TrustRule): boolean {
		const written = this.state?.get<Record<string, string>>(writtenKey);
		return !!written && written[path.resolve(rule.path)] !== rule.level && !ownTrustRules().some(own => own.path === path.resolve(rule.path) && own.level === rule.level);
	}

	/** Records that GeminiCode set `folder`'s entry to `level`, or removed it. */
	private async wrote(folder: string, level: TrustLevel | undefined): Promise<void> {
		if (!this.state) {
			return;
		}
		const { [path.resolve(folder)]: _old, ...others } = this.state.get<Record<string, string>>(writtenKey) ?? {};
		await this.state.update(writtenKey, level ? { ...others, [path.resolve(folder)]: level } : others);
	}

	private notNow(): readonly string[] {
		return this.state?.get<string[]>(notNowKey) ?? [];
	}

	private async remember(): Promise<void> {
		this.written = await fs.readFile(this.file, 'utf8').catch(() => undefined);
	}

	/** The file changed: written by the terminal's CLI, Agent Setup in another window, or by hand. */
	private async changedOutside(): Promise<void> {
		const now = await fs.readFile(this.file, 'utf8').catch(() => undefined);
		if (now === this.written) {
			return;
		}
		this.written = now;
		this.host.log(`${this.file} changed outside this window`);
		this.changed(undefined);
	}

	/** Agents pick up a change once no prompt runs; while some do, a notice says so and offers to restart them now. */
	private changed(subject: string | undefined): void {
		this.labels.clear();
		this.onDidChangeEmitter.fire();
		const working = this.host.runningTurns();
		this.host.reloadWhenIdle();
		if (!working) {
			return;
		}
		const later = working === 1
			? subject ? vscode.l10n.t("{0} is trusted. 1 agent is working, so agents pick it up when it finishes its current work.", subject) : vscode.l10n.t("Folder trust changed. 1 agent is working, so agents pick it up when it finishes its current work.")
			: subject ? vscode.l10n.t("{0} is trusted. {1} agents are working, so agents pick it up when they finish their current work.", subject, working) : vscode.l10n.t("Folder trust changed. {0} agents are working, so agents pick it up when they finish their current work.", working);
		const restart = vscode.l10n.t("Restart Agents Now");
		void vscode.window.showInformationMessage(later, restart).then(choice => choice === restart && this.host.restartNow());
	}
}

/** The repository `folder` is in, else the folder itself. */
async function repositoryOf(folder: string): Promise<string> {
	return await repositoryRoot(folder).catch(() => undefined) ?? path.resolve(folder);
}

/** `folder` through its links, as the CLI compares folders (/tmp is /private/tmp on macOS). */
function realPath(folder: string): Promise<string> {
	return fs.realpath(folder).catch(() => path.resolve(folder));
}

/** Whether `folder` is `parent` or inside it. */
function isInside(folder: string, parent: string): boolean {
	const relative = path.relative(parent, folder);
	return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Whether `parent` holds a Git repository other than `repository`, looking at its first few hundred entries. */
async function hasOtherRepositories(parent: string, repository: string): Promise<boolean> {
	const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
	const others = entries.filter(entry => entry.isDirectory() && path.join(parent, entry.name) !== repository).slice(0, 300);
	const found = await Promise.all(others.map(entry => fs.stat(path.join(parent, entry.name, '.git')).then(() => true, () => false)));
	return found.some(Boolean);
}
