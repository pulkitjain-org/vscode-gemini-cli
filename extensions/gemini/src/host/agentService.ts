/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { isModeAllowed, takesAway } from '../acp/adminPolicy';
import { AgentClient, AgentClientState, WaitAbortedError } from '../acp/agentClient';
import { AgentCommand, includeDirectoryArgs } from '../acp/agentProcess';
import { AgentRuntime, AgentRuntimeState } from '../acp/agentRuntime';
import { AgentError, AgentErrorInfo, errorMessage, parseCliRetry } from '../acp/errors';
import { patchCliBundle } from '../acp/cliPatches';
import { provideRipgrep } from '../acp/cliRipgrep';
import { appRipgrep } from '../acp/index/ripgrepPath';
import { createFileHandlers } from '../acp/fileAccess';
import { PermissionBroker } from '../acp/permissions';
import { CliResolution, isOlderThan } from '../acp/cliResolution';
import { McpDiagnostics, McpProblem } from '../acp/mcpDiagnostics';
import { MIN_CLI_VERSION } from '../acp/protocol';
import { AgentSidecar } from '../acp/sidecar';
import { trustedFoldersPath, trustFolder } from '../acp/trustedFolders';
import { AgentStatus, describeAgentStatus, describeRuntimeStatus } from '../acp/status';
import { isConfirmToolCall } from '../acp/teamTools';
import { agentErrorText } from './chatStatus';
import { agentLaunchSettings, configSection, getAgentCommand, getApprovalPolicy, getCliResolution, getProjectSettings, getWorkspaceCwd, includedFolderPaths } from './configuration';
import { sessionModel, sessionModelList } from './modelPreference';
import { getFileAccessPolicy, WorkspaceFileSystem } from './workspaceFileSystem';

/** How long the first agent process of a launch took, from its spawn. */
export interface StartupTimes {
	/** When it was spawned (ms since the epoch). */
	readonly spawnedAt: number;
	/** Spawn to the `initialize` answer. */
	readonly processReadyMs: number;
	/** Spawn to the first session open on it. */
	readonly firstSessionMs: number;
}

/**
 * The VS Code side of the agent: starts the sidecar on first use, logs it,
 * restarts it when settings change, and turns failures into messages with a way
 * out.
 */
export class AgentService implements vscode.Disposable {

	private readonly sidecar: AgentSidecar;
	/** The agent process; every chat session shares it. */
	readonly runtime: AgentRuntime;
	/**
	 * A session of the service's own, opened only when something asks for it
	 * (`ensureReady`), such as the walkthrough's Sign In: the status comes from
	 * the process and every chat's sessions, so no session opens per process start.
	 */
	readonly client: AgentClient;
	/** The agent's permission requests, answered in the chat view. */
	readonly permissions = new PermissionBroker();
	private readonly disposables: vscode.Disposable[] = [];
	private started = false;
	/** Why the agent was not started at all; cleared on the next start. */
	private blocked: AgentErrorInfo | undefined;
	private _cli: CliResolution | undefined;
	/** The agent version last warned about, so a restart does not warn again. */
	private warnedVersion: string | undefined;
	/** The missing pinned version last offered for install. */
	private offeredVersion: string | undefined;
	private idleRestart: { dispose(): void } | undefined;
	/** The approval settings as last read, to tell a change that takes a permission away. */
	private policy = getApprovalPolicy();
	/** The --include-directories the running process was started with. */
	private includedFolders = '';

	private readonly onDidChangeStatusEmitter = new vscode.EventEmitter<AgentStatus>();
	readonly onDidChangeStatus = this.onDidChangeStatusEmitter.event;

	/** The error last shown as a notification, so a status that repeats it does not show it again. */
	private shownError: string | undefined;
	/** When the first agent process of this launch started, became ready, and served its first session. */
	private startup: { spawnedAt?: number; readyAt?: number; sessionAt?: number } = {};
	private readonly onDidStartEmitter = new vscode.EventEmitter<StartupTimes>();
	/** Fires once per launch, when the first session opens: how long the first agent process took. */
	readonly onDidStart = this.onDidStartEmitter.event;

	/** MCP servers that fail to start, read from the CLI's debug log; unset in tests. */
	private readonly mcpDiagnostics: McpDiagnostics | undefined;
	private _mcpProblems: McpProblem[] = [];
	private readonly onDidChangeMcpProblemsEmitter = new vscode.EventEmitter<void>();
	/** Fires when an MCP server fails, or the agent restarts and they start afresh. */
	readonly onDidChangeMcpProblems = this.onDidChangeMcpProblemsEmitter.event;

	/** `debugLog` is where the agent writes its debug log, read for MCP failures the CLI does not report over ACP. */
	constructor(private readonly log: vscode.LogOutputChannel, debugLog?: string) {
		this.mcpDiagnostics = debugLog ? new McpDiagnostics(debugLog) : undefined;
		this.sidecar = new AgentSidecar({ command: () => this.agentCommand(), cwd: getWorkspaceCwd() });
		this.runtime = new AgentRuntime(this.sidecar, {
			fileSystem: createFileHandlers(new WorkspaceFileSystem(), getFileAccessPolicy),
			log: message => log.debug(message),
		});
		this.client = new AgentClient(this.runtime, {
			cwd: getWorkspaceCwd(),
			openLater: true,
			requestPermission: params => this.permissions.request(params),
			preferredModel: sessionModel,
			modelList: sessionModelList,
			isModeAllowed: modeId => isModeAllowed(getApprovalPolicy(), modeId),
			alwaysAsks: isConfirmToolCall,
			onDidWriteFile: filePath => this.permissions.approvals.noteWrite(filePath),
		});

		// Redirects into the workspace may be approved for the session; others always ask.
		this.permissions.roots = () => getFileAccessPolicy().roots;
		this.disposables.push(
			this.onDidChangeStatusEmitter,
			this.onDidStartEmitter,
			this.onDidChangeStatus(status => this.onStatus(status)),
			this.sidecar.onDidChangeState(() => this.fireStatus()),
			this.runtime.onDidChangeState(state => this.onRuntimeState(state)),
			this.runtime.onDidChangeSessionHealth(health => {
				if (health.opened && this.startup.readyAt !== undefined && this.startup.sessionAt === undefined) {
					this.startup.sessionAt = Date.now();
					const { spawnedAt = 0, readyAt, sessionAt } = this.startup;
					this.onDidStartEmitter.fire({ spawnedAt, processReadyMs: readyAt - spawnedAt, firstSessionMs: sessionAt - spawnedAt });
				}
				this.fireStatus();
			}),
			this.client.onDidChangeState(state => {
				// A request from an agent that is gone can no longer be answered.
				if (state.kind !== 'ready') {
					this.permissions.cancelAll();
					// Session approvals end with the session.
					this.permissions.approvals.clear();
				}
				if (state.kind === 'ready') {
					this.log.info(`Session ${state.sessionId} ready`);
				} else if (state.kind === 'error' && this.runtime.state.kind === 'ready') {
					// Its own session failed, such as for the walkthrough's Sign In: say why, as for the agent.
					this.showOnce(state.error);
				}
			}),
			this.sidecar.onStderr(line => log.info(`[agent] ${line}`)),
			this.onDidChangeMcpProblemsEmitter,
			...(this.mcpDiagnostics ? [
				this.mcpDiagnostics,
				this.mcpDiagnostics.onDidReport(problem => this.reportMcpProblem(problem)),
				// Over ACP the CLI says nothing while it retries an API call; its debug log does.
				this.mcpDiagnostics.onDidReadLines(lines => {
					for (const line of lines) {
						const retry = parseCliRetry(line);
						if (retry) {
							log.info(`The Gemini CLI is retrying an API call (attempt ${retry.attempt}${retry.status ? `, status ${retry.status}` : ''})`);
							this.runtime.noteRetry(retry);
						}
					}
				}),
			] : []),
			this.sidecar.onDidChangeState(state => {
				const detail = state.kind === 'restarting' ? ` (attempt ${state.attempt} in ${state.delayMs}ms, exit code ${state.exitCode})`
					: state.kind === 'failed' ? ` (${state.reason}: ${state.message})` : '';
				log.info(`Sidecar ${state.kind}${detail}`);
				if (state.kind === 'running' && this.startup.spawnedAt === undefined) {
					this.startup.spawnedAt = Date.now();
				}
			}),
			vscode.workspace.onDidChangeConfiguration(e => {
				const before = this.policy;
				this.policy = getApprovalPolicy();
				if (!this.started || !agentLaunchSettings.some(key => e.affectsConfiguration(key))) {
					return;
				}
				// A setting that takes a permission away, or changes which MCP servers may load, applies at once;
				// anything else waits for the running turns, so turning on YOLO doesn't cut off an agent mid-turn.
				if (takesAway(before, this.policy) || e.affectsConfiguration(`${configSection}.mcp.allowedServers`)) {
					log.info('Gemini settings changed; restarting the agent');
					this.restart();
				} else {
					log.info('Gemini settings changed; restarting the agent once it is idle');
					this.restartWhenIdle('restarting with the new Gemini settings');
				}
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				// Every folder of a multi-root window is passed with --include-directories, which the process reads once.
				if (this.started && this.includedFolders !== includeDirectoryArgs(includedFolderPaths()).join('\n')) {
					log.info('Workspace folders changed; restarting the agent once it is idle');
					this.restartWhenIdle('restarting so agents see the workspace folders');
				}
			}),
			vscode.window.onDidCloseTerminal(terminal => {
				if (terminal === this.setupTerminal) {
					this.setupTerminal = undefined;
					log.info('Setup terminal closed; restarting the agent');
					this.restart();
				}
			}),
		);
	}

	/** The CLI the agent process was last started with. */
	get cli(): CliResolution | undefined {
		return this._cli;
	}

	get isStarted(): boolean {
		return this.started;
	}

	/** Whether a prompt is running in any chat. */
	get isBusy(): boolean {
		return this.runtime.busy;
	}

	/** Restarts the agent now, or once the running prompts end, so no turn is cut off. */
	restartWhenIdle(reason = 'restarting on the new Gemini CLI'): void {
		this.idleRestart?.dispose();
		this.idleRestart = undefined;
		if (!this.runtime.busy) {
			this.restart();
			return;
		}
		this.idleRestart = this.runtime.onDidBecomeIdle(() => {
			this.idleRestart?.dispose();
			this.idleRestart = undefined;
			this.log.info(`No agent is working; ${reason}`);
			this.restart();
		});
	}

	/**
	 * Adds `folders` to the CLI's trusted folders and restarts the agent once no
	 * prompt runs, since the CLI reads that list once per process. Returns
	 * whether the restart has to wait. Throws when the list cannot be updated.
	 */
	async trustFolder(...folders: string[]): Promise<boolean> {
		const file = trustedFoldersPath(process.env);
		for (const folder of folders) {
			await trustFolder(file, folder);
			this.log.info(`Trusted ${folder} in ${file}`);
		}
		const waits = this.runtime.busy;
		this.restartWhenIdle('restarting so the agent trusts the folder');
		return waits;
	}

	/** The agent's status: the process, and how opening sessions on it went for every chat (`describeRuntimeStatus`). */
	get status(): AgentStatus {
		return describeRuntimeStatus(this.sidecar.state, this.runtime.state, this.runtime.sessionHealth, this.blocked);
	}

	private fireStatus(): void {
		this.onDidChangeStatusEmitter.fire(this.status);
	}

	/** The status of `client`'s session on the shared agent process. */
	statusFor(client: AgentClient): AgentStatus {
		return describeAgentStatus(this.sidecar.state, client.state, this.blocked);
	}

	/** Writes `message` to the Gemini log. */
	writeLog(message: string): void {
		this.log.info(message);
	}

	/**
	 * Starts the agent if it is not running yet and waits until `client`'s
	 * session is ready, opening it if it waits to be opened. A session that
	 * failed while the agent stayed ready is tried again (`AgentClient.retryOpen`).
	 * Rejects with a `WaitAbortedError` when `signal` aborts, such as on Stop.
	 */
	async ensureReady(client: AgentClient = this.client, signal?: AbortSignal): Promise<Extract<AgentClientState, { kind: 'ready' }>> {
		if (!this.started) {
			this.restart();
		}
		if (client === this.client) {
			// The service's own session opens only when asked for.
			client.open();
		}
		const wasIdle = client.state.kind === 'idle';
		try {
			return await client.whenReady(signal);
		} catch (err) {
			if (err instanceof WaitAbortedError) {
				throw err;
			}
			if (client.state.kind === 'idle') {
				throw new Error(wasIdle ? vscode.l10n.t("The Gemini agent is not running.") : vscode.l10n.t("The Gemini agent stopped."));
			}
			if (err instanceof AgentError) {
				throw new AgentError({ ...err.info, message: agentErrorText(err.info) });
			}
			throw err;
		}
	}

	/** Stops the current turn. Open permission requests are answered `cancelled`. */
	async cancel(): Promise<void> {
		this.permissions.cancelAll();
		await this.client.cancel();
	}

	restart(): void {
		this.idleRestart?.dispose();
		this.idleRestart = undefined;
		const { resolved, problem, overrides } = getProjectSettings();
		if (resolved && problem === 'numeric') {
			this.started = false;
			this.blocked = { kind: 'project-id-numeric', message: vscode.l10n.t("\"{0}\" is a project number. Set the project ID instead, for example my-project-123.", resolved.projectId) };
			this.sidecar.stop();
			// The status shows the error, once.
			this.shownError = undefined;
			this.fireStatus();
			return;
		}
		this.blocked = undefined;
		if (resolved && problem === 'malformed') {
			this.log.warn(`Project ID "${resolved.projectId}" does not look like a Google Cloud project ID; starting anyway`);
		}
		if (resolved?.source === 'workspace' && overrides) {
			this.log.warn(`This workspace's settings set gemini.projectId to "${resolved.projectId}", in place of "${overrides}": usage is billed to the workspace's project`);
		}
		this.log.info(`Starting agent with project ${resolved ? `${resolved.projectId} (from ${resolved.source})` : '(none)'}`);
		this.started = true;
		this.sidecar.start();
	}

	private setupTerminal: vscode.Terminal | undefined;

	/**
	 * Opens the interactive CLI in a terminal with the agent's environment, so
	 * its own login and account-validation flows can run. The agent restarts
	 * when the terminal closes.
	 */
	async completeSetupInTerminal(): Promise<void> {
		const command = await getAgentCommand({ interactive: true });
		this.setupTerminal?.dispose();
		const useShell = command.shell;
		this.setupTerminal = vscode.window.createTerminal({
			name: vscode.l10n.t("Gemini setup"),
			shellPath: useShell ? 'cmd.exe' : command.command,
			shellArgs: useShell ? ['/c', command.command, ...command.args] : [...command.args],
			env: command.env as Record<string, string>,
			cwd: getWorkspaceCwd(),
			message: vscode.l10n.t("Sign in and finish any account setup, then exit the Gemini CLI (/quit) to return to the editor."),
		});
		this.setupTerminal.show();
	}

	/** The agent's command, with its debug log pointed at a file GeminiCode reads, unless the user set one. */
	private async agentCommand(): Promise<AgentCommand> {
		this.includedFolders = includeDirectoryArgs(includedFolderPaths()).join('\n');
		const command = await getAgentCommand({ cli: await this.resolveCli() });
		if (!this.mcpDiagnostics || command.env.GEMINI_DEBUG_LOG_FILE || !await this.mcpDiagnostics.reset()) {
			return command;
		}
		if (this._mcpProblems.length) {
			this._mcpProblems = [];
			this.onDidChangeMcpProblemsEmitter.fire();
		}
		return { ...command, env: { ...command.env, GEMINI_DEBUG_LOG_FILE: this.mcpDiagnostics.file } };
	}

	/** The MCP problems the running agent process reported. */
	get mcpProblems(): readonly McpProblem[] {
		return this._mcpProblems;
	}

	private reportMcpProblem(problem: McpProblem): void {
		this._mcpProblems = [...this._mcpProblems, problem];
		this.onDidChangeMcpProblemsEmitter.fire();
		this.log.warn(`MCP server ${problem.server ?? '(unknown)'}: ${problem.message}`);
		const text = problem.server && problem.unreachable
			? vscode.l10n.t("Gemini could not reach the MCP server \"{0}\", so its tools are not available. Check that it is running, or remove it from the Gemini settings.", problem.server)
			: problem.server
				? vscode.l10n.t("Gemini could not start the MCP server \"{0}\": {1}. Its tools are not available.", problem.server, problem.message)
				: vscode.l10n.t("An MCP server failed: {0}", problem.message);
		const manage = vscode.l10n.t("MCP Servers");
		const showLog = vscode.l10n.t("Show Log");
		void vscode.window.showWarningMessage(text, manage, showLog).then(choice => {
			if (choice === manage) {
				void vscode.commands.executeCommand('gemini.projectSettings');
			} else if (choice === showLog) {
				this.log.show();
			}
		});
	}

	dispose(): void {
		this.idleRestart?.dispose();
		this.setupTerminal?.dispose();
		this.permissions.dispose();
		this.client.dispose();
		this.runtime.dispose();
		this.sidecar.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** Picks the CLI for each process start; the sidecar asks again on every restart. */
	private async resolveCli(): Promise<CliResolution> {
		const cli = this._cli = await getCliResolution();
		const where = cli.source === 'setting' ? `the ${configSection}.cliPath setting`
			: cli.source === 'managed' ? `GeminiCode's copy ${cli.version}`
				: cli.source === 'bundled' ? `the copy bundled with GeminiCode, ${cli.version}` : 'PATH';
		this.log.info(`Using the Gemini CLI from ${where}${cli.cliPath ? ` (${cli.cliPath})` : ''}`);
		// A copy installed before GeminiCode patched installs gets the cap on tool output now (cliPatches.ts).
		if (cli.source === 'managed' && cli.cliPath) {
			const patched = await patchCliBundle(path.dirname(cli.cliPath)).catch(err => `failed: ${errorMessage(err)}`);
			if (patched !== 'unchanged') {
				this.log[patched === 'patched' ? 'info' : 'warn'](`Capping tool output in ACP mode for Gemini CLI ${cli.version}: ${patched}`);
			}
			// The CLI's grep_search falls back to git grep without ripgrep beside it (cliRipgrep.ts).
			const ripgrep = await provideRipgrep(path.dirname(cli.cliPath), await appRipgrep(vscode.env.appRoot)).catch(err => `failed: ${errorMessage(err)}`);
			if (ripgrep !== 'present') {
				this.log[ripgrep === 'added' ? 'info' : 'warn'](`Ripgrep for Gemini CLI ${cli.version}: ${ripgrep}`);
			}
		}
		if (cli.missingVersion) {
			this.log.warn(`Gemini CLI ${cli.missingVersion} is set in ${configSection}.cli.version but not installed; using ${where}`);
			if (cli.missingVersion !== this.offeredVersion) {
				this.offeredVersion = cli.missingVersion;
				void this.offerInstall(cli.missingVersion);
			}
		}
		return cli;
	}

	private onRuntimeState(state: AgentRuntimeState): void {
		if (state.kind === 'ready') {
			const agent = state.agent.agentInfo;
			if (this.startup.readyAt === undefined && this.startup.spawnedAt !== undefined) {
				this.startup.readyAt = Date.now();
			}
			this.log.info(`Agent ready (${agent ? `${agent.name} ${agent.version}` : 'unknown agent'})`);
			if (agent?.version && agent.version !== this.warnedVersion && isOlderThan(agent.version, MIN_CLI_VERSION)) {
				this.warnedVersion = agent.version;
				void this.showOldCli(agent.version);
			}
		}
		this.fireStatus();
	}

	/** Shows an agent-level error once, however many times the status repeats it; a status without an error clears it. */
	private onStatus(status: AgentStatus): void {
		if (status.phase !== 'error' || !status.error) {
			if (status.phase !== 'restarting') {
				this.shownError = undefined;
			}
			return;
		}
		this.showOnce(status.error);
	}

	private showOnce(error: AgentErrorInfo): void {
		const key = `${error.kind}\n${error.message}`;
		if (key === this.shownError) {
			return;
		}
		this.shownError = key;
		this.log.error(`Agent error (${error.kind}): ${error.message}`);
		void this.showError(error);
	}

	private async showOldCli(version: string): Promise<void> {
		const installLatest = vscode.l10n.t("Install Latest");
		const setCliPath = vscode.l10n.t("Set CLI Path");
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t("Gemini CLI {0} is older than {1}, the oldest version GeminiCode supports. Some features may not work.", version, MIN_CLI_VERSION),
			...(this._cli?.source === 'setting' ? [setCliPath] : [installLatest, setCliPath]));
		if (choice === installLatest) {
			await vscode.commands.executeCommand('gemini.installCli');
		} else if (choice === setCliPath) {
			await vscode.commands.executeCommand('workbench.action.openSettings', `${configSection}.cliPath`);
		}
	}

	private async offerInstall(version: string): Promise<void> {
		const install = vscode.l10n.t("Install {0}", version);
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t("Gemini CLI {0} is set in {1} but is not installed, so the gemini on PATH is used.", version, `${configSection}.cli.version`), install);
		if (choice === install) {
			await vscode.commands.executeCommand('gemini.installCli', version);
		}
	}

	private async showError(error: AgentErrorInfo): Promise<void> {
		const setUpInTerminal = vscode.l10n.t("Complete Setup in Terminal");
		const setProject = vscode.l10n.t("Set Project ID");
		const setCliPath = vscode.l10n.t("Set CLI Path");
		const installCli = vscode.l10n.t("Install Gemini CLI");
		const restart = vscode.l10n.t("Restart Agent");
		const showLog = vscode.l10n.t("Show Log");

		let message: string;
		let actions: string[];
		switch (error.kind) {
			case 'auth-required':
			case 'auth-failed':
				message = vscode.l10n.t("Gemini needs you to sign in. Finish signing in in a terminal, then the agent restarts. ({0})", error.message);
				actions = [setUpInTerminal, showLog];
				break;
			case 'project-id-required':
				message = vscode.l10n.t("Your account needs a Google Cloud project ID.");
				actions = [setProject, showLog];
				break;
			case 'project-id-numeric':
				message = error.message;
				actions = [setProject];
				break;
			case 'agent-not-found':
				message = vscode.l10n.t("The Gemini CLI was not found. Install it, or set its path in the gemini.cliPath setting.");
				actions = [installCli, setCliPath, showLog];
				break;
			case 'network':
				// Setup in a terminal cannot fix the network; the log shows what failed.
				message = agentErrorText(error);
				actions = [restart, showLog];
				break;
			case 'timeout':
				message = agentErrorText(error);
				actions = [restart, showLog];
				break;
			default:
				message = vscode.l10n.t("The Gemini agent failed: {0}", error.message);
				actions = [restart, setUpInTerminal, showLog];
		}

		switch (await vscode.window.showErrorMessage(message, ...actions)) {
			case setUpInTerminal: void this.completeSetupInTerminal(); break;
			case setProject: await vscode.commands.executeCommand('gemini.setProjectId'); break;
			case setCliPath: await vscode.commands.executeCommand('workbench.action.openSettings', `${configSection}.cliPath`); break;
			case installCli: await vscode.commands.executeCommand('gemini.installCli'); break;
			case restart: this.restart(); break;
			case showLog: this.log.show(); break;
		}
	}
}
