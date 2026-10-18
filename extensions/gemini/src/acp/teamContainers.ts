/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The team's own Jira and GitLab MCP servers (mcp-atlassian and gitlab-mcp, which a repository's
// .gemini/settings.json may run as servers of the CLI) run instead as children of geminicode-tools
// once the user takes them over in Connections (gemini/docs/AGENTIC-PLAN.md, section 3, and
// adr/0004). Each image is pinned by digest, the token reaches only the container's environment
// (Docker gets the variable's name, not its value), and each container lists only the tools the
// adapter calls, so the agent still sees geminicode-tools' own curated tools and nothing else.
//
// The adapter keeps its own logic (resolving a merge request, the merge readiness check, picking a
// transition); the containers make the calls that map one to one. What has no counterpart stays
// on the in-process connectors: a merge request's summary with its threads, diffs and failed jobs,
// job logs, the lists of merge requests and assignable people, comments on a line, and requesting
// changes.

import { existsSync } from 'node:fs';
import { ChildServer, StdioServerSpec } from './mcpStdio';

/** An image the adapter runs, pinned by digest, with the tag it was read from. */
export interface PinnedImage {
	readonly image: string;
	readonly tag: string;
	readonly digest: string;
}

/** Read from the registries on 18 Oct 2026, at the versions the team's settings file was measured with. */
export const teamImages = {
	jira: { image: 'ghcr.io/sooperset/mcp-atlassian', tag: '0.23.1', digest: 'sha256:5b7c9b64d4eb3210cab74be8bf3e6aeea9ed14f3042dc59ba5c5287bd4dbe466' },
	gitlab: { image: 'zereight050/gitlab-mcp', tag: '2.3.3', digest: 'sha256:0b4acfbe69e5021833bc47a0dd24ba6280502f7ff200f52f3b45d18b06516cb2' },
} as const satisfies Record<string, PinnedImage>;

/** The containers' tools the adapter calls; each container is started with only these. */
export const jiraContainerTools = ['jira_get_issue', 'jira_search', 'jira_get_transitions', 'jira_transition_issue', 'jira_add_comment', 'jira_add_worklog', 'jira_assign_issue'] as const;
export const gitlabContainerTools = ['get_issue', 'create_merge_request', 'create_merge_request_note', 'create_merge_request_discussion_note', 'resolve_merge_request_thread', 'merge_merge_request', 'approve_merge_request'] as const;

/** The image reference Docker runs: `<image>:<tag>@<digest>`, so a moved tag changes nothing. */
export function pinnedReference(pin: PinnedImage): string {
	return `${pin.image}:${pin.tag}@${pin.digest}`;
}

/** Where Docker's command line is on a Mac, since an app started from the Dock has a short PATH. */
export function findDocker(exists: (file: string) => boolean = existsSync): string | undefined {
	return ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'].find(exists);
}

/**
 * `docker run` for `pin` with `env` in the child's environment only: the arguments name each
 * variable (`-e NAME`), so the values are in no process list.
 */
export function containerSpec(docker: string, pin: PinnedImage, env: Readonly<Record<string, string>>, base: NodeJS.ProcessEnv = process.env): StdioServerSpec {
	return {
		command: docker,
		args: ['run', '-i', '--rm', ...Object.keys(env).flatMap(name => ['-e', name]), pinnedReference(pin)],
		env: { PATH: base.PATH, HOME: base.HOME, DOCKER_HOST: base.DOCKER_HOST, DOCKER_CONFIG: base.DOCKER_CONFIG, ...env },
	};
}

export function jiraContainer(docker: string, account: { readonly site: string; readonly email: string; readonly token: string }): ChildServer {
	return new ChildServer('jira', containerSpec(docker, teamImages.jira, {
		JIRA_URL: account.site,
		JIRA_USERNAME: account.email,
		JIRA_API_TOKEN: account.token,
		ENABLED_TOOLS: jiraContainerTools.join(','),
	}));
}

export function gitlabContainer(docker: string, account: { readonly url: string; readonly token: string }): ChildServer {
	return new ChildServer('gitlab', containerSpec(docker, teamImages.gitlab, {
		GITLAB_API_URL: `${account.url.replace(/\/+$/, '')}/api/v4`,
		GITLAB_PERSONAL_ACCESS_TOKEN: account.token,
		GITLAB_TOOLS: gitlabContainerTools.join(','),
	}));
}

/** The children running for the connected tools, when the user took the team's servers over. */
export interface TeamChildren {
	readonly jira?: ChildServer;
	readonly gitlab?: ChildServer;
}

/** Calls a container's tool and returns its text, or throws with the server's own message when it reports an error. */
async function callText(server: ChildServer, tool: string, args: Record<string, unknown>): Promise<string> {
	const result = await server.call(tool, args);
	const text = result.content.map(c => c.type === 'text' ? c.text : '').join('\n').trim();
	if (result.isError) {
		throw new Error(text || `${tool} failed.`);
	}
	return text;
}

async function callJson(server: ChildServer, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const text = await callText(server, tool, args);
	try {
		const value = JSON.parse(text) as unknown;
		return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : { value };
	} catch {
		return { text };
	}
}

function idOf(value: Record<string, unknown>): string | undefined {
	return typeof value.id === 'string' || typeof value.id === 'number' ? String(value.id) : undefined;
}

/** The Jira calls the adapter makes through mcp-atlassian. */
export const jiraVia = {
	issue: (server: ChildServer, key: string) => callText(server, 'jira_get_issue', { issue_key: key, comment_limit: 5 }),
	search: (server: ChildServer, jql: string, max: number) => callText(server, 'jira_search', { jql, limit: Math.min(Math.max(max, 1), 50) }),
	async comment(server: ChildServer, key: string, body: string, visibility?: string): Promise<string | undefined> {
		return idOf(await callJson(server, 'jira_add_comment', { issue_key: key, body, ...visibility ? { visibility: JSON.stringify({ type: 'role', value: visibility }) } : {} }));
	},
	async logWork(server: ChildServer, key: string, spent: string, comment?: string, started?: Date): Promise<string | undefined> {
		return idOf(await callJson(server, 'jira_add_worklog', { issue_key: key, time_spent: spent, ...comment ? { comment } : {}, ...started ? { started: started.toISOString() } : {} }));
	},
	async transitions(server: ChildServer, key: string): Promise<{ id: string; name: string; to: string }[]> {
		const list = JSON.parse(await callText(server, 'jira_get_transitions', { issue_key: key })) as { id?: unknown; name?: unknown; to_status?: unknown; to?: unknown }[];
		return (Array.isArray(list) ? list : []).map(t => ({ id: String(t.id ?? ''), name: String(t.name ?? ''), to: String(t.to_status ?? t.to ?? t.name ?? '') }));
	},
	async transition(server: ChildServer, key: string, transitionId: string, comment?: string, fields?: Readonly<Record<string, string>>): Promise<void> {
		await callText(server, 'jira_transition_issue', { issue_key: key, transition_id: transitionId, ...comment ? { comment } : {}, ...fields && Object.keys(fields).length ? { fields: JSON.stringify(fields) } : {} });
	},
	async assign(server: ChildServer, key: string, assignee: string | null): Promise<void> {
		await callText(server, 'jira_assign_issue', { issue_key: key, assignee: assignee ?? '' });
	},
};

/** The GitLab calls the adapter makes through gitlab-mcp. */
export const gitlabVia = {
	issue: (server: ChildServer, project: string, iid: number) => callText(server, 'get_issue', { project_id: project, issue_iid: String(iid) }),
	async createMergeRequest(server: ChildServer, project: string, mr: { sourceBranch: string; targetBranch: string; title: string; description: string; draft?: boolean; removeSourceBranch?: boolean; reviewerIds?: readonly number[] }): Promise<{ iid: number; url: string }> {
		const made = await callJson(server, 'create_merge_request', {
			project_id: project, title: mr.title, description: mr.description, source_branch: mr.sourceBranch, target_branch: mr.targetBranch,
			...mr.draft ? { draft: true } : {}, remove_source_branch: mr.removeSourceBranch ?? true, ...mr.reviewerIds?.length ? { reviewer_ids: mr.reviewerIds } : {},
		});
		return { iid: Number(made.iid), url: String(made.web_url ?? '') };
	},
	async comment(server: ChildServer, project: string, iid: number, body: string): Promise<string | undefined> {
		return idOf(await callJson(server, 'create_merge_request_note', { project_id: project, merge_request_iid: String(iid), body }));
	},
	async reply(server: ChildServer, project: string, iid: number, discussion: string, body: string): Promise<string | undefined> {
		return idOf(await callJson(server, 'create_merge_request_discussion_note', { project_id: project, merge_request_iid: String(iid), discussion_id: discussion, body }));
	},
	async resolve(server: ChildServer, project: string, iid: number, discussion: string): Promise<void> {
		await callText(server, 'resolve_merge_request_thread', { project_id: project, merge_request_iid: String(iid), discussion_id: discussion, resolved: true });
	},
	async merge(server: ChildServer, project: string, iid: number, options: { sha: string; squash?: boolean; removeSourceBranch: boolean }): Promise<{ sha?: string }> {
		const merged = await callJson(server, 'merge_merge_request', {
			project_id: project, merge_request_iid: String(iid), sha: options.sha, should_remove_source_branch: options.removeSourceBranch,
			...options.squash === undefined ? {} : { squash: options.squash },
		});
		return typeof merged.merge_commit_sha === 'string' ? { sha: merged.merge_commit_sha } : {};
	},
	async approve(server: ChildServer, project: string, iid: number): Promise<void> {
		await callText(server, 'approve_merge_request', { project_id: project, merge_request_iid: String(iid) });
	},
};
