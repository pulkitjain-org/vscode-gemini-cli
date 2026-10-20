/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { onDidChangeSpellCheck, spellCheckOn } from './spellCheck';
import { isModeAllowed } from '../acp/adminPolicy';
import { errorMessage } from '../acp/errors';
import type { JiraClient } from '../acp/jira';
import { formatCounts } from '../acp/agentChanges';
import { attachmentsForFiles } from './addToChat';
import { AgentsView, AgentSummary, relativeTime, startModes } from './agentsView';
import { startsQuietly } from './agentWarmup';
import { detectAuth } from '../acp/directRequest';
import { tildify } from './displayText';
import { configSection, getApprovalPolicy, getProjectSettings } from './configuration';
import { preferredModel } from './modelPreference';
import { moveCard, toggleCard, type DashboardLayout } from '../acp/dashboard';
import { buildDashboard, DashboardInput, StartupState } from './homeDashboard';
import { FromHome, HomeAction, HomeAgent, HomeCardId, HomeProject, HomeStrings, HomeView, ToHome } from './panelProtocol';
import { TeamData } from './teamData';
import type { TeamConnections } from './teamConnections';
import { projectsEnabled } from './projects';
import { agentsColumn } from './editorPlacement';
import { createNonce, escapeAttribute } from './webviewHtml';
import { openTeamLink } from './teamLinks';

const homeViewType = 'gemini.agentHome';
const layoutKey = 'gemini.home.layout';
const firstConnectedKey = 'gemini.home.firstConnectedAt';
/** How fresh the tools' data must be when Home shows or the window gets focus. */
const showRefreshMs = 60_000;
/** How often the tools' data is refreshed while Home is visible. */
const visibleRefreshMs = 5 * 60_000;
const weekMs = 7 * 24 * 60 * 60_000;

export interface HomeOptions {
	readonly state: vscode.Memento;
	readonly version: string;
	/** The running Gemini CLI's version, for the Gemini card. */
	readonly cli?: () => string | undefined;
	/** What came back since the window opened, for the card shown after a start. */
	readonly startup?: () => StartupState;
}
/** Earlier agents listed; the Agents pane has them all. */
const maxEarlier = 8;
/** How often agent updates reach the page at most. */
const updateDelayMs = 200;
/** How long Home trusts its last reading of the saved sign-in. */
const signInCheckMs = 5_000;

type Mode = 'agents' | 'editor';

/**
 * Home: the dashboard GeminiCode opens with. A composer starts a new agent in
 * one step; around it the team tools' state, what needs the user ("Needs
 * you") and cards for agents, Jira tickets, merge requests, quality, releases
 * and Gemini. It opens in front at every launch (`gemini.home.openOnStartup`),
 * whenever the editor area is empty in Agents mode, and from the Agents pane.
 * The tools' data shows at once from the last answers and refreshes in the
 * background while the page is visible; nothing here starts the Gemini CLI.
 */
export class AgentHome implements vscode.Disposable {

	private panel: vscode.WebviewPanel | undefined;
	private mode: Mode = 'editor';
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** The last view posted, to skip posting the same one again. */
	private lastView: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly teamData: TeamData | undefined;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private signIn: { readonly at: number; readonly quiet: Promise<boolean> } | undefined;
	/** The card whose whole list the page has open in its popup. */
	private listCard: HomeCardId | undefined;

	/** `onTyping` runs when the user starts typing a task, so the agent can start meanwhile. */
	constructor(private readonly extensionUri: vscode.Uri, private readonly agents: AgentsView, private readonly onTyping: () => void = () => undefined, private readonly options?: HomeOptions) {
		const team = agents.teamTools;
		if (team && options) {
			this.teamData = new TeamData(options.state, team);
			this.disposables.push(this.teamData, this.teamData.onDidChange(() => this.schedule()), team.onDidChange(() => {
				if (team.connected.size && !options.state.get<number>(firstConnectedKey)) {
					void options.state.update(firstConnectedKey, Date.now());
				}
				this.schedule();
			}));
		}
		// One click back to Home from anywhere: the house at the start of the title bar (geminiModes.ts) runs gemini.home.
		this.disposables.push(
			onDidChangeSpellCheck(on => void this.panel?.webview.postMessage({ type: 'spellCheck', on } satisfies ToHome)),
			vscode.commands.registerCommand('gemini.agentHome', () => this.show(false)),
			vscode.commands.registerCommand('gemini.home', () => this.show(false)),
			vscode.window.onDidChangeWindowState(state => state.focused && this.panel?.visible && this.refreshTools(showRefreshMs)),
			agents.usage?.onDidChange(() => this.schedule()) ?? { dispose: () => undefined },
			// GeminiCode's workbench reports the window mode.
			vscode.commands.registerCommand('_gemini.modeChanged', (mode: Mode) => this.setMode(mode)),
			vscode.window.tabGroups.onDidChangeTabs(e => {
				// Closing Agent Home itself leaves the area empty on purpose.
				if (this.mode === 'agents' && e.closed.length && !e.closed.some(isHomeTab) && openTabs() === 0) {
					this.show(true);
				}
			}),
			agents.onDidChangeAgents(() => this.schedule()),
		);
		void Promise.resolve(vscode.commands.executeCommand<Mode>('_gemini.getMode')).then(mode => this.setMode(mode), () => undefined);
		// In front of the restored tabs, in either mode; off, Home opens as Agent Home did.
		if (vscode.workspace.getConfiguration(configSection).get<boolean>('home.openOnStartup', true)) {
			this.show(false);
		}
	}

	show(preserveFocus: boolean): void {
		if (this.panel) {
			this.panel.reveal(undefined, preserveFocus);
			return;
		}
		if (this.opening) {
			return;
		}
		// Beside the agents, never in one agent's side group.
		this.opening = agentsColumn().then(viewColumn => this.create(viewColumn, preserveFocus)).finally(() => this.opening = undefined);
	}

	private opening: Promise<void> | undefined;

	private create(viewColumn: vscode.ViewColumn, preserveFocus: boolean): void {
		if (this.panel) {
			this.panel.reveal(undefined, preserveFocus);
			return;
		}
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		const panel = vscode.window.createWebviewPanel(homeViewType, vscode.l10n.t("Home"), { viewColumn, preserveFocus }, {
			enableScripts: true,
			localResourceRoots: [media],
		});
		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'gemini.svg');
		panel.webview.html = this.html(panel.webview, media);
		panel.webview.onDidReceiveMessage((message: FromHome) => this.onMessage(message).catch(err => void vscode.window.showErrorMessage(errorMessage(err))));
		panel.onDidChangeViewState(e => {
			if (e.webviewPanel.visible) {
				this.schedule(0);
				this.refreshTools(showRefreshMs);
			}
			this.setRefreshTimer(e.webviewPanel.visible);
			// Switching to Agent Home puts the cursor in its prompt.
			if (e.webviewPanel.active) {
				void panel.webview.postMessage({ type: 'focus' } satisfies ToHome);
			}
		});
		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
				this.listCard = undefined;
				this.setRefreshTimer(false);
			}
		});
		this.panel = panel;
		this.setRefreshTimer(true);
	}

	private setRefreshTimer(on: boolean): void {
		if (on && !this.refreshTimer) {
			this.refreshTimer = setInterval(() => this.refreshTools(visibleRefreshMs), visibleRefreshMs);
		} else if (!on && this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	/** Refreshes the tools' state and data in the background unless they're fresher than `maxAgeMs`. */
	private refreshTools(maxAgeMs: number, force = false): void {
		const team = this.agents.teamTools;
		if (!team?.connected.size || !this.teamData) {
			return;
		}
		const data = this.teamData;
		void (force ? team.refresh() : team.refreshIfOlder(maxAgeMs));
		void this.agents.workspaces().then(workspaces => {
			const folder = workspaces[0]?.folder;
			const branch = this.layout().qualityBranch;
			return force ? data.refresh(folder, branch) : data.refreshIfOlder(maxAgeMs, folder, branch);
		}).finally(() => this.schedule());
		this.schedule();
	}

	private layout(): DashboardLayout {
		return this.options?.state.get<DashboardLayout>(layoutKey) ?? {};
	}

	private async setLayout(layout: DashboardLayout): Promise<void> {
		await this.options?.state.update(layoutKey, layout);
		this.schedule(0);
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.setRefreshTimer(false);
		this.panel?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private setMode(mode: Mode | undefined): void {
		this.mode = mode === 'agents' ? 'agents' : 'editor';
		if (this.mode === 'agents' && openTabs() === 0) {
			this.show(true);
		}
	}

	/** At most one update per `updateDelayMs`, so steady agent activity can't hold the cards back; `0` updates now. */
	private schedule(delay = updateDelayMs): void {
		if (!this.panel?.visible) {
			return;
		}
		if (delay === 0) {
			clearTimeout(this.timer);
		} else if (this.timer !== undefined) {
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.update();
		}, delay);
	}

	private async update(): Promise<void> {
		const panel = this.panel;
		if (!panel) {
			return;
		}
		const view = await this.build();
		const json = JSON.stringify(view);
		// Closed while building (the webview throws once disposed), or nothing changed.
		if (this.panel !== panel || json === this.lastView) {
			return;
		}
		this.lastView = json;
		void panel.webview.postMessage({ type: 'view', view } satisfies ToHome);
	}

	private async build(): Promise<HomeView> {
		const now = Date.now();
		const workspaces = (await this.agents.workspaces()).map(w => ({ folder: w.folder, name: path.basename(w.folder) || w.folder, description: tildify(path.dirname(w.folder)), git: w.git }));
		const all = this.agents.summaries();
		// Projects and their threads have their own list.
		const summaries = all.filter(a => !a.project);
		const isActive = (a: AgentSummary) => a.state === 'working' || a.state === 'waiting' || a.state === 'done' || a.state === 'error' || !!a.changes?.files;
		const toView = (a: AgentSummary): HomeAgent => ({
			id: a.id, title: a.title, workspace: path.basename(a.folder), state: a.state, status: a.status,
			...(a.changes?.files ? { changes: a.changes.files === 1 ? vscode.l10n.t("{0} in 1 file", formatCounts(a.changes)) : vscode.l10n.t("{0} in {1} files", formatCounts(a.changes), a.changes.files) } : {}),
			...(a.worktree ? { branch: a.worktree.branch } : {}),
			updated: relativeTime(a.updatedAt, now),
		});
		return {
			workspaces,
			active: summaries.filter(isActive).map(toView),
			earlier: summaries.filter(a => !isActive(a)).slice(0, maxEarlier).map(toView),
			...(projectsEnabled() ? {
				projects: all.flatMap((a): HomeProject[] => a.project?.role === 'coordinator' ? [{
					id: a.id, title: a.title, workspace: path.basename(a.folder), state: a.state, updated: relativeTime(a.updatedAt, now),
					threads: a.project.threads === 1 ? vscode.l10n.t("1 thread") : vscode.l10n.t("{0} threads", a.project.threads),
				}] : []),
			} : {}),
			ownBranch: vscode.workspace.getConfiguration(configSection).get<boolean>('agents.ownBranch', false),
			modes: startModes().filter(mode => isModeAllowed(getApprovalPolicy(), mode.id)),
			...preferredModel() ? { model: preferredModel() } : {},
			dashboard: this.dashboard(all, workspaces[0]?.name, await this.unfinished(), await this.signedIn(), (await this.agents.teamTools?.workspaceDefaults().catch(() => undefined))?.jira?.commentVisibility),
		};
	}

	/** Whether the CLI has a saved sign-in, read at most every few seconds since Home rebuilds often. */
	private async signedIn(): Promise<boolean> {
		if (!this.signIn || Date.now() - this.signIn.at > signInCheckMs) {
			this.signIn = { at: Date.now(), quiet: detectAuth().then(auth => startsQuietly(auth), () => false) };
		}
		return this.signIn.quiet;
	}

	/** What a quit cut off, from the team tools' records on disk; nothing without them. */
	private async unfinished(): Promise<DashboardInput['unfinished']> {
		const team = this.agents.teamTools;
		if (!team) {
			return undefined;
		}
		const [flows, intents] = await Promise.all([team.flows.list().catch(() => []), team.audit.unfinished().catch(() => [])]);
		return { flows, intents };
	}

	private dashboard(agents: readonly AgentSummary[], repository: string | undefined, unfinished: DashboardInput['unfinished'], signedIn: boolean, commentVisibility: string | undefined): HomeView['dashboard'] {
		const team = this.agents.teamTools;
		const firstConnected = this.options?.state.get<number>(firstConnectedKey);
		const reading = this.agents.usage?.reading;
		const cli = this.options?.cli?.();
		const projectId = getProjectSettings().resolved?.projectId;
		return buildDashboard({
			now: new Date(),
			connected: team?.connected ?? new Set(),
			state: tool => team?.state(tool) ?? { kind: 'off' },
			data: this.teamData?.snapshot ?? {},
			agents,
			repository,
			layout: this.layout(),
			usage: reading?.kind === 'ok' ? reading.quota : undefined,
			versions: { app: this.options?.version ?? '', ...cli ? { cli } : {} },
			...projectId ? { projectId } : {},
			signedIn,
			...this.teamData?.refreshedAt ? { dataFrom: this.teamData.refreshedAt } : {},
			...this.options?.startup ? { startup: this.options.startup() } : {},
			projectsOn: projectsEnabled(),
			refreshing: !!this.teamData && Date.now() - this.teamData.refreshedAt < 3000,
			hideUnconnected: !!firstConnected && Date.now() - firstConnected > weekMs,
			gitlabUrl: team?.connectors.gitlab?.url,
			jiraUrl: team?.connectors.jira?.site,
			...commentVisibility ? { jiraCommentVisibility: commentVisibility } : {},
			...unfinished ? { unfinished } : {},
			...this.listCard ? { list: this.listCard } : {},
		});
	}

	private async runAction(action: HomeAction): Promise<void> {
		switch (action.kind) {
			case 'link':
				if (/^https?:\/\//i.test(action.url)) {
					await openTeamLink(action.url);
				}
				return;
			case 'agent':
				return this.onMessage({ type: action.do, id: action.id });
			case 'command':
				// Only GeminiCode's own commands and opening a folder: the page can't run anything else.
				if (/^gemini\.|^workbench\.action\.files\.openFolder$|^workbench\.view\.extension\.gemini/.test(action.command)) {
					await vscode.commands.executeCommand(action.command, ...action.args ?? []);
				}
				return;
			case 'comment':
				// The page opens its comment box itself; the comment comes back as a 'comment' message.
				return;
		}
	}

	/** The team tools and the Jira client for the comment box, which always goes to Jira's REST API (never mcp-atlassian in Docker). */
	private jira(): { readonly team: TeamConnections; readonly client: JiraClient } {
		const team = this.agents.teamTools;
		const client = team?.connected.has('jira') ? team.connectors.jira : undefined;
		if (!team || !client) {
			throw new Error(vscode.l10n.t("Connect Jira in Connections to comment on tickets."));
		}
		return { team, client };
	}

	/**
	 * Posts a comment from Home's comment box as Jira rich text, through the
	 * same audited write as the other pages (teamTools.ts, jira_rich_comment).
	 * Pasted files are written to a folder of their own first, and removed after.
	 */
	private async postComment(message: Extract<FromHome, { type: 'comment' }>): Promise<void> {
		let error: string | undefined;
		let pasted: string | undefined;
		try {
			const { team } = this.jira();
			const files = [...message.files];
			if (message.pasted.length) {
				pasted = await fs.mkdtemp(path.join(os.tmpdir(), 'geminicode-comment-'));
				for (const [i, file] of message.pasted.entries()) {
					// Each in a folder of its own, so two pasted "image.png" keep their names.
					const folder = path.join(pasted, String(i));
					await fs.mkdir(folder);
					const target = path.join(folder, path.basename(file.name) || 'file');
					await fs.writeFile(target, Buffer.from(file.data, 'base64'));
					files.push(target);
				}
			}
			await team.write('jira_rich_comment', {
				key: message.key, markdown: message.markdown, document: message.document, files,
				...message.visibility ? { visibility: message.visibility } : {},
			});
		} catch (err) {
			error = errorMessage(err);
		} finally {
			if (pasted) {
				await fs.rm(pasted, { recursive: true, force: true }).catch(() => undefined);
			}
		}
		void this.panel?.webview.postMessage({ type: 'commented', key: message.key, ...error ? { error } : {} } satisfies ToHome);
	}

	/** Who @ can mention in a comment on `key`: people who can see the ticket. */
	private async commentPeople(key: string, query: string, id: number): Promise<void> {
		let answer: ToHome;
		try {
			const users = await this.jira().client.mentionableUsers(key, query);
			answer = { type: 'commentPeople', id, people: users.map(u => ({ accountId: u.accountId, name: u.displayName, ...u.emailAddress ? { email: u.emailAddress } : {} })) };
		} catch (err) {
			answer = { type: 'commentPeople', id, people: [], error: errorMessage(err) };
		}
		void this.panel?.webview.postMessage(answer);
	}

	private async commentOptions(key: string): Promise<void> {
		const { roles, groups } = await Promise.resolve().then(() => this.jira().client.commentVisibilities(key)).catch(() => ({ roles: [], groups: [] }));
		void this.panel?.webview.postMessage({ type: 'commentOptions', key, roles, groups } satisfies ToHome);
	}

	/** Files to attach: dropped ones by their URIs, or picked. */
	private async commentFiles(uris: readonly string[] | undefined): Promise<void> {
		const picked = uris
			? uris.map(uri => vscode.Uri.parse(uri)).filter(uri => uri.scheme === 'file')
			: await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: vscode.l10n.t("Attach"), title: vscode.l10n.t("Attach Files to the Comment") }) ?? [];
		const files = await Promise.all(picked.map(async uri => {
			const stat = await fs.stat(uri.fsPath).catch(() => undefined);
			return stat?.isFile() ? [{ path: uri.fsPath, name: path.basename(uri.fsPath), size: stat.size }] : [];
		}));
		void this.panel?.webview.postMessage({ type: 'commentFiles', files: files.flat() } satisfies ToHome);
	}

	private async onMessage(message: FromHome): Promise<void> {
		switch (message.type) {
			case 'ready':
				// A page loaded afresh has no list open.
				this.listCard = undefined;
				this.lastView = undefined;
				await this.update();
				void this.panel?.webview.postMessage({ type: 'focus' } satisfies ToHome);
				this.refreshTools(showRefreshMs);
				return;
			case 'start':
				if (message.text.trim()) {
					if (!await this.agents.startWithPrompt(message.folder, message.text.trim(), message.ownBranch, message.mode, message.attachments)) {
						void this.panel?.webview.postMessage({ type: 'startFailed', text: message.text } satisfies ToHome);
					}
				}
				return;
			case 'typing':
				this.onTyping();
				if (!message.ownBranch) {
					this.agents.prepareStart(message.folder);
				}
				return;
			case 'newProject':
				await vscode.commands.executeCommand('gemini.projects.new');
				return;
			case 'addFolder':
				await vscode.commands.executeCommand('workbench.action.addRootFolder');
				return;
			case 'pickFiles': {
				const uris = await vscode.window.showOpenDialog({
					canSelectMany: true,
					canSelectFiles: true,
					canSelectFolders: false,
					openLabel: vscode.l10n.t("Attach"),
					title: vscode.l10n.t("Attach Files to the Task"),
				});
				if (uris?.length) {
					void this.panel?.webview.postMessage({ type: 'attached', attachments: await attachmentsForFiles(uris) } satisfies ToHome);
				}
				return;
			}
			case 'projectHelpers':
				await vscode.commands.executeCommand('gemini.projectSettings');
				return;
			case 'open':
				await this.agents.open(message.id);
				return;
			case 'stop':
				this.agents.stopTurn(message.id);
				return;
			case 'review':
				await this.agents.openChanges(message.id);
				return;
			case 'mergeBack':
				await this.agents.mergeBack(message.id);
				return;
			case 'action':
				await this.runAction(message.action);
				return;
			case 'refresh':
				this.refreshTools(0, true);
				return;
			case 'layout': {
				let layout = this.layout();
				if (message.visible !== undefined) {
					layout = toggleCard(layout, message.card, message.visible);
				}
				if (message.move) {
					layout = moveCard(layout, message.card, message.move);
				}
				await this.setLayout(layout);
				return;
			}
			case 'qualityBranch':
				await this.setLayout({ ...this.layout(), qualityBranch: message.branch });
				this.refreshTools(0, true);
				return;
			case 'showList':
				this.listCard = message.card;
				await this.update();
				return;
			case 'comment':
				await this.postComment(message);
				return;
			case 'commentPeople':
				await this.commentPeople(message.key, message.query, message.id);
				return;
			case 'commentOptions':
				await this.commentOptions(message.key);
				return;
			case 'commentFiles':
				await this.commentFiles(message.uris);
				return;
		}
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = createNonce();
		const strings: HomeStrings = {
			title: vscode.l10n.t("What should an agent do?"),
			writeLabel: vscode.l10n.t("Write"),
			previewLabel: vscode.l10n.t("Preview"),
			previewMarkdown: vscode.l10n.t("Preview ({0})"),
			previewEmpty: vscode.l10n.t("Nothing to preview yet."),
			calloutNote: vscode.l10n.t("Note"),
			calloutTip: vscode.l10n.t("Tip"),
			calloutImportant: vscode.l10n.t("Important"),
			calloutWarning: vscode.l10n.t("Warning"),
			calloutCaution: vscode.l10n.t("Caution"),
			subtitle: vscode.l10n.t("Describe the task. A new agent starts on it right away, and you can start more while it works."),
			placeholder: vscode.l10n.t("Fix the rounding in the cart total and add a test"),
			start: vscode.l10n.t("Start Agent"),
			ownBranch: vscode.l10n.t("On its own branch"),
			ownBranchHint: vscode.l10n.t("The agent works in its own copy of the repository, on a new branch. Merge Back brings its work into yours."),
			workspace: vscode.l10n.t("Workspace"),
			addFolder: vscode.l10n.t("Add Folder to Workspace..."),
			projectHelpers: vscode.l10n.t("Project Helpers"),
			projectHelpersHint: vscode.l10n.t("MCP servers, rules and hooks for your projects"),
			plusMenu: vscode.l10n.t("Add files and pick a mode"),
			mode: vscode.l10n.t("Mode"),
			files: vscode.l10n.t("Files"),
			filesDetail: vscode.l10n.t("Attach files or images"),
			remove: vscode.l10n.t("Remove"),
			active: vscode.l10n.t("Agents"),
			earlier: vscode.l10n.t("Earlier"),
			projects: vscode.l10n.t("Projects"),
			noProjects: vscode.l10n.t("No projects yet. A project's coordinator splits work into threads, each an agent on its own branch."),
			newProject: vscode.l10n.t("New Project"),
			open: vscode.l10n.t("Open"),
			stop: vscode.l10n.t("Stop"),
			review: vscode.l10n.t("Review"),
			mergeBack: vscode.l10n.t("Merge Back"),
			noAgents: vscode.l10n.t("No agents are running. Start one above."),
			noWorkspace: vscode.l10n.t("Add a workspace folder for agents to work in."),
			customize: vscode.l10n.t("Customize"),
			refresh: vscode.l10n.t("Refresh"),
			needsYou: vscode.l10n.t("Needs you"),
			showCard: vscode.l10n.t("Show"),
			moveUp: vscode.l10n.t("Move Up"),
			moveDown: vscode.l10n.t("Move Down"),
			cards: vscode.l10n.t("Cards"),
			qualityBranch: vscode.l10n.t("Release branch for Quality"),
			getStarted: vscode.l10n.t("Get started"),
			composerPlaceholder: vscode.l10n.t("Describe a task, or paste a Jira, GitLab or Figma link..."),
			moreActions: vscode.l10n.t("More Actions"),
			fromTools: vscode.l10n.t("From Your Tools..."),
			fromToolsEmpty: vscode.l10n.t("Connect Jira or GitLab in Connections to start from a ticket or a merge request."),
			tickets: vscode.l10n.t("My tickets"),
			mergeRequests: vscode.l10n.t("Merge requests"),
			showAll: vscode.l10n.t("Show All ({0})"),
			filterList: vscode.l10n.t("Filter"),
			noMatches: vscode.l10n.t("Nothing matches."),
			close: vscode.l10n.t("Close"),
			commentTitle: vscode.l10n.t("Comment on {0}"),
			commentPlaceholder: vscode.l10n.t("Write a comment. Blank lines start paragraphs."),
			commentHelp: vscode.l10n.t("Posted to Jira as you. Markdown works: **bold**, _italic_, `code`, lists, - [ ] tasks, > quotes, > [!NOTE] panels and tables. Type @ to mention someone, and paste or drop files to attach them."),
			commentPost: vscode.l10n.t("Post Comment"),
			commentPosting: vscode.l10n.t("Posting..."),
			commentPosted: vscode.l10n.t("Commented on {0}."),
			commentBold: vscode.l10n.t("Bold"),
			commentItalic: vscode.l10n.t("Italic"),
			commentStrike: vscode.l10n.t("Strikethrough"),
			commentCode: vscode.l10n.t("Code"),
			commentLink: vscode.l10n.t("Link"),
			commentBullets: vscode.l10n.t("Bulleted List"),
			commentNumbers: vscode.l10n.t("Numbered List"),
			commentTasks: vscode.l10n.t("Task List"),
			commentQuote: vscode.l10n.t("Quote"),
			commentPanel: vscode.l10n.t("Info Panel"),
			commentCodeBlock: vscode.l10n.t("Code Block"),
			commentTable: vscode.l10n.t("Table"),
			commentRule: vscode.l10n.t("Divider"),
			commentMention: vscode.l10n.t("Mention Someone"),
			commentAttach: vscode.l10n.t("Attach Files"),
			commentFormatting: vscode.l10n.t("Formatting"),
			commentDrop: vscode.l10n.t("Drop files to attach them"),
			commentNoPeople: vscode.l10n.t("No one matches."),
			commentSearching: vscode.l10n.t("Searching..."),
			commentVisibleTo: vscode.l10n.t("Visible to"),
			commentEveryone: vscode.l10n.t("Everyone who can see the ticket"),
			commentRoles: vscode.l10n.t("Project roles"),
			commentGroups: vscode.l10n.t("Groups"),
			commentTooLarge: vscode.l10n.t("{0} is too large to attach from here. Attach it with the paperclip instead."),
			commentShortcut: vscode.l10n.t("{0} ({1})"),
			commentTipWrite: vscode.l10n.t("Write the comment in Markdown"),
			commentTipBullets: vscode.l10n.t("Bulleted List: a - at the start of each line"),
			commentTipNumbers: vscode.l10n.t("Numbered List: 1. 2. 3. at the start of each line"),
			commentTipTasks: vscode.l10n.t("Task List: each line gets a checkbox in Jira"),
			commentTipQuote: vscode.l10n.t("Quote: a > at the start of each line"),
			commentTipPanel: vscode.l10n.t("Info Panel: a > [!NOTE] block, shown as a coloured panel in Jira. TIP, IMPORTANT, WARNING or CAUTION give the other colours."),
			commentTipCodeBlock: vscode.l10n.t("Code Block: keeps spacing; add the language after the opening ``` to highlight it"),
			commentTipTable: vscode.l10n.t("Table: a header row and a row to fill in"),
			commentTipRule: vscode.l10n.t("Divider: a line across the comment"),
			commentTipMention: vscode.l10n.t("Mention Someone: Jira notifies them. You can also type @"),
			commentTipAttach: vscode.l10n.t("Attach Files: uploaded to the ticket and linked from the comment. You can also paste or drop them."),
			commentTipVisibility: vscode.l10n.t("Who can see this comment in Jira"),
			commentTipCancel: vscode.l10n.t("Close without posting. What you wrote is kept until Home closes."),
			commentRemoveFile: vscode.l10n.t("Remove {0}"),
			cancel: vscode.l10n.t("Cancel"),
		};
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'home.js'));
		// Preview's renderer, loaded at idle or on the first Preview so home.js stays small.
		const draftMarkdown = webview.asWebviewUri(vscode.Uri.joinPath(media, 'draftMarkdown.js'));
		// The comment box for Jira tickets, loaded the first time it opens.
		const commentBox = webview.asWebviewUri(vscode.Uri.joinPath(media, 'commentBox.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panels.css'));
		const menuStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'menu.css'));
		const homeStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'home.css'));
		const codicons = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codicon.css'));
		const glassStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'glass.css'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data: ${webview.cspSource}; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codicons}" rel="stylesheet">
	<link href="${menuStyle}" rel="stylesheet">
	<link href="${style}" rel="stylesheet">
	<link href="${homeStyle}" rel="stylesheet">
	<link href="${glassStyle}" rel="stylesheet">
	<title>Home</title>
</head>
<body class="agent-home" spellcheck="false">
	<main class="home dash">
		<header class="dash-head">
			<h1 id="title"></h1><p id="subtitle" class="muted"></p><span id="stale" class="dash-pill" hidden></span>
			<div class="dash-tools"><span id="tools" class="dash-tool-logos"></span><button type="button" id="refresh" class="icon-button"><i class="codicon codicon-refresh" aria-hidden="true"></i></button><span class="dash-customize"><button type="button" id="customize" class="icon-button"><i class="codicon codicon-settings-gear" aria-hidden="true"></i></button><div id="customize-menu" class="home-menu" hidden></div></span></div>
		</header>
		<div id="banner" class="dash-banner" hidden></div>
		<section class="home-start">
			<form id="composer" class="home-composer">
				<div id="attachments" class="attachments" hidden></div>
				<div class="composer-tabs" role="tablist"><button type="button" id="tab-write" class="composer-tab" role="tab" aria-selected="true" aria-controls="prompt"></button><button type="button" id="tab-preview" class="composer-tab" role="tab" aria-selected="false" aria-controls="preview"></button></div>
				<textarea id="prompt" rows="3" spellcheck="${spellCheckOn()}"></textarea>
				<div id="preview" class="composer-preview markdown" role="tabpanel" tabindex="0" hidden></div>
				<div class="home-composer-bar">
					<span class="home-plus"><button type="button" id="plus" class="plus-button"><i class="codicon codicon-add" aria-hidden="true"></i></button><div id="plus-menu" class="home-menu" hidden></div></span>
					<span class="home-folder"><button type="button" id="workspace" class="option-button"><i class="codicon codicon-folder" aria-hidden="true"></i><span></span><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button><div id="workspace-menu" class="home-menu" hidden></div></span>
					<label id="own-branch-label" class="option-switch"><span class="sep" aria-hidden="true">·</span><input type="checkbox" id="own-branch"><span class="switch-track" aria-hidden="true"></span><span class="switch-label"></span></label>
					<span class="home-mode"><span class="sep" aria-hidden="true">·</span><button type="button" id="mode" class="option-button"><i class="codicon" aria-hidden="true"></i><span></span><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button><div id="mode-menu" class="home-menu" hidden></div></span>
					<span id="model" class="home-model" hidden><span class="sep" aria-hidden="true">·</span><span></span></span>
					<span class="spacer"></span>
					<span class="home-from-tools"><button type="button" id="from-tools" class="option-button"><span></span><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button><div id="from-tools-menu" class="home-menu" hidden></div></span>
					<button type="submit" id="start" class="primary"><span></span></button>
				</div>
			</form>
			<div class="dash-quick-row"><div id="quick" class="dash-quick"></div><button type="button" id="helpers" class="option-button helpers-button"><i class="codicon codicon-tools" aria-hidden="true"></i><span></span></button></div>
		</section>
		<section id="setup" class="dash-setup" hidden></section>
		<section id="needs" class="dash-needs" hidden></section>
		<section id="cards" class="dash-cards"></section>
		<div id="row-menu" class="home-menu" hidden></div>
		<section id="active" class="home-section"></section>
		<section id="projects" class="home-section" hidden></section>
		<section id="earlier" class="home-section"></section>
	</main>
	<script nonce="${nonce}" type="module" src="${script}" data-draft-markdown="${draftMarkdown}" data-comment-box="${commentBox}" data-strings="${escapeAttribute(JSON.stringify(strings))}"></script>
</body>
</html>`;
	}
}

function openTabs(): number {
	return vscode.window.tabGroups.all.reduce((count, group) => count + group.tabs.length, 0);
}

function isHomeTab(tab: vscode.Tab): boolean {
	return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(homeViewType);
}
