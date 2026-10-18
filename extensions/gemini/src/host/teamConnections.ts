/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { AuditLog } from '../acp/auditLog';
import { FlowRecordStore } from '../acp/flowRecords';
import { FigmaDesktop } from '../acp/figma';
import { GitLabClient } from '../acp/gitlab';
import { JiraClient } from '../acp/jira';
import type { InstantAnswer } from '../acp/permissions';
import { isProjectToolCall } from '../acp/projectMcp';
import { SnykCli } from '../acp/snyk';
import { SonarClient } from '../acp/sonar';
import type { ChildServer } from '../acp/mcpStdio';
import { findDocker, FolderChildren, gitlabContainer, jiraContainer, snykServer, sonarContainer, TeamChildren, teamImages } from '../acp/teamContainers';
import { readTeamDefaults, TeamDefaults } from '../acp/teamDefaults';
import { normalizeBaseUrl, TeamToolError, TeamToolId, teamToolIds, teamToolNames } from '../acp/teamHttp';
import { isConfirmToolCall, TeamConnectors, teamReadTools, TeamToolContext, teamWrite, TeamWriteResult } from '../acp/teamTools';
import { TeamToolsMcpServer } from '../acp/teamToolsMcp';
import { repositoryRoot } from '../acp/worktrees';
import { configSection } from './configuration';

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
	private clients: TeamConnectors = {};
	private connectedSet = new Set<TeamToolId>();
	private readonly states = new Map<TeamToolId, ConnectionState>();
	private readonly folders = new Map<string, string>();
	private readonly defaultsCache = new Map<string, { at: number; value: Promise<TeamDefaults> }>();
	private checking: Promise<void> | undefined;
	/** Tools being connected now, which pages show as checking. */
	private readonly connecting = new Set<TeamToolId>();
	private readonly disposables: vscode.Disposable[] = [];
	/** The team's own servers, run as children once taken over, with what each was started for. */
	private children: TeamChildren = {};
	private childKeys: Partial<Record<ChildTool, string>> = {};
	private readonly tokens = new Map<TeamToolId, string>();
	private warnedNoDocker = false;

	constructor(private readonly context: vscode.ExtensionContext, version: string, private readonly log: vscode.LogOutputChannel) {
		this.audit = new AuditLog(vscode.Uri.joinPath(context.globalStorageUri, 'audit').fsPath);
		this.flows = new FlowRecordStore(vscode.Uri.joinPath(context.globalStorageUri, 'flows').fsPath);
		this.toolContext = {
			audit: this.audit,
			connected: () => this.connectedSet,
			connectors: () => this.clients,
			folder: agent => this.folders.get(agent),
			defaults: folder => this.defaults(folder),
			children: () => this.children,
			childUnavailable: (server, reason) => this.log.warn(`The ${server} server didn't start, so the call went to ${server === 'jira' ? 'Jira' : 'GitLab'} directly: ${reason}`),
		};
		this.server = new TeamToolsMcpServer(this.toolContext, version);
		for (const tool of teamToolIds) {
			const saved = context.globalState.get<ConnectionState>(stateKey(tool));
			if (saved) {
				this.states.set(tool, { ...saved, stale: true });
			}
		}
		this.disposables.push(
			this.onDidChangeEmitter,
			context.secrets.onDidChange(e => e.key.startsWith(secretPrefix) && void this.load().then(() => this.onDidChangeEmitter.fire())),
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
	 * `folder` (else the first workspace folder) for the team's defaults and
	 * the GitLab project. Throws with the tool's own message when it fails.
	 */
	async write(name: string, args: Record<string, unknown>, folder?: string): Promise<TeamWriteResult> {
		const where = folder ?? vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
		const result = await teamWrite(this.toolContext, { caller: 'ui', ...where ? { folder: where } : {} }, name, args);
		if (!result.ok) {
			throw new Error(result.text);
		}
		return result;
	}

	dispose(): void {
		for (const tool of childTools) {
			this.children[tool]?.stop();
		}
		this.server.dispose();
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

	/** The defaults of the first open folder that has them. */
	async workspaceDefaults(): Promise<TeamDefaults> {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme === 'file') {
				const defaults = await this.defaults(folder.uri.fsPath);
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
	async connect(tool: TeamToolId, details: { url?: string; email?: string; token?: string }): Promise<ConnectionState> {
		const url = details.url ? normalizeBaseUrl(details.url) : undefined;
		const token = details.token?.trim();
		const account: StoredAccount = { ...url ? { url } : {}, ...details.email ? { email: details.email.trim() } : {} };
		if ((tool === 'jira' || tool === 'gitlab' || tool === 'sonar') && (!url || !token || (tool === 'jira' && !account.email))) {
			throw new TeamToolError('failed', tool === 'jira' ? vscode.l10n.t("Enter the Jira site, your email and an API token.") : vscode.l10n.t("Enter the server address and a token."));
		}
		const clients = clientsFor(tool, account, token);
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
		await this.context.secrets.delete(secretKey(tool));
		await this.context.globalState.update(stateKey(tool), undefined);
		this.states.delete(tool);
		await this.load();
		this.onDidChangeEmitter.fire();
		this.log.info(`Disconnected ${teamToolNames[tool]}`);
	}

	/** The `mcpServers` for an agent's session: the team tools, once any is connected and the server listens. */
	mcpServersFor(agent: string, folder?: string): acp.McpServer[] {
		if (folder) {
			this.folders.set(agent, folder);
		}
		const config = this.connectedSet.size ? this.server.configFor(agent) : undefined;
		return config ? [config] : [];
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

	/** Lets the reading tools run without a card; changes still ask. */
	instantAnswer(request: acp.RequestPermissionRequest): InstantAnswer | undefined {
		if (!this.connectedSet.size || !isProjectToolCall(request, teamReadTools)) {
			return undefined;
		}
		const allow = request.options.find(option => option.kind === 'allow_once') ?? request.options.find(option => option.kind.startsWith('allow'));
		return allow && { optionId: allow.optionId, quiet: true };
	}

	private async load(): Promise<void> {
		const clients: { -readonly [K in keyof TeamConnectors]: TeamConnectors[K] } = {};
		const connected = new Set<TeamToolId>();
		for (const tool of teamToolIds) {
			const token = await this.context.secrets.get(secretKey(tool));
			if (!token) {
				continue;
			}
			const account = this.accountOf(tool) ?? {};
			Object.assign(clients, clientsFor(tool, account, token));
			connected.add(tool);
			this.tokens.set(tool, token);
		}
		for (const tool of teamToolIds.filter(t => !connected.has(t))) {
			this.tokens.delete(tool);
		}
		this.clients = clients;
		this.connectedSet = connected;
		this.updateChildren();
	}

	/**
	 * Starts nothing: sets up the tools' own servers, each started on its first call, while
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
			this.log.info(`${teamToolNames[tool]} calls go through ${this.childName(tool)}, started on the first call`);
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

	private async check(tool: TeamToolId): Promise<void> {
		if (!this.connectedSet.has(tool)) {
			return;
		}
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
	/** Loaded from the last window, not checked yet in this one. */
	readonly stale?: boolean;
}

const secretPrefix = 'geminicode-tools.';

/** The longest a Connect check may take: the Snyk CLI can be slow to start. */
const connectTimeoutMs = 45_000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([promise, new Promise<T>(resolve => timer = setTimeout(() => resolve(fallback), ms))]).finally(() => clearTimeout(timer));
}

function secretKey(tool: TeamToolId): string {
	return `${secretPrefix}${tool}`;
}

function accountKey(tool: TeamToolId): string {
	return `gemini.teamTools.${tool}.account`;
}

function stateKey(tool: TeamToolId): string {
	return `gemini.teamTools.${tool}.state`;
}

function clientsFor(tool: TeamToolId, account: StoredAccount, token: string | undefined): TeamConnectors {
	switch (tool) {
		case 'jira':
			return { jira: new JiraClient({ site: account.url ?? '', email: account.email ?? '', token: token ?? '' }) };
		case 'gitlab':
			return { gitlab: new GitLabClient({ url: account.url ?? '', token: token ?? '' }) };
		case 'sonar':
			return { sonar: new SonarClient({ url: account.url ?? '', token: token ?? '' }) };
		case 'snyk':
			return { snyk: new SnykCli() };
		case 'figma':
			return { figma: new FigmaDesktop() };
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** Checks one tool, never throwing. */
export async function probe(tool: TeamToolId, clients: TeamConnectors): Promise<ConnectionState> {
	try {
		switch (tool) {
			case 'jira': {
				const jira = clients.jira!;
				const me = await jira.myself();
				return { kind: 'connected', account: me.displayName, server: hostOf(jira.site) };
			}
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
		}
	} catch (err) {
		if (err instanceof TeamToolError) {
			return { kind: err.kind === 'unreachable' ? 'unreachable' : err.kind === 'auth' ? 'auth' : 'failed', detail: err.message };
		}
		return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
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
