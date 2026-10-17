/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { FigmaDesktop } from '../acp/figma';
import { GitLabClient } from '../acp/gitlab';
import { JiraClient } from '../acp/jira';
import type { InstantAnswer } from '../acp/permissions';
import { isProjectToolCall } from '../acp/projectMcp';
import { SnykCli } from '../acp/snyk';
import { SonarClient } from '../acp/sonar';
import { readTeamDefaults, TeamDefaults } from '../acp/teamDefaults';
import { normalizeBaseUrl, TeamToolError, TeamToolId, teamToolIds, teamToolNames } from '../acp/teamHttp';
import { TeamConnectors, teamReadTools } from '../acp/teamTools';
import { TeamToolsMcpServer } from '../acp/teamToolsMcp';
import { repositoryRoot } from '../acp/worktrees';

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
	private clients: TeamConnectors = {};
	private connectedSet = new Set<TeamToolId>();
	private readonly states = new Map<TeamToolId, ConnectionState>();
	private readonly folders = new Map<string, string>();
	private readonly defaultsCache = new Map<string, { at: number; value: Promise<TeamDefaults> }>();
	private checking: Promise<void> | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext, version: string, private readonly log: vscode.LogOutputChannel) {
		this.server = new TeamToolsMcpServer({
			connected: () => this.connectedSet,
			connectors: () => this.clients,
			folder: agent => this.folders.get(agent),
			defaults: folder => this.defaults(folder),
		}, version);
		for (const tool of teamToolIds) {
			const saved = context.globalState.get<ConnectionState>(stateKey(tool));
			if (saved) {
				this.states.set(tool, { ...saved, stale: true });
			}
		}
		this.disposables.push(
			this.onDidChangeEmitter,
			context.secrets.onDidChange(e => e.key.startsWith(secretPrefix) && void this.load().then(() => this.onDidChangeEmitter.fire())),
		);
		void this.load().then(() => {
			this.onDidChangeEmitter.fire();
			if (this.connectedSet.size) {
				void this.server.start().catch(err => this.log.warn(`The team tools server didn't start: ${err}`));
			}
		});
	}

	dispose(): void {
		this.server.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
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
		if (!needsToken) {
			// Turned on at once: the row shows the check, then what's missing (snyk auth, Figma not open).
			this.setState(tool, { kind: 'checking' });
		}
		const state = await probe(tool, clients);
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
		}
		this.clients = clients;
		this.connectedSet = connected;
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
