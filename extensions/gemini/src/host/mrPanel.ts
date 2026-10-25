/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { errorMessage } from '../acp/errors';
import { GitLabDiscussion, GitLabJob, GitLabMr, MergeReadiness } from '../acp/gitlab';
import { JiraIssue, jiraKeyIn } from '../acp/jira';
import { SonarGate, sonarProjectKeyIn } from '../acp/sonar';
import { mrFixPrompt } from '../acp/teamFlowLogic';
import { gitlabProjectOf } from '../acp/teamTools';
import type { AgentsView } from './agentsView';
import type { ChangesSource } from './changesView';
import type { TeamConnections } from './teamConnections';
import { relativeTime } from './displayText';
import { type MergeOptions, pipelineTone } from './teamFlows';
import { ChangesTeamView, FromChangesTeam } from './teamFlowProtocol';
import { openTeamLink } from './teamLinks';

/** How long an agent's merge request status is reused before it is read again. */
const freshMs = 60_000;

interface MrState {
	readonly at: number;
	readonly project?: string;
	readonly branch?: string;
	readonly mr?: GitLabMr;
	readonly failed: readonly GitLabJob[];
	readonly passedJobs: readonly string[];
	/** How far the head pipeline is: jobs finished well, of all its jobs. */
	readonly jobs?: { readonly done: number; readonly total: number };
	readonly threads: readonly GitLabDiscussion[];
	readonly gate?: SonarGate;
	readonly ticket?: JiraIssue;
	readonly readiness?: MergeReadiness;
	readonly error?: string;
}

/**
 * The team part of the Changes panel: Open Merge Request and Run Checks for
 * the agent in front, and once its branch has an open merge request, that
 * merge request's pipeline (failed jobs with Fix), SonarQube gate, the last
 * Snyk result, new review threads, and Fix Pipeline and Comments, which sends
 * them to the agent. GitLab is read in the background and at most once a
 * minute per agent, so the panel never waits on it.
 */
export class MrPanel implements vscode.Disposable {

	private readonly states = new Map<string, MrState>();
	private readonly loading = new Set<string>();
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private readonly tools: TeamConnections, private readonly agents: AgentsView, private readonly checks: (agentId: string) => string | undefined) { }

	dispose(): void {
		this.onDidChangeEmitter.dispose();
	}

	view(source: ChangesSource): ChangesTeamView | undefined {
		const gitlab = this.tools.connectors.gitlab;
		const canCheck = this.tools.connected.has('snyk') || this.tools.connected.has('sonar');
		if (!gitlab && !canCheck) {
			return undefined;
		}
		const state = this.states.get(source.agentId);
		if (gitlab && (!state || Date.now() - state.at > freshMs)) {
			void this.load(source);
		}
			const view: { -readonly [K in keyof ChangesTeamView]: ChangesTeamView[K] } = {
			...gitlab && state?.project && !state.mr && state.branch ? { openMr: vscode.l10n.t("Open Merge Request") } : {},
			...canCheck ? { runChecks: vscode.l10n.t("Run Checks") } : {},
		};
		const mr = state?.mr;
		if (mr) {
			const rows: NonNullable<ChangesTeamView['mr']>['rows'][number][] = [];
			const sha = (state.readiness?.sha || mr.diffRefs?.headSha || '').slice(0, 7);
			if (mr.pipeline) {
				rows.push({
					tool: 'gitlab', label: sha ? vscode.l10n.t("Pipeline for {0}", sha) : vscode.l10n.t("Pipeline"), detail: `#${mr.pipeline.id}`,
					pill: { text: state.jobs?.total ? vscode.l10n.t("{0} · {1} of {2} jobs", mr.pipeline.status, state.jobs.done, state.jobs.total) : mr.pipeline.status, tone: pipelineTone(mr.pipeline.status) },
					jobs: state.failed.map(j => ({ id: j.id, name: `${j.stage} · ${j.name}`, fix: vscode.l10n.t("Fix") })),
					...state.passedJobs.length ? { note: state.passedJobs.join(', ') } : {},
				});
			}
			if (state.gate) {
				rows.push({ tool: 'sonar', label: vscode.l10n.t("Quality gate"), pill: state.gate.status === 'OK' ? { text: vscode.l10n.t("passed"), tone: 'ok' } : state.gate.status === 'ERROR' ? { text: vscode.l10n.t("failed"), tone: 'error' } : { text: vscode.l10n.t("not analysed"), tone: 'muted' } });
			}
			const snyk = this.checks(source.agentId);
			if (snyk && this.tools.connected.has('snyk')) {
				rows.push({ tool: 'snyk', label: 'Snyk', detail: snyk });
			}
			const open = state.threads.filter(d => !d.resolved);
			rows.push({
				tool: 'review', label: vscode.l10n.t("Review threads"),
				pill: open.length ? { text: vscode.l10n.t("{0} unresolved", open.length), tone: 'warn' } : { text: vscode.l10n.t("0 unresolved"), tone: 'ok' },
				threads: open.map(d => ({ id: d.id, author: d.notes[0].author, text: d.notes[d.notes.length - 1].body.replace(/\s+/g, ' ').slice(0, 160) })),
			});
			if (state.ticket) {
				rows.push({ tool: 'jira', label: state.ticket.key, detail: state.ticket.summary, pill: { text: state.ticket.status, tone: state.ticket.statusCategory === 'done' ? 'ok' : 'info' } });
			}
			const readiness = state.readiness;
			const ticket = state.ticket?.key;
			view.mr = {
				iid: mr.iid,
				...readiness ? {
					merge: {
						heading: vscode.l10n.t("Merge !{0}", mr.iid),
						readAt: Date.now() - state.at < 60_000 ? vscode.l10n.t("read live {0} s ago", Math.round((Date.now() - state.at) / 1000)) : vscode.l10n.t("read live {0} ago", relativeTime(state.at, Date.now())),
						checks: readiness.checks.map(c => ({ name: c.name, state: c.ok ? 'ok' : c.pending ? 'pending' : 'missing', detail: c.detail, source: c.source })),
						ready: readiness.ready,
						squash: { label: vscode.l10n.t("Squash commits (project default)"), on: readiness.squash },
						removeSourceBranch: { label: vscode.l10n.t("Delete source branch"), on: readiness.removeSourceBranch },
						...ticket ? { moveTicket: { label: vscode.l10n.t("Move {0} to Done with a comment", ticket), on: true, key: ticket } } : {},
						request: { path: `/merge_requests/${mr.iid}/merge`, sha: readiness.sha.slice(0, 7) },
						// Everything but a running pipeline in place: the button says what it waits for.
						button: !readiness.ready && readiness.checks.every(c => c.ok || c.pending) ? vscode.l10n.t("Merge When the Pipeline Passes") : vscode.l10n.t("Merge..."),
						note: readiness.ready ? vscode.l10n.t("Read from GitLab just now. You will confirm once more, and GitLab checks again.") : vscode.l10n.t("Enabled when every line above is green. You will confirm once more."),
					},
				} : {},
				heading: `!${mr.iid} ${mr.title}`,
				target: `→ ${mr.targetBranch}`,
				url: mr.url,
				openIn: vscode.l10n.t("Open in GitLab"),
				rows,
				...state.failed.length || open.length ? {
					fixAll: {
						label: vscode.l10n.t("Fix Pipeline and {0} Comments"),
						one: vscode.l10n.t("Fix Pipeline and 1 Comment"),
						pipelineOnly: vscode.l10n.t("Fix Pipeline"),
						commentsOnly: vscode.l10n.t("Fix {0} Comments"),
					},
				} : {},
			};
		}
		return view.openMr || view.runChecks || view.mr ? view : undefined;
	}

	async act(source: ChangesSource, message: FromChangesTeam): Promise<void> {
		switch (message.action) {
			case 'openMr':
				await vscode.commands.executeCommand('gemini.team.openMergeRequest', source.agentId);
				return;
			case 'runChecks':
				await vscode.commands.executeCommand('gemini.team.runChecks', source.agentId);
				return;
			case 'merge': {
				const state = this.states.get(source.agentId);
				if (state?.project && state.mr) {
					const options: MergeOptions = { squash: message.squash, removeSourceBranch: message.removeSourceBranch, ...message.moveTicket && state.ticket ? { moveTicket: state.ticket.key } : {} };
					await vscode.commands.executeCommand('gemini.team.mergeMergeRequest', state.project, state.mr.iid, options);
					// Read again: merged, or GitLab said no.
					this.states.set(source.agentId, { ...state, at: 0 });
					this.onDidChangeEmitter.fire();
				}
				return;
			}
			case 'openUrl': {
				const url = this.states.get(source.agentId)?.mr?.url;
				if (url) {
					await openTeamLink(url);
				}
				return;
			}
			case 'fixJob':
				return this.fix(source, [message.job], []);
			case 'fixMr': {
				const state = this.states.get(source.agentId);
				return this.fix(source, message.jobs ? state?.failed.map(j => j.id) ?? [] : [], message.threads);
			}
		}
	}

	private async fix(source: ChangesSource, jobIds: readonly number[], threadIds: readonly string[]): Promise<void> {
		const gitlab = this.tools.connectors.gitlab;
		const state = this.states.get(source.agentId);
		if (!gitlab || !state?.mr || !state.project) {
			return;
		}
		const project = state.project;
		const jobs = await Promise.all(state.failed.filter(j => jobIds.includes(j.id)).map(async j => ({ name: j.name, id: j.id, log: await gitlab.jobLogTail(project, j.id, 6000).catch(err => errorMessage(err)) })));
		const threads = state.threads.filter(d => threadIds.includes(d.id)).map(d => ({ id: d.id, author: d.notes[0].author, body: d.notes.map(n => `${n.author}: ${n.body}`).join('\n'), path: d.notes[0].path, line: d.notes[0].line }));
		if (!jobs.length && !threads.length) {
			return;
		}
		const controller = this.agents.controllerOf(source.agentId);
		if (controller?.running) {
			void vscode.window.showInformationMessage(vscode.l10n.t("{0} is working. Try again when it finishes its turn.", source.title));
			return;
		}
		await this.agents.open(source.agentId);
		void this.agents.controllerOf(source.agentId)?.send(mrFixPrompt({ iid: state.mr.iid, url: state.mr.url }, jobs, threads));
		// Read again after the agent pushes.
		this.states.set(source.agentId, { ...state, at: 0 });
	}

	private async load(source: ChangesSource): Promise<void> {
		const gitlab = this.tools.connectors.gitlab;
		if (!gitlab || this.loading.has(source.agentId)) {
			return;
		}
		this.loading.add(source.agentId);
		const previous = this.states.get(source.agentId);
		try {
			const defaults = await this.tools.defaults(source.folder);
			const local = await gitlabProjectOf(source.folder, gitlab.url, defaults);
			if (!local.project || !local.branch) {
				this.states.set(source.agentId, { at: Date.now(), failed: [], passedJobs: [], threads: [] });
				return;
			}
			const summary = await gitlab.mrForBranch(local.project, local.branch);
			if (!summary) {
				this.states.set(source.agentId, { at: Date.now(), project: local.project, branch: local.branch, failed: [], passedJobs: [], threads: [] });
				return;
			}
			const sonar = this.tools.connectors.sonar;
			const jira = this.tools.connectors.jira;
			const sonarKey = sonar ? defaults.sonar?.projectKey ?? await sonarProjectKeyIn(source.folder) : undefined;
			const key = jiraKeyIn(`${local.branch} ${summary.title}`, defaults.jira?.projects);
			const mr = await gitlab.mr(local.project, summary.iid);
			const [jobs, threads, gate, ticket, readiness] = await Promise.all([
				mr.pipeline ? gitlab.jobs(local.project, mr.pipeline.id).catch(() => []) : Promise.resolve([]),
				gitlab.discussions(local.project, mr.iid).catch(() => []),
				sonar && sonarKey ? sonar.gate({ project: sonarKey, mergeRequest: String(mr.iid) }).catch(() => undefined) : Promise.resolve(undefined),
				jira && key ? jira.issue(key).catch(() => undefined) : Promise.resolve(undefined),
				mr.state === 'opened' ? gitlab.mergeReadiness(local.project, mr.iid).catch(() => undefined) : Promise.resolve(undefined),
			]);
			this.states.set(source.agentId, {
				at: Date.now(), project: local.project, branch: local.branch, mr,
				failed: jobs.filter(j => j.status === 'failed'),
				passedJobs: jobs.filter(j => j.status === 'success').map(j => j.name).slice(0, 6),
				...jobs.length ? { jobs: { done: jobs.filter(j => j.status === 'success').length, total: jobs.length } } : {},
				threads, gate, ticket, readiness,
			});
		} catch (err) {
			this.states.set(source.agentId, { ...previous ?? { failed: [], passedJobs: [], threads: [] }, at: Date.now(), error: errorMessage(err) });
		} finally {
			this.loading.delete(source.agentId);
		}
		this.onDidChangeEmitter.fire();
	}
}
