/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Starting an agent's session and chat in this window: the AgentSession on
// the shared agent process, with the browser's, the team tools', the index's
// and the project's MCP servers, and the ChatController with everything its
// options reach into the window for; then the agent's activity, edits and
// session state wired back to the list. The pane keeps the agents started
// here in its `live` map.

import { errorsNotice } from '../../acp/editorTools';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { AgentChanges } from '../../acp/agentChanges';
import { cliHome, projectTempDirName } from '../../acp/cli/formats';
import { attentionChange } from '../../acp/attention';
import { branchNameFrom } from '../../acp/branchNames';
import { writeCommitMessage } from '../../acp/commitMessage';
import type { AgentRecord, AgentsModel } from '../../acp/agents';
import { coordinatorModel } from '../../acp/projectHub';
import { FolderFileIndex } from '../../acp/folderFiles';
import { errorMessage } from '../../acp/errors';
import type { SessionChoice } from '../../acp/sessionSettings';
import { coordinatorHome } from '../../acp/worktrees';
import type { AgentNotifier } from '../agentNotifier';
import type { AgentService } from '../agentService';
import { AgentSession } from '../agentSession';
import type { CommitSettler } from '../commitSettler';
import { toolChipsFor } from '../toolChips';
import { ChatActivity, ChatController, ChatEnhancer, ChatWorkspace, FileSearch } from '../chatController';
import { getApprovalPolicy, includedFolderPaths } from '../configuration';
import { configuredDefaultMode } from '../defaultMode';
import { isModeAllowed } from '../../acp/toolPolicy';
import { effectiveStartMode } from '../../acp/chatTurns';
import { type InstantAnswer, shellCommand } from '../../acp/permissions';
import { isReadOnlyGitRead } from '../../acp/sessionApprovals';
import { Projects, projectsEnabled } from '../projects';
import type { DiffPreview } from '../diffPreview';
import { agentColumn } from '../editorPlacement';
import { sessionModel } from '../modelPreference';
import type { WorkspaceFileIndex } from '../workspaceFiles';
import type { AgentsView } from '../agentsView';
import type { AgentForks } from './agentForks';
import type { AgentFeatures } from './agentFeatures';
import type { AgentPersistence } from './agentPersistence';
import type { AgentSideLinks } from './agentSideLinks';
import type { AgentTabs } from './agentTabs';
import { spareDelayMs, type SpareSession } from './spareSession';
import { showError } from '../errorNotice';

/** An agent with a live session in this window. */
export interface LiveAgent {
	readonly session: AgentSession;
	readonly controller: ChatController;
	/** The files this agent's tools edited. */
	readonly changes: AgentChanges;
	/** The files of its folder, for the @ picker and its Files page's search. */
	readonly files: FileSearch;
	panel?: vscode.WebviewPanel;
	/** A turn finished while its tab was not in front. */
	unread: boolean;
	activity: ChatActivity;
	/** A pending save of the conversation. */
	saveTimer?: ReturnType<typeof setTimeout>;
	/** When the oldest change not yet saved happened, so a long reply is saved while it streams. */
	unsavedSince?: number;
	/** The icon file its tab shows (its state, or Gemini's or Jira's at rest); unset until set. */
	tabIcon?: string;
	readonly disposables: vscode.Disposable[];
}

/** What starting an agent's session and chat reaches into the Agents pane for. */
export interface AgentStartHost {
	readonly extensionUri: vscode.Uri;
	/** Where Plan Review keeps its files. */
	readonly planReviewFolder: string;
	readonly model: AgentsModel;
	readonly service: AgentService;
	/** The agents running in this window; a started agent is added. */
	readonly live: Map<string, LiveAgent>;
	readonly projects: Pick<Projects, 'mcpServersFor' | 'ready' | 'instantAnswer' | 'repoFolders' | 'chatProject' | 'threadActivity' | 'threadChanged' | 'attach'>;
	readonly spare: Pick<SpareSession, 'key'>;
	readonly forks: Pick<AgentForks, 'forkerFor'>;
	readonly settler: Pick<CommitSettler, 'update'>;
	readonly notifier: Pick<AgentNotifier, 'notify'>;
	readonly workspaceFiles: Pick<WorkspaceFileIndex, 'scopedTo'>;
	readonly diffPreview: DiffPreview;
	readonly enhancer: ChatEnhancer;
	/** The pane's own surface the chat reaches: what activate sets on it (the browser, the team tools, the index, usage), reviews, the spare session and its tabs. */
	readonly view: Pick<AgentsView, 'browser' | 'teamTools' | 'index' | 'debug' | 'usage' | 'contextCost' | 'reviewChip' | 'openReview' | 'direct' | 'review' | 'cliDefaultMode' | 'prepareStart' | 'open' | 'openChanges'>;
	/** Try in Workspace, Plan Review and the design-system note, loaded once first needed. */
	readonly features: Pick<AgentFeatures, 'tries' | 'planReviews' | 'onDemand'>;
	readonly tabs: Pick<AgentTabs, 'reveal'>;
	/** The side column's links, and Run on the agent's replies. */
	readonly sideLinks: Pick<AgentSideLinks, 'openSideLink' | 'chatTerminal'>;
	/** Saves the agent's conversation and checkpoints. */
	readonly persistence: Pick<AgentPersistence, 'scheduleSave' | 'checkpointFiles'>;
	/** Redraws the list, or agent `id`'s row. */
	refresh(id?: string): void;
	/** An agent started or ended a turn, for Plan Review. */
	turnChanged(id: string): void;
}

export class AgentStarter {

	/** The model an agent's first session starts on, picked in the New thread dialog or the browser's New Agent. */
	private readonly threadModels = new Map<string, string>();

	constructor(private readonly host: AgentStartHost) { }

	/** The model agent `id`'s first session starts on. */
	pickModel(id: string, model: string): void {
		this.threadModels.set(id, model);
	}

	/** A coordinator runs on the model picked in its chat, else Flash; a thread on the model picked for it, once; others on the user's choice. */
	private preferredModel(record: AgentRecord): ((available: readonly SessionChoice[]) => string | undefined) | undefined {
		const picked = this.threadModels.get(record.id);
		if (picked) {
			this.threadModels.delete(record.id);
			return available => available.some(choice => choice.id === picked) ? picked : sessionModel(available);
		}
		if (projectsEnabled() && record.project?.role === 'coordinator') {
			return available => {
				const project = this.host.model.agent(record.id)?.project;
				const picked = project?.role === 'coordinator' ? project.model : undefined;
				return picked && available.some(choice => choice.id === picked) ? picked : coordinatorModel(available.map(choice => choice.id));
			};
		}
		return undefined;
	}

	start(record: AgentRecord, folder: string, openLater = false): LiveAgent {
		const host = this.host;
		const project = projectsEnabled() ? record.project : undefined;
		// A coordinator's session runs in its own empty folder (coordinatorHome); its chat still belongs to the workspace.
		const cwd = project?.role === 'coordinator' ? coordinatorHome(record.id) : folder;
		// An agent's worktree starts from a copy of its workspace's index; a coordinator has no code to index.
		const indexServers = () => cwd === folder ? host.view.index?.mcpServersFor(record.id, folder, record.worktree ? host.model.workspace(record.workspaceId)?.folder : undefined) ?? [] : [];
		const servers = () => [...host.view.browser?.mcpServersFor(record.id, folder) ?? [], ...host.view.teamTools?.mcpServersFor(record.id, folder) ?? [], ...indexServers(), ...host.view.debug?.servers(record.id) ?? [], ...project ? host.projects.mcpServersFor(host.model.agent(record.id) ?? record) : []];
		const session = new AgentSession(host.service, cwd, record.sessionId, servers, openLater, {
			// A project agent's session needs the project's server, which a spare never has, listening before it opens:
			// a session opened without it, as from a restored tab or a thread warmed at project open, never gets the tools.
			// A coordinator's own folder has to exist before its session opens there.
			...(project ? { beforeOpen: async () => { if (cwd !== folder) { await fs.promises.mkdir(cwd, { recursive: true }); } await host.projects.ready(); } } : { spareKey: () => host.spare.key(folder) }),
			onDidOpenSession: servers => {
				host.view.browser?.bindSession(record.id, folder, servers);
				host.view.teamTools?.bindSession(record.id, folder, servers);
				// An agent whose task needed the team tools keeps them on every session.
				if (host.model.agent(record.id)?.teamTools) {
					host.view.teamTools?.enableTeamTools(record.id);
				}
				host.view.index?.bindSession(record.id, folder, servers);
				host.view.debug?.bindSession(record.id, servers);
				// Refill, for the next agent, which most likely starts in the same folder; not in an agent's own worktree.
				if (!host.model.agent(record.id)?.worktree) {
					host.view.prepareStart(folder, spareDelayMs);
				}
			},
		}, this.preferredModel(record));
		// A new agent starts in `gemini.agents.defaultMode`, else the CLI's own default; one started with a mode of its own (Home, a team flow) switches to it after this.
		const startMode = !record.sessionId && !project ? effectiveStartMode(configuredDefaultMode(), host.view.cliDefaultMode, modeId => isModeAllowed(getApprovalPolicy(), modeId)) : undefined;
		if (startMode) {
			session.client.setModeOnNextSession(startMode);
		}
		session.permissions.confirmOnly = request => !!host.view.teamTools?.isConfirmCall(request);
		session.permissions.answerAtOnce = request => (project ? host.projects.instantAnswer(host.model.agent(record.id) ?? record, request) : undefined)
			?? host.view.teamTools?.instantAnswer(request) ?? (host.view.reviewChip?.(record.id) ? reviewerGitAnswer(request) : undefined);
		// A folder of the window lists the window's files it may reach: its own, and the others with `gemini.agents.allWorkspaceFolders`.
		// A folder outside the window lists its files from its index once that is built, else from git.
		const files: FileSearch = isOpenFolder(folder) ? host.workspaceFiles.scopedTo(() => [folder, ...includedFolderPaths()]) : new FolderFileIndex(folder, undefined, () => host.view.index?.files(folder) ?? Promise.resolve(undefined));
		const changes = new AgentChanges(folder, path.join(cliHome(), projectTempDirName));
		const workspace = (): ChatWorkspace | undefined => {
			const workspace = host.model.workspace(record.workspaceId);
			const current = host.model.agent(record.id) ?? record;
			// A coordinator of a project with several repositories shows each; a thread across them, its worktree of each.
			const threadRepos = current.repos?.filter(repo => !repo.merged).map(repo => ({ name: repo.key, folder: repo.cwd }));
			const repos = current.project?.role === 'coordinator' && projectsEnabled() ? host.projects.repoFolders(current.id) : threadRepos && threadRepos.length > 1 ? threadRepos : undefined;
			return workspace && { folder: workspace.folder, cwd: folder, worktree: !!current.worktree, ...(repos ? { repos } : {}) };
		};
		const live: LiveAgent = {
			session,
			changes,
			files,
			controller: new ChatController(host.extensionUri, session, host.diffPreview, files, {
				reveal: preserveFocus => host.tabs.reveal(record.id, preserveFocus),
				isShown: () => host.live.get(record.id)?.panel?.visible === true,
				onDidPickModel: modelId => host.model.setCoordinatorModel(record.id, modelId),
				sendTriedEdits: () => host.features.tries.sendEdits(record.id, true),
				reviewPlan: file => void host.features.planReviews.open(record.id, file).catch(err => showError(errorMessage(err))),
				planReviewFolder: host.planReviewFolder,
				editorColumn: () => agentColumn(record.id, host.live.get(record.id)?.panel),
				enhancer: host.enhancer,
				indexContext: draft => host.view.index?.contextFor(folder, draft) ?? Promise.resolve(undefined),
				// Not for a coordinator, which runs in an empty folder without the index.
				indexHint: () => cwd === folder ? host.view.index?.hint(folder) : undefined,
				errorsAfterTurn: async () => {
					const found = await host.view.index?.diagnostics(folder);
					return found && errorsNotice(folder, found.diagnostics);
				},
				designSystemNote: async () => host.view.teamTools ? host.features.onDemand().designSystemNoteFor(await host.view.teamTools.defaults(cwd)) : undefined,
				teamTools: {
					available: () => !!host.view.teamTools?.connected.size,
					enabled: () => !!host.view.teamTools?.teamToolsEnabled(record.id),
					enable: () => {
						host.model.setTeamTools(record.id);
						host.view.teamTools?.enableTeamTools(record.id);
					},
					notePrompt: (text, attachments) => {
						if (host.view.teamTools?.promptNeedsTools(text, attachments)) {
							host.model.setTeamTools(record.id);
							host.view.teamTools.enableTeamTools(record.id);
						}
					},
				},
				// Research reads the agent's own folder with workers of its own; not in a project's chats, whose threads do the reading.
				...project ? {} : {
					research: {
						runtime: host.service.runtime,
						cwd: () => folder,
						mcpServers: (worker: string) => host.view.index?.mcpServersFor(worker, folder, record.worktree ? host.model.workspace(record.workspaceId)?.folder : undefined) ?? [],
						release: (worker: string) => host.view.index?.forgetAgent(worker),
						outline: async () => host.view.index?.outlineOf(folder),
					},
				},
				usage: () => host.view.usage,
				contextCost: () => host.view.contextCost,
				// The index's definitions, only while agents get its tools and the folder's index is built.
				symbols: async query => {
					const index = host.view.index;
					if (!index?.hint(cwd) || cwd !== folder) {
						return undefined;
					}
					const answer = await index.request('findSymbol', { root: folder, name: query });
					const found = answer ? [...answer.result.definitions, ...answer.result.similar] : [];
					return found.map(symbol => ({ name: symbol.name, kind: symbol.kind, path: path.join(folder, symbol.path), line: symbol.line, endLine: symbol.endLine }));
				},
				toolChips: () => host.view.teamTools && toolChipsFor(host.view.teamTools),
				// Debug mode's phase and hypotheses, with every prompt while the agent is in it.
				turnNote: () => host.view.debug?.turnNote(record.id),
				debugAction: (action, arg) => void vscode.commands.executeCommand('gemini.debug.action', record.id, action, arg),
				review: () => host.view.reviewChip?.(record.id),
				openReview: () => host.view.openReview?.(record.id),
				openMergeRequest: () => void vscode.commands.executeCommand('gemini.team.openMergeRequest', record.id),
				title: () => host.model.agent(record.id)?.title ?? record.title,
				// A coordinator splits work into threads instead; a thread's fork is a new thread (Fork Thread).
				...(record.project?.role === 'coordinator' ? {} : { fork: host.forks.forkerFor(record.id) }),
				...(project?.role === 'coordinator' ? { project: host.projects.chatProject(record.id) } : {}),
				...(project?.role === 'thread' ? {
					parentProject: {
						name: () => host.model.agent(project.coordinator)?.title ?? '',
						open: () => void host.view.open(project.coordinator),
					},
				} : {}),
				savedSessions: {
					inUse: () => new Set(host.model.snapshot().agents.flatMap(a => a.id !== record.id && a.sessionId ? [a.sessionId] : [])),
				},
				saveCheckpoints: stored => void host.persistence.checkpointFiles.save(record.id, stored),
				sharedPage: {
					current: () => host.view.browser?.sharedPage(record.id) ?? Promise.resolve(undefined),
					stop: () => host.view.browser?.stopSharing(record.id) ?? Promise.resolve(),
					reveal: () => host.view.browser?.revealSharedPage(record.id) ?? Promise.resolve(false),
				},
				workspace,
				// A coordinator works in an empty folder of its own: it has no changes, terminal or files to link to.
				...(project?.role === 'coordinator' ? {} : {
					sideLinks: {
						view: () => ({ place: path.basename(workspace()?.folder ?? folder), added: changes.totals.added, removed: changes.totals.removed }),
						onDidChange: listener => changes.onDidChange(listener),
						open: link => host.sideLinks.openSideLink(record.id, link),
					},
				}),
				terminal: host.sideLinks.chatTerminal(record.id, workspace, project?.role === 'coordinator'),
				// An edit to a file another live agent in the folder has unreviewed changes in says so.
				sharedFiles: {
					others: filePath => host.view.review.othersChanging(filePath, record.id).flatMap(source => source.id ? [{ agent: source.id, title: host.model.agent(source.id)?.title ?? '' }] : []),
					show: agent => void host.view.openChanges(agent),
				},
				git: {
					folder: () => folder,
					// An agent on its own branch commits there with Merge Back, not from the chat.
					...(record.worktree ? { ownBranch: record.worktree.branch } : {
						commit: {
							files: () => changes.files.map(file => file.path),
							onDidChange: listener => changes.onDidChange(listener),
							suggestion: () => {
								const title = host.model.agent(record.id)?.title ?? record.title;
								// The agent's name when no message can be written from the diff.
								return { branch: branchNameFrom(title), message: title, writeMessage: () => writeCommitMessage(folder, changes.files.map(file => file.path), host.view.direct) };
							},
							// Committed changes are no longer the agent's to review.
							committed: () => changes.clear(),
						},
					}),
				},
			}),
			unread: false,
			activity: { busy: false, needsPermission: false },
			disposables: [],
		};
		live.disposables.push(
			live.controller.onDidChangeActivity(activity => {
				if (live.activity.busy && !activity.busy && !live.panel?.active) {
					live.unread = true;
				}
				const change = attentionChange(live.activity, activity);
				if (change) {
					host.notifier.notify(record.id, change, host.model.agent(record.id)?.title ?? record.title, () => void host.view.open(record.id));
				}
				if (!activity.busy) {
					host.persistence.scheduleSave(record.id, live);
					if (live.activity.busy) {
						host.view.index?.agentTurnEnded(folder);
					}
				}
				const before = live.activity;
				live.activity = activity;
				if (project) {
					host.projects.threadActivity(host.model.agent(record.id) ?? record, before, activity);
				}
				// A tried agent's turn ended: its new work follows into the checkout. A discarded one's new work replaces what Restore would bring back.
				const ended = before.busy && !activity.busy ? host.model.agent(record.id) : undefined;
				if (ended?.tried || ended?.discarded?.length) {
					void host.features.tries.turnEnded(record.id);
				}
				if (before.busy !== activity.busy) {
					// Working again after Keep or Merge Back: no longer kept or merged, so it is not archived under it.
					if (activity.busy) {
						host.model.setResolved(record.id, undefined);
					}
					host.turnChanged(record.id);
				}
				host.refresh(record.id);
			}),
			session.client.onDidChangeState(state => {
				if (state.kind === 'ready') {
					host.model.setSessionId(record.id, state.savedSessionId);
				}
			}),
			live.controller.onDidEditFiles(diffs => {
				changes.record(diffs);
				host.view.index?.agentEdited(folder, diffs.map(diff => diff.path));
			}),
			changes.onDidChange(() => {
				host.view.review.refreshSoon();
				host.settler.update();
				host.model.setChanges(record.id, changes.totals);
				if (project) {
					host.projects.threadChanged(host.model.agent(record.id) ?? record);
				}
				host.persistence.scheduleSave(record.id, live);
				host.refresh();
			}),
			live.controller.onDidRestoreSession(title => {
				host.model.recordRestore(record.id, title);
				const name = host.model.agent(record.id)?.title;
				if (live.panel && name) {
					live.panel.title = name;
				}
				host.persistence.scheduleSave(record.id, live);
			}),
			live.controller.onDidSendPrompt(text => {
				host.model.recordPrompt(record.id, text);
				const title = host.model.agent(record.id)?.title;
				if (live.panel && title) {
					live.panel.title = title;
				}
			}),
			session.onDidChangeStatus(() => host.refresh(record.id)),
		);
		host.live.set(record.id, live);
		if (project) {
			host.projects.attach(record);
		}
		return live;
	}
}

function isOpenFolder(folder: string): boolean {
	return (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.scheme === 'file' && f.uri.fsPath === folder);
}

/**
 * A merge request reviewer's read-only git command (`git diff`, `git log`,
 * `git show`, `git status`), allowed with Allow once: its checkout is never
 * trusted, so the Gemini CLI asks before every git command there. It is a
 * worktree of the user's own clone, so git runs with the user's own config,
 * and these commands run no hooks.
 */
function reviewerGitAnswer(request: acp.RequestPermissionRequest): InstantAnswer | undefined {
	const command = shellCommand(request);
	const once = request.options.find(option => option.kind === 'allow_once');
	return command !== undefined && once && isReadOnlyGitRead(command) ? { optionId: once.optionId, label: vscode.l10n.t("Allowed: the reviewer reads the repository with git") } : undefined;
}
