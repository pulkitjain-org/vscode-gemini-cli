/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { suggestedTransition } from '../acp/teamDefaults';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { tildify } from './displayText';
import { branchChoices, changedFiles, checkoutForChecks, listBranches } from '../acp/checksBranch';
import { analyzeFiles } from '../acp/teamContainers';
import { errorMessage } from '../acp/errors';
import { GitLabClient, GitLabMr } from '../acp/gitlab';
import { formatDuration, type JiraMyTickets, jiraKeyIn, parseDuration } from '../acp/jira';
import { keyOf, type JiraSites } from '../acp/jiraSites';
import { extensionChunk } from './lazyFeature';
import { branchSummary, branchWorktree, fetchBranches, pushBranch, UnpushedCommitsError } from '../acp/releaseMerge';
import { describeSnyk } from '../acp/snyk';
import { sonarIssuesUrl, sonarProjectKeyIn } from '../acp/sonar';
import { countText } from '../acp/teamHttp';
import {
	CheckFinding, checksFixPrompt, findingsFromLocalSonar, findingsFromSnyk, findingsFromSonar, isUsualTarget, jiraCommentRequest, mrDescriptionRequest, mrFixPrompt,
	mrFixRepliesPrompt, MrThreadForFix, resolveWorkFolder, targetChoices, ticketBranchName, ticketStartPrompt, WorkFolder, workFolderChoices,
} from '../acp/teamFlowLogic';
import { gitlabProjectOf } from '../acp/teamTools';
import type { FoundClone } from '../acp/cloneSearch';
import type { CloneAsk } from './reviewClone';
import { AgentWorktree, commitAll, currentBranch, git, GitError, inRepository, repositoryRoot, runWorktreeSetup } from '../acp/worktrees';
import { setupCommandFor } from './agents/agentWorktrees';
import type { AgentsView } from './agentsView';
import type { TeamConnections } from './teamConnections';
import type { FlowRecord } from '../acp/flowRecords';
import type { FlowRecording, TeamFlowPanel } from './teamFlowPanel';
import { ChecksView, FlowAttachment, MoveTicketView, OpenMrView, ReviewView, Tone, TransitionView } from './teamFlowProtocol';
import { Reviews } from './reviews';
import { openTeamLink } from './teamLinks';
import { ticketPickItems } from './toolChips';
import { showError } from './errorNotice';

/** Where checks run: a checkout on a branch, the repository it belongs to, and the agent working there when there is one. */
interface ChecksPlace {
	readonly cwd: string;
	readonly title: string;
	readonly repository: string;
	readonly branch?: string;
	readonly agentId?: string;
	readonly worktree?: AgentWorktree;
	/** What the checkout's setup did, for the page's subtitle: "setup: npm ci (done, 41 s)". */
	readonly setup?: string;
}

/** Where Open Merge Request keeps the targets the user chose, by project, and how many. */
const recentTargetsKey = 'gemini.team.recentTargets';
const maxRecentTargets = 5;

/** Where an agent works and the GitLab project and branch there. */
interface GitPlace {
	readonly cwd: string;
	readonly project: string;
	readonly branch: string;
	readonly remote: string;
}

/**
 * The team flows: start an agent on a Jira ticket, open a merge request,
 * move a ticket (with a comment) and log time, review someone else's merge
 * request, and run the checks. Each opens
 * as a tab (TeamFlowPanel); nothing is written to Jira or GitLab until the
 * user presses the button that does it.
 */
export class TeamFlows implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	/** Merge request reviews in progress. */
	readonly reviews: Reviews;
	/** A reopened flow's typed fields, for the flow its command opens next. */
	private pendingRestore: { readonly command: string; readonly fields: NonNullable<FlowRecord['fields']> } | undefined;

	/** The target each Open Merge Request's description was written for. */
	private readonly describedFor = new WeakMap<TeamFlowPanel<OpenMrView>, string>();
	/** The bundle the flows' page comes from (src/pages.ts), loaded with the first flow opened. */
	private readonly pages = extensionChunk<typeof import('../pages')>('pages');

	/** `onDemand` loads dist/onDemand.js, where finding or cloning a merge request's repository lives (reviewClone.ts). */
	constructor(private readonly extensionUri: vscode.Uri, private readonly tools: TeamConnections, private readonly agents: AgentsView, private readonly state?: vscode.Memento, private readonly onDemand?: () => typeof import('../onDemand')) {
		const run = <A extends unknown[]>(id: string, handler: (...args: A) => Promise<unknown>) => vscode.commands.registerCommand(id, (...args: A) => handler(...args).catch(err => void showError(errorMessage(err))));
		this.reviews = new Reviews({
			extensionUri, tools, agents,
			gitlab: () => this.gitlab(),
			cloneOf: (project, gitlab, askFor) => this.cloneOf(project, gitlab, askFor === undefined ? undefined : { iid: askFor, purpose: 'review' }),
			side: (mr, ticket, folder) => this.reviewSide(mr, ticket, folder),
		});
		// A reviewer only reads, after a restart too: its writes would go out before the user chose what to post.
		tools.readOnlyBy(agent => !!this.reviews.forAgent(agent));
		this.disposables.push(
			this.reviews,
			run('gemini.team.startOnTicket', (key?: unknown) => this.startOnTicket(str(key))),
			run('gemini.team.openMergeRequest', (agent?: unknown) => this.openMergeRequest(str(agent))),
			run('gemini.team.moveTicket', (key?: unknown, agent?: unknown, suggest?: unknown) => this.moveTicket(str(key), str(agent), str(suggest))),
			run('gemini.team.logTime', (key?: unknown) => this.moveTicket(str(key), undefined, undefined, 'log')),
			run('gemini.team.reviewMergeRequest', (project?: unknown, iid?: unknown) => this.reviewMergeRequest(str(project), Number(iid) || undefined)),
			// From the palette: the review in progress; with an agent id, that agent's review; with a comment thread, the review's page.
			run('gemini.team.openReview', async (target?: unknown) => {
				if (isCommentThread(target)) {
					this.reviews.comments.openPage(target);
					return;
				}
				const review = str(target) ? this.reviews.forAgent(str(target)!) : undefined;
				return review ? this.reviews.open(review.project, review.iid) : this.openReview();
			}),
			run('gemini.team.actions', () => this.pickAction()),
			run('gemini.team.startNewReview', (project?: unknown, iid?: unknown) => this.startNewReview(str(project), Number(iid) || undefined)),
			run('gemini.team.discardReview', (project?: unknown, iid?: unknown) => this.discardReview(str(project), Number(iid) || undefined)),
			run('gemini.team.fixMergeRequest', (project?: unknown, iid?: unknown) => this.fixMergeRequest(str(project), Number(iid) || undefined)),
			run('gemini.team.reopenFlow', (id?: unknown) => this.reopenFlow(str(id))),
			run('gemini.team.discardFlow', async (id?: unknown) => str(id) ? this.tools.flows.close(str(id)!) : undefined),
			run('gemini.team.settleIntent', (id?: unknown) => this.settleIntent(str(id))),
			run('gemini.team.mergeMergeRequest', (project?: unknown, iid?: unknown, options?: unknown) => this.mergeMergeRequest(str(project), Number(iid) || undefined, isMergeOptions(options) ? options : {})),
			run('gemini.team.reassignTicket', (key?: unknown) => this.reassignTicket(str(key))),
			run('gemini.team.runChecks', (agent?: unknown) => this.runChecks(str(agent))),
			run('gemini.team.runChecksOnBranch', (branch?: unknown) => this.runChecksOnBranch(str(branch))),
		);
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** The last checks' result for an agent, in a line. */
	checksSummary(agentId: string): string | undefined {
		return this.agents.checkResult(agentId);
	}

	// --- Unfinished after a quit

	/** Starts a flow again from the inputs it was opened with; its old record goes, the new flow writes its own. */
	private async reopenFlow(id: string | undefined): Promise<void> {
		const record = id ? await this.tools.flows.get(id) : undefined;
		if (!record) {
			return;
		}
		await this.tools.flows.close(record.id);
		// The flow the command opens takes back what the user had typed.
		this.pendingRestore = record.fields && { command: record.command, fields: record.fields };
		try {
			await vscode.commands.executeCommand(record.command, ...record.args);
		} finally {
			this.pendingRestore = undefined;
		}
	}

	/** A flow's recording, with what the user typed before a quit when it is the flow being reopened. */
	private recording(command: string, args: readonly unknown[], about: string): FlowRecording {
		const restore = this.pendingRestore?.command === command ? this.pendingRestore.fields : undefined;
		this.pendingRestore = undefined;
		return { store: this.tools.flows, command, args, about, ...restore ? { restore } : {} };
	}

	/** Marks an audit intent with no result as looked into: the user checked the tool. */
	private async settleIntent(id: string | undefined): Promise<void> {
		const entry = (await this.tools.audit.unfinished()).find(e => e.id === id);
		if (entry) {
			await this.tools.audit.settle(entry, 'checked by hand');
		}
	}

	// --- Helpers

	private jira(): JiraSites {
		const jira = this.tools.connectors.jira;
		if (!jira) {
			throw new Error(vscode.l10n.t("Connect Jira first, in Connections."));
		}
		return jira;
	}

	private gitlab(): GitLabClient {
		const gitlab = this.tools.connectors.gitlab;
		if (!gitlab) {
			throw new Error(vscode.l10n.t("Connect GitLab first, in Connections."));
		}
		return gitlab;
	}

	/**
	 * The folder a flow works in: the agent in front's workspace, else the
	 * active editor's folder, else the first open folder. `ambiguous` says the
	 * window gave no hint between several, where the visual pass asks.
	 */
	private workFolder(): WorkFolder {
		const activeId = this.agents.activeAgentId();
		const editor = vscode.window.activeTextEditor?.document.uri;
		const editorFolder = editor && vscode.workspace.getWorkspaceFolder(editor);
		return resolveWorkFolder({
			agentFolder: activeId ? this.agents.agentPlace(activeId)?.folder : undefined,
			editorFolder: editorFolder?.uri.scheme === 'file' ? editorFolder.uri.fsPath : undefined,
			folders: (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath),
		});
	}

	/**
	 * The folder a flow works in, as `workFolder` finds it; when several
	 * folders are open and nothing says which, a quick pick titled `title`
	 * asks, with the agent last in front first: the folder, and the agent when
	 * its choice was picked. Undefined when dismissed; no folder when none is open.
	 */
	private async pickWorkFolder(title: string): Promise<{ readonly folder?: string; readonly agent?: string } | undefined> {
		const work = this.workFolder();
		if (!work.ambiguous) {
			return { ...work.folder ? { folder: work.folder } : {} };
		}
		const last = this.agents.agentLastInFront();
		const place = last ? this.agents.agentPlace(last) : undefined;
		const choices = workFolderChoices(last && place ? { id: last, title: place.title, cwd: place.cwd, folder: place.folder } : undefined, (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath));
		const inFront = vscode.l10n.t("agent in front");
		type Item = vscode.QuickPickItem & { readonly choice: ReturnType<typeof workFolderChoices>[number] };
		const pick = vscode.window.createQuickPick<Item>();
		pick.title = title;
		pick.placeholder = vscode.l10n.t("Several folders are open, and neither the agent in front nor the active editor says which");
		pick.matchOnDescription = true;
		pick.items = choices.map(choice => ({ label: `$(${choice.agent ? 'git-branch' : 'folder'}) ${choice.label}`, description: choice.agent ? `${tildify(choice.path)} · ${inFront}` : tildify(choice.path), choice }));
		const picked = await new Promise<{ readonly folder: string; readonly agent?: string } | undefined>(resolve => {
			pick.onDidAccept(() => {
				resolve(pick.selectedItems[0]?.choice);
				pick.hide();
			});
			pick.onDidHide(() => resolve(undefined));
			pick.show();
		});
		pick.dispose();
		return picked;
	}

	/** The folder of the team's defaults (Jira projects, targets): the flow's folder, asked for when the window doesn't say. */
	private defaultsFolder(): Promise<{ readonly folder?: string } | undefined> {
		return this.pickWorkFolder(vscode.l10n.t("Use the team settings of which folder?"));
	}

	/** The agent asked for, else the one in front, else the only running one. */
	private agentId(agent: string | undefined): string {
		const id = agent ?? this.agents.activeAgentId() ?? this.agents.summaries().find(a => a.state !== 'stopped')?.id;
		if (!id || !this.agents.agentPlace(id)) {
			throw new Error(vscode.l10n.t("Open an agent first."));
		}
		return id;
	}

	private async gitPlace(cwd: string, gitlab: GitLabClient): Promise<GitPlace> {
		const defaults = await this.tools.defaults(cwd);
		const local = await gitlabProjectOf(cwd, gitlab.url, defaults);
		if (!local.project) {
			throw new Error(vscode.l10n.t("{0} isn't a clone of a project on {1}.", path.basename(cwd), new URL(gitlab.url).host));
		}
		if (!local.branch) {
			throw new Error(vscode.l10n.t("{0} isn't on a branch.", path.basename(cwd)));
		}
		return { cwd, project: local.project, branch: local.branch, remote: local.remote ?? 'origin' };
	}

	/**
	 * A clone of `project`, for checking out its branches: the one remembered
	 * for it, else the first among the window's folders, the agents' folders
	 * and VS Code's recent folders, remembered. For the review of merge
	 * request `askFor`, asks the user when none is found; undefined when they cancel.
	 */
	/** A clone of `project` among the user's folders; with `ask`, the one they choose or clone when none is found. */
	private async cloneOf(project: string, gitlab: GitLabClient, ask?: CloneAsk): Promise<FoundClone | undefined> {
		if (!this.onDemand) {
			return undefined;
		}
		const agentFolders = async () => [...this.agents.summaries().map(a => a.folder), ...(await this.agents.workspaces()).map(w => w.folder)];
		return this.onDemand().cloneFor(project, gitlab, this.state, agentFolders, folder => gitlabProjectOf(folder, gitlab.url), ask);
	}

	private async draft(request: { readonly system: string; readonly prompt: string }): Promise<string | undefined> {
		try {
			return (await this.agents.direct?.(request))?.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	private async send(agentId: string, text: string): Promise<void> {
		void (await this.startTurn(agentId, text)).turn;
	}

	/** Opens the agent and sends it `text`; `turn` resolves when that turn ends. */
	private async startTurn(agentId: string, text: string): Promise<{ readonly controller: NonNullable<ReturnType<AgentsView['controllerOf']>>; readonly turn: Promise<void> }> {
		await this.agents.open(agentId);
		const controller = this.agents.controllerOf(agentId);
		if (!controller) {
			throw new Error(vscode.l10n.t("The agent isn't running."));
		}
		if (controller.running) {
			throw new Error(vscode.l10n.t("The agent is working. Try again when it finishes its turn."));
		}
		return { controller, turn: controller.send(text) };
	}

	// --- Start on a ticket

	/** Starts an agent on a ticket, named by its key or, from Home and the picker, its link, which says the ticket's Jira site. */
	private async startOnTicket(key: string | undefined): Promise<void> {
		const jira = this.jira();
		key ??= await this.pickTicket(jira);
		if (!key) {
			return;
		}
		const issue = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Reading {0}...", keyOf(key)) }, () => jira.issue(key!));
		if (!this.workFolder().folder) {
			throw new Error(vscode.l10n.t("Open your repository's folder first."));
		}
		const folder = (await this.pickWorkFolder(vscode.l10n.t("Start on {0} in which folder?", issue.key)))?.folder;
		if (!folder) {
			return;
		}
		const id = await this.agents.startTeamAgent({
			folder,
			title: `${issue.key} ${issue.summary}`,
			branch: ticketBranchName(issue.key, issue.summary),
			text: ticketStartPrompt(issue.key, issue.summary),
		});
		if (id && issue.statusCategory === 'new') {
			await this.moveTicket(issue.url, id, 'start');
		}
	}

	/** The link of the ticket the user picks, which names its Jira site too. */
	private async pickTicket(jira: JiraSites): Promise<string | undefined> {
		const mine = await jira.myTickets().catch((): JiraMyTickets => ({ issues: [] }));
		const picked = await vscode.window.showQuickPick(ticketPickItems(mine), { title: vscode.l10n.t("Start Agent on a Jira Ticket"), placeHolder: vscode.l10n.t("Your open tickets, this sprint's first"), matchOnDescription: true });
		return picked?.url ?? picked?.key;
	}

	// --- Move a ticket, and log time

	/** The palette's one entry for the Jira and GitLab actions Home's cards offer; each then asks for its ticket, agent or branch. */
	private async pickAction(): Promise<void> {
		const items: (vscode.QuickPickItem & { readonly command: string })[] = [
			{ label: vscode.l10n.t("$(git-pull-request) Open Merge Request..."), detail: vscode.l10n.t("From an agent's branch, with a title and description Gemini drafts"), command: 'gemini.team.openMergeRequest' },
			{ label: vscode.l10n.t("$(checklist) Run Checks"), detail: vscode.l10n.t("The team's checks on an agent's branch, with Gemini fixing what fails"), command: 'gemini.team.runChecks' },
			{ label: vscode.l10n.t("$(git-branch) Run Checks on a Branch..."), detail: vscode.l10n.t("The same checks on any branch, before a merge request exists"), command: 'gemini.team.runChecksOnBranch' },
			{ label: vscode.l10n.t("$(arrow-right) Move Jira Ticket..."), detail: vscode.l10n.t("The moves your workflow allows, with a comment Gemini drafts"), command: 'gemini.team.moveTicket' },
			{ label: vscode.l10n.t("$(clock) Log Time on Jira Ticket..."), command: 'gemini.team.logTime' },
			{ label: vscode.l10n.t("$(person) Reassign Jira Ticket..."), command: 'gemini.team.reassignTicket' },
		];
		const picked = await vscode.window.showQuickPick(items, { title: vscode.l10n.t("Jira and GitLab Actions"), placeHolder: vscode.l10n.t("What to do; it then asks which ticket, agent or branch") });
		if (picked) {
			await vscode.commands.executeCommand(picked.command);
		}
	}

	private async moveTicket(key: string | undefined, agent: string | undefined, suggest: string | undefined, mode: 'move' | 'log' = 'move'): Promise<void> {
		const jira = this.jira();
		const place = agent ? this.agents.agentPlace(agent) : undefined;
		const defaultsIn = place ? { folder: place.folder } : await this.defaultsFolder();
		if (!defaultsIn) {
			return;
		}
		const defaults = await this.tools.workspaceDefaults(defaultsIn.folder);
		key ??= place ? jiraKeyIn(`${place.branch ?? ''} ${place.title}`, defaults.jira?.projects) : undefined;
		key ??= await this.pickTicket(jira);
		if (!key) {
			return;
		}
		// `ref` names the ticket to Jira: its link, from Home or the picker, says which site it is on.
		const ref = key;
		const ticket = keyOf(key);
		let mrInfo: { iid: number; url: string; target: string } | undefined;
		/** The steps of this flow that went through, so pressing again after a failure doesn't repeat them: a move, a time log. */
		const finished = new Map<string, string>();
		const flow: TeamFlowPanel<MoveTicketView> = new (this.pages().TeamFlowPanel<MoveTicketView>)(this.extensionUri, mode === 'log' ? vscode.l10n.t("Log Time on {0}", ticket) : vscode.l10n.t("Move {0}", ticket), 'jira', vscode.l10n.t("Reading {0}...", ticket), async (action, value) => {
			const view = flow.view;
			if (!view) {
				return;
			}
			switch (action) {
				case 'select': {
					const transition = view.transitions.find(t => t.id === value);
					if (!transition) {
						return;
					}
					flow.update({ selected: transition.id, comment: flow.field('comment', view.comment) });
					if (!flow.fields.has('commentEdited')) {
						flow.update({ generating: true });
						const text = await this.draft(jiraCommentRequest({ key: ticket, summary: view.summary, to: transition.to, ...mrInfo ? { mr: mrInfo } : {} }));
						flow.update({ generating: false, ...text ? { comment: text, commentRev: view.commentRev + 1 } : {} });
						flow.fields.delete('comment');
					}
					return;
				}
				case 'submit':
					return flow.busy(vscode.l10n.t("Updating {0}...", ticket), async () => {
						const done: string[] = [];
						const current = flow.view!;
						const logTime = flow.field('logTime', current.logTime);
						const spent = flow.field('spent', current.spent);
						if (logTime && !parseDuration(spent)) {
							throw new Error(vscode.l10n.t("\"{0}\" isn't a time Jira understands. Use hours and minutes, such as 1h 30m.", spent));
						}
						if (current.mode === 'move' && current.selected) {
							const transition = current.transitions.find(t => t.id === current.selected)!;
							const fields: Record<string, string> = {};
							for (const field of transition.fields) {
								const given = flow.field<string>(`field:${field.id}`, current.fieldValues[field.id] ?? '');
								if (given) {
									fields[field.id] = given;
								} else if (field.required) {
									throw new Error(vscode.l10n.t("Choose {0} for this move.", field.name));
								}
							}
							const comment = flow.field('addComment', current.addComment) ? flow.field('comment', current.comment).trim() : '';
							const step = `move:${transition.id}`;
							if (!finished.has(step)) {
								// The agent's jira_transition, by transition id: the same checks, the comment's visibility and the audit record.
								const moved = await this.tools.write('jira_transition', { key: ref, to: transition.to, transition: transition.id, fields, ...comment ? { comment } : {} }, place?.cwd);
								finished.set(step, moved.warning
									? vscode.l10n.t("Moved {0} to {1}. {2}", ticket, transition.to, moved.warning)
									: vscode.l10n.t("Moved {0} to {1}{2}.", ticket, transition.to, comment ? vscode.l10n.t(" with the comment") : ''));
							}
							done.push(finished.get(step)!);
						}
						if (logTime) {
							const date = flow.field('date', current.date);
							const started = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T${new Date().toTimeString().slice(0, 8)}`) : new Date();
							const workComment = flow.field('workComment', current.workComment);
							const step = `log:${spent}:${date}`;
							if (!finished.has(step)) {
								try {
									await this.tools.write('jira_log_time', { key: ref, spent, started: started.toISOString(), ...workComment ? { comment: workComment } : {} }, place?.cwd);
								} catch (err) {
									// The move went through: say so, so pressing again logs only the time.
									throw done.length ? new Error(vscode.l10n.t("{0} Logging the time failed: {1} Press the button again to log only the time.", done.join(' '), errorMessage(err))) : err;
								}
								finished.set(step, vscode.l10n.t("Logged {0} on {1}.", formatDuration(parseDuration(spent)), ticket));
							}
							done.push(finished.get(step)!);
						}
						if (!done.length) {
							throw new Error(current.mode === 'log' ? vscode.l10n.t("Enter the time spent.") : vscode.l10n.t("Choose where to move the ticket, or tick Log time."));
						}
						flow.update({ done: done.join(' ') });
					});
				case 'open':
					return void openTeamLink(view.url);
			}
		}, vscode.ViewColumn.Active, this.recording(mode === 'log' ? 'gemini.team.logTime' : 'gemini.team.moveTicket', mode === 'log' ? [ref] : [ref, agent, suggest], ticket));
		try {
			const [issue, transitions, me, place2] = await Promise.all([
				jira.issue(ref),
				mode === 'move' ? jira.transitions(ref) : Promise.resolve([]),
				jira.myself(ref).catch(() => undefined),
				agent ? this.mrOfAgent(agent).catch(() => undefined) : Promise.resolve(undefined),
			]);
			mrInfo = place2 && { iid: place2.iid, url: place2.url, target: place2.targetBranch };
			const logged = await jira.worklogTotals(ref, me?.accountId).catch(() => undefined);
			const views: TransitionView[] = transitions.map(t => ({ id: t.id, name: t.name, to: t.to, tone: categoryTone(t.toCategory), fields: t.fields }));
			// The team's transition ids from .gemini/geminicode-tools.json when set, else the default workflow's status names.
			const selected = suggestedTransition(views, suggest, defaults.jira?.transitions);
			flow.setView({
				kind: 'moveTicket', mode, key: ticket, summary: issue.summary, url: issue.url, status: issue.status, statusTone: categoryTone(issue.statusCategory),
				transitions: views, fieldValues: {}, comment: '', commentRev: 0, generating: false,
				...defaults.jira?.commentVisibility ? { visibility: defaults.jira.commentVisibility } : {},
				addComment: true, logTime: mode === 'log', spent: '', date: today(), workComment: '',
				...logged && logged.total ? { logged: vscode.l10n.t("{0} logged{1}", formatDuration(logged.total), logged.mine ? vscode.l10n.t(", {0} by you", formatDuration(logged.mine)) : '') } : {},
			});
			if (selected) {
				// Same as the user picking it: drafts the comment.
				await (async () => {
					const transition = views.find(t => t.id === selected)!;
					flow.update({ selected, generating: true });
					const text = await this.draft(jiraCommentRequest({ key: ticket, summary: issue.summary, to: transition.to, ...mrInfo ? { mr: mrInfo } : {} }));
					flow.update({ generating: false, ...text ? { comment: text, commentRev: 1 } : {} });
				})();
			}
		} catch (err) {
			flow.fail(err);
		}
	}

	private async mrOfAgent(agent: string): Promise<{ iid: number; url: string; targetBranch: string } | undefined> {
		const gitlab = this.tools.connectors.gitlab;
		const place = this.agents.agentPlace(agent);
		if (!gitlab || !place) {
			return undefined;
		}
		const gp = await this.gitPlace(place.cwd, gitlab);
		return gitlab.mrForBranch(gp.project, gp.branch);
	}

	// --- Open a merge request

	private async openMergeRequest(agent: string | undefined): Promise<void> {
		const gitlab = this.gitlab();
		const agentId = this.agentId(agent);
		const place = this.agents.agentPlace(agentId)!;
		const flow: TeamFlowPanel<OpenMrView> = new (this.pages().TeamFlowPanel<OpenMrView>)(this.extensionUri, vscode.l10n.t("Open Merge Request"), 'gitlab', vscode.l10n.t("Reading the branch..."), (action, value) => this.openMrAction(flow, agentId, gp!, action, value), vscode.ViewColumn.Active, this.recording('gemini.team.openMergeRequest', [agentId], place.title));
		let gp: GitPlace | undefined;
		try {
			gp = await this.gitPlace(place.cwd, gitlab);
			const [me, reviewed] = await Promise.all([gitlab.user(), this.reviewedBy(agentId, gp)]);
			const base = { kind: 'openMr', project: gp.project, source: gp.branch, host: new URL(gitlab.url).host, account: me.username, targets: [], moreTargets: false, title: '', description: '', descriptionRev: 0, generating: false, attachments: [], reviewers: [], members: [], updateJira: false, deleteBranch: true, draft: false } as const;
			if (reviewed) {
				// A reviewer's branch is a local copy of someone else's: pushing it would open a second merge request for the same work.
				flow.setView({ ...base, reviewOf: reviewed });
				return;
			}
			const defaults = await this.tools.defaults(place.cwd);
			const key = jiraKeyIn(`${gp.branch} ${place.title}`, defaults.jira?.projects);
			const jira = this.tools.connectors.jira;
			const [branches, existing, ticket, members] = await Promise.all([
				gitlab.branches(gp.project),
				gitlab.mrForBranch(gp.project, gp.branch),
				key && jira ? jira.issue(key).catch(() => undefined) : Promise.resolve(undefined),
				gitlab.members(gp.project).catch(() => []),
			]);
			const targets = targetChoices(branches.map(b => b.name), { releasePattern: defaults.gitlab?.releaseBranches, fixVersions: ticket?.fixVersions, defaultTarget: defaults.gitlab?.defaultTarget, source: gp.branch, recent: this.recentTargets(gp.project) });
			const recent = targets.find(t => t.recent && t.branch === this.recentTargets(gp!.project)[0]);
			const checks = this.agents.checkResult(agentId);
			flow.setView({
				...base,
				targets, moreTargets: branches.length >= 100, target: targets.find(t => t.suggested)?.branch ?? recent?.branch ?? targets.find(t => t.usual)?.branch ?? targets[0]?.branch,
				...ticket ? { ticket: { key: ticket.key, summary: ticket.summary, url: ticket.url, fixVersions: ticket.fixVersions } } : {},
				title: ticket ? `${ticket.key} ${ticket.summary}` : place.title,
				attachments: checks ? [{ id: 'checks', name: vscode.l10n.t("Check results"), detail: checks, icon: 'pass', tools: ['snyk', 'sonar'], checked: true }] : [],
				members: members.map(m => ({ id: m.id, username: m.username, name: m.name })),
				updateJira: !!ticket,
				...existing ? { existing: { iid: existing.iid, url: existing.url } } : {},
			});
			void this.checkTarget(flow, gp, defaults.gitlab?.releaseBranches);
			if (flow.view?.target) {
				await this.generateDescription(flow, gp);
			}
		} catch (err) {
			flow.fail(err);
		}
	}

	/** The merge request agent `agentId` reviews, when it is a reviewer: its branch is the review's local copy. */
	private async reviewedBy(agentId: string, gp: GitPlace): Promise<OpenMrView['reviewOf']> {
		const review = this.reviews.forAgent(agentId);
		if (review) {
			const saved = await this.tools.reviews.get(review.project, review.iid);
			return { iid: review.iid, project: review.project, url: saved?.url ?? '' };
		}
		const iid = Number(/^review\/(?<iid>\d+)-/.exec(gp.branch)?.groups?.iid);
		if (!iid) {
			return undefined;
		}
		const mr = await this.gitlab().mr(gp.project, iid, false).catch(() => undefined);
		return mr ? { iid, project: gp.project, url: mr.url } : undefined;
	}

	/** The targets the user chose before in `project`, the last first. */
	private recentTargets(project: string): string[] {
		return this.state?.get<Record<string, string[]>>(recentTargetsKey)?.[project] ?? [];
	}

	private rememberTarget(project: string, target: string): void {
		const all = this.state?.get<Record<string, string[]>>(recentTargetsKey) ?? {};
		void this.state?.update(recentTargetsKey, { ...all, [project]: [target, ...(all[project] ?? []).filter(t => t !== target)].slice(0, maxRecentTargets) });
	}

	/** Notes a target that isn't develop, main or a release branch, with how far ahead of it the branch is. */
	private async checkTarget(flow: TeamFlowPanel<OpenMrView>, gp: GitPlace, releasePattern: string | undefined): Promise<void> {
		const target = flow.view?.target;
		if (!target || isUsualTarget(target, releasePattern)) {
			flow.update({ unusualTarget: undefined });
			return;
		}
		await fetchBranches(gp.cwd, gp.remote, [target]).catch(() => undefined);
		const [commits, files] = await Promise.all([
			git(gp.cwd, ['rev-list', '--count', `${gp.remote}/${target}..HEAD`]).catch(() => ''),
			git(gp.cwd, ['diff', '--name-only', `${gp.remote}/${target}...HEAD`]).catch(() => ''),
		]);
		if (flow.view?.target === target) {
			flow.update({ unusualTarget: vscode.l10n.t("Merges into a feature branch, not develop, main or a release. Commits ahead of it: {0} \u00b7 files changed: {1}", Number(commits.trim()) || 0, files.trim().split('\n').filter(Boolean).length) });
		}
	}

	private async openMrAction(flow: TeamFlowPanel<OpenMrView>, agentId: string, gp: GitPlace, action: string, value: unknown): Promise<void> {
		const view = flow.view;
		const gitlab = this.gitlab();
		if (!view) {
			return;
		}
		switch (action) {
			case 'target': {
				const target = str(value);
				if (!target || target === view.target) {
					return;
				}
				const known = view.targets.some(t => t.branch === target);
				this.keepTyped(flow);
				flow.update({
					target,
					...known ? {} : { targets: [...view.targets, { branch: target, release: false, suggested: false, usual: false }] },
					describedFor: this.describedFor.get(flow) !== target && flow.view?.description ? this.describedFor.get(flow) : undefined,
				});
				const defaults = await this.tools.defaults(gp.cwd);
				await this.checkTarget(flow, gp, defaults.gitlab?.releaseBranches);
				return;
			}
			case 'searchTargets': {
				const query = str(value);
				if (!query || !view.moreTargets) {
					return;
				}
				// Sent beside the state, so the open menu keeps its search field and stays open.
				const found = await gitlab.branches(gp.project, query).catch(() => []);
				const known = new Set(flow.view!.targets.map(t => t.branch));
				flow.send({ type: 'branches', branches: found.filter(b => !known.has(b.name) && b.name !== gp.branch).map(b => ({ branch: b.name, release: false, suggested: false, usual: isUsualTarget(b.name) })) });
				return;
			}
			case 'openReviewed':
				return view.reviewOf ? void openTeamLink(view.reviewOf.url) : undefined;
			case 'fixReviewed':
				flow.dispose();
				return view.reviewOf ? void vscode.commands.executeCommand('gemini.team.fixMergeRequest', view.reviewOf.project, view.reviewOf.iid) : undefined;
			case 'openReview':
				flow.dispose();
				return view.reviewOf ? this.reviews.open(view.reviewOf.project, view.reviewOf.iid) : undefined;
			case 'regenerate':
				this.keepTyped(flow);
				await this.generateDescription(flow, gp);
				return;
			case 'addFile': {
				this.keepTyped(flow);
				const files = await vscode.window.showOpenDialog({ canSelectMany: true, title: vscode.l10n.t("Add to the Merge Request"), openLabel: vscode.l10n.t("Add") });
				if (!files?.length) {
					return;
				}
				const added: FlowAttachment[] = await Promise.all(files.map(async file => {
					const size = await fs.stat(file.fsPath).then(s => s.size, () => 0);
					return { id: `file:${file.fsPath}`, name: path.basename(file.fsPath), detail: formatSize(size), icon: /\.(png|jpe?g|gif|webp)$/i.test(file.fsPath) ? 'file-media' : /\.(mp4|webm|mov)$/i.test(file.fsPath) ? 'device-camera-video' : 'file', checked: true };
				}));
				flow.update({ attachments: [...view.attachments.filter(a => !added.some(b => b.id === a.id)), ...added] });
				return;
			}
			case 'reviewers':
				flow.update({ reviewers: view.members.filter(m => Array.isArray(value) && value.includes(m.id)) });
				return;
			case 'openExisting':
				return void openTeamLink(view.existing?.url ?? '');
			case 'submit':
				this.keepTyped(flow);
				return flow.busy(vscode.l10n.t("Pushing {0}...", gp.branch), async () => {
					// Committing mid-turn would push half the agent's edits, and its own git commit would meet our index.lock.
					const whenIdle = () => {
						if (this.agents.controllerOf(agentId)?.running) {
							throw new Error(vscode.l10n.t("Wait for the agent to finish its turn, then press Open again."));
						}
					};
					whenIdle();
					const current = flow.view!;
					const title = flow.field('title', current.title).trim();
					if (!title || !current.target) {
						throw new Error(vscode.l10n.t("Enter a title."));
					}
					const target = current.target;
					this.rememberTarget(gp.project, target);
					await inRepository(gp.cwd, async () => {
						const dirty = (await git(gp.cwd, ['status', '--porcelain'])).trim();
						if (dirty) {
							// Checked again: a turn may have started while the page was open.
							whenIdle();
							await commitAll(gp.cwd, title);
						}
						await pushBranch(gp.cwd, gp.remote, gp.branch).catch(err => { throw plainGitError(err); });
					});
					let description = flow.field('description', current.description);
					const ticked = current.attachments.filter(a => flow.field(`attach:${a.id}`, a.checked));
					const extra: string[] = [];
					for (const attachment of ticked) {
						if (attachment.id === 'checks') {
							extra.push(`**${attachment.name}:** ${attachment.detail}`);
						} else if (attachment.id.startsWith('file:')) {
							// A page tool: the same checks (a size cap) and audit record as every other write.
							const uploaded = await this.tools.write('gitlab_upload', { project: gp.project, file: attachment.id.slice(5) }, gp.cwd);
							extra.push(String(uploaded.data?.markdown ?? ''));
						}
					}
					if (extra.length) {
						description = `${description.trim()}\n\n### Attachments\n\n${extra.join('\n\n')}`;
					}
					// The agent's gitlab_create_mr, from the agent's folder: the same project and branch, and the audit record.
					const made = await this.tools.write('gitlab_create_mr', {
						target, title, description,
						draft: flow.field('draft', current.draft), deleteBranch: flow.field('deleteBranch', current.deleteBranch),
						reviewers: current.reviewers.map(r => r.id),
					}, this.agents.agentPlace(agentId)?.cwd);
					const mr = { iid: Number(made.data?.iid), url: String(made.data?.url ?? '') };
					flow.dispose();
					const open = vscode.l10n.t("Open in GitLab");
					void vscode.window.showInformationMessage(vscode.l10n.t("Opened merge request !{0}.", mr.iid), open).then(choice => choice === open ? openTeamLink(mr.url) : undefined);
					if (current.ticket && flow.field('updateJira', current.updateJira)) {
						await this.moveTicket(current.ticket.key, agentId, 'review');
					}
				});
		}
	}

	/** Keeps what the user typed in the view, before a re-render. */
	private keepTyped(flow: TeamFlowPanel<OpenMrView>): void {
		const view = flow.view!;
		flow.update({
			title: flow.field('title', view.title), description: flow.field('description', view.description),
			updateJira: flow.field('updateJira', view.updateJira), deleteBranch: flow.field('deleteBranch', view.deleteBranch), draft: flow.field('draft', view.draft),
			attachments: view.attachments.map(a => ({ ...a, checked: flow.field(`attach:${a.id}`, a.checked) })),
		});
		for (const name of ['title', 'description', 'updateJira', 'deleteBranch', 'draft']) {
			flow.fields.delete(name);
		}
	}

	private async generateDescription(flow: TeamFlowPanel<OpenMrView>, gp: GitPlace): Promise<void> {
		const view = flow.view!;
		flow.update({ generating: true });
		await fetchBranches(gp.cwd, gp.remote, [view.target!]).catch(() => undefined);
		const summary = await branchSummary(gp.cwd, `${gp.remote}/${view.target}`);
		const jira = this.tools.connectors.jira;
		const ticket = view.ticket && jira ? await jira.issue(view.ticket.key).catch(() => undefined) : undefined;
		const text = await this.draft(mrDescriptionRequest({
			title: flow.field('title', view.title), target: view.target!, ...summary,
			...ticket ? { ticket: { key: ticket.key, summary: ticket.summary, description: ticket.description, url: ticket.url } } : {},
		}));
		const fallback = [view.ticket ? `Closes [${view.ticket.key}](${view.ticket.url})` : '', '### What changes', '', summary.commits || '-', '', '### How to test', '', '1. '].join('\n').trim();
		const current = flow.view!;
		flow.update({ generating: false, description: text ?? fallback, descriptionRev: current.descriptionRev + 1, describedFor: undefined });
		this.describedFor.set(flow, view.target!);
		flow.fields.delete('description');
	}

	// --- Review someone else's merge request

	/**
	 * Reviews merge request `iid`: the review in progress where it was left,
	 * else a new one Gemini starts. With no merge request named, the user picks
	 * one waiting for their review; those in progress say so.
	 */
	private async reviewMergeRequest(project: string | undefined, iid: number | undefined): Promise<void> {
		if (!project || !iid) {
			const gitlab = this.gitlab();
			const list = await gitlab.reviewRequests();
			const going = vscode.l10n.t("in progress");
			const picked = await vscode.window.showQuickPick(list.map(mr => ({
				label: `!${mr.iid} ${mr.title}`,
				description: [mr.author, mr.project, this.reviews.find(mr.project, mr.iid) ? going : ''].filter(Boolean).join(' \u00b7 '),
				mr,
			})), { title: vscode.l10n.t("Review a Merge Request"), placeHolder: vscode.l10n.t("Merge requests waiting for your review") });
			if (!picked) {
				return;
			}
			project = picked.mr.project;
			iid = picked.mr.iid;
		}
		await this.reviews.open(project, iid);
	}

	/** The reviews in progress, to pick one to continue; or another merge request to review. */
	private async openReview(): Promise<void> {
		const another = { label: `$(add) ${vscode.l10n.t("Review another merge request...")}`, review: undefined };
		const items = this.reviews.inProgress.map(r => ({
			label: `!${r.iid} ${r.title}`,
			description: [r.project, r.comments ? vscode.l10n.t("draft: {0}", r.comments) : '', new Date(r.updatedAt).toLocaleString(vscode.env.language, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })].filter(Boolean).join(' \u00b7 '),
			review: r,
		}));
		const picked = await vscode.window.showQuickPick([...items, another], { title: vscode.l10n.t("Open Merge Request Review"), placeHolder: vscode.l10n.t("Reviews in progress, the last changed first") });
		if (!picked) {
			return;
		}
		return picked.review ? this.reviews.open(picked.review.project, picked.review.iid) : this.reviewMergeRequest(undefined, undefined);
	}

	/** Starts the review of merge request `iid` over; a draft in progress goes once the user confirms. */
	private async startNewReview(project: string | undefined, iid: number | undefined): Promise<void> {
		if (!project || !iid) {
			return;
		}
		const going = this.reviews.find(project, iid);
		if (going) {
			const start = vscode.l10n.t("Start a New Review");
			const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Start the review of !{0} over?", iid), { modal: true, detail: vscode.l10n.t("Gemini reviews it again, and the draft in progress ({0} comments) is thrown away.", going.comments) }, start);
			if (answer !== start) {
				return;
			}
		}
		await this.reviews.open(project, iid, true);
	}

	/** Throws away the draft of the review of merge request `iid`, once the user confirms. */
	private async discardReview(project: string | undefined, iid: number | undefined): Promise<void> {
		if (!project || !iid) {
			return;
		}
		const discard = vscode.l10n.t("Discard Draft");
		const answer = await vscode.window.showWarningMessage(vscode.l10n.t("Discard your review of !{0}?", iid), { modal: true, detail: vscode.l10n.t("Its comments and replies aren't posted and can't be brought back.") }, discard);
		if (answer === discard) {
			await this.reviews.discard(project, iid);
		}
	}

	/** The Pipeline, Quality gate, ticket and Approvals rows beside a review. */
	private async reviewSide(mr: GitLabMr, ticket: string | undefined, folder: string): Promise<ReviewView['side']> {
		const side: ReviewView['side'][number][] = [];
		if (mr.pipeline) {
			side.push({ tool: 'gitlab', label: vscode.l10n.t("Pipeline"), pill: { text: mr.pipeline.status, tone: pipelineTone(mr.pipeline.status) } });
		}
		const sonar = this.tools.connectors.sonar;
		const defaults = await this.tools.defaults(folder);
		const key = defaults.sonar?.projectKey ?? await sonarProjectKeyIn(folder);
		const [gate, issue] = await Promise.all([
			sonar && key ? sonar.gate({ project: key, mergeRequest: String(mr.iid) }).catch(() => undefined) : undefined,
			ticket && this.tools.connectors.jira ? this.tools.connectors.jira.issue(ticket).catch(() => undefined) : undefined,
		]);
		if (gate) {
			side.push({ tool: 'sonar', label: vscode.l10n.t("Quality gate"), pill: gate.status === 'OK' ? { text: vscode.l10n.t("passed"), tone: 'ok' } : gate.status === 'ERROR' ? { text: vscode.l10n.t("failed"), tone: 'error' } : { text: vscode.l10n.t("not analysed"), tone: 'muted' } });
		}
		if (issue) {
			side.push({ tool: 'jira', label: issue.key, detail: issue.summary, pill: { text: issue.status, tone: categoryTone(issue.statusCategory) } });
		}
		if (mr.approvals) {
			side.push({ tool: 'people', label: vscode.l10n.t("Approvals"), pill: { text: vscode.l10n.t("{0} of {1}", mr.approvals.given, mr.approvals.required), tone: mr.approvals.given >= mr.approvals.required && mr.approvals.required ? 'ok' : 'muted' } });
		} else {
			// GitLab didn't answer for the approvals: pending, never passed.
			side.push({ tool: 'people', label: vscode.l10n.t("Approvals"), detail: vscode.l10n.t("couldn't read, counted as pending"), pill: { text: vscode.l10n.t("pending"), tone: 'muted' }, retry: true });
		}
		return side;
	}

	// --- Merge a merge request

	/**
	 * Merges a merge request once GitLab says it can be: the checks are read
	 * live and shown in a dialog, the merge names the head they were read
	 * for, and the audit log gets the record. With no merge request named,
	 * the agent in front's is taken.
	 */
	private async mergeMergeRequest(project: string | undefined, iid: number | undefined, options: MergeOptions = {}): Promise<void> {
		const gitlab = this.gitlab();
		if (!project || !iid) {
			const agentId = this.agentId(undefined);
			const found = await this.mrOfAgent(agentId);
			if (!found) {
				throw new Error(vscode.l10n.t("The agent in front has no open merge request."));
			}
			const place = await this.gitPlace(this.agents.agentPlace(agentId)!.cwd, gitlab);
			project = place.project;
			iid = found.iid;
		}
		const p = project;
		const n = iid;
		const [mr, readiness] = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Reading !{0}...", n) }, () => Promise.all([gitlab.mr(p, n, false), gitlab.mergeReadiness(p, n)]));
		// allow-any-unicode-next-line
		const lines = readiness.checks.map(c => c.unreadable ? `◌ ${c.name}: ${vscode.l10n.t("couldn't read, counted as pending")}` : `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
		if (!readiness.ready) {
			// A check GitLab didn't answer for may pass when read again.
			const retry = readiness.checks.some(c => c.unreadable) ? vscode.l10n.t("Retry") : undefined;
			if (retry && await vscode.window.showWarningMessage(vscode.l10n.t("!{0} can't be merged yet.", n), { modal: true, detail: lines.join('\n') }, retry) === retry) {
				return this.mergeMergeRequest(p, n, options);
			}
			if (!retry) {
				await vscode.window.showWarningMessage(vscode.l10n.t("!{0} can't be merged yet.", n), { modal: true, detail: lines.join('\n') });
			}
			return;
		}
		const squash = options.squash ?? readiness.squash;
		const removeSourceBranch = options.removeSourceBranch ?? readiness.removeSourceBranch;
		const merge = vscode.l10n.t("Merge");
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t("Merge !{0} \"{1}\" into {2}?", n, mr.title, mr.targetBranch),
			{ modal: true, detail: [...lines, '', vscode.l10n.t("At commit {0}{1}{2}. GitLab refuses if the branch moved meanwhile.", readiness.sha.slice(0, 8), squash ? vscode.l10n.t(", squashed") : '', removeSourceBranch ? vscode.l10n.t(", deleting the source branch") : '')].join('\n') },
			merge,
		);
		if (choice !== merge) {
			return;
		}
		// The agent's gitlab_merge, at the head the user confirmed: it reads GitLab's checks again and refuses if the branch moved.
		const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Merging !{0}...", n) }, () =>
			this.tools.write('gitlab_merge', { project: p, mr: String(n), sha: readiness.sha, squash, deleteBranch: removeSourceBranch }));
		const merged = { sha: typeof result.data?.sha === 'string' ? result.data.sha : undefined };
		// After the merge, only to find the ticket in the branch's name: no question for that.
		const defaults = await this.tools.workspaceDefaults(this.workFolder().folder);
		const ticket = options.moveTicket ?? (this.tools.connectors.jira ? jiraKeyIn(`${mr.sourceBranch} ${mr.title}`, defaults.jira?.projects) : undefined);
		if (options.moveTicket) {
			// The panel's "Move … to Done" was ticked: the move opens at once, with its own confirmation.
			void vscode.window.showInformationMessage(vscode.l10n.t("Merged !{0}{1}.", n, merged.sha ? ` (${merged.sha.slice(0, 8)})` : ''));
			await this.moveTicket(ticket, undefined, 'done');
			return;
		}
		const open = vscode.l10n.t("Open in GitLab");
		const move = ticket ? vscode.l10n.t("Move {0}...", ticket) : undefined;
		const next = await vscode.window.showInformationMessage(vscode.l10n.t("Merged !{0}{1}.", n, merged.sha ? ` (${merged.sha.slice(0, 8)})` : ''), ...move ? [move, open] : [open]);
		if (next === open) {
			await openTeamLink(mr.url);
		} else if (move && next === move) {
			await this.moveTicket(ticket, undefined, 'done');
		}
	}

	// --- Reassign a ticket

	/** Hands a ticket to someone the project allows, to the user, or to nobody. */
	private async reassignTicket(key: string | undefined): Promise<void> {
		const jira = this.jira();
		key ??= await this.pickTicket(jira);
		if (!key) {
			return;
		}
		const ticket = keyOf(key);
		const picked = await extensionChunk<typeof import('../onDemand')>('onDemand')().pickAssignee(jira, key, ticket);
		if (!picked) {
			return;
		}
		const who = picked.accountId === null ? vscode.l10n.t("nobody") : picked.label.replace(/^\$\([^)]*\)\s*/, '');
		await this.tools.write('jira_assign', { key, to: who, accountId: picked.accountId }, this.workFolder().folder);
		void vscode.window.showInformationMessage(picked.accountId === null ? vscode.l10n.t("{0} is now unassigned.", ticket) : vscode.l10n.t("Assigned {0} to {1}.", ticket, who));
	}

	// --- Fix a merge request's pipeline (from Home)

	/**
	 * Fix on Home: sends a failed pipeline's logs and the open threads to the
	 * agent on the merge request's branch, in a clone of its project, else to
	 * a new agent in a worktree on that branch (never moving the branch back or
	 * dropping a commit; see branchWorktree). The agent commits; its shell
	 * can't sign in, so GeminiCode pushes when the turn ends, then asks for
	 * the thread replies.
	 */
	private async fixMergeRequest(project: string | undefined, iid: number | undefined): Promise<void> {
		const gitlab = this.gitlab();
		if (!project || !iid) {
			throw new Error(vscode.l10n.t("Choose a merge request on Home."));
		}
		const mr = await gitlab.mr(project, iid, false);
		const jobs = mr.pipeline?.status === 'failed' ? await gitlab.jobs(project, mr.pipeline.id, true) : [];
		const logs = await Promise.all(jobs.slice(0, 3).map(async j => ({ name: j.name, id: j.id, log: await gitlab.jobLogTail(project, j.id, 6000).catch(e => errorMessage(e)) })));
		const discussions = await gitlab.discussions(project, iid).catch(() => []);
		const threads = discussions.filter(d => !d.resolved).map(d => ({ id: d.id, author: d.notes[0].author, body: d.notes.map(n => n.body).join('\n'), path: d.notes[0].path, line: d.notes[0].line }));
		const text = mrFixPrompt({ iid, url: mr.url }, logs, threads);
		const existing = await this.agentOnBranch(project, mr.sourceBranch, gitlab);
		if (existing) {
			const { controller, turn } = await this.startTurn(existing.id, text);
			return this.pushFix(existing.id, existing.cwd, existing.remote, mr.sourceBranch, threads, controller, turn);
		}
		const clone = await this.cloneOf(project, gitlab, { iid, purpose: 'fix' });
		if (!clone) {
			// The user cancelled the question of where the clone is.
			return;
		}
		let worktree: AgentWorktree & { readonly existing?: boolean };
		try {
			worktree = await inRepository(clone.folder, () => branchWorktree(clone.folder, clone.remote, mr.sourceBranch));
		} catch (err) {
			if (err instanceof UnpushedCommitsError) {
				throw new Error(err.count === 1
					? vscode.l10n.t("Your local {0} has 1 commit that isn't pushed. Push it, or move it to another branch, then press Fix again.", err.branch)
					: vscode.l10n.t("Your local {0} has {1} commits that aren't pushed. Push them, or move them to another branch, then press Fix again.", err.branch, err.count));
			}
			throw plainGitError(err);
		}
		// A checkout that was there already stays the user's: the agent works in it, but removing the agent leaves it alone.
		const ours = !worktree.existing || worktree.folder.startsWith(path.join(os.homedir(), '.geminicode') + path.sep);
		const id = await this.agents.startTeamAgent({ folder: ours ? clone.folder : worktree.folder, title: vscode.l10n.t("Fix !{0} {1}", iid, mr.title), ...ours ? { worktree } : {}, text: '' });
		if (!id) {
			throw new Error(vscode.l10n.t("The agent couldn't start."));
		}
		const { controller, turn } = await this.startTurn(id, text);
		return this.pushFix(id, worktree.cwd, clone.remote, mr.sourceBranch, threads, controller, turn);
	}

	/** An agent on `branch` in a clone of `project`: the same branch name in another repository is another branch. */
	private async agentOnBranch(project: string, branch: string, gitlab: GitLabClient): Promise<{ readonly id: string; readonly cwd: string; readonly remote: string } | undefined> {
		for (const agent of this.agents.summaries().filter(a => a.worktree?.branch === branch)) {
			const cwd = this.agents.agentPlace(agent.id)?.cwd;
			const local = cwd ? await gitlabProjectOf(cwd, gitlab.url).catch(() => undefined) : undefined;
			if (cwd && local?.project?.toLowerCase() === project.toLowerCase()) {
				return { id: agent.id, cwd, remote: local.remote ?? 'origin' };
			}
		}
		return undefined;
	}

	/**
	 * Once a fix agent's turn ends: pushes the commits it made (taking the
	 * repository's git lock), then asks it to reply to the threads it fixed.
	 * Nothing is pushed while it left changes uncommitted, or made no commit.
	 */
	private async pushFix(agentId: string, cwd: string, remote: string, branch: string, threads: readonly MrThreadForFix[], controller: { send(text: string): Promise<void> }, turn: Promise<void>): Promise<void> {
		await turn;
		if (!this.agents.agentPlace(agentId) || this.agents.controllerOf(agentId)?.running) {
			return;
		}
		const ahead = Number((await git(cwd, ['rev-list', '--count', `${remote}/${branch}..HEAD`]).catch(() => '0')).trim()) || 0;
		if (!ahead) {
			return;
		}
		if ((await git(cwd, ['status', '--porcelain'])).trim()) {
			throw new Error(vscode.l10n.t("The agent left changes in {0} that aren't committed, so its commits weren't pushed. Ask it to commit them, then press Fix again.", branch));
		}
		await inRepository(cwd, () => pushBranch(cwd, remote, branch)).catch(err => { throw plainGitError(err); });
		if (threads.length) {
			const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
			void controller.send(mrFixRepliesPrompt({ branch, head, commits: ahead }, threads));
		}
	}

	// --- Checks

	/** Checks for an agent's branch, in its folder; with no agent in front, for a branch the user picks. */
	private async runChecks(agent: string | undefined): Promise<void> {
		let id = agent ?? this.agents.activeAgentId();
		let repository: string | undefined;
		if (!id) {
			// With several folders and nothing in front, the agent last in front is one of the choices.
			const picked = await this.pickWorkFolder(vscode.l10n.t("Run Checks in which folder?"));
			if (!picked) {
				return;
			}
			id = picked.agent;
			repository = picked.folder;
		}
		const place = id ? this.agents.agentPlace(id) : undefined;
		if (!id || !place) {
			return this.runChecksOnBranch(undefined, repository);
		}
		await this.openChecks({ cwd: place.cwd, title: place.title, repository: place.folder, agentId: id, ...place.branch ? { branch: place.branch } : {} });
	}

	/**
	 * Checks on any branch before a merge request exists: the repository's own
	 * branch, an agent's, a local or a remote one. A branch that isn't checked
	 * out gets a worktree of its own (with the repository's setup run in it),
	 * which later runs reuse. Fix starts an agent there when none works on it.
	 */
	private async runChecksOnBranch(branch: string | undefined, folder?: string): Promise<void> {
		const repository = await this.checksRepository(folder);
		if (!repository) {
			return;
		}
		const gitlab = this.tools.connectors.gitlab;
		const remote = (gitlab ? await gitlabProjectOf(repository, gitlab.url, await this.tools.defaults(repository)).catch(() => ({ remote: undefined })) : { remote: undefined }).remote ?? 'origin';
		if (!branch) {
			const [current, branches] = await Promise.all([currentBranch(repository).catch(() => undefined), listBranches(repository, remote)]);
			const agents = this.agents.summaries().flatMap(a => a.worktree?.branch ? [{ branch: a.worktree.branch, title: a.title }] : []);
			const kinds = { current: vscode.l10n.t("checked out here"), agent: vscode.l10n.t("agent"), local: vscode.l10n.t("local branch"), remote: vscode.l10n.t("on {0}", remote) };
			const ownCheckout = vscode.l10n.t("gets a checkout of its own, reused next time");
			const picked = await vscode.window.showQuickPick(
				branchChoices(current, agents, branches.locals, branches.remotes).map(choice => ({ label: choice.branch, description: choice.kind === 'agent' ? `${kinds.agent}: ${choice.agent}` : kinds[choice.kind], ...choice.kind === 'local' || choice.kind === 'remote' ? { detail: ownCheckout } : {}, choice })),
				{ title: vscode.l10n.t("Run Checks on a Branch"), placeHolder: vscode.l10n.t("A branch that isn't checked out gets a checkout of its own, which later runs reuse"), matchOnDescription: true },
			);
			if (!picked) {
				return;
			}
			branch = picked.choice.branch;
		}
		const chosen = branch;
		const checkout = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Checking out {0}...", chosen) }, () => inRepository(repository, () => checkoutForChecks(repository, remote, chosen)).catch(err => { throw plainGitError(err); }));
		let setup: string | undefined;
		if (checkout.created && checkout.worktree) {
			const worktree = checkout.worktree;
			const command = await setupCommandFor(repository, this.state, 'checks');
			if (command) {
				const started = Date.now();
				const code = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Setting up {0} for the checks...", chosen) }, () => runWorktreeSetup(command, worktree, repository, () => undefined));
				setup = code === 0 ? vscode.l10n.t("setup: {0} (done, {1} s)", command, Math.round((Date.now() - started) / 1000)) : vscode.l10n.t("setup: {0} (ended with code {1})", command, code);
				if (code !== 0) {
					void vscode.window.showWarningMessage(vscode.l10n.t("The setup command for {0} ended with code {1}; the checks run on the checkout as it is.", chosen, code));
				}
			}
		}
		const agent = this.agents.summaries().find(a => a.worktree?.branch === chosen && a.state !== 'stopped');
		await this.openChecks({ cwd: checkout.cwd, title: chosen, branch: chosen, repository, ...agent ? { agentId: agent.id } : {}, ...checkout.worktree ? { worktree: checkout.worktree } : {}, ...setup ? { setup } : {} });
	}

	/**
	 * The repository Run Checks works in: `picked`'s, else the agent in
	 * front's, else the active editor's, else the one the user picks among
	 * several open folders. Undefined when the user dismissed the question.
	 */
	private async checksRepository(picked?: string): Promise<string | undefined> {
		const chosen = picked ? { folder: picked } : await this.pickWorkFolder(vscode.l10n.t("Run Checks in which folder?"));
		if (!chosen) {
			return undefined;
		}
		const folder = chosen.folder;
		if (!folder) {
			throw new Error(vscode.l10n.t("Open your repository's folder first."));
		}
		return await repositoryRoot(folder) ?? folder;
	}

	private async openChecks(start: ChecksPlace): Promise<void> {
		let place = start;
		// A tab in the active group (Home's, when Run Checks... starts it there), not a split beside Home.
		const flow: TeamFlowPanel<ChecksView> = new (this.pages().TeamFlowPanel<ChecksView>)(this.extensionUri, vscode.l10n.t("Checks: {0}", place.title), this.tools.connected.has('snyk') ? 'snyk' : 'sonar', vscode.l10n.t("Starting the checks..."), async (action, value) => {
			const view = flow.view;
			if (!view) {
				return;
			}
			switch (action) {
				case 'again':
					return this.check(flow, place);
				case 'open':
					return void openTeamLink(str(value)!);
				case 'fix':
				case 'fixAll': {
					const chosen = action === 'fix' ? view.findings.filter(f => f.id === value)
						: view.findings.filter(f => flow.field(`check:${f.id}`, f.checked));
					if (!chosen.length) {
						return;
					}
					const prompt = checksFixPrompt(chosen);
					if (place.agentId) {
						await this.send(place.agentId, prompt);
					} else {
						// No agent works on this branch yet: start one in its checkout, with the findings as its first prompt.
						const id = await this.agents.startTeamAgent({ folder: place.repository, title: vscode.l10n.t("Fix checks on {0}", place.branch ?? place.title), text: prompt, ...place.worktree ? { worktree: place.worktree } : {} });
						if (!id) {
							throw new Error(vscode.l10n.t("The agent couldn't start."));
						}
						place = { ...place, agentId: id };
						flow.update({ agentId: id });
					}
					const target = place.agentId ? this.agents.agentPlace(place.agentId)?.title ?? place.title : place.title;
					flow.update({ sent: vscode.l10n.t("Sent {0} to {1}.", chosen.length === 1 ? vscode.l10n.t("the finding") : vscode.l10n.t("{0} findings", chosen.length), target) });
					return;
				}
			}
		}, vscode.ViewColumn.Active);
		await this.check(flow, place);
	}

	private async check(flow: TeamFlowPanel<ChecksView>, place: ChecksPlace): Promise<void> {
		const { snyk, sonar } = this.tools.connectors;
		const branch = place.branch ?? ((await git(place.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || undefined);
		const rows: ChecksView['rows'][number][] = [
			snyk ? { tool: 'snyk', name: vscode.l10n.t("Snyk: dependencies"), state: 'running', detail: vscode.l10n.t("Running snyk test...") } : { tool: 'snyk', name: vscode.l10n.t("Snyk"), state: 'off', detail: vscode.l10n.t("Not connected") },
			...snyk ? [{ tool: 'snyk' as const, name: vscode.l10n.t("Snyk Code: source"), state: 'running' as const, detail: vscode.l10n.t("Running snyk code test...") }] : [],
			sonar ? { tool: 'sonar', name: vscode.l10n.t("SonarQube: new code"), state: 'running', detail: vscode.l10n.t("Reading the last analysis...") } : { tool: 'sonar', name: 'SonarQube', state: 'off', detail: vscode.l10n.t("Not connected") },
			// SonarQube's own analysers on this Mac, before anything is pushed, when its server runs as a child.
			...sonar && this.tools.sonarServerFor(place.cwd) ? [{ tool: 'sonar' as const, name: vscode.l10n.t("SonarQube: changed files, on this Mac"), state: 'running' as const, detail: vscode.l10n.t("Analysing the files this branch changed...") }] : [],
		];
		flow.setView({ kind: 'checks', agentTitle: place.title, ...place.agentId ? { agentId: place.agentId } : {}, ...branch ? { branch } : {}, where: tildify(place.cwd), ...place.setup ? { setup: place.setup } : {}, rows, findings: [] });
		const results: string[] = [];
		const setRow = (name: string, row: Partial<ChecksView['rows'][number]>, findings: readonly CheckFinding[] = []) => {
			const view = flow.view;
			if (!view) {
				return;
			}
			flow.update({
				rows: view.rows.map(r => r.name === name ? { ...r, ...row } : r),
				findings: [...view.findings, ...findings.map(f => ({ ...f, checked: f.severity === 'critical' || f.severity === 'high' || f.severity === 'blocker' }))],
			});
		};
		const tasks: Promise<void>[] = [];
		if (snyk) {
			for (const code of [false, true]) {
				const name = rows[code ? 1 : 0].name;
				tasks.push((code ? snyk.testCode(place.cwd) : snyk.testDependencies(place.cwd)).then(result => {
					const findings = findingsFromSnyk(result.findings, code);
					results.push(result.problem ? '' : findings.length ? describeSnyk(result).split('\n')[0] : vscode.l10n.t("{0} clean", code ? 'Snyk Code' : 'Snyk'));
					setRow(name, result.problem ? { state: 'problem', detail: result.problem } : { state: 'done', detail: findings.length ? vscode.l10n.t("{0} issues", findings.length) : vscode.l10n.t("No issues found."), pill: findings.length ? { text: String(findings.length), tone: findings.some(f => f.severity === 'critical' || f.severity === 'high') ? 'error' : 'warn' } : { text: vscode.l10n.t("clean"), tone: 'ok' } }, findings);
				}, err => setRow(name, { state: 'problem', detail: errorMessage(err) })));
			}
		}
		if (sonar) {
			const name = rows.find(r => r.tool === 'sonar')!.name;
			tasks.push((async () => {
				const defaults = await this.tools.defaults(place.cwd);
				const key = defaults.sonar?.projectKey ?? await sonarProjectKeyIn(place.cwd);
				if (!key) {
					setRow(name, { state: 'problem', detail: vscode.l10n.t("No SonarQube project key: add sonar.projectKey to sonar-project.properties or .gemini/geminicode-tools.json.") });
					return;
				}
				const target = { project: key, ...branch ? { branch } : {} };
				try {
					const [gate, issues] = await Promise.all([sonar.gate(target), sonar.issues(target)]);
					const findings = findingsFromSonar(issues);
					// A list cut at its page says so: "50 of 312 issues shown", with SonarQube's own list for the rest.
					const cut = issues.total !== undefined && issues.total > issues.length;
					results.push(vscode.l10n.t("SonarQube new code: {0}{1}, {2} issues", gate.status === 'OK' ? vscode.l10n.t("gate passed") : gate.status === 'ERROR' ? vscode.l10n.t("gate failed") : vscode.l10n.t("no gate"), gate.coverage ? vscode.l10n.t(", coverage {0}%", gate.coverage) : '', countText(issues)));
					setRow(name, {
						state: 'done',
						detail: [
							vscode.l10n.t("Quality gate {0}{1}", gate.status === 'OK' ? vscode.l10n.t("passed") : gate.status === 'ERROR' ? vscode.l10n.t("failed") : vscode.l10n.t("not computed"), gate.coverage ? vscode.l10n.t(" · coverage {0}%", gate.coverage) : ''),
							...cut ? [vscode.l10n.t("{0} of {1} issues shown", issues.length, issues.total!)] : [],
						].join(' · '),
						pill: { text: findings.length ? String(findings.length) : vscode.l10n.t("clean"), tone: gate.status === 'ERROR' ? 'error' : findings.length ? 'warn' : 'ok' },
						...cut ? { link: { label: vscode.l10n.t("Open in SonarQube"), url: sonarIssuesUrl(sonar.url, target) } } : {},
					}, findings);
				} catch (err) {
					setRow(name, { state: 'problem', detail: /404|found nothing/.test(errorMessage(err)) ? vscode.l10n.t("{0} hasn't been analysed yet; SonarQube runs in the pipeline after you push.", branch ?? key) : errorMessage(err) });
				}
			})());
		}
		const local = sonar && this.tools.sonarServerFor(place.cwd);
		if (local) {
			const name = vscode.l10n.t("SonarQube: changed files, on this Mac");
			tasks.push((async () => {
				const defaults = await this.tools.defaults(place.cwd);
				const key = defaults.sonar?.projectKey ?? await sonarProjectKeyIn(place.cwd);
				if (!key) {
					setRow(name, { state: 'off', detail: vscode.l10n.t("No SonarQube project key.") });
					return;
				}
				try {
					const files = await changedFiles(place.cwd, defaults.gitlab?.defaultTarget ?? 'main');
					const found = await analyzeFiles(local, key, files);
					const findings = findingsFromLocalSonar(found.issues);
					const detail = !found.analysed.length && !found.failed.length
						? vscode.l10n.t("No changed file in a language SonarQube analyses.")
						: [vscode.l10n.t("{0} files analysed", found.analysed.length), found.skipped.length ? vscode.l10n.t("{0} skipped", found.skipped.length) : '', found.failed.length ? vscode.l10n.t("{0} failed: {1}", found.failed.length, found.failed[0].reason) : ''].filter(Boolean).join(' · ');
					results.push(vscode.l10n.t("SonarQube on this Mac: {0} issues in {1} changed files", found.issues.length, found.analysed.length));
					setRow(name, { state: found.failed.length && !found.analysed.length ? 'problem' : 'done', detail, pill: findings.length ? { text: String(findings.length), tone: findings.some(f => f.severity === 'blocker' || f.severity === 'critical' || f.severity === 'high') ? 'error' : 'warn' } : { text: vscode.l10n.t("clean"), tone: 'ok' } }, findings);
				} catch (err) {
					setRow(name, { state: 'problem', detail: errorMessage(err) });
				}
			})());
		}
		await Promise.all(tasks);
		const summary = results.filter(Boolean).join(' · ');
		if (summary && place.agentId) {
			this.agents.setCheckResult(place.agentId, summary);
		}
	}
}

/**
 * A git failure in plain words, for the usual problems (no VPN, no sign-in).
 * The GitError, with git's own output, stays as the cause: what a Show Log
 * would show.
 */
function plainGitError(err: unknown): unknown {
	if (!(err instanceof GitError) || !err.problem) {
		return err;
	}
	const message = err.problem === 'vpn' ? vscode.l10n.t("Git couldn't reach the server. Check your VPN.")
		: err.problem === 'signIn' ? vscode.l10n.t("Git couldn't sign in to the server. Sign in with git once in a terminal (run git fetch there), then try again.")
			: vscode.l10n.t("Git got no answer from the server within a minute. Check your VPN.");
	return new Error(message, { cause: err });
}

/** A comment thread from the review's gutter menu, as opposed to an agent id. */
function isCommentThread(value: unknown): value is vscode.CommentThread {
	return typeof value === 'object' && value !== null && 'uri' in value && 'comments' in value;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function today(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function categoryTone(category: string): Tone {
	return category === 'done' ? 'ok' : category === 'indeterminate' ? 'info' : 'muted';
}

/** What the merge request panel asks the merge to do besides GitLab's defaults. */
export interface MergeOptions {
	readonly squash?: boolean;
	readonly removeSourceBranch?: boolean;
	/** The ticket to move to Done once merged. */
	readonly moveTicket?: string;
}

function isMergeOptions(value: unknown): value is MergeOptions {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function pipelineTone(status: string): Tone {
	return status === 'success' ? 'ok' : status === 'failed' ? 'error' : status === 'running' || status === 'pending' ? 'info' : 'muted';
}


function formatSize(bytes: number): string {
	return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
