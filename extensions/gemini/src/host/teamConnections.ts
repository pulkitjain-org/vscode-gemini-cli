/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { AuditLog } from '../acp/auditLog';
import { FlowRecordStore } from '../acp/flowRecords';
import { ReviewStore } from '../acp/reviewStore';
import type { FigmaClient, FigmaDesktop } from '../acp/figma';
import { extensionChunk } from './lazyFeature';
import { GitLabClient } from '../acp/gitlab';
import { JiraClient } from '../acp/jira';
import { JiraSite, JiraSites } from '../acp/jiraSites';
import { LatestLoad } from '../acp/latestLoad';
import type { InstantAnswer } from '../acp/permissions';
import { isProjectToolCall } from '../acp/projectMcp';
import { SnykCli } from '../acp/snyk';
import { SonarClient } from '../acp/sonar';
import type { ChildServer } from '../acp/mcpStdio';
import { findDocker, FolderChildren, gitlabContainer, jiraContainer, snykServer, sonarContainer, TeamChildren, teamImages } from '../acp/teamContainers';
import { readTeamDefaults, TeamDefaults } from '../acp/teamDefaults';
import { hostOf, normalizeBaseUrl, ServerHealth, ServerHealthChange, teamReachability, teamRequest, TeamToolError, TeamToolId, teamToolIds, teamToolNames, unreachableNow } from '../acp/teamHttp';
import { ConfluenceAccount, ConfluenceTools, isConfirmToolCall, TeamConnectors, teamReadTools, TeamToolContext, teamToolsServerName, teamWrite, TeamWriteResult } from '../acp/teamTools';
import { TeamToolsMcpServer } from '../acp/teamToolsMcp';
import { repositoryRoot } from '../acp/worktrees';
import { configSection, getApprovalPolicy } from './configuration';

/** Runs the tools' own MCP servers as children of the team tools; set by Take Over Both Servers in Connections. */
export const runTeamServersSetting = 'team.runTeamServers';

/** The tools whose own servers can run as children. */
const childTools = ['jira', 'gitlab', 'sonar', 'snyk'] as const;
type ChildTool = typeof childTools[number];

function isChildTool(tool: TeamToolId): tool is ChildTool {
	return (childTools as readonly string[]).includes(tool);
}

/**
 * The user's connections to the team's tools (Jira, GitLab, SonarQube, Snyk,
 * Figma), each with their own account. Server addresses and the Jira email
 * are kept in global state; tokens only in SecretStorage (the macOS
 * keychain), never in settings or an agent's environment. Snyk and Figma
 * need no token: they go through the Snyk CLI and the Figma desktop app.
 *
 * Owns the `geminicode-tools` MCP server, started on the first session once
 * any tool is connected. Each tool's state is checked at once in parallel
 * with a short timeout, and the last result is kept so pages show it at once.
 */
export class TeamConnections implements vscode.Disposable {

	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	private readonly server: TeamToolsMcpServer;
	/** Every write to Jira or GitLab, by an agent or from a page, recorded before and after it happens. */
	readonly audit: AuditLog;
	/** What the team tools run against, for the agents' server and for the pages' writes alike. */
	private readonly toolContext: TeamToolContext;
	/** The flows open right now, on disk, so a quit leaves them listed on Home. */
	readonly flows: FlowRecordStore;
	/** Merge request reviews in progress, kept until they are posted or discarded. */
	readonly reviews: ReviewStore;
	private clients: TeamConnectors = {};
	private connectedSet = new Set<TeamToolId>();
	private readonly states = new Map<TeamToolId, ConnectionState>();
	/** The state of each Jira site after the first, by its id. */
	private readonly siteStates = new Map<string, ConnectionState>();
	/** The state of Confluence on each Jira site it is turned on for, by the site's id. */
	private readonly confluenceStates = new Map<string, ConnectionState>();
	/** Confluence's tools, from its bundle, constructed on first use. */
	private confluenceTools: (ConfluenceTools & vscode.Disposable) | undefined;
	private createConfluence: (() => ConfluenceTools & vscode.Disposable) | undefined;
	private readonly folders = new Map<string, string>();
	private readonly defaultsCache = new Map<string, { at: number; value: Promise<TeamDefaults> }>();
	private checking: Promise<void> | undefined;
	/** Tools being connected now, which pages show as checking. */
	private readonly connecting = new Set<TeamToolId>();
	private readonly disposables: vscode.Disposable[] = [];
	/** The team's own servers, run as children once taken over, with what each was started for. */
	private children: TeamChildren = {};
	private childKeys: Partial<Record<ChildTool, string>> = {};
	private tokens = new Map<TeamToolId, string>();
	/** The tokens of the Jira sites after the first, by id. */
	private siteTokens = new Map<string, string>();
	/** What each tool's client was made from, so a load keeps a client whose account and token didn't change. */
	private clientKeys: Record<string, string> = {};
	/** Figma's client, kept while Figma is on: its connection and the designs it read outlive a load. */
	private figma: LazyFigma | undefined;
	private readonly loader = new LatestLoad(() => this.read(), loaded => this.applyLoaded(loaded));
	private warnedNoDocker = false;
	/** Each unreachable tool's next check, when its backoff ends, so its state clears by itself once the server answers. */
	private readonly recheck = new Map<TeamToolId, ReturnType<typeof setTimeout>>();
	private readonly siteRecheck = new Map<string, ReturnType<typeof setTimeout>>();
	/** Agents whose team tools only read, such as a merge request's reviewer. */
	private readonly readOnlyAgents = new Set<string>();
	/** Folders whose agents' team tools only read: a review's worktree, marked before its reviewer's session opens. */
	private readonly readOnlyFolders = new Set<string>();
	private readOnlyWhen: ((agent: string) => boolean) | undefined;

	constructor(private readonly context: vscode.ExtensionContext, version: string, private readonly log: vscode.LogOutputChannel) {
		this.audit = new AuditLog(vscode.Uri.joinPath(context.globalStorageUri, 'audit').fsPath);
		this.flows = new FlowRecordStore(vscode.Uri.joinPath(context.globalStorageUri, 'flows').fsPath);
		this.reviews = new ReviewStore(vscode.Uri.joinPath(context.globalStorageUri, 'reviews').fsPath);
		this.toolContext = {
			audit: this.audit,
			connected: () => this.connectedSet,
			connectors: () => this.clients,
			folder: agent => this.folders.get(agent),
			defaults: folder => this.defaults(folder),
			children: () => this.children,
			readOnly: agent => this.isReadOnly(agent),
			childUnavailable: (server, reason) => this.log.warn(`The ${server} server didn't start, so the call went to ${server === 'jira' ? 'Jira' : 'GitLab'} directly: ${reason}`),
			allowShell: () => getApprovalPolicy().allowShell,
			confluence: () => this.confluence(),
			// Code Connect is the repository's call (`figma.codeConnect` in .gemini/geminicode-tools.json, read by `designSystem`), not a setting.
			figmaCodeConnect: () => false,
			designSystem: async folder => extensionChunk<typeof import('../onDemand')>('onDemand')().figmaDesignSystem(await this.defaults(folder)),
		};
		this.server = new TeamToolsMcpServer(this.toolContext, version);
		for (const tool of teamToolIds) {
			const saved = context.globalState.get<ConnectionState>(stateKey(tool));
			if (saved) {
				this.states.set(tool, { ...saved, stale: true });
			}
		}
		for (const site of this.jiraSiteList()) {
			const saved = context.globalState.get<ConnectionState>(siteStateKey(site.id));
			if (saved) {
				this.siteStates.set(site.id, { ...saved, stale: true });
			}
		}
		this.disposables.push(
			this.onDidChangeEmitter,
			context.secrets.onDidChange(e => e.key.startsWith(secretPrefix) && void this.load().then(() => this.onDidChangeEmitter.fire())),
			teamReachability.onDidChange(change => this.reachabilityChanged(change)),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(`${configSection}.${runTeamServersSetting}`)) {
					this.updateChildren();
					this.onDidChangeEmitter.fire();
				}
			}),
		);
		void this.load().then(() => {
			this.onDidChangeEmitter.fire();
			if (this.connectedSet.size) {
				void this.server.start().catch(err => this.log.warn(`The team tools server didn't start: ${err}`));
			}
		});
	}

	/**
	 * A write from one of GeminiCode's pages, through the same code and audit
	 * record as an agent's tool call (acp/teamTools.ts, `teamWrite`), in
	 * `folder` (else the active editor's folder, else the first workspace
	 * folder) for the team's defaults and the GitLab project. Throws with the
	 * tool's own message when it fails; a write that went through with a later
	 * step failed resolves, with that step in `warning`.
	 */
	async write(name: string, args: Record<string, unknown>, folder?: string): Promise<TeamWriteResult> {
		const where = folder ?? editorFolder() ?? vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
		const result = await teamWrite(this.toolContext, { caller: 'ui', ...where ? { folder: where } : {} }, name, args);
		if (!result.ok) {
			throw new Error(result.text);
		}
		return result;
	}

	/** As `write`, without throwing: a failed write's result, with what the tool gave back (a Confluence conflict's version). */
	tryWrite(name: string, args: Record<string, unknown>, folder?: string): Promise<TeamWriteResult> {
		const where = folder ?? editorFolder() ?? vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
		return teamWrite(this.toolContext, { caller: 'ui', ...where ? { folder: where } : {} }, name, args);
	}

	/** Opens a Confluence draft's Review Page, or asks which; says so when Confluence isn't connected. */
	async openConfluenceDraft(id?: string): Promise<void> {
		const confluence = this.confluence();
		if (!confluence) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Connect Confluence in Connections to review drafts."));
			return;
		}
		await confluence.openDraft(id);
	}

	/**
	 * Makes `agent`'s team tools read-only: it is offered only the reading
	 * tools, and any write it asks for is refused. Set before its session opens.
	 */
	markReadOnly(agent: string): void {
		this.readOnlyAgents.add(agent);
	}

	/** Makes the team tools of any agent working in `folder` read-only, from its session's first tool list. */
	markReadOnlyFolder(folder: string): void {
		this.readOnlyFolders.add(folder);
	}

	/** Also treats as read-only the agents `when` names, such as every review's reviewer after a restart. */
	readOnlyBy(when: (agent: string) => boolean): void {
		this.readOnlyWhen = when;
	}

	isReadOnly(agent: string): boolean {
		const folder = this.folders.get(agent);
		return this.readOnlyAgents.has(agent) || (!!folder && this.readOnlyFolders.has(folder)) || !!this.readOnlyWhen?.(agent);
	}

	/**
	 * The reachability of `tool`'s servers, one state per server: unreachable
	 * (calls fail at once until `retryAt`), sign-in needed (the token was
	 * refused), or fine. The data behind the pages' per-server banners.
	 */
	serverHealth(tool: TeamToolId): ServerHealth {
		return teamReachability.health(tool);
	}

	dispose(): void {
		for (const timer of [...this.recheck.values(), ...this.siteRecheck.values()]) {
			clearTimeout(timer);
		}
		for (const tool of childTools) {
			this.children[tool]?.stop();
		}
		this.server.dispose();
		this.confluenceTools?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** The server that makes a tool's calls when it runs as a child, as "mcp-atlassian 0.23.1 in Docker". */
	childOf(tool: TeamToolId): string | undefined {
		return isChildTool(tool) && this.children[tool] ? this.childName(tool) : undefined;
	}

	/** The tools the user has connected (a token saved, or Snyk or Figma turned on), whether or not they answer now. */
	get connected(): ReadonlySet<TeamToolId> {
		return this.connectedSet;
	}

	get connectors(): TeamConnectors {
		return this.clients;
	}

	/** Each tool's last known state; `stale` until checked in this window. */
	state(tool: TeamToolId): ConnectionState {
		return this.states.get(tool) ?? { kind: this.connectedSet.has(tool) ? 'checking' : 'off' };
	}

	isConnecting(tool: TeamToolId): boolean {
		return this.connecting.has(tool);
	}

	accountOf(tool: TeamToolId): StoredAccount | undefined {
		return this.context.globalState.get<StoredAccount>(accountKey(tool));
	}

	/** The team's defaults for the repository around `folder`, cached briefly. */
	defaults(folder: string): Promise<TeamDefaults> {
		const cached = this.defaultsCache.get(folder);
		if (cached && Date.now() - cached.at < 30_000) {
			return cached.value;
		}
		const value = repositoryRoot(folder).then(root => readTeamDefaults(root ?? folder), () => readTeamDefaults(folder));
		this.defaultsCache.set(folder, { at: Date.now(), value });
		return value;
	}

	/** The defaults of `preferred` (the folder the flow works in) when it has them, else of the active editor's folder, else of the first open folder that has them. */
	async workspaceDefaults(preferred?: string): Promise<TeamDefaults> {
		const folders = [preferred, editorFolder(), ...(vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath)];
		for (const folder of [...new Set(folders)]) {
			if (folder) {
				const defaults = await this.defaults(folder);
				if (defaults.file) {
					return defaults;
				}
			}
		}
		return {};
	}

	/**
	 * Checks `tools` (all connected ones by default) in parallel, each with its
	 * own timeout, and fires `onDidChange` as each answers.
	 */
	refresh(tools: readonly TeamToolId[] = [...this.connectedSet]): Promise<void> {
		const run = Promise.all(tools.map(tool => this.check(tool))).then(() => undefined);
		this.checking = run;
		return run;
	}

	/** Refreshes unless a refresh ran in the last `ms`. */
	refreshIfOlder(ms: number): Promise<void> {
		const oldest = Math.min(...[...this.connectedSet].map(tool => this.states.get(tool)?.checkedAt ?? 0));
		return Date.now() - oldest > ms ? this.refresh() : this.checking ?? Promise.resolve();
	}

	/**
	 * Saves a connection after checking it. Throws a `TeamToolError` (with a
	 * message for the user) and saves nothing when the check fails, except
	 * when the server can't be reached: then it is saved, as the VPN may
	 * just be off.
	 */
	async connect(tool: TeamToolId, details: { url?: string; email?: string; token?: string; name?: string }): Promise<ConnectionState> {
		const url = details.url ? normalizeBaseUrl(details.url) : undefined;
		const token = details.token?.trim();
		const name = tool === 'jira' ? details.name?.trim() || this.accountOf('jira')?.name : undefined;
		const account: StoredAccount = { ...url ? { url } : {}, ...details.email ? { email: details.email.trim() } : {}, ...name ? { name } : {} };
		if ((tool === 'jira' || tool === 'gitlab' || tool === 'sonar') && (!url || !token || (tool === 'jira' && !account.email))) {
			throw new TeamToolError('failed', tool === 'jira' ? vscode.l10n.t("Enter the Jira site, your email and an API token.") : vscode.l10n.t("Enter the server address and a token."));
		}
		if (tool === 'jira' && url && this.jiraSiteList().some(site => hostOf(site.url) === hostOf(url))) {
			throw new TeamToolError('failed', vscode.l10n.t("{0} is already connected.", hostOf(url)));
		}
		const clients = clientsFor(tool, account, token, tool === 'figma' ? this.figma ??= lazyFigma(this.log) : undefined);
		const needsToken = tool === 'jira' || tool === 'gitlab' || tool === 'sonar';
		this.log.info(`Connecting ${teamToolNames[tool]}${url ? ` at ${url}` : ''}`);
		this.connecting.add(tool);
		let state: ConnectionState;
		try {
			if (!needsToken) {
				// Turned on at once: the row shows the check, then what's missing (snyk auth, Figma not open).
				this.setState(tool, { kind: 'checking' });
			}
			state = await withTimeout(probe(tool, clients), connectTimeoutMs, { kind: 'failed', detail: vscode.l10n.t("{0} didn't answer within {1} seconds.", teamToolNames[tool], connectTimeoutMs / 1000) });
		} finally {
			this.connecting.delete(tool);
		}
		this.log.info(`${teamToolNames[tool]}: ${state.kind}${state.detail ? ` (${state.detail})` : ''}`);
		if (needsToken && (state.kind === 'auth' || state.kind === 'failed')) {
			throw new TeamToolError(state.kind === 'auth' ? 'auth' : 'failed', state.detail ?? vscode.l10n.t("{0} refused the token.", teamToolNames[tool]));
		}
		await this.context.globalState.update(accountKey(tool), account);
		if (token) {
			await this.context.secrets.store(secretKey(tool), token);
		} else {
			await this.context.secrets.store(secretKey(tool), 'on');
		}
		await this.load();
		this.setState(tool, state);
		void this.server.start().catch(err => this.log.warn(`The team tools server didn't start: ${err}`));
		this.log.info(`Connected ${teamToolNames[tool]}${url ? ` at ${url}` : ''}`);
		return state;
	}

	async disconnect(tool: TeamToolId): Promise<void> {
		if (tool === 'confluence') {
			await this.context.globalState.update(confluenceSitesKey, undefined);
			this.confluenceStates.clear();
		}
		await this.context.secrets.delete(secretKey(tool));
		await this.context.globalState.update(stateKey(tool), undefined);
		this.states.delete(tool);
		await this.load();
		this.onDidChangeEmitter.fire();
		this.log.info(`Disconnected ${teamToolNames[tool]}`);
	}

	/** The Jira sites added after the first, in the order they were added. */
	jiraSiteList(): readonly StoredJiraSite[] {
		const saved = this.context.globalState.get<unknown>(jiraSitesKey);
		return Array.isArray(saved) ? saved.filter(isStoredSite) : [];
	}

	/** A Jira site's last known state, by its id; `stale` until checked in this window. */
	siteState(id: string): ConnectionState {
		return this.siteStates.get(id) ?? { kind: 'checking' };
	}

	/** The name the first Jira site shows under, on Home and in Connections. */
	jiraName(): string {
		const account = this.accountOf('jira');
		return account?.name || defaultSiteName(account?.url ?? '');
	}

	/**
	 * Confluence's tools, from `create` (its bundle's feature), constructed
	 * the first time an agent or a page uses Confluence.
	 */
	useConfluence(create: () => ConfluenceTools & vscode.Disposable): void {
		this.createConfluence = create;
	}

	confluence(): ConfluenceTools | undefined {
		if (!this.connectedSet.has('confluence') || !this.createConfluence) {
			return undefined;
		}
		return this.confluenceTools ??= this.createConfluence();
	}

	/** The Jira sites Confluence is turned on for, by id ('default' for the first). */
	confluenceSiteIds(): readonly string[] {
		const saved = this.context.globalState.get<unknown>(confluenceSitesKey);
		return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [];
	}

	/** Confluence's state on a Jira site, by the site's id. */
	confluenceState(id: string): ConnectionState {
		return this.confluenceStates.get(id) ?? { kind: 'checking' };
	}

	/** The keychain and saved settings, for Connections' site actions (siteConnections.ts, in the pages bundle). */
	get storage(): { readonly secrets: vscode.SecretStorage; readonly globalState: vscode.Memento } {
		return this.context;
	}

	/** Reads the saved accounts and tokens again, after Connections changed them, and tells the pages. */
	async reload(): Promise<void> {
		await this.load();
		this.onDidChangeEmitter.fire();
	}

	/** Sets, or with none forgets, a Jira site's state after the first. */
	setSiteState(id: string, state: ConnectionState | undefined): void {
		if (state) {
			const stamped = { ...state, checkedAt: Date.now() };
			this.siteStates.set(id, stamped);
			void this.context.globalState.update(siteStateKey(id), stamped);
		} else {
			this.siteStates.delete(id);
			void this.context.globalState.update(siteStateKey(id), undefined);
		}
		this.onDidChangeEmitter.fire();
	}

	/** Sets, or with none forgets, Confluence's state on a Jira site; Confluence's own state follows. */
	setConfluenceState(id: string, state: ConnectionState | undefined): void {
		if (state) {
			this.confluenceStates.set(id, { ...state, checkedAt: Date.now() });
		} else {
			this.confluenceStates.delete(id);
		}
		this.setState('confluence', aggregate([...this.confluenceStates.values()]));
	}

	/** Sets a tool's state, and checks it again unless `state` is final. */
	setToolState(tool: TeamToolId, state: ConnectionState, recheck = false): void {
		this.setState(tool, state);
		if (recheck) {
			void this.check(tool);
		}
	}

	/** Marks a tool as being connected, which pages show as checking. */
	setConnecting(tool: TeamToolId, on: boolean): void {
		if (on) {
			this.connecting.add(tool);
		} else {
			this.connecting.delete(tool);
		}
	}

	/** Checks a Jira site's account before it is saved, within the Connect dialog's time. */
	checkJiraSite(url: string, email: string, token: string): Promise<ConnectionState> {
		return withTimeout(probeSite(new JiraClient({ site: url, email, token })), connectTimeoutMs, { kind: 'failed', detail: vscode.l10n.t("{0} didn't answer within {1} seconds.", teamToolNames.jira, connectTimeoutMs / 1000) });
	}

	/** Checks Confluence with a Jira site's account, within the Connect dialog's time. */
	checkConfluence(account: ConfluenceAccount): Promise<ConnectionState> {
		return withTimeout(probeConfluence(account), connectTimeoutMs, { kind: 'failed', detail: vscode.l10n.t("{0} didn't answer within {1} seconds.", teamToolNames.confluence, connectTimeoutMs / 1000) });
	}

	startServer(): void {
		void this.server.start().catch(err => this.log.warn(`The team tools server didn't start: ${err}`));
	}

	/** Each connected Jira site's account, the first site first. */
	jiraAccounts(tokens = this.tokens, siteTokens = this.siteTokens): ConfluenceAccount[] {
		const first = this.accountOf('jira');
		const token = tokens.get('jira');
		const accounts: ConfluenceAccount[] = first?.url && first.email && token ? [{ id: 'default', name: this.jiraName(), site: first.url, email: first.email, token }] : [];
		for (const site of this.jiraSiteList()) {
			const siteToken = siteTokens.get(site.id);
			if (siteToken) {
				accounts.push({ id: site.id, name: site.name, site: site.url, email: site.email, token: siteToken });
			}
		}
		return accounts;
	}

	/** The `mcpServers` for an agent's session: the team tools, once any is connected and the server listens. */
	mcpServersFor(agent: string, folder?: string): acp.McpServer[] {
		if (folder) {
			this.folders.set(agent, folder);
		}
		const config = this.connectedSet.size ? this.server.configFor(agent) : undefined;
		if (config) {
			// The team's Jira and GitLab servers start while the agent reads the prompt, not on its first call.
			this.children.jira?.warm();
			this.children.gitlab?.warm();
		}
		return config ? [config] : [];
	}

	/** Forgets a removed agent: its folder and the spare session's slot bound to it. */
	forgetAgent(agent: string): void {
		this.folders.delete(agent);
		this.server.unbind(agent);
	}

	get serving(): boolean {
		return !!this.connectedSet.size && this.server.listening;
	}

	spareServers(): acp.McpServer[] {
		const config = this.connectedSet.size ? this.server.configForSlot() : undefined;
		return config ? [config] : [];
	}

	bindSession(agent: string, folder: string, servers: readonly acp.McpServer[]): void {
		this.folders.set(agent, folder);
		for (const server of servers) {
			const url = (server as { readonly url?: unknown }).url;
			if (typeof url === 'string') {
				this.server.bind(url, agent);
			}
		}
	}

	/** Whether the request is for a confirm-class tool: a card every time, Allow once and Reject only. */
	isConfirmCall(request: acp.RequestPermissionRequest): boolean {
		return isConfirmToolCall(request);
	}

	/** Lets the reading tools run without a card; changes, and Snyk's tests, which run the project's build tools, still ask. */
	instantAnswer(request: acp.RequestPermissionRequest): InstantAnswer | undefined {
		if (!this.connectedSet.size || !isProjectToolCall(request, teamReadTools, teamToolsServerName)) {
			return undefined;
		}
		const allow = request.options.find(option => option.kind === 'allow_once') ?? request.options.find(option => option.kind.startsWith('allow'));
		return allow && { optionId: allow.optionId, quiet: true };
	}

	/** Reads the saved accounts and tokens again; loads run one at a time, and only the newest is applied. */
	private load(): Promise<void> {
		return this.loader.load();
	}

	private async read(): Promise<LoadedClients> {
		const clients: { -readonly [K in keyof TeamConnectors]: TeamConnectors[K] } = {};
		const connected = new Set<TeamToolId>();
		const tokens = new Map<TeamToolId, string>();
		const siteTokens = new Map<string, string>();
		const keys: Record<string, string> = {};
		for (const tool of teamToolIds) {
			const token = await this.context.secrets.get(secretKey(tool));
			if (!token) {
				continue;
			}
			const account = this.accountOf(tool) ?? {};
			Object.assign(clients, clientsFor(tool, account, token, tool === 'figma' ? this.figma ??= lazyFigma(this.log) : undefined));
			connected.add(tool);
			tokens.set(tool, token);
			keys[tool] = JSON.stringify([account, token]);
		}
		if (clients.jira) {
			const more: JiraSite[] = [];
			// A site with the first's host, or another's, is left out: one site, one client.
			const hosts = new Set([hostOf(clients.jira.site)]);
			for (const site of this.jiraSiteList()) {
				const token = await this.context.secrets.get(siteSecretKey(site.id));
				if (token && !hosts.has(hostOf(site.url))) {
					hosts.add(hostOf(site.url));
					siteTokens.set(site.id, token);
					more.push({ id: site.id, name: site.name, client: new JiraClient({ site: site.url, email: site.email, token }) });
				}
			}
			keys.jira += JSON.stringify([this.jiraName(), ...this.jiraSiteList().filter(site => siteTokens.has(site.id)), ...siteTokens]);
			clients.jira = new JiraSites([{ ...clients.jira.sites[0], name: this.jiraName() }, ...more]);
			// Confluence shares each Jira site's account; it is on for the sites the user turned it on for.
			const enabled = new Set(this.confluenceSiteIds());
			const confluence = this.jiraAccounts(tokens, siteTokens).filter(account => enabled.has(account.id));
			if (confluence.length) {
				clients.confluence = confluence;
				connected.add('confluence');
			}
		}
		return { clients, connected, tokens, siteTokens, keys };
	}

	/**
	 * Uses what `read` found. A tool whose account and token didn't change
	 * keeps its client, and with it what the client learned (Jira's projects,
	 * GitLab's review states, Figma's connection and designs); Figma's is
	 * closed once Figma is turned off.
	 */
	private applyLoaded(loaded: LoadedClients): void {
		const clients = loaded.clients as Record<string, unknown>;
		const old = this.clients as Record<string, unknown>;
		for (const [tool, key] of Object.entries(loaded.keys)) {
			if (this.clientKeys[tool] === key && old[tool]) {
				clients[tool] = old[tool];
			}
		}
		if (!loaded.clients.figma) {
			this.figma?.dispose();
			this.figma = undefined;
		}
		this.clients = loaded.clients;
		this.clientKeys = loaded.keys;
		this.connectedSet = loaded.connected;
		this.tokens = loaded.tokens;
		this.siteTokens = loaded.siteTokens;
		this.updateChildren();
	}

	/**
	 * Starts nothing: sets up the tools' own servers, started when a session opens (`mcpServersFor`) or on their first call, while
	 * `gemini.team.runTeamServers` is on: the team's Jira and GitLab servers and SonarSource's
	 * SonarQube server in Docker, and Snyk's server from the Snyk CLI. A server whose account or
	 * token changed is stopped and set up again.
	 */
	private updateChildren(): void {
		const on = vscode.workspace.getConfiguration(configSection).get<boolean>(runTeamServersSetting, false);
		const docker = on ? findDocker() : undefined;
		const account = (tool: TeamToolId) => ({ ...this.accountOf(tool), token: this.tokens.get(tool) });
		const jira = account('jira');
		const gitlab = account('gitlab');
		const sonar = account('sonar');
		const wanted: Record<ChildTool, string | undefined> = {
			jira: docker && jira.url && jira.email && jira.token ? JSON.stringify([docker, jira.url, jira.email, jira.token]) : undefined,
			gitlab: docker && gitlab.url && gitlab.token ? JSON.stringify([docker, gitlab.url, gitlab.token]) : undefined,
			sonar: docker && sonar.url && sonar.token ? JSON.stringify([docker, sonar.url, sonar.token]) : undefined,
			snyk: on && this.clients.snyk ? 'on' : undefined,
		};
		const next: { -readonly [K in ChildTool]?: TeamChildren[K] } = {};
		for (const tool of childTools) {
			if (wanted[tool] === this.childKeys[tool] && this.children[tool]) {
				Object.assign(next, { [tool]: this.children[tool] });
				continue;
			}
			this.children[tool]?.stop();
			if (!wanted[tool]) {
				continue;
			}
			if (tool === 'jira' && docker) {
				next.jira = jiraContainer(docker, { site: jira.url!, email: jira.email!, token: jira.token! });
			} else if (tool === 'gitlab' && docker) {
				next.gitlab = gitlabContainer(docker, { url: gitlab.url!, token: gitlab.token! });
			} else if (tool === 'sonar' && docker) {
				next.sonar = new FolderChildren(folder => sonarContainer(docker, { url: sonar.url!, token: sonar.token! }, folder));
			} else if (tool === 'snyk' && this.clients.snyk) {
				// The CLI's path is found once, in the login shell; the servers start on their first call.
				const snyk = this.clients.snyk;
				void snyk.executable().then(cli => {
					if (this.childKeys.snyk === wanted.snyk && !this.children.snyk) {
						this.children = { ...this.children, snyk: new FolderChildren(folder => snykServer(cli, folder)) };
					}
				});
				continue;
			}
			this.log.info(`${teamToolNames[tool]} calls go through ${this.childName(tool)}, started when needed`);
		}
		if (on && !docker && !this.warnedNoDocker) {
			this.warnedNoDocker = true;
			this.log.warn('gemini.team.runTeamServers is on, but Docker isn\'t installed; Jira, GitLab and SonarQube are called directly.');
		}
		this.children = next;
		this.childKeys = wanted;
	}

	private childName(tool: ChildTool): string {
		switch (tool) {
			case 'jira': return vscode.l10n.t("mcp-atlassian {0} in Docker", teamImages.jira.tag);
			case 'gitlab': return vscode.l10n.t("gitlab-mcp {0} in Docker", teamImages.gitlab.tag);
			case 'sonar': return vscode.l10n.t("sonarqube-mcp {0} in Docker", teamImages.sonar.tag);
			case 'snyk': return vscode.l10n.t("Snyk's MCP server");
		}
	}

	/** SonarQube's server for `folder`, for the analysis Checks runs on this Mac, when it runs as a child. */
	sonarServerFor(folder: string): ChildServer | undefined {
		return this.children.sonar?.for(folder);
	}

	/**
	 * A server's reachability changed on some call: an outage marks the tool
	 * unreachable once and checks it again when its wait ends; a refused token
	 * marks it as needing sign-in until the token changes; an answer after an
	 * outage checks it again, so its row shows the account.
	 */
	private reachabilityChanged(change: ServerHealthChange): void {
		const { tool, health } = change;
		if (!this.connectedSet.has(tool)) {
			return;
		}
		const site = tool === 'jira' ? this.clients.jira?.sites.slice(1).find(s => new URL(s.client.site).origin === change.origin) : undefined;
		if (site) {
			this.siteReachabilityChanged(site, health);
			return;
		}
		clearTimeout(this.recheck.get(tool));
		this.recheck.delete(tool);
		const current = this.states.get(tool);
		if (health.kind === 'unreachable') {
			if (current?.kind !== 'unreachable' || current.retryAt !== health.retryAt) {
				this.setState(tool, { ...current?.kind === 'unreachable' ? current : {}, kind: 'unreachable', detail: unreachableNow(tool), retryAt: health.retryAt });
			}
			this.recheck.set(tool, setTimeout(() => {
				this.recheck.delete(tool);
				void this.check(tool);
			}, Math.max(0, health.retryAt - Date.now())));
		} else if (health.kind === 'signIn') {
			if (current?.kind !== 'auth') {
				this.log.warn(`${teamToolNames[tool]} refused the token; its calls stop until the token is replaced`);
				this.setState(tool, { kind: 'auth', detail: vscode.l10n.t("{0} refused the token. It may have expired or been revoked: replace it in Connections.", teamToolNames[tool]) });
			}
		} else if (current?.kind === 'unreachable' || current?.kind === 'auth') {
			void this.check(tool);
		}
	}

	/** As `reachabilityChanged`, for a Jira site after the first: its own row's state. */
	private siteReachabilityChanged(site: JiraSite, health: ServerHealth): void {
		const key = `jira ${site.id}`;
		clearTimeout(this.siteRecheck.get(key));
		this.siteRecheck.delete(key);
		const current = this.siteStates.get(site.id);
		if (health.kind === 'unreachable') {
			this.setSiteState(site.id, { kind: 'unreachable', detail: vscode.l10n.t("Can't reach {0}. Check your connection.", hostOf(site.client.site)), retryAt: health.retryAt });
			this.siteRecheck.set(key, setTimeout(() => {
				this.siteRecheck.delete(key);
				void this.checkSite(site);
			}, Math.max(0, health.retryAt - Date.now())));
		} else if (health.kind === 'signIn') {
			this.setSiteState(site.id, { kind: 'auth', detail: vscode.l10n.t("Jira refused the token. It may have expired or been revoked: replace it.") });
		} else if (current?.kind === 'unreachable' || current?.kind === 'auth') {
			void this.checkSite(site);
		}
	}

	private async checkSite(site: JiraSite): Promise<void> {
		teamReachability.retryNow('jira');
		this.setSiteState(site.id, await probeSite(site.client));
	}

	private async check(tool: TeamToolId): Promise<void> {
		if (!this.connectedSet.has(tool)) {
			return;
		}
		if (tool === 'jira') {
			void Promise.all((this.clients.jira?.sites.slice(1) ?? []).map(site => this.checkSite(site)));
		}
		if (tool === 'confluence') {
			const states = await Promise.all((this.clients.confluence ?? []).map(async account => {
				const state = await probeConfluence(account);
				this.confluenceStates.set(account.id, { ...state, checkedAt: Date.now() });
				return state;
			}));
			this.setState(tool, aggregate(states));
			return;
		}
		// An explicit check always asks the server, even while it waits out an outage.
		teamReachability.retryNow(tool);
		const previous = this.states.get(tool);
		if (!previous || previous.kind === 'off') {
			this.setState(tool, { kind: 'checking' });
		}
		const state = await probe(tool, this.clients);
		this.setState(tool, state);
	}

	private setState(tool: TeamToolId, state: ConnectionState): void {
		const stamped = { ...state, checkedAt: Date.now() };
		this.states.set(tool, stamped);
		if (state.kind !== 'checking') {
			void this.context.globalState.update(stateKey(tool), stamped);
		}
		this.onDidChangeEmitter.fire();
	}
}

/** What the user entered for a tool, other than the token. */
export interface StoredAccount {
	readonly url?: string;
	readonly email?: string;
	/** For Jira: the name the first site shows under once there are more. */
	readonly name?: string;
}

/** A Jira site added after the first; its token is in SecretStorage under its id. */
export interface StoredJiraSite {
	readonly id: string;
	readonly name: string;
	readonly url: string;
	readonly email: string;
}

export const jiraSitesKey = 'gemini.teamTools.jira.sites';

export function isStoredSite(value: unknown): value is StoredJiraSite {
	const site = value as Partial<StoredJiraSite> | null;
	return !!site && typeof site.id === 'string' && typeof site.name === 'string' && typeof site.url === 'string' && typeof site.email === 'string';
}

/** A site's name until the user gives one: its subdomain, as Acme for acme.atlassian.net. */
export function defaultSiteName(url: string): string {
	const label = hostOf(url).split('.')[0] ?? '';
	return label ? label[0].toUpperCase() + label.slice(1) : 'Jira';
}

export type ConnectionKind = 'off' | 'checking' | 'connected' | 'unreachable' | 'auth' | 'failed' | 'notInstalled';

export interface ConnectionState {
	readonly kind: ConnectionKind;
	/** Who the user is signed in as. */
	readonly account?: string;
	/** The server's host, or the CLI's endpoint. */
	readonly server?: string;
	readonly version?: string;
	/** When the token expires, as an ISO date, when the tool says. */
	readonly expires?: string;
	/** What went wrong, or how it connects, for the user. */
	readonly detail?: string;
	readonly checkedAt?: number;
	/** For an unreachable tool: when it is next tried, in ms since the epoch. */
	readonly retryAt?: number;
	/** Loaded from the last window, not checked yet in this one. */
	readonly stale?: boolean;
}

export const secretPrefix = 'geminicode-tools.';

/** The longest a Connect check may take: the Snyk CLI can be slow to start. */
export const connectTimeoutMs = 45_000;

export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([promise, new Promise<T>(resolve => timer = setTimeout(() => resolve(fallback), ms))]).finally(() => clearTimeout(timer));
}

/** The workspace folder of the active editor, when it has one on disk. */
function editorFolder(): string | undefined {
	const uri = vscode.window.activeTextEditor?.document.uri;
	const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
	return folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}

export function secretKey(tool: TeamToolId): string {
	return `${secretPrefix}${tool}`;
}

export function accountKey(tool: TeamToolId): string {
	return `gemini.teamTools.${tool}.account`;
}

export function stateKey(tool: TeamToolId): string {
	return `gemini.teamTools.${tool}.state`;
}

export function siteSecretKey(id: string): string {
	return `${secretPrefix}jira.${id}`;
}

export function siteStateKey(id: string): string {
	return `gemini.teamTools.jira.sites.${id}.state`;
}

function clientsFor(tool: TeamToolId, account: StoredAccount, token: string | undefined, figma?: FigmaClient): TeamConnectors {
	switch (tool) {
		case 'jira':
			return { jira: new JiraSites([{ id: 'default', name: account.name || defaultSiteName(account.url ?? ''), client: new JiraClient({ site: account.url ?? '', email: account.email ?? '', token: token ?? '' }) }]) };
		case 'gitlab':
			return { gitlab: new GitLabClient({ url: account.url ?? '', token: token ?? '' }) };
		case 'sonar':
			return { sonar: new SonarClient({ url: account.url ?? '', token: token ?? '' }) };
		case 'snyk':
			return { snyk: new SnykCli() };
		case 'figma':
			return figma ? { figma } : {};
		case 'confluence':
			// Made from the Jira sites' accounts in `load`.
			return {};
	}
}

type LazyFigma = FigmaClient & { dispose(): void };

/** Figma's client, from dist/onDemand.js the first time Figma is checked or read. */
function lazyFigma(log: vscode.LogOutputChannel | undefined): LazyFigma {
	let client: FigmaDesktop | undefined;
	const get = () => client ??= new (extensionChunk<typeof import('../onDemand')>('onDemand')().FigmaDesktop)(undefined, undefined, line => log?.info(line));
	return {
		status: () => get().status(),
		designContext: (link, options) => get().designContext(link, options),
		screenshot: link => get().screenshot(link),
		outline: nodeId => get().outline(nodeId),
		variables: nodeId => get().variables(nodeId),
		dispose: () => client?.dispose(),
	};
}

interface LoadedClients {
	readonly clients: TeamConnectors;
	readonly connected: Set<TeamToolId>;
	readonly tokens: Map<TeamToolId, string>;
	readonly siteTokens: Map<string, string>;
	readonly keys: Record<string, string>;
}

export const confluenceSitesKey = 'gemini.teamTools.confluence.sites';

/** Confluence on several sites as one state: connected when any site is, else the first site's problem. */
function aggregate(states: readonly ConnectionState[]): ConnectionState {
	return states.find(state => state.kind === 'connected') ?? states[0] ?? { kind: 'off' };
}

/** Checks Confluence on one site with its Jira site's account, never throwing; through the main bundle's request, so its reachability is shared. */
export async function probeConfluence(account: ConfluenceAccount): Promise<ConnectionState> {
	try {
		const basic = Buffer.from(`${account.email}:${account.token}`).toString('base64');
		const me = await teamRequest<{ displayName?: string; publicName?: string }>('confluence', `${account.site.replace(/\/+$/, '')}/wiki/rest/api/user/current`, { headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' } });
		return { kind: 'connected', account: me?.displayName ?? me?.publicName ?? '', server: hostOf(account.site) };
	} catch (err) {
		return stateOfError(err);
	}
}

/** A failed check as a connection state. */
export function stateOfError(err: unknown): ConnectionState {
	if (err instanceof TeamToolError) {
		return { kind: err.kind === 'unreachable' ? 'unreachable' : err.kind === 'auth' ? 'auth' : 'failed', detail: err.message };
	}
	return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
}

/** Checks one tool, never throwing. */
export async function probe(tool: TeamToolId, clients: TeamConnectors): Promise<ConnectionState> {
	try {
		switch (tool) {
			case 'jira':
				return await probeSite(clients.jira!.primary);
			case 'gitlab': {
				const gitlab = clients.gitlab!;
				const [user, version, token] = await Promise.all([gitlab.user(), gitlab.version().catch(() => undefined), gitlab.token()]);
				const missingApi = token && !token.scopes.includes('api');
				return {
					kind: 'connected', account: user.username, server: hostOf(gitlab.url),
					...version ? { version: version.split('-')[0] } : {},
					...token?.expiresAt ? { expires: token.expiresAt } : {},
					...missingApi ? { detail: vscode.l10n.t("This token can only read. Create one with the api scope to open merge requests and comment.") } : {},
				};
			}
			case 'sonar': {
				const sonar = clients.sonar!;
				const [user, version] = await Promise.all([sonar.user(), sonar.version().catch(() => undefined)]);
				return { kind: 'connected', account: user.name, server: hostOf(sonar.url), ...version ? { version } : {} };
			}
			case 'snyk': {
				const status = await clients.snyk!.status();
				if (!status.installed) {
					return { kind: 'notInstalled', detail: status.problem };
				}
				return status.problem
					? { kind: /auth/i.test(status.problem) ? 'auth' : 'unreachable', detail: status.problem, ...status.endpoint ? { server: status.endpoint } : {}, ...status.version ? { version: status.version } : {} }
					: { kind: 'connected', ...status.user ? { account: status.user } : {}, ...status.endpoint ? { server: status.endpoint } : {}, ...status.version ? { version: status.version } : {} };
			}
			case 'figma': {
				const status = await clients.figma!.status();
				return status.running ? { kind: 'connected', detail: vscode.l10n.t("Through the Figma desktop app.") } : { kind: 'unreachable', detail: status.problem };
			}
			case 'confluence':
				return aggregate(await Promise.all((clients.confluence ?? []).map(probeConfluence)));
		}
	} catch (err) {
		if (err instanceof TeamToolError) {
			return { kind: err.kind === 'unreachable' ? 'unreachable' : err.kind === 'auth' ? 'auth' : 'failed', detail: err.message };
		}
		return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
	}
}

/** Checks one Jira site, never throwing. */
export async function probeSite(jira: JiraClient): Promise<ConnectionState> {
	try {
		const me = await jira.myself();
		return { kind: 'connected', account: me.displayName, server: hostOf(jira.site) };
	} catch (err) {
		return stateOfError(err);
	}
}

/** Where to create a token for `tool`, with the name and scope filled in where the tool allows. */
export function createTokenUrl(tool: TeamToolId, url: string | undefined): string | undefined {
	const base = url ? normalizeBaseUrl(url) : '';
	switch (tool) {
		case 'jira':
			return 'https://id.atlassian.com/manage-profile/security/api-tokens';
		case 'gitlab':
			return base ? `${base}/-/user_settings/personal_access_tokens?name=GeminiCode&scopes=api` : undefined;
		case 'sonar':
			return base ? `${base}/account/security` : undefined;
		default:
			return undefined;
	}
}
