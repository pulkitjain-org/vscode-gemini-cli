/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../acp/errors';
import { GitLabClient, GitLabMr } from '../acp/gitlab';
import { formatDuration, JiraClient, JiraIssueSummary, jiraKeyIn, parseDuration } from '../acp/jira';
import { branchSummary, checkMerge, fetchBranches, mergeInWorktree, mergeUnfinished, pushBranch, reviewWorktree } from '../acp/releaseMerge';
import { describeSnyk } from '../acp/snyk';
import { sonarProjectKeyIn } from '../acp/sonar';
import { isReleaseBranch, sortReleaseBranches, TeamDefaults } from '../acp/teamDefaults';
import {
	CheckFinding, checksFixPrompt, findingsFromSnyk, findingsFromSonar, jiraCommentRequest, mrDescriptionRequest, mrFixPrompt, parseReviewFindings, releaseConflictPrompt,
	releaseMergeBranch, releaseMergeMr, releaseTargets, reviewPrompt, reviewSummary, targetChoices, ticketBranchName, ticketStartPrompt,
} from '../acp/teamFlowLogic';
import { gitlabProjectOf } from '../acp/teamTools';
import { commitAll, git } from '../acp/worktrees';
import type { AgentsView } from './agentsView';
import type { TeamConnections } from './teamConnections';
import { TeamFlowPanel } from './teamFlowPanel';
import { ChecksView, FlowAttachment, FlowPerson, MoveTicketView, OpenMrView, ReleaseView, ReviewView, Tone, TransitionView } from './teamFlowProtocol';
import { openTeamLink } from './teamLinks';

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
 * request, merge a release branch forward, and run the checks. Each opens
 * as a tab (TeamFlowPanel); nothing is written to Jira or GitLab until the
 * user presses the button that does it.
 */
export class TeamFlows implements vscode.Disposable {

	/** The last checks' one-line result per agent, offered as an attachment to its merge request. */
	private readonly checkResults = new Map<string, string>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly tools: TeamConnections, private readonly agents: AgentsView) {
		const run = <A extends unknown[]>(id: string, handler: (...args: A) => Promise<unknown>) => vscode.commands.registerCommand(id, (...args: A) => handler(...args).catch(err => void vscode.window.showErrorMessage(errorMessage(err))));
		this.disposables.push(
			run('gemini.team.startOnTicket', (key?: unknown) => this.startOnTicket(str(key))),
			run('gemini.team.openMergeRequest', (agent?: unknown) => this.openMergeRequest(str(agent))),
			run('gemini.team.moveTicket', (key?: unknown, agent?: unknown, suggest?: unknown) => this.moveTicket(str(key), str(agent), str(suggest))),
			run('gemini.team.logTime', (key?: unknown) => this.moveTicket(str(key), undefined, undefined, 'log')),
			run('gemini.team.reviewMergeRequest', (project?: unknown, iid?: unknown) => this.reviewMergeRequest(str(project), Number(iid) || undefined)),
			run('gemini.team.fixMergeRequest', (project?: unknown, iid?: unknown) => this.fixMergeRequest(str(project), Number(iid) || undefined)),
			run('gemini.team.mergeReleaseForward', (source?: unknown) => this.mergeReleaseForward(str(source))),
			run('gemini.team.runChecks', (agent?: unknown) => this.runChecks(str(agent))),
		);
	}

	dispose(): void {
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** The last checks' result for an agent, in a line. */
	checksSummary(agentId: string): string | undefined {
		return this.checkResults.get(agentId);
	}

	// --- Helpers

	private jira(): JiraClient {
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

	/** An open folder that is a clone of `project`, for checking out its branches. */
	private async cloneOf(project: string, gitlab: GitLabClient): Promise<{ folder: string; remote: string } | undefined> {
		const folders = [
			...(vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath),
			...this.agents.summaries().map(a => a.folder),
		];
		for (const folder of [...new Set(folders)]) {
			const local = await gitlabProjectOf(folder, gitlab.url).catch(() => undefined);
			if (local?.project?.toLowerCase() === project.toLowerCase()) {
				return { folder, remote: local.remote ?? 'origin' };
			}
		}
		return undefined;
	}

	private async firstClone(gitlab: GitLabClient): Promise<{ folder: string; project: string; remote: string; defaults: TeamDefaults }> {
		for (const f of vscode.workspace.workspaceFolders ?? []) {
			if (f.uri.scheme !== 'file') {
				continue;
			}
			const defaults = await this.tools.defaults(f.uri.fsPath);
			const local = await gitlabProjectOf(f.uri.fsPath, gitlab.url, defaults).catch(() => undefined);
			if (local?.project) {
				return { folder: f.uri.fsPath, project: local.project, remote: local.remote ?? 'origin', defaults };
			}
		}
		throw new Error(vscode.l10n.t("Open a clone of your GitLab project first."));
	}

	private async draft(request: { readonly system: string; readonly prompt: string }): Promise<string | undefined> {
		try {
			return (await this.agents.direct?.(request))?.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	private async send(agentId: string, text: string): Promise<void> {
		await this.agents.open(agentId);
		const controller = this.agents.controllerOf(agentId);
		if (!controller) {
			throw new Error(vscode.l10n.t("The agent isn't running."));
		}
		if (controller.running) {
			throw new Error(vscode.l10n.t("The agent is working. Try again when it finishes its turn."));
		}
		void controller.send(text);
	}

	// --- Start on a ticket

	private async startOnTicket(key: string | undefined): Promise<void> {
		const jira = this.jira();
		key ??= await this.pickTicket(jira);
		if (!key) {
			return;
		}
		const issue = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t("Reading {0}...", key) }, () => jira.issue(key!));
		const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
		if (!folder) {
			throw new Error(vscode.l10n.t("Open your repository's folder first."));
		}
		const id = await this.agents.startTeamAgent({
			folder,
			title: `${issue.key} ${issue.summary}`,
			branch: ticketBranchName(issue.key, issue.summary),
			text: ticketStartPrompt(issue.key, issue.summary),
		});
		if (id && issue.statusCategory === 'new') {
			await this.moveTicket(issue.key, id, 'In Progress');
		}
	}

	private async pickTicket(jira: JiraClient): Promise<string | undefined> {
		const sprint = await jira.mySprint().catch(() => ({ issues: [] as JiraIssueSummary[] }));
		const items = sprint.issues.map(issue => ({ label: issue.key, description: issue.summary, detail: issue.status }));
		const picked = await vscode.window.showQuickPick(items, { title: vscode.l10n.t("Start Agent on a Jira Ticket"), placeHolder: vscode.l10n.t("Your tickets in the current sprint, or type a key such as ACME-412"), matchOnDescription: true });
		return picked?.label;
	}

	// --- Move a ticket, and log time

	private async moveTicket(key: string | undefined, agent: string | undefined, suggest: string | undefined, mode: 'move' | 'log' = 'move'): Promise<void> {
		const jira = this.jira();
		const place = agent ? this.agents.agentPlace(agent) : undefined;
		const defaults = await this.tools.workspaceDefaults();
		key ??= place ? jiraKeyIn(`${place.branch ?? ''} ${place.title}`, defaults.jira?.projects) : undefined;
		key ??= await this.pickTicket(jira);
		if (!key) {
			return;
		}
		const ticket = key;
		let mrInfo: { iid: number; url: string; target: string } | undefined;
		const flow: TeamFlowPanel<MoveTicketView> = new TeamFlowPanel<MoveTicketView>(this.extensionUri, mode === 'log' ? vscode.l10n.t("Log Time on {0}", ticket) : vscode.l10n.t("Move {0}", ticket), 'jira', vscode.l10n.t("Reading {0}...", ticket), async (action, value) => {
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
							await jira.transition(ticket, transition.id, current.visibility ? undefined : comment || undefined, fields);
							if (comment && current.visibility) {
								await jira.comment(ticket, comment, current.visibility);
							}
							done.push(vscode.l10n.t("Moved {0} to {1}{2}.", ticket, transition.to, comment ? vscode.l10n.t(" with the comment") : ''));
						}
						if (logTime) {
							const date = flow.field('date', current.date);
							const started = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T${new Date().toTimeString().slice(0, 8)}`) : new Date();
							await jira.logWork(ticket, spent, flow.field('workComment', current.workComment) || undefined, started);
							done.push(vscode.l10n.t("Logged {0} on {1}.", formatDuration(parseDuration(spent)), ticket));
						}
						if (!done.length) {
							throw new Error(current.mode === 'log' ? vscode.l10n.t("Enter the time spent.") : vscode.l10n.t("Choose where to move the ticket, or tick Log time."));
						}
						flow.update({ done: done.join(' ') });
					});
				case 'open':
					return void openTeamLink(view.url);
			}
		});
		try {
			const [issue, transitions, me, place2] = await Promise.all([
				jira.issue(ticket),
				mode === 'move' ? jira.transitions(ticket) : Promise.resolve([]),
				jira.myself().catch(() => undefined),
				agent ? this.mrOfAgent(agent).catch(() => undefined) : Promise.resolve(undefined),
			]);
			mrInfo = place2 && { iid: place2.iid, url: place2.url, target: place2.targetBranch };
			const logged = await jira.worklogTotals(ticket, me?.accountId).catch(() => undefined);
			const views: TransitionView[] = transitions.map(t => ({ id: t.id, name: t.name, to: t.to, tone: categoryTone(t.toCategory), fields: t.fields }));
			const wanted = suggest?.toLowerCase();
			const selected = wanted ? views.find(t => t.to.toLowerCase() === wanted || t.name.toLowerCase() === wanted)?.id : undefined;
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
		const flow: TeamFlowPanel<OpenMrView> = new TeamFlowPanel<OpenMrView>(this.extensionUri, vscode.l10n.t("Open Merge Request"), 'gitlab', vscode.l10n.t("Reading the branch..."), (action, value) => this.openMrAction(flow, agentId, gp!, action, value));
		let gp: GitPlace | undefined;
		try {
			gp = await this.gitPlace(place.cwd, gitlab);
			const defaults = await this.tools.defaults(place.cwd);
			const key = jiraKeyIn(`${gp.branch} ${place.title}`, defaults.jira?.projects);
			const jira = this.tools.connectors.jira;
			const [branches, existing, me, ticket, members] = await Promise.all([
				gitlab.branches(gp.project),
				gitlab.mrForBranch(gp.project, gp.branch),
				gitlab.user(),
				key && jira ? jira.issue(key).catch(() => undefined) : Promise.resolve(undefined),
				gitlab.members(gp.project).catch(() => []),
			]);
			const targets = targetChoices(branches.map(b => b.name), { releasePattern: defaults.gitlab?.releaseBranches, fixVersions: ticket?.fixVersions, defaultTarget: defaults.gitlab?.defaultTarget, source: gp.branch });
			const checks = this.checkResults.get(agentId);
			flow.setView({
				kind: 'openMr', step: 'target', project: gp.project, source: gp.branch, host: new URL(gitlab.url).host, account: me.username,
				targets, target: targets.find(t => t.suggested)?.branch ?? targets[0]?.branch,
				...ticket ? { ticket: { key: ticket.key, summary: ticket.summary, url: ticket.url, fixVersions: ticket.fixVersions } } : {},
				title: ticket ? `${ticket.key} ${ticket.summary}` : place.title,
				description: '', descriptionRev: 0, generating: false,
				attachments: checks ? [{ id: 'checks', name: vscode.l10n.t("Check results"), detail: checks, icon: 'pass', tools: ['snyk', 'sonar'], checked: true }] : [],
				reviewers: [], members: members.map(m => ({ id: m.id, username: m.username, name: m.name })),
				updateJira: !!ticket, deleteBranch: true, draft: false,
				...existing ? { existing: { iid: existing.iid, url: existing.url } } : {},
			});
		} catch (err) {
			flow.fail(err);
		}
	}

	private async openMrAction(flow: TeamFlowPanel<OpenMrView>, agentId: string, gp: GitPlace, action: string, value: unknown): Promise<void> {
		const view = flow.view;
		const gitlab = this.gitlab();
		if (!view) {
			return;
		}
		switch (action) {
			case 'target':
				flow.update({ target: str(value) });
				return;
			case 'next':
				if (!view.target) {
					return;
				}
				flow.update({ step: 'details' });
				if (!view.description) {
					await this.generateDescription(flow, gp);
				}
				return;
			case 'back':
				this.keepTyped(flow);
				flow.update({ step: 'target' });
				return;
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
					const current = flow.view!;
					const title = flow.field('title', current.title).trim();
					if (!title || !current.target) {
						throw new Error(vscode.l10n.t("Enter a title."));
					}
					const dirty = (await git(gp.cwd, ['status', '--porcelain'])).trim();
					if (dirty) {
						await commitAll(gp.cwd, title);
					}
					await pushBranch(gp.cwd, gp.remote, gp.branch);
					let description = flow.field('description', current.description);
					const ticked = current.attachments.filter(a => flow.field(`attach:${a.id}`, a.checked));
					const extra: string[] = [];
					for (const attachment of ticked) {
						if (attachment.id === 'checks') {
							extra.push(`**${attachment.name}:** ${attachment.detail}`);
						} else if (attachment.id.startsWith('file:')) {
							const file = attachment.id.slice(5);
							extra.push(await gitlab.upload(gp.project, path.basename(file), await fs.readFile(file)));
						}
					}
					if (extra.length) {
						description = `${description.trim()}\n\n### Attachments\n\n${extra.join('\n\n')}`;
					}
					const mr = await gitlab.createMergeRequest(gp.project, {
						sourceBranch: gp.branch, targetBranch: current.target, title, description,
						draft: flow.field('draft', current.draft), removeSourceBranch: flow.field('deleteBranch', current.deleteBranch),
						reviewerIds: current.reviewers.map(r => r.id),
					});
					flow.dispose();
					const open = vscode.l10n.t("Open in GitLab");
					void vscode.window.showInformationMessage(vscode.l10n.t("Opened merge request !{0}.", mr.iid), open).then(choice => choice === open ? openTeamLink(mr.url) : undefined);
					if (current.ticket && flow.field('updateJira', current.updateJira)) {
						await this.moveTicket(current.ticket.key, agentId, 'In Review');
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
		flow.update({ generating: false, description: text ?? fallback, descriptionRev: current.descriptionRev + 1 });
		flow.fields.delete('description');
	}

	// --- Review someone else's merge request

	private async reviewMergeRequest(project: string | undefined, iid: number | undefined): Promise<void> {
		const gitlab = this.gitlab();
		if (!project || !iid) {
			const list = await gitlab.reviewRequests();
			const picked = await vscode.window.showQuickPick(list.map(mr => ({ label: `!${mr.iid} ${mr.title}`, description: `${mr.author} · ${mr.project}`, mr })), { title: vscode.l10n.t("Review a Merge Request"), placeHolder: vscode.l10n.t("Merge requests waiting for your review") });
			if (!picked) {
				return;
			}
			project = picked.mr.project;
			iid = picked.mr.iid;
		}
		const p = project;
		const n = iid;
		let agentId: string | undefined;
		const flow: TeamFlowPanel<ReviewView> = new TeamFlowPanel<ReviewView>(this.extensionUri, vscode.l10n.t("Review !{0}", n), 'gitlab', vscode.l10n.t("Reading !{0}...", n), async (action, value) => {
			const view = flow.view;
			if (!view) {
				return;
			}
			switch (action) {
				case 'openAgent':
					return agentId ? this.agents.open(agentId) : undefined;
				case 'openGitLab':
					return void openTeamLink(view.mr.url);
				case 'readAgain':
					return this.readReview(flow, agentId);
				case 'openDiff': {
					const finding = view.findings.find(f => f.id === value);
					const cwd = agentId ? this.agents.agentPlace(agentId)?.cwd : undefined;
					if (finding?.file && cwd) {
						const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(cwd, finding.file)));
						const line = Math.max(0, (finding.line ?? 1) - 1);
						await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, selection: new vscode.Range(line, 0, line, 0) });
					}
					return;
				}
				case 'post':
					return flow.busy(vscode.l10n.t("Posting to GitLab..."), async () => {
						const current = flow.view!;
						const ticked = current.findings.filter(f => flow.field(`check:${f.id}`, f.checked)).map(f => ({ ...f, comment: flow.field(`comment:${f.id}`, f.comment) }));
						let posted = 0;
						for (const f of ticked) {
							if (f.file && f.line) {
								await gitlab.commentOnLine(p, n, f.file, f.line, f.comment);
							} else {
								await gitlab.comment(p, n, f.file ? `**${f.file}**\n\n${f.comment}` : f.comment);
							}
							posted++;
						}
						const mode = str(value);
						if (mode === 'request') {
							await gitlab.requestChanges(p, n, vscode.l10n.t("Requesting changes: see the {0} comments above.", posted));
						} else if (mode === 'approve') {
							await gitlab.approve(p, n);
						}
						flow.update({
							done: mode === 'approve' ? vscode.l10n.t("Approved !{0}{1}.", n, posted ? vscode.l10n.t(" and posted {0} comments", posted) : '')
								: mode === 'request' ? vscode.l10n.t("Posted {0} comments and requested changes on !{1}.", posted, n)
									: vscode.l10n.t("Posted {0} comments on !{1}.", posted, n),
							...mode === 'approve' ? { approvedByMe: true } : {},
						});
					});
			}
		}, vscode.ViewColumn.Beside);
		try {
			const [m, diffs] = await Promise.all([gitlab.mr(p, n), gitlab.diffs(p, n)]);
			const clone = await this.cloneOf(p, gitlab);
			if (!clone) {
				throw new Error(vscode.l10n.t("Open a clone of {0} first, so the merge request can be checked out.", p));
			}
			const defaults = await this.tools.defaults(clone.folder);
			const ticket = jiraKeyIn(`${m.sourceBranch} ${m.title} ${m.description}`, defaults.jira?.projects);
			flow.setView({
				kind: 'review', project: p,
				mr: { iid: n, title: m.title, url: m.url, author: m.author, source: m.sourceBranch, target: m.targetBranch, files: diffs.length },
				state: 'preparing', summary: '', findings: [], findingsRev: 0, side: [],
				files: diffs.map(d => ({ path: d.newPath, ...diffCounts(d.diff) })),
				approvedByMe: !!m.approvals?.approvedByMe,
			});
			void this.reviewSide(flow, m, ticket, clone.folder);
			const worktree = await reviewWorktree(clone.folder, clone.remote, m.sourceBranch, `review/${n}-${m.sourceBranch.replace(/[^\w.-]+/g, '-')}`.slice(0, 60));
			agentId = await this.agents.startTeamAgent({ folder: clone.folder, title: vscode.l10n.t("Review !{0} {1}", n, m.title), worktree, text: '' });
			if (!agentId) {
				throw new Error(vscode.l10n.t("The reviewer couldn't start."));
			}
			flow.update({ agentId, state: 'reviewing' });
			flow.panel.reveal(vscode.ViewColumn.Beside, true);
			const controller = this.agents.controllerOf(agentId);
			await controller?.send(reviewPrompt({ iid: n, title: m.title, url: m.url, author: m.author, sourceBranch: m.sourceBranch, targetBranch: m.targetBranch }, ticket));
			await this.readReview(flow, agentId);
		} catch (err) {
			flow.fail(err);
		}
	}

	private async readReview(flow: TeamFlowPanel<ReviewView>, agentId: string | undefined): Promise<void> {
		const controller = agentId ? this.agents.controllerOf(agentId) : undefined;
		const items = controller?.conversation ?? [];
		const lastUser = items.map(i => i.kind).lastIndexOf('user');
		const reply = items.slice(lastUser + 1).flatMap(i => i.kind === 'agent' ? [i.text] : []).join('\n');
		const findings = parseReviewFindings(reply);
		const view = flow.view!;
		flow.update({
			state: findings ? 'ready' : 'unparsed',
			summary: reviewSummary(reply),
			findings: (findings ?? []).map((f, i) => ({ ...f, id: `f${view.findingsRev + 1}-${i}`, checked: f.kind !== 'nit' })),
			findingsRev: view.findingsRev + 1,
		});
	}

	private async reviewSide(flow: TeamFlowPanel<ReviewView>, mr: GitLabMr, ticket: string | undefined, folder: string): Promise<void> {
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
		}
		if (!flow.isDisposed) {
			flow.update({ side });
		}
	}

	// --- Fix a merge request's pipeline (from Home)

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
		const existing = this.agents.summaries().find(a => a.worktree?.branch === mr.sourceBranch);
		if (existing) {
			await this.send(existing.id, text);
			return;
		}
		const clone = await this.cloneOf(project, gitlab);
		if (!clone) {
			throw new Error(vscode.l10n.t("Open a clone of {0} first.", project));
		}
		const worktree = await reviewWorktree(clone.folder, clone.remote, mr.sourceBranch, mr.sourceBranch);
		await this.agents.startTeamAgent({ folder: clone.folder, title: vscode.l10n.t("Fix !{0} {1}", iid, mr.title), worktree, text });
	}

	// --- Merge a release branch forward

	private async mergeReleaseForward(source: string | undefined): Promise<void> {
		const gitlab = this.gitlab();
		let repo: { folder: string; project: string; remote: string; defaults: TeamDefaults } | undefined;
		const flow: TeamFlowPanel<ReleaseView> = new TeamFlowPanel<ReleaseView>(this.extensionUri, vscode.l10n.t("Merge Release Branch Forward"), 'gitlab', vscode.l10n.t("Reading the release branches..."), async (action, value) => {
			const view = flow.view;
			if (!view || !repo) {
				return;
			}
			switch (action) {
				case 'source':
					return this.checkRelease(flow, repo, str(value)!, branchNames);
				case 'reviewers':
					flow.update({ reviewers: view.members.filter(m => Array.isArray(value) && value.includes(m.id)) });
					return;
				case 'openAgent':
					return this.agents.open(str(value)!);
				case 'openUrl':
					return void openTeamLink(str(value)!);
				case 'push':
					return flow.busy(vscode.l10n.t("Pushing..."), () => this.pushRelease(flow, repo!, str(value)!));
				case 'submit':
					return flow.busy(vscode.l10n.t("Merging..."), () => this.startRelease(flow, repo!));
			}
		});
		let branchNames: string[] = [];
		try {
			repo = await this.firstClone(gitlab);
			const [branches, members] = await Promise.all([gitlab.branches(repo.project), gitlab.members(repo.project).catch(() => [])]);
			branchNames = branches.map(b => b.name);
			const pattern = repo.defaults.gitlab?.releaseBranches;
			const sources = sortReleaseBranches(branchNames.filter(b => isReleaseBranch(b, pattern)));
			if (!sources.length) {
				throw new Error(vscode.l10n.t("{0} has no release branches (named like {1}).", repo.project, pattern ?? 'release/*'));
			}
			flow.setView({ kind: 'release', sources, targets: [], tickets: [], addTickets: false, reviewers: [], members: members.map(m => ({ id: m.id, username: m.username, name: m.name })), fetching: true, started: false });
			await this.checkRelease(flow, repo, source && sources.includes(source) ? source : sources[0], branchNames);
		} catch (err) {
			flow.fail(err);
		}
	}

	private async checkRelease(flow: TeamFlowPanel<ReleaseView>, repo: { folder: string; project: string; remote: string; defaults: TeamDefaults }, source: string, branches: readonly string[]): Promise<void> {
		const targets = releaseTargets(source, branches, { releasePattern: repo.defaults.gitlab?.releaseBranches, defaultTarget: repo.defaults.gitlab?.defaultTarget });
		flow.update({ source, fetching: true, targets: targets.map(t => ({ ...t, checking: true, conflicts: [] })), tickets: [] });
		const jira = this.tools.connectors.jira;
		const version = source.replace(/^.*\//, '');
		void (jira ? jira.search(`fixVersion = "${version.replace(/"/g, '')}" ORDER BY key`, 50).catch(() => []) : Promise.resolve([])).then(issues => {
			if (flow.view?.source === source) {
				flow.update({ tickets: issues.map(i => i.key), addTickets: issues.length > 0 });
			}
		});
		await fetchBranches(repo.folder, repo.remote, [source, ...targets.map(t => t.branch)]);
		flow.update({ fetching: false });
		await Promise.all(targets.map(async target => {
			const check = await checkMerge(repo.folder, repo.remote, source, target.branch).catch(() => undefined);
			const view = flow.view;
			if (!view || view.source !== source) {
				return;
			}
			flow.update({
				targets: view.targets.map(t => t.branch === target.branch ? { ...t, checking: false, ticked: flow.field(`tick:${t.branch}`, t.ticked) && (check?.behind ?? 1) > 0, ...check ? { behind: check.behind, clean: check.clean, conflicts: check.conflicts } : {} } : { ...t, ticked: flow.field(`tick:${t.branch}`, t.ticked) }),
			});
		}));
	}

	private async startRelease(flow: TeamFlowPanel<ReleaseView>, repo: { folder: string; project: string; remote: string }): Promise<void> {
		const view = flow.view!;
		const source = view.source!;
		const ticked = view.targets.filter(t => flow.field(`tick:${t.branch}`, t.ticked) && (t.behind ?? 1) > 0);
		if (!ticked.length) {
			throw new Error(vscode.l10n.t("Tick the branches to merge into."));
		}
		flow.update({ started: true });
		const tickets = flow.field('addTickets', view.addTickets) ? view.tickets : [];
		for (const target of ticked) {
			const branch = releaseMergeBranch(source, target.branch);
			let result: NonNullable<ReleaseView['targets'][number]['result']>;
			try {
				const merged = await mergeInWorktree(repo.folder, repo.remote, source, target.branch, branch);
				if (merged.kind === 'merged') {
					await pushBranch(merged.worktree.folder, repo.remote, branch);
					const mr = await this.openReleaseMr(repo.project, source, target.branch, branch, tickets, false, view.reviewers);
					await git(repo.folder, ['worktree', 'remove', '--force', merged.worktree.folder]).catch(() => undefined);
					result = { text: vscode.l10n.t("Opened !{0}", mr.iid), tone: 'ok', url: mr.url };
				} else {
					const agentId = await this.agents.startTeamAgent({
						folder: repo.folder, title: vscode.l10n.t("Merge {0} into {1}", source, target.branch), worktree: merged.worktree,
						text: releaseConflictPrompt(source, target.branch, merged.files),
					});
					this.releaseWork.set(`${source}→${target.branch}`, { folder: merged.worktree.folder, branch, agentId });
					result = { text: vscode.l10n.t("An agent is resolving {0} conflicts. Check its work, then push.", merged.files.length), tone: 'warn', ...agentId ? { agentId } : {}, canPush: true };
				}
			} catch (err) {
				result = { text: errorMessage(err), tone: 'error' };
			}
			const now = flow.view!;
			flow.update({ targets: now.targets.map(t => t.branch === target.branch ? { ...t, result } : t) });
		}
		await this.agents.open(view.targets.map(t => t.result?.agentId).find(Boolean) ?? '').catch(() => undefined);
	}

	private readonly releaseWork = new Map<string, { folder: string; branch: string; agentId?: string }>();

	private async pushRelease(flow: TeamFlowPanel<ReleaseView>, repo: { folder: string; project: string; remote: string }, target: string): Promise<void> {
		const view = flow.view!;
		const source = view.source!;
		const work = this.releaseWork.get(`${source}→${target}`);
		if (!work) {
			throw new Error(vscode.l10n.t("Nothing to push for {0}.", target));
		}
		if (await mergeUnfinished(work.folder)) {
			throw new Error(vscode.l10n.t("The merge into {0} isn't finished: files still conflict or it isn't committed.", target));
		}
		await pushBranch(work.folder, repo.remote, work.branch);
		const tickets = flow.field('addTickets', view.addTickets) ? view.tickets : [];
		const mr = await this.openReleaseMr(repo.project, source, target, work.branch, tickets, true, view.reviewers);
		this.releaseWork.delete(`${source}→${target}`);
		const now = flow.view!;
		flow.update({ targets: now.targets.map(t => t.branch === target ? { ...t, result: { text: vscode.l10n.t("Opened !{0}", mr.iid), tone: 'ok', url: mr.url } } : t) });
	}

	private openReleaseMr(project: string, source: string, target: string, branch: string, tickets: readonly string[], resolved: boolean, reviewers: readonly FlowPerson[]) {
		const { title, description } = releaseMergeMr(source, target, tickets, resolved);
		return this.gitlab().createMergeRequest(project, { sourceBranch: branch, targetBranch: target, title, description, removeSourceBranch: true, reviewerIds: reviewers.map(r => r.id) });
	}

	// --- Checks

	private async runChecks(agent: string | undefined): Promise<void> {
		const agentId = this.agentId(agent);
		const place = this.agents.agentPlace(agentId)!;
		const flow: TeamFlowPanel<ChecksView> = new TeamFlowPanel<ChecksView>(this.extensionUri, vscode.l10n.t("Checks: {0}", place.title), this.tools.connected.has('snyk') ? 'snyk' : 'sonar', vscode.l10n.t("Starting the checks..."), async (action, value) => {
			const view = flow.view;
			if (!view) {
				return;
			}
			switch (action) {
				case 'again':
					return this.check(flow, agentId);
				case 'open':
					return void openTeamLink(str(value)!);
				case 'fix':
				case 'fixAll': {
					const chosen = action === 'fix' ? view.findings.filter(f => f.id === value)
						: view.findings.filter(f => flow.field(`check:${f.id}`, f.checked));
					if (!chosen.length) {
						return;
					}
					await this.send(agentId, checksFixPrompt(chosen));
					flow.update({ sent: vscode.l10n.t("Sent {0} to {1}.", chosen.length === 1 ? vscode.l10n.t("the finding") : vscode.l10n.t("{0} findings", chosen.length), place.title) });
					return;
				}
			}
		}, vscode.ViewColumn.Beside);
		await this.check(flow, agentId);
	}

	private async check(flow: TeamFlowPanel<ChecksView>, agentId: string): Promise<void> {
		const place = this.agents.agentPlace(agentId)!;
		const { snyk, sonar } = this.tools.connectors;
		const branch = (await git(place.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || undefined;
		const rows: ChecksView['rows'][number][] = [
			snyk ? { tool: 'snyk', name: vscode.l10n.t("Snyk: dependencies"), state: 'running', detail: vscode.l10n.t("Running snyk test...") } : { tool: 'snyk', name: vscode.l10n.t("Snyk"), state: 'off', detail: vscode.l10n.t("Not connected") },
			...snyk ? [{ tool: 'snyk' as const, name: vscode.l10n.t("Snyk Code: source"), state: 'running' as const, detail: vscode.l10n.t("Running snyk code test...") }] : [],
			sonar ? { tool: 'sonar', name: vscode.l10n.t("SonarQube: new code"), state: 'running', detail: vscode.l10n.t("Reading the last analysis...") } : { tool: 'sonar', name: 'SonarQube', state: 'off', detail: vscode.l10n.t("Not connected") },
		];
		flow.setView({ kind: 'checks', agentTitle: place.title, agentId, ...branch ? { branch } : {}, rows, findings: [] });
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
					results.push(vscode.l10n.t("SonarQube new code: {0}{1}, {2} issues", gate.status === 'OK' ? vscode.l10n.t("gate passed") : gate.status === 'ERROR' ? vscode.l10n.t("gate failed") : vscode.l10n.t("no gate"), gate.coverage ? vscode.l10n.t(", coverage {0}%", gate.coverage) : '', issues.length));
					setRow(name, { state: 'done', detail: vscode.l10n.t("Quality gate {0}{1}", gate.status === 'OK' ? vscode.l10n.t("passed") : gate.status === 'ERROR' ? vscode.l10n.t("failed") : vscode.l10n.t("not computed"), gate.coverage ? vscode.l10n.t(" · coverage {0}%", gate.coverage) : ''), pill: { text: findings.length ? String(findings.length) : vscode.l10n.t("clean"), tone: gate.status === 'ERROR' ? 'error' : findings.length ? 'warn' : 'ok' } }, findings);
				} catch (err) {
					setRow(name, { state: 'problem', detail: /404|found nothing/.test(errorMessage(err)) ? vscode.l10n.t("{0} hasn't been analysed yet; SonarQube runs in the pipeline after you push.", branch ?? key) : errorMessage(err) });
				}
			})());
		}
		await Promise.all(tasks);
		const summary = results.filter(Boolean).join(' · ');
		if (summary) {
			this.checkResults.set(agentId, summary);
		}
	}
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

export function pipelineTone(status: string): Tone {
	return status === 'success' ? 'ok' : status === 'failed' ? 'error' : status === 'running' || status === 'pending' ? 'info' : 'muted';
}

function diffCounts(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) {
			added++;
		} else if (line.startsWith('-') && !line.startsWith('---')) {
			removed++;
		}
	}
	return { added, removed };
}

function formatSize(bytes: number): string {
	return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
