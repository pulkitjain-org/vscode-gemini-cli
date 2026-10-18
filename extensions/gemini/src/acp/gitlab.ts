/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GitLab (self-managed, over the VPN) through REST API v4 with the user's
// personal access token (`api` scope). Answers are trimmed to what a panel or
// the model needs: an MR's state, pipeline, approvals and open threads, a
// failed job's log tail.

import { clip, Fetch, normalizeBaseUrl, teamRequest } from './teamHttp';

export interface GitLabAuth {
	readonly url: string;
	readonly token: string;
}

export interface GitLabUser {
	readonly id: number;
	readonly username: string;
	readonly name: string;
}

export interface GitLabTokenInfo {
	readonly name?: string;
	readonly scopes: readonly string[];
	readonly expiresAt?: string;
}

export type PipelineState = 'success' | 'failed' | 'running' | 'pending' | 'canceled' | 'skipped' | 'manual' | 'created' | 'none';

export interface GitLabMrSummary {
	readonly projectId: number;
	/** `group/repo` */
	readonly project: string;
	readonly iid: number;
	readonly title: string;
	readonly author: string;
	readonly sourceBranch: string;
	readonly targetBranch: string;
	readonly draft: boolean;
	readonly url: string;
	readonly updatedAt: string;
	/** GitLab's `detailed_merge_status`, such as mergeable, ci_still_running, conflict. */
	readonly mergeStatus?: string;
	readonly reviewers: readonly string[];
}

export interface GitLabMr extends GitLabMrSummary {
	readonly description: string;
	readonly state: string;
	readonly pipeline?: { readonly id: number; readonly status: PipelineState; readonly url?: string };
	readonly approvals?: { readonly given: number; readonly required: number; readonly approvedByMe: boolean };
	readonly diffRefs?: { readonly baseSha: string; readonly headSha: string; readonly startSha: string };
	readonly changes?: string;
}

export interface GitLabNote {
	readonly id: number;
	readonly author: string;
	readonly body: string;
	readonly createdAt: string;
	readonly path?: string;
	readonly line?: number;
}

export interface GitLabDiscussion {
	readonly id: string;
	readonly resolved: boolean;
	readonly notes: readonly GitLabNote[];
}

export interface GitLabJob {
	readonly id: number;
	readonly name: string;
	readonly stage: string;
	readonly status: string;
	readonly url: string;
}

export interface GitLabDiffFile {
	readonly oldPath: string;
	readonly newPath: string;
	readonly diff: string;
	readonly newFile: boolean;
	readonly deletedFile: boolean;
}

export interface GitLabBranch {
	readonly name: string;
	readonly commitDate?: string;
	readonly protected: boolean;
}

export interface NewMergeRequest {
	readonly sourceBranch: string;
	readonly targetBranch: string;
	readonly title: string;
	readonly description: string;
	readonly draft?: boolean;
	readonly removeSourceBranch?: boolean;
	readonly reviewerIds?: readonly number[];
	readonly squash?: boolean;
}

/** A project's path from a git remote on the GitLab host: `git@host:group/repo.git`, `https://host/group/repo`. */
export function projectPathFromRemote(remote: string, gitlabUrl: string): string | undefined {
	const host = (() => {
		try {
			return new URL(normalizeBaseUrl(gitlabUrl)).hostname.toLowerCase();
		} catch {
			return '';
		}
	})();
	const trimmed = remote.trim();
	let remoteHost: string | undefined;
	let path: string | undefined;
	const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(trimmed);
	if (scp && !/^[a-z]+:\/\//i.test(trimmed)) {
		remoteHost = scp[1];
		path = scp[2];
	} else {
		try {
			const url = new URL(trimmed);
			remoteHost = url.hostname;
			path = url.pathname;
		} catch {
			return undefined;
		}
	}
	if (!remoteHost || remoteHost.toLowerCase() !== host) {
		return undefined;
	}
	const project = path.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
	return project.includes('/') ? project : undefined;
}

/** The project and iid of an MR link such as `https://host/group/repo/-/merge_requests/12`, or `!12` with a default project. */
export function parseMrRef(ref: string): { readonly project?: string; readonly iid: number } | undefined {
	const link = /\/(.+?)\/-\/merge_requests\/(\d+)/.exec(ref);
	if (link) {
		try {
			return { project: decodeURIComponent(new URL(ref).pathname.replace(/\/-\/merge_requests\/.*$/, '').replace(/^\//, '')), iid: Number(link[2]) };
		} catch {
			return { project: link[1].replace(/^https?:\/\/[^/]+\//, ''), iid: Number(link[2]) };
		}
	}
	const bang = /^\s*!?(\d+)\s*$/.exec(ref);
	return bang ? { iid: Number(bang[1]) } : undefined;
}

export class GitLabClient {

	readonly url: string;
	private me: Promise<GitLabUser> | undefined;
	private readonly projectIds = new Map<string, Promise<number>>();

	constructor(private readonly auth: GitLabAuth, private readonly fetcher: Fetch = fetch) {
		this.url = normalizeBaseUrl(auth.url);
	}

	private request<T>(path: string, init: Parameters<typeof teamRequest>[2] = {}): Promise<T> {
		return teamRequest<T>('gitlab', `${this.url}/api/v4${path}`, { ...init, headers: { 'PRIVATE-TOKEN': this.auth.token, ...init.headers } }, this.fetcher);
	}

	user(): Promise<GitLabUser> {
		this.me ??= this.request<GitLabUser>('/user').then(u => ({ id: u.id, username: u.username, name: u.name }), err => {
			this.me = undefined;
			throw err;
		});
		return this.me;
	}

	async version(): Promise<string | undefined> {
		return (await this.request<{ version?: string }>('/version'))?.version;
	}

	async token(): Promise<GitLabTokenInfo | undefined> {
		try {
			const t = await this.request<{ name?: string; scopes?: string[]; expires_at?: string | null }>('/personal_access_tokens/self');
			return { name: t.name, scopes: t.scopes ?? [], expiresAt: t.expires_at ?? undefined };
		} catch {
			return undefined;
		}
	}

	/** The numeric id of `project` (`group/repo`, or an id). */
	projectId(project: string | number): Promise<number> {
		if (typeof project === 'number' || /^\d+$/.test(project)) {
			return Promise.resolve(Number(project));
		}
		let id = this.projectIds.get(project);
		if (!id) {
			id = this.request<{ id: number }>(`/projects/${encodeURIComponent(project)}`).then(p => p.id);
			id.catch(() => this.projectIds.delete(project));
			this.projectIds.set(project, id);
		}
		return id;
	}

	mrUrl(project: string, iid: number): string {
		return `${this.url}/${project}/-/merge_requests/${iid}`;
	}

	/** Open MRs where the user is a reviewer. */
	async reviewRequests(): Promise<GitLabMrSummary[]> {
		const me = await this.user();
		const list = await this.request<RawMr[]>(`/merge_requests?scope=all&state=opened&reviewer_id=${me.id}&per_page=20&order_by=updated_at`);
		return list.map(mrSummary);
	}

	/** Open MRs assigned to the user (as the one to finish them), which may not be theirs. */
	async assignedMergeRequests(): Promise<GitLabMrSummary[]> {
		const me = await this.user();
		const list = await this.request<RawMr[]>(`/merge_requests?scope=all&state=opened&assignee_id=${me.id}&per_page=20&order_by=updated_at`);
		return list.map(mrSummary);
	}

	/** The user's own open MRs. */
	async myMergeRequests(): Promise<GitLabMrSummary[]> {
		const list = await this.request<RawMr[]>('/merge_requests?scope=created_by_me&state=opened&per_page=20&order_by=updated_at');
		return list.map(mrSummary);
	}

	/** The open MR from `branch` in `project`, if any. */
	async mrForBranch(project: string | number, branch: string): Promise<GitLabMrSummary | undefined> {
		const id = await this.projectId(project);
		const list = await this.request<RawMr[]>(`/projects/${id}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&per_page=1`);
		return list[0] && mrSummary(list[0]);
	}

	async mr(project: string | number, iid: number, withApprovals = true): Promise<GitLabMr> {
		const id = await this.projectId(project);
		const [raw, approvals, me] = await Promise.all([
			this.request<RawMr>(`/projects/${id}/merge_requests/${iid}`),
			withApprovals ? this.request<{ approved_by?: { user?: { id: number } }[]; approvals_required?: number; approvals_left?: number }>(`/projects/${id}/merge_requests/${iid}/approvals`).catch(() => undefined) : undefined,
			this.user(),
		]);
		const given = approvals?.approved_by?.length ?? 0;
		return {
			...mrSummary(raw),
			description: raw.description ?? '',
			state: raw.state ?? 'opened',
			...raw.head_pipeline ? { pipeline: { id: raw.head_pipeline.id, status: pipelineState(raw.head_pipeline.status), url: raw.head_pipeline.web_url } } : {},
			...approvals ? { approvals: { given, required: approvals.approvals_required ?? given + (approvals.approvals_left ?? 0), approvedByMe: !!approvals.approved_by?.some(a => a.user?.id === me.id) } } : {},
			...raw.diff_refs ? { diffRefs: { baseSha: raw.diff_refs.base_sha, headSha: raw.diff_refs.head_sha, startSha: raw.diff_refs.start_sha } } : {},
			...raw.changes_count ? { changes: String(raw.changes_count) } : {},
		};
	}

	async diffs(project: string | number, iid: number): Promise<GitLabDiffFile[]> {
		const id = await this.projectId(project);
		const files = await this.request<{ old_path: string; new_path: string; diff: string; new_file: boolean; deleted_file: boolean }[]>(`/projects/${id}/merge_requests/${iid}/diffs?per_page=100`);
		return files.map(f => ({ oldPath: f.old_path, newPath: f.new_path, diff: f.diff, newFile: f.new_file, deletedFile: f.deleted_file }));
	}

	/** The MR's threads that people wrote (not system notes), oldest first. */
	async discussions(project: string | number, iid: number): Promise<GitLabDiscussion[]> {
		const id = await this.projectId(project);
		const raw = await this.request<RawDiscussion[]>(`/projects/${id}/merge_requests/${iid}/discussions?per_page=100`);
		return raw.flatMap(d => {
			const notes = (d.notes ?? []).filter(n => !n.system);
			if (!notes.length) {
				return [];
			}
			return [{
				id: d.id,
				resolved: notes.every(n => !n.resolvable || n.resolved),
				notes: notes.map(n => ({
					id: n.id,
					author: n.author?.username ?? '',
					body: n.body ?? '',
					createdAt: n.created_at ?? '',
					...n.position?.new_path ? { path: n.position.new_path } : {},
					...n.position?.new_line ? { line: n.position.new_line } : {},
				})),
			}];
		});
	}

	async jobs(project: string | number, pipeline: number, failedOnly = false): Promise<GitLabJob[]> {
		const id = await this.projectId(project);
		const jobs = await this.request<{ id: number; name: string; stage: string; status: string; web_url: string }[]>(`/projects/${id}/pipelines/${pipeline}/jobs?per_page=100${failedOnly ? '&scope[]=failed' : ''}`);
		return jobs.map(j => ({ id: j.id, name: j.name, stage: j.stage, status: j.status, url: j.web_url }));
	}

	/** The end of a job's log, where the failure usually is, without terminal colour codes. */
	async jobLogTail(project: string | number, job: number, maxChars = 12_000): Promise<string> {
		const id = await this.projectId(project);
		const log = await this.request<string>(`/projects/${id}/jobs/${job}/trace`, { text: true, timeoutMs: 15_000 });
		const clean = stripAnsi(log ?? '');
		return clean.length > maxChars ? `… (${clean.length - maxChars} earlier characters cut)\n${clean.slice(-maxChars)}` : clean;
	}

	async issue(project: string | number, iid: number): Promise<{ title: string; description: string; state: string; url: string; labels: readonly string[] }> {
		const id = await this.projectId(project);
		const i = await this.request<{ title: string; description?: string; state: string; web_url: string; labels?: string[] }>(`/projects/${id}/issues/${iid}`);
		return { title: i.title, description: i.description ?? '', state: i.state, url: i.web_url, labels: i.labels ?? [] };
	}

	async branches(project: string | number, search = ''): Promise<GitLabBranch[]> {
		const id = await this.projectId(project);
		const list = await this.request<{ name: string; protected?: boolean; commit?: { committed_date?: string } }[]>(`/projects/${id}/repository/branches?per_page=100${search ? `&search=${encodeURIComponent(search)}` : ''}`);
		return list.map(b => ({ name: b.name, protected: !!b.protected, commitDate: b.commit?.committed_date }));
	}

	async members(project: string | number, query = ''): Promise<GitLabUser[]> {
		const id = await this.projectId(project);
		const list = await this.request<{ id: number; username: string; name: string; state?: string }[]>(`/projects/${id}/members/all?per_page=50${query ? `&query=${encodeURIComponent(query)}` : ''}`);
		const me = await this.user().catch(() => undefined);
		return list.filter(u => u.state !== 'blocked' && u.id !== me?.id && !/bot$/i.test(u.username)).map(u => ({ id: u.id, username: u.username, name: u.name }));
	}

	async createMergeRequest(project: string | number, mr: NewMergeRequest): Promise<GitLabMrSummary> {
		const id = await this.projectId(project);
		const title = mr.draft && !/^draft:/i.test(mr.title) ? `Draft: ${mr.title}` : mr.title;
		const raw = await this.request<RawMr>(`/projects/${id}/merge_requests`, {
			method: 'POST',
			body: {
				source_branch: mr.sourceBranch,
				target_branch: mr.targetBranch,
				title,
				description: mr.description,
				remove_source_branch: mr.removeSourceBranch ?? true,
				...mr.reviewerIds?.length ? { reviewer_ids: mr.reviewerIds } : {},
				...mr.squash !== undefined ? { squash: mr.squash } : {},
			},
		});
		return mrSummary(raw);
	}

	/** Uploads a file to the project and returns the Markdown that shows it. */
	async upload(project: string | number, name: string, data: Uint8Array, type = 'application/octet-stream'): Promise<string> {
		const id = await this.projectId(project);
		const form = new FormData();
		form.append('file', new Blob([data], { type }), name);
		const result = await this.request<{ markdown: string }>(`/projects/${id}/uploads`, { method: 'POST', body: form, timeoutMs: 60_000 });
		return result.markdown;
	}

	async comment(project: string | number, iid: number, body: string): Promise<{ readonly id?: number }> {
		const id = await this.projectId(project);
		const note = await this.request<{ id?: number }>(`/projects/${id}/merge_requests/${iid}/notes`, { method: 'POST', body: { body } });
		return { ...note?.id ? { id: note.id } : {} };
	}

	async replyToDiscussion(project: string | number, iid: number, discussion: string, body: string): Promise<{ readonly id?: number }> {
		const id = await this.projectId(project);
		const note = await this.request<{ id?: number }>(`/projects/${id}/merge_requests/${iid}/discussions/${encodeURIComponent(discussion)}/notes`, { method: 'POST', body: { body } });
		return { ...note?.id ? { id: note.id } : {} };
	}

	async resolveDiscussion(project: string | number, iid: number, discussion: string, resolved = true): Promise<void> {
		const id = await this.projectId(project);
		await this.request(`/projects/${id}/merge_requests/${iid}/discussions/${encodeURIComponent(discussion)}?resolved=${resolved}`, { method: 'PUT' });
	}

	/** A comment on a line of the MR's new version; a general comment when the line isn't in the diff. */
	async commentOnLine(project: string | number, iid: number, path: string, line: number, body: string): Promise<'line' | 'general'> {
		const id = await this.projectId(project);
		const mr = await this.mr(id, iid, false);
		if (mr.diffRefs) {
			try {
				await this.request(`/projects/${id}/merge_requests/${iid}/discussions`, {
					method: 'POST',
					body: {
						body,
						position: { position_type: 'text', base_sha: mr.diffRefs.baseSha, start_sha: mr.diffRefs.startSha, head_sha: mr.diffRefs.headSha, new_path: path, old_path: path, new_line: line },
					},
				});
				return 'line';
			} catch {
				// The line isn't part of the diff; fall through to a general comment that names it.
			}
		}
		await this.comment(id, iid, `**${path}:${line}**\n\n${body}`);
		return 'general';
	}

	/** The merge request's approval rules as GitLab applies them to it, with who approved each. */
	async approvalState(project: string | number, iid: number): Promise<ApprovalRule[]> {
		const id = await this.projectId(project);
		const state = await this.request<{ rules?: { name?: string; rule_type?: string; approvals_required?: number; approved?: boolean; approved_by?: { username?: string }[]; eligible_approvers?: { username?: string }[] }[] }>(`/projects/${id}/merge_requests/${iid}/approval_state`);
		return (state?.rules ?? []).map(rule => ({
			name: rule.name || (rule.rule_type === 'code_owner' ? 'Code owners' : rule.rule_type === 'any_approver' ? 'Any eligible approver' : 'Approval rule'),
			required: rule.approvals_required ?? 0,
			approvedBy: (rule.approved_by ?? []).flatMap(u => u.username ? [u.username] : []),
			eligible: (rule.eligible_approvers ?? []).flatMap(u => u.username ? [u.username] : []),
			met: rule.approved ?? (rule.approved_by?.length ?? 0) >= (rule.approvals_required ?? 0),
		}));
	}

	/** The project's merge settings that gate a merge. */
	async mergeSettings(project: string | number): Promise<MergeSettings> {
		const id = await this.projectId(project);
		const p = await this.request<{ only_allow_merge_if_pipeline_succeeds?: boolean; only_allow_merge_if_all_discussions_are_resolved?: boolean; squash_option?: string; remove_source_branch_after_merge?: boolean }>(`/projects/${id}`);
		return {
			pipelineMustSucceed: !!p.only_allow_merge_if_pipeline_succeeds,
			threadsMustBeResolved: !!p.only_allow_merge_if_all_discussions_are_resolved,
			squash: p.squash_option === 'always' || p.squash_option === 'default_on',
			removeSourceBranch: p.remove_source_branch_after_merge !== false,
		};
	}

	/** Whether the merge request can be merged now, check by check, read live. */
	async mergeReadiness(project: string | number, iid: number): Promise<MergeReadiness> {
		const id = await this.projectId(project);
		const [raw, rules, settings, discussions] = await Promise.all([
			this.request<RawMr>(`/projects/${id}/merge_requests/${iid}`),
			this.approvalState(id, iid).catch(() => []),
			this.mergeSettings(id),
			this.discussions(id, iid).catch(() => []),
		]);
		return mergeReadiness(raw, rules, settings, discussions.filter(d => !d.resolved).length);
	}

	/** Merges the merge request at `sha`, the head the user saw; GitLab refuses if it moved. */
	async merge(project: string | number, iid: number, options: { readonly sha: string; readonly squash?: boolean; readonly removeSourceBranch?: boolean }): Promise<{ readonly sha?: string }> {
		const id = await this.projectId(project);
		const result = await this.request<{ merge_commit_sha?: string; sha?: string }>(`/projects/${id}/merge_requests/${iid}/merge`, {
			method: 'PUT',
			body: { sha: options.sha, ...options.squash === undefined ? {} : { squash: options.squash }, should_remove_source_branch: options.removeSourceBranch ?? true },
			timeoutMs: 30_000,
		});
		return { sha: result?.merge_commit_sha ?? result?.sha };
	}

	async approve(project: string | number, iid: number): Promise<void> {
		const id = await this.projectId(project);
		await this.request(`/projects/${id}/merge_requests/${iid}/approve`, { method: 'POST' });
	}

	/**
	 * Requests changes: GitLab 17.2 and later record it as the reviewer's
	 * state; older ones get the user's approval withdrawn and a note.
	 */
	async requestChanges(project: string | number, iid: number, summary: string): Promise<void> {
		const id = await this.projectId(project);
		const me = await this.user();
		await this.request(`/projects/${id}/merge_requests/${iid}/unapprove`, { method: 'POST' }).catch(() => undefined);
		try {
			await this.request(`/projects/${id}/merge_requests/${iid}/reviewers/${me.id}`, { method: 'PUT', body: { state: 'requested_changes' } });
		} catch {
			// Not supported here; the note below says it.
		}
		await this.comment(id, iid, summary.trim() || 'Requesting changes, see the comments above.');
	}
}

export interface ApprovalRule {
	readonly name: string;
	readonly required: number;
	readonly approvedBy: readonly string[];
	readonly eligible: readonly string[];
	readonly met: boolean;
}

export interface MergeSettings {
	readonly pipelineMustSucceed: boolean;
	readonly threadsMustBeResolved: boolean;
	readonly squash: boolean;
	readonly removeSourceBranch: boolean;
}

export interface MergeCheck {
	readonly name: string;
	readonly ok: boolean;
	/** Not met yet because GitLab is still at it: a pipeline running, a merge status still being worked out. */
	readonly pending?: boolean;
	readonly detail: string;
	/** Where the rule comes from, for the panel's small print. */
	readonly source: string;
}

export interface MergeReadiness {
	readonly ready: boolean;
	readonly checks: readonly MergeCheck[];
	/** The head commit the checks were read for; the merge names it so a later push can't slip in. */
	readonly sha: string;
	readonly squash: boolean;
	readonly removeSourceBranch: boolean;
}

/**
 * The merge checks from what GitLab reports: its own verdict first, then
 * each rule the project applies. GitLab enforces the same rules when the
 * merge is requested, so this decides what the button says, not what is allowed.
 */
export function mergeReadiness(mr: Pick<RawMr, 'state' | 'detailed_merge_status' | 'has_conflicts' | 'draft' | 'work_in_progress' | 'head_pipeline' | 'sha' | 'diff_refs'>, rules: readonly ApprovalRule[], settings: MergeSettings, unresolvedThreads: number): MergeReadiness {
	const checks: MergeCheck[] = [];
	const status = mr.detailed_merge_status ?? '';
	checks.push({ name: 'Open and not a draft', ok: mr.state === 'opened' && !(mr.draft ?? mr.work_in_progress), detail: mr.state !== 'opened' ? `the merge request is ${mr.state}` : (mr.draft ?? mr.work_in_progress) ? 'still a draft' : 'open', source: 'state, draft' });
	const pipeline = mr.head_pipeline?.status;
	const pipelineRunning = pipeline === 'running' || pipeline === 'pending' || pipeline === 'created';
	checks.push({
		name: settings.pipelineMustSucceed ? 'Pipeline must succeed' : 'Pipeline',
		ok: !settings.pipelineMustSucceed || pipeline === 'success' || pipeline === 'skipped',
		...settings.pipelineMustSucceed && pipelineRunning ? { pending: true } : {},
		detail: pipeline ? `head pipeline ${pipeline}` : 'no pipeline',
		source: settings.pipelineMustSucceed ? 'only_allow_merge_if_pipeline_succeeds' : 'head_pipeline.status',
	});
	for (const rule of rules) {
		checks.push({ name: `Approvals: ${rule.name}`, ok: rule.met, detail: `${rule.approvedBy.length} of ${rule.required}${rule.approvedBy.length ? ` (${rule.approvedBy.join(', ')})` : ''}${!rule.met && rule.eligible.length ? `; eligible: ${rule.eligible.slice(0, 6).join(', ')}` : ''}`, source: 'approval_state' });
	}
	if (!rules.length) {
		checks.push({ name: 'Approvals', ok: true, detail: 'no approval rules apply', source: 'approval_state' });
	}
	checks.push({ name: settings.threadsMustBeResolved ? 'All threads resolved' : 'Review threads', ok: !settings.threadsMustBeResolved || unresolvedThreads === 0, detail: unresolvedThreads ? `${unresolvedThreads} unresolved` : 'none open', source: settings.threadsMustBeResolved ? 'only_allow_merge_if_all_discussions_are_resolved' : 'discussions' });
	checks.push({ name: 'No conflicts with the target', ok: !mr.has_conflicts && status !== 'conflict', detail: mr.has_conflicts || status === 'conflict' ? 'conflicts' : 'clean', source: 'has_conflicts' });
	const gitlabSaysNo = status && status !== 'mergeable' && status !== 'ci_still_running' && status !== 'ci_must_pass';
	checks.push({ name: 'GitLab says mergeable', ok: status === 'mergeable', ...status === 'ci_still_running' || status === 'ci_must_pass' || status === 'checking' ? { pending: true } : {}, detail: status || 'unknown', source: 'detailed_merge_status' });
	const sha = mr.sha ?? mr.diff_refs?.head_sha ?? '';
	return {
		ready: checks.every(c => c.ok) && !gitlabSaysNo && !!sha,
		checks,
		sha,
		squash: settings.squash,
		removeSourceBranch: settings.removeSourceBranch,
	};
}

interface RawMr {
	readonly iid: number;
	readonly project_id: number;
	readonly title: string;
	readonly description?: string;
	readonly state?: string;
	readonly draft?: boolean;
	readonly work_in_progress?: boolean;
	readonly web_url: string;
	readonly source_branch: string;
	readonly target_branch: string;
	readonly author?: { readonly username?: string };
	readonly reviewers?: readonly { readonly username?: string }[];
	readonly updated_at?: string;
	readonly detailed_merge_status?: string;
	readonly has_conflicts?: boolean;
	readonly sha?: string;
	readonly references?: { readonly full?: string };
	readonly head_pipeline?: { readonly id: number; readonly status: string; readonly web_url?: string };
	readonly diff_refs?: { readonly base_sha: string; readonly head_sha: string; readonly start_sha: string };
	readonly changes_count?: string;
}

interface RawDiscussion {
	readonly id: string;
	readonly notes?: readonly {
		readonly id: number;
		readonly body?: string;
		readonly system?: boolean;
		readonly resolvable?: boolean;
		readonly resolved?: boolean;
		readonly created_at?: string;
		readonly author?: { readonly username?: string };
		readonly position?: { readonly new_path?: string; readonly new_line?: number };
	}[];
}

function mrSummary(raw: RawMr): GitLabMrSummary {
	const project = raw.references?.full?.replace(/!\d+$/, '') ?? raw.web_url.replace(/^https?:\/\/[^/]+\//, '').replace(/\/-\/merge_requests\/.*$/, '');
	return {
		projectId: raw.project_id,
		project,
		iid: raw.iid,
		title: raw.title,
		author: raw.author?.username ?? '',
		sourceBranch: raw.source_branch,
		targetBranch: raw.target_branch,
		draft: !!(raw.draft ?? raw.work_in_progress),
		url: raw.web_url,
		updatedAt: raw.updated_at ?? '',
		...raw.detailed_merge_status ? { mergeStatus: raw.detailed_merge_status } : {},
		reviewers: (raw.reviewers ?? []).flatMap(r => r.username ? [r.username] : []),
	};
}

function pipelineState(status: string): PipelineState {
	return (['success', 'failed', 'running', 'pending', 'canceled', 'skipped', 'manual', 'created'] as const).find(s => s === status) ?? (status === 'waiting_for_resource' || status === 'preparing' || status === 'scheduled' ? 'pending' : 'none');
}

export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*[A-Za-z]|\u001b\]8;;[^\u0007]*\u0007|section_(start|end):\d+:[\w.-]+\r?\u001b\[0K/g, '').replace(/\r(?!\n)/g, '\n');
}

/** An MR as text for the model: state, pipeline, approvals, open threads and the diff, cut to size. */
export function describeMr(mr: GitLabMr, discussions: readonly GitLabDiscussion[], diffs: readonly GitLabDiffFile[], failedJobs: readonly GitLabJob[] = []): string {
	const lines = [
		`!${mr.iid} ${mr.title} (${mr.url})`,
		`${mr.sourceBranch} → ${mr.targetBranch} · by ${mr.author}${mr.draft ? ' · draft' : ''} · ${mr.state}${mr.mergeStatus ? ` · ${mr.mergeStatus}` : ''}`,
		mr.pipeline ? `Pipeline: ${mr.pipeline.status}${failedJobs.length ? ` (failed: ${failedJobs.map(j => `${j.name} [job ${j.id}]`).join(', ')})` : ''}` : 'Pipeline: none',
		...mr.approvals ? [`Approvals: ${mr.approvals.given} of ${mr.approvals.required}`] : [],
		...mr.reviewers.length ? [`Reviewers: ${mr.reviewers.join(', ')}`] : [],
		'',
		'Description:',
		clip(mr.description.trim() || '(none)', 4000),
	];
	const open = discussions.filter(d => !d.resolved);
	if (open.length) {
		lines.push('', `Open threads (${open.length}):`);
		for (const d of open.slice(0, 20)) {
			const first = d.notes[0];
			lines.push(`- [discussion ${d.id}]${first.path ? ` ${first.path}${first.line ? `:${first.line}` : ''}` : ''}`);
			for (const note of d.notes) {
				lines.push(`  ${note.author}: ${clip(note.body.trim(), 800).replace(/\n/g, '\n  ')}`);
			}
		}
	}
	if (diffs.length) {
		lines.push('', `Changed files (${diffs.length}):`);
		let budget = 30_000;
		for (const file of diffs) {
			const header = `--- ${file.newFile ? '(new) ' : file.deletedFile ? '(deleted) ' : ''}${file.newPath}`;
			if (budget <= 0) {
				lines.push(header);
				continue;
			}
			const body = clip(file.diff, Math.min(budget, 6000));
			budget -= body.length;
			lines.push(header, body);
		}
	}
	return lines.join('\n');
}
