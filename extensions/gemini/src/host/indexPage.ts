/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DocsRefresh } from '../acp/docs/docsProtocol';
import { provisionalTitle } from '../acp/docs/docsRegistry';
import { suggestDocs } from '../acp/docs/suggest';
import type { IndexStatus } from '../acp/index/indexerProtocol';
import { folderTrustApplies, isFolderTrusted, trustedFoldersPath } from '../acp/trustedFolders';
import type { AgentService } from './agentService';
import { configSection } from './configuration';
import { DocsSources, defaultMaxPages, SourceView } from './docsSources';
import { tildify } from './displayText';
import type { DocsSourceView, FromIndexPage, IndexPageStrings, IndexPageView, IndexWorkspaceView, ToIndexPage } from './indexProtocol';
import { createNonce, escapeAttribute } from './webviewHtml';
import { indexBuildOn, type WorkspaceIndex } from './workspaceIndex';

const viewType = 'gemini.index';
const dismissedKey = 'gemini.index.dismissedDocs';
/** Status events during a build arrive often; the page redraws at most this often. */
const redrawMs = 400;

export interface IndexPageAgents {
	/** The workspaces agents can work in, open folders first. */
	workspaces(): Promise<readonly { readonly folder: string }[]>;
}

/**
 * The Index page: each workspace's index (its state, size and age, with
 * Index Now, Rebuild, Pause and Remove) and the documentation attached to
 * it (with Add Docs, Refresh and suggestions from the folder's
 * dependencies). It opens as a tab in the active group, like every page
 * Home opens. Opening it builds nothing.
 */
export class IndexPage implements vscode.Disposable {

	private panel: vscode.WebviewPanel | undefined;
	private docsFolder: string | undefined;
	private redrawTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly index: WorkspaceIndex,
		private readonly docs: DocsSources,
		private readonly agents: IndexPageAgents,
		private readonly service: AgentService,
		private readonly state: vscode.Memento,
	) {
		const folderOf = async (arg: unknown) => typeof arg === 'string' ? arg : (arg as { folder?: unknown } | undefined)?.folder as string | undefined ?? await this.pickFolder();
		this.disposables.push(
			vscode.commands.registerCommand('gemini.index.open', (arg: unknown) => this.show(typeof arg === 'string' ? arg : (arg as { folder?: string } | undefined)?.folder)),
			vscode.commands.registerCommand('gemini.index.rebuild', async (arg: unknown) => {
				const folder = await folderOf(arg);
				if (folder) {
					await this.index.rebuild(folder);
				}
			}),
			vscode.commands.registerCommand('gemini.index.pause', async (arg: unknown) => {
				const folder = await folderOf(arg);
				if (folder) {
					await this.index.pause(folder);
				}
			}),
			vscode.commands.registerCommand('gemini.index.addDocs', async () => {
				await this.show();
				void this.panel?.webview.postMessage({ type: 'openAdd' } satisfies ToIndexPage);
			}),
			index.onDidChangeStatus(() => this.redrawSoon()),
			index.onDidChangeEnabled(() => this.redrawSoon()),
			docs.onDidChange(() => this.redrawSoon()),
			vscode.workspace.onDidChangeConfiguration(e => (e.affectsConfiguration(`${configSection}.index`) || e.affectsConfiguration(`${configSection}.docs`)) && this.redrawSoon()),
		);
	}

	async show(folder?: string): Promise<void> {
		if (folder) {
			this.docsFolder = folder;
		}
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);
			void this.update();
			return;
		}
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		const panel = vscode.window.createWebviewPanel(viewType, vscode.l10n.t("Index"), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media] });
		panel.iconPath = new vscode.ThemeIcon('database');
		panel.webview.html = this.html(panel.webview, media);
		panel.webview.onDidReceiveMessage((message: FromIndexPage) => void this.onMessage(message));
		panel.onDidChangeViewState(e => e.webviewPanel.visible && this.redrawSoon());
		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
			}
		});
		this.panel = panel;
	}

	dispose(): void {
		clearTimeout(this.redrawTimer);
		this.panel?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private redrawSoon(): void {
		if (!this.panel?.visible || this.redrawTimer) {
			return;
		}
		this.redrawTimer = setTimeout(() => {
			this.redrawTimer = undefined;
			void this.update();
		}, redrawMs);
	}

	private async onMessage(message: FromIndexPage): Promise<void> {
		switch (message.type) {
			case 'ready':
				await this.update();
				return;
			case 'setEnabled':
				await vscode.workspace.getConfiguration(configSection).update('index.enabled', message.enabled, vscode.ConfigurationTarget.Global);
				return;
			case 'build':
				await this.index.build(message.folder);
				break;
			case 'rebuild':
				await this.index.rebuild(message.folder);
				break;
			case 'pause':
				await this.index.pause(message.folder);
				break;
			case 'resume':
				await this.index.resume(message.folder);
				break;
			case 'remove': {
				const remove = vscode.l10n.t("Remove Index");
				const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Remove the index of {0}?", path.basename(message.folder)), { modal: true, detail: vscode.l10n.t("Agents search file by file there until an agent starts in it again, which builds a new one.") }, remove);
				if (answer === remove) {
					await this.index.remove(message.folder);
				}
				break;
			}
			case 'skipped':
				await this.postSkipped(message.folder);
				return;
			case 'include':
				await this.include(message.folder, message.paths);
				return;
			case 'openIgnoreFile':
				await this.openIgnoreFile(message.folder);
				return;
			case 'editInclude':
				await vscode.commands.executeCommand('workbench.action.openSettings', `${configSection}.index.include`);
				return;
			case 'trust':
				// Only a folder the page lists, and only once the user agreed, as Chat asks.
				if (!(await this.agents.workspaces()).some(workspace => workspace.folder === message.folder) || !await this.service.trust.ask(message.folder, { explicit: true })) {
					return;
				}
				break;
			case 'reveal':
				await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(message.folder));
				return;
			case 'docsFolder':
				this.docsFolder = message.folder;
				break;
			case 'checkUrl':
				void this.panel?.webview.postMessage({ type: 'urlProblem', url: message.url, problem: message.url.trim() ? this.docs.refusal(message.url.trim()) : undefined } satisfies ToIndexPage);
				return;
			case 'addDocs': {
				try {
					await this.docs.add({ ...message.request, url: message.request.url.trim(), maxPages: clampPages(message.request.maxPages) });
					void this.panel?.webview.postMessage({ type: 'added' } satisfies ToIndexPage);
				} catch (err) {
					void this.panel?.webview.postMessage({ type: 'urlProblem', url: message.request.url, problem: err instanceof Error ? err.message : String(err) } satisfies ToIndexPage);
				}
				break;
			}
			case 'attach':
				if (this.docsFolder) {
					await this.docs.attach(message.id, this.docsFolder, message.attached);
				}
				break;
			case 'refreshSource':
				void this.docs.fetch(message.id);
				break;
			case 'removeSource': {
				const remove = vscode.l10n.t("Remove");
				if (await vscode.window.showWarningMessage(vscode.l10n.t("Remove these docs from every folder?"), { modal: true }, remove) === remove) {
					await this.docs.remove(message.id);
				}
				break;
			}
			case 'setRefresh':
				await this.docs.setRefresh(message.id, message.refresh);
				break;
			case 'openUrl':
				if (/^https?:\/\//.test(message.url)) {
					await vscode.env.openExternal(vscode.Uri.parse(message.url));
				}
				return;
			case 'dismissSuggestion':
				await this.state.update(dismissedKey, [...new Set([...this.state.get<string[]>(dismissedKey, []), message.url])]);
				break;
		}
		await this.update();
	}

	private async update(): Promise<void> {
		const panel = this.panel;
		if (!panel?.visible) {
			return;
		}
		const view = await this.build();
		if (this.panel === panel) {
			void panel.webview.postMessage({ type: 'view', view } satisfies ToIndexPage);
		}
	}

	private async build(): Promise<IndexPageView> {
		const folders = [...new Set((await this.agents.workspaces()).map(w => w.folder))];
		const statuses = this.index.enabled ? await this.index.refreshStatus(folders).catch(() => [] as IndexStatus[]) : [];
		const trustFile = trustedFoldersPath(process.env);
		const trustApplies = await folderTrustApplies(process.env).catch(() => false);
		const workspaces = await Promise.all(folders.map(async (folder): Promise<IndexWorkspaceView> => {
			const status = statuses.find(s => s.root === folder);
			const untrusted = trustApplies && await isFolderTrusted(trustFile, folder).catch(() => undefined) !== true;
			return { folder, name: path.basename(folder) || folder, untrusted, readOnly: !!status?.readOnly, ...describe(status) };
		}));
		if (!this.docsFolder || !folders.includes(this.docsFolder)) {
			this.docsFolder = folders[0];
		}
		const docsEnabled = vscode.workspace.getConfiguration(configSection).get<boolean>('docs.enabled', true);
		const sources = docsEnabled ? await this.docs.list().catch(() => [] as SourceView[]) : [];
		const docsFolder = this.docsFolder;
		const have = new Set([...sources.map(s => s.url), ...this.state.get<string[]>(dismissedKey, [])]);
		const suggestions = docsEnabled && docsFolder ? await suggestDocs(docsFolder, have).catch(() => []) : [];
		return {
			enabled: this.index.enabled,
			workspaces,
			docsEnabled,
			...docsFolder ? { docsFolder } : {},
			folders: folders.map(folder => ({ folder, name: path.basename(folder) || folder })),
			sources: sources.map(source => sourceView(source, docsFolder)),
			suggestions: suggestions.slice(0, 6).map(s => ({ title: s.title, url: s.url, library: s.library, ...s.version ? { version: s.version } : {} })),
			manifests: [...new Set(suggestions.map(s => s.manifest))],
		};
	}

	/** Sends the files left out of `folder`'s index to the page's popup. */
	private async postSkipped(folder: string): Promise<void> {
		const files = await this.index.skipped(folder).catch(() => []);
		void this.panel?.webview.postMessage({ type: 'skippedList', folder, name: path.basename(folder) || folder, files } satisfies ToIndexPage);
	}

	/**
	 * Adds `paths` to `gemini.index.include`, for the workspace folder when it
	 * is one in this window, else for the user; the index then reads them.
	 */
	private async include(folder: string, paths: readonly string[]): Promise<void> {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folder));
		const config = vscode.workspace.getConfiguration(configSection, vscode.Uri.file(folder));
		const target = workspaceFolder?.uri.fsPath === folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global;
		const inspected = config.inspect<string[]>('index.include');
		const current = (target === vscode.ConfigurationTarget.WorkspaceFolder ? inspected?.workspaceFolderValue : inspected?.globalValue) ?? [];
		// An exact path, so a name with glob characters matches only itself.
		const patterns = paths.map(file => `/${file.replace(/[*?[\]\\!#]/g, '\\$&')}`);
		await config.update('index.include', [...new Set([...current, ...patterns])], target);
	}

	private async openIgnoreFile(folder: string): Promise<void> {
		const file = vscode.Uri.file(path.join(folder, '.geminiignore'));
		try {
			await vscode.workspace.fs.stat(file);
		} catch {
			await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(vscode.l10n.t("# Files Gemini agents and GeminiCode's index leave out, in .gitignore syntax.\n")));
		}
		await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.Active });
	}

	private async pickFolder(): Promise<string | undefined> {
		const folders = (await this.agents.workspaces()).map(w => w.folder);
		if (folders.length <= 1) {
			return folders[0];
		}
		const pick = await vscode.window.showQuickPick(folders.map(folder => ({ label: path.basename(folder), description: tildify(path.dirname(folder)), folder })), { placeHolder: vscode.l10n.t("Which workspace?") });
		return pick?.folder;
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = createNonce();
		const strings: IndexPageStrings = {
			title: vscode.l10n.t("Index"),
			subtitle: vscode.l10n.t("What agents can look up without searching file by file: an index of each workspace and the docs you attach. Everything stays on this Mac, in ~/.geminicode/index."),
			enable: vscode.l10n.t("Keep indexes and give agents the index tools"),
			off: vscode.l10n.t("Indexing is off. Agents search file by file, as the Gemini CLI does on its own."),
			workspaces: vscode.l10n.t("Workspaces"),
			workspacesHint: vscode.l10n.t("Each workspace has its own index. It updates as files change, and when you switch branches."),
			noWorkspaces: vscode.l10n.t("Add a workspace folder for agents to work in."),
			indexed: vscode.l10n.t("indexed"),
			indexing: vscode.l10n.t("indexing"),
			paused: vscode.l10n.t("paused"),
			notIndexed: vscode.l10n.t("not indexed"),
			failed: vscode.l10n.t("failed"),
			untrusted: vscode.l10n.t("The Gemini CLI loads GeminiCode's tools only in trusted folders, so agents here can't use the index."),
			readOnly: vscode.l10n.t("Another GeminiCode window keeps this index up to date."),
			rebuild: vscode.l10n.t("Rebuild"),
			indexNow: vscode.l10n.t("Index Now"),
			pause: vscode.l10n.t("Pause"),
			resume: vscode.l10n.t("Resume"),
			removeIndex: vscode.l10n.t("Remove Index"),
			skippedFiles: vscode.l10n.t("Files Left Out"),
			trust: vscode.l10n.t("Trust Folder"),
			reveal: vscode.l10n.t("Reveal in Finder"),
			more: vscode.l10n.t("More Actions"),
			docs: vscode.l10n.t("Docs"),
			docsHint: vscode.l10n.t("Pages agents can search in {0}. Fetched from this Mac and treated as reference, never as instructions."),
			docsOff: vscode.l10n.t("Adding documentation is turned off (gemini.docs.enabled)."),
			addDocs: vscode.l10n.t("Add Docs"),
			noDocs: vscode.l10n.t("No docs yet. Add a library's documentation, such as https://react.dev/reference, and agents can search it with docs_search."),
			attach: vscode.l10n.t("Agents in this workspace can search these docs"),
			refreshSource: vscode.l10n.t("Refresh"),
			removeSource: vscode.l10n.t("Remove"),
			openPage: vscode.l10n.t("Open Page"),
			fetching: vscode.l10n.t("fetching"),
			retry: vscode.l10n.t("Retry"),
			suggestions: vscode.l10n.t("Suggested from your dependencies"),
			suggestionsHint: vscode.l10n.t("Found in {0}. Adding one fetches the docs for the version you use."),
			add: vscode.l10n.t("Add"),
			dismiss: vscode.l10n.t("Dismiss"),
			addTitle: vscode.l10n.t("Add Docs"),
			addSubtitle: vscode.l10n.t("Agents in the workspaces you pick can search these pages."),
			address: vscode.l10n.t("Address"),
			addressPlaceholder: 'https://react.dev/reference',
			what: vscode.l10n.t("What to fetch"),
			scopePage: vscode.l10n.t("Only this page"),
			scopePrefix: vscode.l10n.t("Pages under this address"),
			scopePrefixHint: vscode.l10n.t("Uses the site's llms.txt or sitemap when it has one, otherwise follows links under the address"),
			scopeSite: vscode.l10n.t("The whole site"),
			upTo: vscode.l10n.t("Up to"),
			pagesUnit: vscode.l10n.t("pages"),
			refresh: vscode.l10n.t("Refresh"),
			refreshDefault: vscode.l10n.t("As in settings"),
			refreshDaily: vscode.l10n.t("Daily"),
			refreshWeekly: vscode.l10n.t("Weekly"),
			refreshManual: vscode.l10n.t("Only when I ask"),
			attachTo: vscode.l10n.t("Workspaces"),
			fine: vscode.l10n.t("Fetched from this Mac, through its network settings. Pages are stored once, on this Mac, and never sent anywhere else."),
			cancel: vscode.l10n.t("Cancel"),
			addAndFetch: vscode.l10n.t("Add and Fetch"),
			close: vscode.l10n.t("Close"),
			skippedTitle: vscode.l10n.t("Files Left Out of {0}", '{0}'),
			skippedCount: vscode.l10n.t("{0} files", '{0}'),
			skippedHint: vscode.l10n.t("Index Anyway adds a file to gemini.index.include, and it is indexed in a moment. Secret files and binary content are never indexed."),
			skippedFilter: vscode.l10n.t("Filter by path or reason"),
			skippedNone: vscode.l10n.t("Nothing is left out of this index."),
			skippedLoading: vscode.l10n.t("Reading the index\u2026"),
			skippedGroup: vscode.l10n.t("{0} files", '{0}'),
			indexAnyway: vscode.l10n.t("Index Anyway"),
			indexAllAnyway: vscode.l10n.t("Index All Anyway"),
			included: vscode.l10n.t("Included"),
			neverIndexed: vscode.l10n.t("never indexed"),
			skippedMore: vscode.l10n.t("{0} more; filter to find them", '{0}'),
			tooManyForAll: vscode.l10n.t("Too many to include one by one; add a pattern to gemini.index.include instead."),
			openIgnoreFile: vscode.l10n.t("Open .geminiignore"),
			editInclude: vscode.l10n.t("Edit Included Files"),
		};
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'indexPage.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panels.css'));
		const menuStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'menu.css'));
		const codicons = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.css'));
		const glassStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'glass.css'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data: ${webview.cspSource}; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codicons}" rel="stylesheet">
	<link href="${menuStyle}" rel="stylesheet">
	<link href="${style}" rel="stylesheet">
	<link href="${glassStyle}" rel="stylesheet">
	<title>${strings.title}</title>
</head>
<body class="settings-page index-page">
	<main id="page" class="settings"></main>
	<script nonce="${nonce}" type="module" src="${script}" data-strings="${escapeAttribute(JSON.stringify(strings))}" data-max-pages="${defaultMaxPages}"></script>
</body>
</html>`;
	}
}

function clampPages(pages: number): number {
	return Math.max(1, Math.min(Number.isFinite(pages) ? Math.floor(pages) : defaultMaxPages, 5_000));
}

/** A workspace's state, its line of detail and, while building, how far it is. */
function describe(status: IndexStatus | undefined): Pick<IndexWorkspaceView, 'state' | 'detail' | 'progress' | 'skipped'> {
	const state = status?.state;
	switch (state?.kind) {
		case 'ready': {
			const parts = [
				state.files === 1 ? vscode.l10n.t("1 file") : vscode.l10n.t("{0} files", state.files.toLocaleString()),
				state.symbols === 1 ? vscode.l10n.t("1 symbol") : vscode.l10n.t("{0} symbols", state.symbols.toLocaleString()),
				formatBytes(state.bytes),
				vscode.l10n.t("updated {0}", relativeAge(state.updatedAt)),
			];
			return { state: 'ready', detail: parts.join(' · '), skipped: state.skipped };
		}
		case 'building': {
			const progress = state.total ? state.done / state.total : 0;
			const detail = state.first
				? vscode.l10n.t("{0} of {1} files · agents use plain text search until it's ready", state.done.toLocaleString(), state.total.toLocaleString())
				: vscode.l10n.t("Updating {0} of {1} changed files", state.done.toLocaleString(), state.total.toLocaleString());
			return { state: 'building', detail, progress, skipped: 0 };
		}
		case 'paused':
			return { state: 'paused', detail: vscode.l10n.t("Paused at {0} of {1} files", state.done.toLocaleString(), state.total.toLocaleString()), progress: state.total ? state.done / state.total : 0, skipped: 0 };
		case 'failed':
			return { state: 'failed', detail: state.message, skipped: 0 };
		default: {
			const buildOn = indexBuildOn();
			const detail = buildOn === 'manual' ? vscode.l10n.t("Not indexed yet") : buildOn === 'workspaceOpen' ? vscode.l10n.t("Indexes when the window opens") : vscode.l10n.t("Indexes when an agent first starts here");
			return { state: 'none', detail, skipped: 0 };
		}
	}
}

function sourceView(source: SourceView, folder: string | undefined): DocsSourceView {
	const others = source.folders.filter(f => f !== folder).length;
	const refresh = refreshLabel(source.refresh);
	const parts = [
		source.pages !== undefined ? (source.pages === 1 ? vscode.l10n.t("1 page") : vscode.l10n.t("{0} pages", source.pages.toLocaleString())) : '',
		source.sections !== undefined ? vscode.l10n.t("{0} sections", source.sections.toLocaleString()) : '',
		source.fetchedAt ? vscode.l10n.t("refreshed {0}", relativeAge(source.fetchedAt)) : '',
		refresh,
		others === 1 ? vscode.l10n.t("also used by 1 other workspace") : others > 1 ? vscode.l10n.t("also used by {0} other workspaces", others) : '',
	].filter(Boolean);
	return {
		id: source.id,
		title: source.title ?? provisionalTitle(source.url),
		url: source.url,
		detail: parts.join(' · '),
		attached: !!folder && source.folders.includes(folder),
		fetching: source.fetching,
		...source.error ? { error: source.error } : {},
		...source.refresh ? { refresh: source.refresh } : {},
	};
}

function refreshLabel(refresh: DocsRefresh | undefined): string {
	switch (refresh) {
		case 'daily': return vscode.l10n.t("daily");
		case 'weekly': return vscode.l10n.t("weekly");
		case 'manual': return vscode.l10n.t("refreshed only when you ask");
		default: return '';
	}
}

function formatBytes(bytes: number): string {
	return bytes >= 1024 * 1024 ? vscode.l10n.t("{0} MB", (bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)) : vscode.l10n.t("{0} KB", Math.max(1, Math.round(bytes / 1024)));
}

function relativeAge(at: number): string {
	const minutes = Math.floor((Date.now() - at) / 60_000);
	if (minutes < 1) {
		return vscode.l10n.t("just now");
	}
	if (minutes < 60) {
		return minutes === 1 ? vscode.l10n.t("1 minute ago") : vscode.l10n.t("{0} minutes ago", minutes);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return hours === 1 ? vscode.l10n.t("1 hour ago") : vscode.l10n.t("{0} hours ago", hours);
	}
	const days = Math.floor(hours / 24);
	return days === 1 ? vscode.l10n.t("yesterday") : vscode.l10n.t("{0} days ago", days);
}
