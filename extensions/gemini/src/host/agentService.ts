/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isModeAllowed } from '../acp/adminPolicy';
import { AgentClient, AgentClientState } from '../acp/agentClient';
import type { AgentCommand } from '../acp/agentProcess';
import { AgentRuntime } from '../acp/agentRuntime';
import { AgentErrorInfo } from '../acp/errors';
import { createFileHandlers } from '../acp/fileAccess';
import { PermissionBroker } from '../acp/permissions';
import { CliResolution, isOlderThan } from '../acp/cliResolution';
import { McpDiagnostics, McpProblem } from '../acp/mcpDiagnostics';
import { MIN_CLI_VERSION } from '../acp/protocol';
import { AgentSidecar } from '../acp/sidecar';
import { trustedFoldersPath, trustFolder } from '../acp/trustedFolders';
import { AgentStatus, describeAgentStatus } from '../acp/status';
import { agentLaunchSettings, configSection, getAgentCommand, getApprovalPolicy, getCliResolution, getProjectSettings, getWorkspaceCwd } from './configuration';
import { preferredModel } from './modelPreference';
import { getFileAccessPolicy, WorkspaceFileSystem } from './workspaceFileSystem';

/**
 * The VS Code side of the agent: starts the sidecar on first use, logs it,
 * restarts it when settings change, and turns failures into messages with a way
 * out.
 */
export class AgentService implements vscode.Disposable {

	private readonly sidecar: AgentSidecar;
	/** The agent process; every chat session shares it. */
	readonly runtime: AgentRuntime;
	/** The sidebar chat's session. */
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

	private readonly onDidChangeStatusEmitter = new vscode.EventEmitter<AgentStatus>();
	readonly onDidChangeStatus = this.onDidChangeStatusEmitter.event;

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
		});
		this.client = new AgentClient(this.runtime, {
			cwd: getWorkspaceCwd(),
			requestPermission: params => this.permissions.request(params),
			preferredModel,
			isModeAllowed: modeId => isModeAllowed(getApprovalPolicy(), modeId),
		});

		this.disposables.push(
			this.onDidChangeStatusEmitter,
			this.sidecar.onDidChangeState(() => this.onDidChangeStatusEmitter.fire(this.status)),
			this.client.onDidChangeState(state => {
				// A request from an agent that is gone can no longer be answered.
				if (state.kind !== 'ready') {
					this.permissions.cancelAll();
				}
				this.onDidChangeStatusEmitter.fire(this.status);
			}),
			this.sidecar.onStderr(line => log.info(`[agent] ${line}`)),
			this.onDidChangeMcpProblemsEmitter,
			...(this.mcpDiagnostics ? [this.mcpDiagnostics, this.mcpDiagnostics.onDidReport(problem => this.reportMcpProblem(problem))] : []),
			this.sidecar.onDidChangeState(state => {
				const detail = state.kind === 'restarting' ? ` (attempt ${state.attempt} in ${state.delayMs}ms, exit code ${state.exitCode})`
					: state.kind === 'failed' ? ` (${state.reason}: ${state.message})` : '';
				log.info(`Sidecar ${state.kind}${detail}`);
			}),
			this.client.onDidChangeState(state => this.onClientState(state)),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (this.started && agentLaunchSettings.some(key => e.affectsConfiguration(key))) {
					log.info('Gemini settings changed; restarting the agent');
					this.restart();
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
	 * Adds `folder` to the CLI's trusted folders and restarts the agent once no
	 * prompt runs, since the CLI reads that list once per process. Returns
	 * whether the restart has to wait. Throws when the list cannot be updated.
	 */
	trustFolder(folder: string): boolean {
		const file = trustedFoldersPath(process.env);
		trustFolder(file, folder);
		this.log.info(`Trusted ${folder} in ${file}`);
		const waits = this.runtime.busy;
		this.restartWhenIdle('restarting so the agent trusts the folder');
		return waits;
	}

	get status(): AgentStatus {
		return this.statusFor(this.client);
	}

	/** The status of `client`'s session on the shared agent process. */
	statusFor(client: AgentClient): AgentStatus {
		return describeAgentStatus(this.sidecar.state, client.state, this.blocked);
	}

	/** Starts the agent if it is not running yet and waits until `client`'s session is ready. */
	async ensureReady(client: AgentClient = this.client): Promise<Extract<AgentClientState, { kind: 'ready' }>> {
		if (!this.started) {
			this.restart();
		}
		const state = client.state;
		if (state.kind === 'ready') {
			return state;
		}
		if (state.kind === 'error' || state.kind === 'idle') {
			throw new Error(state.kind === 'error' ? state.error.message : vscode.l10n.t("The Gemini agent is not running."));
		}
		return new Promise((resolve, reject) => {
			const listener = client.onDidChangeState(s => {
				if (s.kind === 'ready') {
					listener.dispose();
					resolve(s);
				} else if (s.kind === 'error' || s.kind === 'idle') {
					listener.dispose();
					reject(new Error(s.kind === 'error' ? s.error.message : vscode.l10n.t("The Gemini agent stopped.")));
				}
			});
		});
	}

	/** Stops the current turn. Open permission requests are answered `cancelled`. */
	async cancel(): Promise<void> {
		this.permissions.cancelAll();
		await this.client.cancel();
	}

	restart(): void {
		this.idleRestart?.dispose();
		this.idleRestart = undefined;
		const { resolved, problem } = getProjectSettings();
		if (resolved && problem === 'numeric') {
			this.started = false;
			this.blocked = { kind: 'project-id-numeric', message: vscode.l10n.t("\"{0}\" is a project number. Set the project ID instead, for example my-project-123.", resolved.projectId) };
			this.sidecar.stop();
			this.onDidChangeStatusEmitter.fire(this.status);
			void this.showError(this.blocked);
			return;
		}
		this.blocked = undefined;
		if (resolved && problem === 'malformed') {
			this.log.warn(`Project ID "${resolved.projectId}" does not look like a Google Cloud project ID; starting anyway`);
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
	completeSetupInTerminal(): void {
		this.setupTerminal?.dispose();
		const command = getAgentCommand({ interactive: true });
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
	private agentCommand(): AgentCommand {
		const command = getAgentCommand({ cli: this.resolveCli() });
		if (!this.mcpDiagnostics || command.env.GEMINI_DEBUG_LOG_FILE || !this.mcpDiagnostics.reset()) {
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
		const text = problem.server
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
	private resolveCli(): CliResolution {
		const cli = this._cli = getCliResolution();
		const where = cli.source === 'setting' ? `the ${configSection}.cliPath setting`
			: cli.source === 'managed' ? `GeminiCode's copy ${cli.version}`
				: cli.source === 'bundled' ? `the copy bundled with GeminiCode, ${cli.version}` : 'PATH';
		this.log.info(`Using the Gemini CLI from ${where}${cli.cliPath ? ` (${cli.cliPath})` : ''}`);
		if (cli.missingVersion) {
			this.log.warn(`Gemini CLI ${cli.missingVersion} is set in ${configSection}.cli.version but not installed; using ${where}`);
			if (cli.missingVersion !== this.offeredVersion) {
				this.offeredVersion = cli.missingVersion;
				void this.offerInstall(cli.missingVersion);
			}
		}
		return cli;
	}

	private onClientState(state: AgentClientState): void {
		switch (state.kind) {
			case 'ready': {
				const agent = state.agent.agentInfo;
				this.log.info(`Session ${state.sessionId} ready (${agent ? `${agent.name} ${agent.version}` : 'unknown agent'})`);
				if (agent?.version && agent.version !== this.warnedVersion && isOlderThan(agent.version, MIN_CLI_VERSION)) {
					this.warnedVersion = agent.version;
					void this.showOldCli(agent.version);
				}
				break;
			}
			case 'error':
				this.log.error(`Agent error (${state.error.kind}): ${state.error.message}`);
				void this.showError(state.error);
				break;
		}
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
			default:
				message = vscode.l10n.t("The Gemini agent failed: {0}", error.message);
				actions = [restart, setUpInTerminal, showLog];
		}

		switch (await vscode.window.showErrorMessage(message, ...actions)) {
			case setUpInTerminal: this.completeSetupInTerminal(); break;
			case setProject: await vscode.commands.executeCommand('gemini.setProjectId'); break;
			case setCliPath: await vscode.commands.executeCommand('workbench.action.openSettings', `${configSection}.cliPath`); break;
			case installCli: await vscode.commands.executeCommand('gemini.installCli'); break;
			case restart: this.restart(); break;
			case showLog: this.log.show(); break;
		}
	}
}
