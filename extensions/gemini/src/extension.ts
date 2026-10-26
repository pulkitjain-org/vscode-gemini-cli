/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { validateProjectId } from './acp/projectId';
import { filesToAttach, selectionsToAttach } from './host/addToChat';
import { AppUpdateNotice } from './host/appUpdateNotice';
import { Appearance } from './host/appearance';
import { AgentService } from './host/agentService';
import { AgentHome } from './host/agentHome';
import { AgentWarmup } from './host/agentWarmup';
import { AgentsView, loadSavedAgents } from './host/agentsView';
import { TerminalGemini } from './host/terminalGemini';
import { tildify } from './host/displayText';
import { ChangesPanel } from './host/changesPanel';
import { applyLayoutDefaults } from './host/layoutDefaults';
import { checkAgent } from './host/checkAgent';
import { CliManager } from './host/cliManager';
import { DiffPreview } from './host/diffPreview';
import { errorMessage } from './acp/errors';
import { PromptEnhancer } from './acp/promptEnhancer';
import { configSection, getAgentCommand, getWorkspaceCwd, loadProductInfo, productInfo, setAgentEnvOverride, setStorageDirs } from './host/configuration';
import { initModelList, initModelPreference, knownModelList } from './host/modelPreference';
import { initReactionRecents } from './host/chatReactions';
import { SetupWalkthrough, walkthroughId } from './host/setupWalkthrough';
import { GeminiStatusBar } from './host/statusBar';
import { QuickEdits } from './host/quickEdits';
import { UsageMeter } from './host/usageMeter';
import { forgetSkills, initTeamCommands } from './host/teamCommands';
import { KeepAwake } from './acp/keepAwake';
import { debugLogName } from './acp/mcpDiagnostics';
import { BrowserTools } from './host/browserTools';
import { TeamConnections } from './host/teamConnections';
import { TeamFlows } from './host/teamFlows';
import { setTraceFile, setTraceFolder } from './host/traceCommand';
import { scheduleStorageMaintenance } from './host/storageMaintenance';
import { MrPanel } from './host/mrPanel';
import { TeamStatusBar } from './host/teamStatusBar';
import { AuditStatusBar } from './host/auditStatusBar';
import { chunkLoader, LazyFeature } from './host/lazyFeature';
import { recordPilot, setPilotSink } from './acp/pilotLog';
import { WorkspaceFileIndex } from './host/workspaceFiles';
import { WorkspaceIndex } from './host/workspaceIndex';
import { DocsSources } from './host/docsSources';
import { IndexPage } from './host/indexPage';
import { IndexStatusBar } from './host/indexStatusBar';
import { measureFolderContextCost } from './host/contextCostProbe';
import { ContextMeasures } from './host/chat/chatContext';
import { FixWithGemini } from './host/quickFix';
import { parseMemoryList, runCliCommands } from './acp/cliCommands';
import { disposeGitIgnore } from './host/workspaceFileSystem';
import { logErrorCommand } from './host/errorNotice';

/** The pilot's setting (pilot.ts): while it is on, the pilot is constructed at launch, to record it. */
const pilotRecordSetting = 'pilot.record';

/** Finishes the writes that must outlive the window; set by activate. */
let saveBeforeExit: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const activationStart = Date.now();
	const log = vscode.window.createOutputChannel('Gemini', { log: true });
	// The agent list is read while the product info loads.
	const savedAgents = loadSavedAgents(context);
	await loadProductInfo();
	initModelPreference(context.globalState);
	initReactionRecents(context.globalState);
	setStorageDirs({
		managedCli: vscode.Uri.joinPath(context.globalStorageUri, 'gemini-cli').fsPath,
		bundledCli: vscode.Uri.joinPath(context.extensionUri, 'cli').fsPath,
		adminPolicy: vscode.Uri.joinPath(context.globalStorageUri, 'policy').fsPath,
	});
	const teamCommandStore = initTeamCommands(log);
	// The CLI's debug log, one per window's process (GEMINI_DEBUG_LOG_FILE), so windows never empty each other's.
	const service = new AgentService(log, vscode.Uri.joinPath(context.globalStorageUri, 'cli-logs', debugLogName()).fsPath);
	const diffPreview = new DiffPreview();
	const fileIndex = new WorkspaceFileIndex();
	// Rewrites run on the agent process every chat shares, in an empty folder of their own.
	const enhancer = new PromptEnhancer(service.runtime, {
		cwd: vscode.Uri.joinPath(context.globalStorageUri, 'enhance').fsPath,
		start: () => service.isStarted || service.restart(),
		// One direct request when inline edit's are on; the CLI otherwise, or when it fails.
		direct: (request): Promise<string | undefined> => quickEdits.enhancePrompt(request),
		onDirectFailed: err => log.info(`Prompt enhancement's direct request failed (${errorMessage(err)}); asking the CLI`),
		onDidEnhance: ({ ms, model }) => log.info(`Prompt enhanced in ${ms} ms with ${model ?? 'the default model'}`),
	});
	const agentsView = new AgentsView(context, service, diffPreview, fileIndex, enhancer, await savedAgents);
	saveBeforeExit = () => agentsView.saveAll();
	// Agents mode's Changes panel follows the agent in front, as the Changes view does.
	const changesPanel = new ChangesPanel(context.extensionUri);
	changesPanel.show(agentsView.focusedSource);
	void applyLayoutDefaults(context);
	// Add to Chat goes to the agent tab in front, else the running agent used last, else a new agent.
	const chatInFront = (orNew = false) => agentsView.chatFor(orNew);
	const quickEdits = new QuickEdits(agentsView.review, log);
	const statusBar = new GeminiStatusBar(service);
	// For Home's card after a start: when the window opened and when the agent was first ready.
	const activatedAt = Date.now();
	let readyAt: number | undefined;
	context.subscriptions.push(service.onDidChangeStatus(status => {
		if (status.phase === 'ready' && readyAt === undefined) {
			readyAt = Date.now();
		}
	}));
	const usageMeter = new UsageMeter(quickEdits.client, log);
	agentsView.usage = usageMeter;
	// Drafts a project's Memory text with the same direct request quick edits use.
	agentsView.direct = request => quickEdits.enhancePrompt(request);
	initModelList({
		quotaModels: () => {
			const reading = usageMeter.reading;
			return reading?.kind === 'ok' ? reading.quota.map(q => q.model) : undefined;
		},
		workspaceFolder: getWorkspaceCwd,
	});
	const walkthrough = new SetupWalkthrough(service, context.globalState);
	const warmup = new AgentWarmup(service, () => walkthrough.isSetUp, log);
	const browserTools = new BrowserTools(String(context.extension.packageJSON.version ?? ''), log, {
		stop: agent => agentsView.stopTurn(agent),
		title: agent => agentsView.agentTitle(agent) ?? vscode.l10n.t("Agent"),
		open: () => agentsView.summaries().filter(agent => agent.state !== 'stopped'),
		attach: async (agent, attachments) => {
			await agentsView.open(agent);
			await agentsView.controllerOf(agent)?.addAttachments(attachments);
		},
		showSharedPage: async agent => {
			await agentsView.open(agent);
			await agentsView.controllerOf(agent)?.refreshSharedPage();
		},
		sharedPageChanged: agent => void agentsView.controllerOf(agent)?.refreshSharedPage(),
		attachToFront: async attachments => (await chatInFront(true))?.addAttachments(attachments),
		model: agent => agentsView.controllerOf(agent)?.model,
		newAgent: page => agentsView.newAgentFor(page),
		recent: () => agentsView.summaries().filter(agent => agent.state === 'stopped' && agent.project?.role !== 'coordinator').slice(0, 10)
			.map(agent => ({ id: agent.id, title: agent.title, detail: tildify(agent.worktree?.folder ?? agent.folder) })),
		wake: agent => agentsView.open(agent),
		send: (agent, text, attachments) => void agentsView.controllerOf(agent)?.send(text, attachments),
	});
	agentsView.browser = browserTools;
	const teamTools = new TeamConnections(context, String(context.extension.packageJSON.version ?? ''), log);
	agentsView.teamTools = teamTools;
	// The indexer runs from indexer.js beside this file, in out/ or dist/.
	const workspaceIndex = new WorkspaceIndex({ script: path.join(__dirname, 'indexer.js'), version: String(context.extension.packageJSON.version ?? ''), log });
	agentsView.index = workspaceIndex;
	const docsSources = workspaceIndex.docs = new DocsSources(workspaceIndex, log);
	// A tool connecting, or the browser or the index turned on or off, changes what a new session gets: the spare follows.
	context.subscriptions.push(
		workspaceIndex,
		docsSources,
		new IndexPage(context.extensionUri, workspaceIndex, docsSources, agentsView, service, context.globalState),
		new IndexStatusBar(workspaceIndex),
		workspaceIndex.onDidChangeEnabled(() => agentsView.refreshSpare()),
		teamTools.onDidChange(() => agentsView.refreshSpare()),
		vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration(`${configSection}.browser`) && agentsView.refreshSpare()),
	);
	// What every model call in a folder carries: Project Helpers' Context cost, and the chat's usage popover (/context).
	const measureContext = (folder: string, servers: readonly string[]) => measureFolderContextCost({
		folder,
		servers,
		// What a new agent's session gets from GeminiCode itself.
		geminicodeServers: () => [...browserTools.spareServers(), ...teamTools.spareServers(), ...workspaceIndex.spareServers(folder)],
		emptyFolder: vscode.Uri.joinPath(context.globalStorageUri, 'context-probe').fsPath,
		log: message => log.info(message),
	});
	const contextMeasures = new ContextMeasures(context.globalState, {
		measure: measureContext,
		// The CLI lists the context files it loaded itself, without a model call, in a hidden session.
		ruleFiles: async folder => {
			const [reply] = await runCliCommands(service.runtime, folder, ['/memory list']);
			return reply === undefined ? undefined : parseMemoryList(reply);
		},
		log: message => log.info(message),
	});
	agentsView.contextCost = contextMeasures;
	const teamFlows = new TeamFlows(context.extensionUri, teamTools, agentsView, context.globalState);
	// A reviewer agent's chat has a chip that opens its review.
	agentsView.reviewChip = agentId => {
		const review = teamFlows.reviews.forAgent(agentId);
		return review && { label: vscode.l10n.t("Review !{0}", review.iid), tip: vscode.l10n.t("Open the review of !{0}: {1}", review.iid, review.title) };
	};
	agentsView.openReview = agentId => void vscode.commands.executeCommand('gemini.team.openAgentReview', agentId);
	context.subscriptions.push(teamFlows.reviews.onDidChange(() => agentsView.refreshChats()));
	// Pages opened on request and tools used rarely load from bundles of their own, the first time one of their commands runs.
	const traceFolder = vscode.Uri.joinPath(context.globalStorageUri, 'traces').fsPath;
	setTraceFolder(traceFolder);
	const pages = chunkLoader<typeof import('./pages')>(__dirname, 'pages');
	const onDemand = chunkLoader<typeof import('./onDemand')>(__dirname, 'onDemand');
	let launching = true;
	const pilot = new LazyFeature(['gemini.pilot.export'], () => new (onDemand().Pilot)(context.globalStorageUri.fsPath, teamTools, usageMeter, { setSink: setPilotSink, record: recordPilot }, launching));
	// While recording is on, the pilot starts with the window, to record the launch; turned on later, it starts then.
	const startPilot = () => {
		if (vscode.workspace.getConfiguration(configSection).get<boolean>(pilotRecordSetting, false)) {
			try {
				pilot.get();
			} catch (err) {
				log.error(`The pilot's counters could not start: ${errorMessage(err)}`);
			}
		}
	};
	startPilot();
	launching = false;
	const mrPanel = new MrPanel(teamTools, agentsView, agent => teamFlows.checksSummary(agent));
	changesPanel.team = mrPanel;
	// caffeinate watches this process, so it ends with GeminiCode even if GeminiCode crashes.
	const keepAwake = new KeepAwake({ platform: process.platform, pid: process.pid, log: message => log.info(message) });
	const readKeepAwake = () => keepAwake.setEnabled(vscode.workspace.getConfiguration(configSection).get<boolean>('keepAwake', true));
	readKeepAwake();

	context.subscriptions.push(
		log,
		{ dispose: disposeGitIgnore },
		teamCommandStore,
		enhancer,
		service,
		diffPreview,
		fileIndex,
		agentsView,
		changesPanel,
		agentsView.onDidFocus(source => changesPanel.show(source)),
		new AgentHome(context.extensionUri, agentsView, () => warmup.startSoon(), { state: context.globalState, version: productInfo.version ?? String(context.extension.packageJSON.version ?? ''), cli: () => service.status.agentVersion, startup: () => ({ activatedAt, agent: agentPhase(service.status.phase), ...readyAt ? { readyAt } : {} }), reviews: { inProgress: () => teamFlows.reviews.inProgress, onDidChange: teamFlows.reviews.onDidChange } }),
		new LazyFeature(['gemini.projectSettings', 'gemini.newSkill'], () => new (pages().SettingsPage)(context.extensionUri, service, {
			getAgentCommand,
			forgetSkills,
			storage: {
				globalStorage: context.globalStorageUri.fsPath,
				agents: () => agentsView.storageAgents(),
				worktrees: () => agentsView.storageWorktrees(),
				removeWorktree: (repository, worktree, item) => agentsView.removeStorageWorktree(repository, worktree, item),
				cliVersion: () => service.status.agentVersion,
			},
		}, measureContext, context.globalState)),
		contextMeasures,
		// A quick fix on every problem: attach it, and the code around it, to the agent in front.
		new FixWithGemini(() => chatInFront(true)),
		quickEdits,
		statusBar,
		usageMeter,
		usageMeter.onDidChange(usage => statusBar.setUsage(usage)),
		walkthrough,
		warmup,
		new Appearance(context.extensionUri),
		new CliManager(service, context.globalState, log),
		new AppUpdateNotice(context.globalState, log),
		keepAwake,
		browserTools,
		teamTools,
		teamFlows,
		new LazyFeature(['gemini.recordTrace'], () => new (onDemand().TraceRecorder)(service, log, { setTraceFile, setAgentEnvOverride, dir: traceFolder })),
		new LazyFeature(['gemini.runBenchmark'], () => new (onDemand().BenchmarkCommand)(service, log, {
			getAgentCommand,
			knownModelList,
			version: () => productInfo.version,
			// Imported here, so the runner and the ACP SDK it uses stay in this bundle, which carries the SDK anyway.
			runner: () => import('./acp/benchmark'),
		})),
		pilot,
		vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration(`${configSection}.${pilotRecordSetting}`) && startPilot()),
		scheduleStorageMaintenance(context.globalStorageUri.fsPath, log),
		mrPanel,
		new LazyFeature(['gemini.connections'], () => new (pages().ConnectionsPage)(context.extensionUri, teamTools, log)),
		new TeamStatusBar(context.extensionUri, teamTools),
		new AuditStatusBar(teamTools.audit),
		new TerminalGemini({
			terminals: agentsView.terminals,
			attachTo: async (agent, attachments) => {
				await agentsView.open(agent);
				await agentsView.controllerOf(agent)?.addAttachments(attachments);
			},
			attachToFront: async attachments => (await chatInFront(true))?.addAttachments(attachments),
			direct: request => quickEdits.enhancePrompt(request),
		}),
		service.runtime.onDidBecomeBusy(() => keepAwake.setBusy(true)),
		service.runtime.onDidBecomeIdle(() => keepAwake.setBusy(false)),
		vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration(`${configSection}.keepAwake`) && readKeepAwake()),
		vscode.commands.registerCommand('gemini.enhancePrompt', async () => (await chatInFront())?.requestEnhance()),
		vscode.commands.registerCommand('gemini.toggleFollowAgent', async () => (await chatInFront())?.toggleFollowing()),
		vscode.commands.registerCommand('gemini.openChatAsMarkdown', async () => {
			const agent = agentsView.activeAgentId() ?? agentsView.summaries().find(each => each.state !== 'stopped')?.id;
			return agent ? agentsView.openAsMarkdown(agent) : vscode.window.showInformationMessage(vscode.l10n.t("Open an agent first."));
		}),
		vscode.commands.registerCommand('gemini.showUsage', async () => (await chatInFront())?.showUsage()),
		vscode.commands.registerCommand('gemini.sessionApprovals', async () => (await chatInFront())?.manageApprovals()),
		vscode.commands.registerCommand('gemini.addFileToChat', async (uri: unknown, uris: unknown) => {
			const attachments = await filesToAttach(uri, uris);
			return (await chatInFront(true))?.addAttachments(attachments);
		}),
		vscode.commands.registerCommand('gemini.addSelectionToChat', async () => {
			// Read before a new agent's tab takes the editor's place.
			const attachments = selectionsToAttach();
			return (await chatInFront(true))?.addAttachments(attachments);
		}),
		vscode.commands.registerCommand('gemini.showLog', () => log.show()),
		vscode.commands.registerCommand(logErrorCommand, (message: unknown) => typeof message === 'string' && log.error(message)),
		new LazyFeature(['gemini.openAuditLog'], () => new (onDemand().AuditPage)(context.extensionUri, teamTools.audit, id => agentsView.summaries().find(agent => agent.id === id)?.title)),
		vscode.commands.registerCommand('gemini.checkAgent', () => checkAgent(log)),
		vscode.commands.registerCommand('gemini.restartAgent', () => service.restart()),
		vscode.commands.registerCommand('gemini.completeSetupInTerminal', () => service.completeSetupInTerminal()),
		vscode.commands.registerCommand('gemini.setProjectId', () => setProjectId()),
		vscode.commands.registerCommand('gemini.signIn', () => walkthrough.signIn()),
		vscode.commands.registerCommand('gemini.getStarted', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', walkthroughId, false)),
	);
	// One line per launch, to measure startup on real machines (FINDINGS.md, starting the agent).
	const servicesUpMs = Date.now() - activationStart;
	const started = service.onDidStart(times => {
		started.dispose();
		log.info(`Startup: services up ${servicesUpMs} ms after activation; agent spawned ${times.spawnedAt - activationStart} ms after activation, process ready ${times.processReadyMs} ms after spawn, first session ready ${times.firstSessionMs} ms after spawn`);
	});
	context.subscriptions.push(started);
}

export function deactivate(): Promise<void> | undefined {
	// VS Code waits for this (a few seconds at most) before the process ends.
	return saveBeforeExit?.().catch(() => undefined);
}

async function setProjectId(): Promise<void> {
	const config = vscode.workspace.getConfiguration(configSection);
	const value = await vscode.window.showInputBox({
		title: vscode.l10n.t("Google Cloud Project ID"),
		prompt: vscode.l10n.t("The project ID (not the project number) that Gemini bills to, for example my-project-123."),
		value: config.get<string>('projectId') ?? '',
		ignoreFocusOut: true,
		validateInput: input => {
			const problem = input.trim() ? validateProjectId(input.trim()) : undefined;
			return problem === 'numeric' ? vscode.l10n.t("That is a project number. Enter the project ID instead.")
				: problem === 'malformed' ? { message: vscode.l10n.t("This does not look like a project ID."), severity: vscode.InputBoxValidationSeverity.Warning }
					: undefined;
		},
	});
	if (value === undefined) {
		return;
	}
	const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
	await config.update('projectId', value.trim() || undefined, target);
}

/** The agent's phase as Home's startup card names it. */
function agentPhase(phase: string): 'stopped' | 'starting' | 'ready' | 'error' {
	return phase === 'ready' ? 'ready' : phase === 'error' ? 'error' : phase === 'starting' || phase === 'restarting' ? 'starting' : 'stopped';
}
