/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentChanges } from '../acp/agentChanges';
import { CliBundleInfo, DirectClient, DirectRequest, DirectRequestError, readCliBundle } from '../acp/directRequest';
import { errorMessage } from '../acp/errors';
import { cleanCommitMessage, cleanEdit, commitMessagePrompt, inlineEditPrompt, latestFlashModel, quickEditModels } from '../acp/quickPrompts';
import { configSection, getCliResolution, getProjectSettings } from './configuration';
import { preferredModel } from './modelPreference';
import { ReviewController, ReviewSource } from './reviewController';

const enabledSetting = 'inlineEdit.enabled';
const modelSetting = 'inlineEdit.model';

/** The parts of the built-in Git extension's API used here. */
interface GitRepository {
	readonly rootUri: vscode.Uri;
	readonly inputBox: { value: string };
	diff(cached?: boolean): Promise<string>;
	log(options?: { maxEntries?: number }): Promise<readonly { readonly message: string }[]>;
}

interface GitApi {
	readonly repositories: readonly GitRepository[];
	getRepository(uri: vscode.Uri): GitRepository | null;
}

/**
 * Inline edit and commit messages: one direct request each to a fast model,
 * outside any agent, so they take a second or two. An inline edit shows in
 * the file for review, with Keep and Undo on each change.
 */
export class QuickEdits implements vscode.Disposable {

	private readonly client: DirectClient;
	private readonly source: ReviewSource;
	private readonly disposables: vscode.Disposable[] = [];
	private lastInstruction = '';
	private cliBundle: Promise<CliBundleInfo> | undefined;
	/** The account was refused the latest Flash model, so this window goes straight to the one every account has. */
	private latestRefused = false;

	constructor(review: ReviewController, private readonly log: vscode.LogOutputChannel) {
		this.client = new DirectClient({
			projectId: () => getProjectSettings().resolved?.projectId,
			oauthClient: () => this.readCliBundle().then(info => info.oauthClient),
		});
		// Reading the CLI's bundle takes a moment, so do it before the first request needs it.
		const warm = setTimeout(() => void this.readCliBundle(), 5000);
		const changes = new AgentChanges(path.sep);
		this.source = { title: vscode.l10n.t("inline edit"), changes, saves: false };
		this.disposables.push(
			{ dispose: () => clearTimeout(warm) },
			changes,
			review.addSource(this.source),
			vscode.commands.registerCommand('gemini.inlineEdit', () => this.inlineEdit()),
			vscode.commands.registerCommand('gemini.generateCommitMessage', (scm?: { rootUri?: vscode.Uri }) => this.commitMessage(scm?.rootUri)),
		);
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private enabled(): boolean {
		if (vscode.workspace.getConfiguration(configSection).get<boolean>(enabledSetting, true)) {
			return true;
		}
		void vscode.window.showInformationMessage(vscode.l10n.t("Inline edit and commit messages are turned off (gemini.inlineEdit.enabled)."));
		return false;
	}

	private readCliBundle(): Promise<CliBundleInfo> {
		return this.cliBundle ??= findCliEntry()
			.then(entry => entry ? readCliBundle(entry) : {})
			.catch(err => {
				this.log.warn(`Could not read the Gemini CLI bundle: ${errorMessage(err)}`);
				return {};
			});
	}

	/**
	 * Sends the request to the first model that takes it. The latest Flash
	 * model is not open to every account yet; if it is refused, the request
	 * goes to the one every account has, and so does every later one.
	 */
	private async generate(request: Omit<DirectRequest, 'model'>): Promise<string> {
		const cli = await this.readCliBundle();
		const models = quickEditModels({
			setting: vscode.workspace.getConfiguration(configSection).get<string>(modelSetting, latestFlashModel),
			chatModel: preferredModel(),
			cliFlash: { latest: cli.latestFlash, base: cli.baseFlash },
			latestRefused: this.latestRefused,
		});
		for (let i = 0; ; i++) {
			const started = Date.now();
			try {
				const text = await this.client.generate({ ...request, model: models[i] });
				this.log.info(`Direct request: ${Date.now() - started} ms with ${models[i]}`);
				return text;
			} catch (err) {
				const refused = err instanceof DirectRequestError && (err.status === 400 || err.status === 403 || err.status === 404);
				if (!refused || i === models.length - 1 || request.signal?.aborted) {
					throw err;
				}
				this.log.info(`${models[i]} was refused (${errorMessage(err)}); using ${models[i + 1]}`);
				this.latestRefused = true;
			}
		}
	}

	/** Asks what to change in the selected lines (or the line with the cursor), and shows Gemini's rewrite in place. */
	async inlineEdit(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.scheme !== 'file' || !this.enabled()) {
			return;
		}
		const document = editor.document;
		const selection = editor.selection;
		const start = selection.start.line;
		// A selection that ends at the start of a line does not include that line.
		const end = selection.end.character === 0 && selection.end.line > start ? selection.end.line : selection.end.line + 1;
		const instruction = await vscode.window.showInputBox({
			title: end - start === 1 ? vscode.l10n.t("Edit line {0} with Gemini", start + 1) : vscode.l10n.t("Edit lines {0}-{1} with Gemini", start + 1, end),
			placeHolder: vscode.l10n.t("Describe the change, for example \"handle the empty list\""),
			value: this.lastInstruction,
			valueSelection: [0, this.lastInstruction.length],
			ignoreFocusOut: true,
		});
		if (!instruction?.trim()) {
			return;
		}
		this.lastInstruction = instruction;
		const version = document.version;
		const before = document.getText();
		const lines = before.split('\n');
		const original = lines.slice(start, end).join('\n') + (end < lines.length ? '\n' : '');
		const { system, prompt } = inlineEditPrompt({ path: vscode.workspace.asRelativePath(document.uri), languageId: document.languageId, lines, start, end, instruction });
		const reply = await this.withProgress(vscode.ProgressLocation.Notification, vscode.l10n.t("Gemini is editing…"), signal =>
			this.generate({ system, prompt, signal }));
		if (reply === undefined) {
			return;
		}
		if (document.version !== version) {
			void vscode.window.showWarningMessage(vscode.l10n.t("The file changed while Gemini was working, so the edit was not applied. Try again."));
			return;
		}
		const text = cleanEdit(reply, original);
		if (text === original) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Gemini suggested no change."));
			return;
		}
		const range = new vscode.Range(start, 0, end, 0);
		const target = end < lines.length ? range : document.validateRange(new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER));
		if (!await editor.edit(edit => edit.replace(target, text))) {
			return;
		}
		this.source.changes.record([{ path: document.uri.fsPath, oldText: before, newText: document.getText() }]);
		editor.selection = new vscode.Selection(start, 0, start, 0);
		editor.revealRange(new vscode.Range(start, 0, start, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	/** Writes a commit message for the staged changes (or, with none staged, all changes) into the Source Control input. */
	async commitMessage(root: vscode.Uri | undefined): Promise<void> {
		if (!this.enabled()) {
			return;
		}
		const git = await gitApi();
		const active = vscode.window.activeTextEditor?.document.uri;
		const repository = (root && git?.getRepository(root)) || (active && git?.getRepository(active)) || git?.repositories[0];
		if (!repository) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Open a Git repository to write a commit message."));
			return;
		}
		const diff = await repository.diff(true) || await repository.diff(false);
		if (!diff.trim()) {
			void vscode.window.showInformationMessage(vscode.l10n.t("There are no changes to describe."));
			return;
		}
		const subjects = await repository.log({ maxEntries: 8 }).then(commits => commits.map(c => c.message.split('\n')[0]), () => []);
		const { system, prompt } = commitMessagePrompt(diff, subjects);
		const reply = await this.withProgress(vscode.ProgressLocation.SourceControl, vscode.l10n.t("Writing a commit message…"), signal =>
			this.generate({ system, prompt, signal, temperature: 0.3 }));
		if (reply) {
			repository.inputBox.value = cleanCommitMessage(reply);
		}
	}

	/** Runs `work` with a cancellable progress; undefined when cancelled or failed (the failure is shown). */
	private async withProgress<T>(location: vscode.ProgressLocation, title: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
		const abort = new AbortController();
		try {
			return await vscode.window.withProgress({ location, title, cancellable: true }, (_progress, token) => {
				token.onCancellationRequested(() => abort.abort());
				return work(abort.signal);
			});
		} catch (err) {
			if (!abort.signal.aborted) {
				this.log.warn(`Direct request failed: ${errorMessage(err)}`);
				const signIn = vscode.l10n.t("Sign In");
				const actions = err instanceof DirectRequestError && err.kind === 'auth' ? [signIn] : [];
				if (await vscode.window.showErrorMessage(errorMessage(err), ...actions) === signIn) {
					void vscode.commands.executeCommand('gemini.signIn');
				}
			}
			return undefined;
		}
	}
}

async function gitApi(): Promise<GitApi | undefined> {
	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
	if (!extension) {
		return undefined;
	}
	const exports = extension.isActive ? extension.exports : await extension.activate();
	return exports.getAPI(1);
}

/** The CLI's `gemini.js`: the one GeminiCode runs, else the one on the PATH. */
async function findCliEntry(): Promise<string | undefined> {
	const configured = getCliResolution().cliPath;
	if (configured) {
		return configured;
	}
	const { promises: fs } = await import('node:fs');
	for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
		const candidate = path.join(dir, 'gemini');
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			// Not here.
		}
	}
	return undefined;
}
