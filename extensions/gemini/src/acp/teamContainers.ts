/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The team's own Jira and GitLab MCP servers (mcp-atlassian and gitlab-mcp, which a repository's
// .gemini/settings.json may run as servers of the CLI) run instead as children of geminicode-tools
// once the user takes them over in Connections (gemini/docs/adr/0004-one-tool-adapter.md). Each image is pinned by digest, the token reaches only the container's environment
// (Docker gets the variable's name, not its value), and each container lists only the tools the
// adapter calls, so the agent still sees geminicode-tools' own curated tools and nothing else.
// Tokens go to the container on its input, read by a shell before the server starts: `docker inspect`
// prints a container's environment (an `--env-file`'s values included), and the agent's shell can run it.
//
// SonarSource's SonarQube server (in Docker, the folder mounted read-only) and Snyk's own server
// (`snyk mcp`, from the user's Snyk CLI) run the same way, one per folder.
//
// The adapter keeps its own logic (resolving a merge request, the merge readiness check, picking a
// transition); the containers make the calls that map one to one. What has no counterpart stays
// on the in-process connectors: a merge request's summary with its threads, diffs and failed jobs,
// job logs, the lists of merge requests and assignable people, comments on a line, and requesting
// changes.

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { proxyVariables } from './env';
import { ChildServer, McpServerUnavailableError, StdioServerSpec } from './mcpStdio';

/** An image the adapter runs, pinned by digest, with the tag it was read from. */
export interface PinnedImage {
	readonly image: string;
	readonly tag: string;
	readonly digest: string;
	/** The image's own entrypoint, which the shell that reads the tokens hands over to. Read from the image's config at this digest; each image has /bin/sh. */
	readonly entrypoint: readonly string[];
}

/** Read from the registries on 18 Oct 2026, at the versions the team's settings file was measured with. */
export const teamImages = {
	jira: { image: 'ghcr.io/sooperset/mcp-atlassian', tag: '0.23.1', digest: 'sha256:5b7c9b64d4eb3210cab74be8bf3e6aeea9ed14f3042dc59ba5c5287bd4dbe466', entrypoint: ['mcp-atlassian'] },
	gitlab: { image: 'zereight050/gitlab-mcp', tag: '2.3.3', digest: 'sha256:0b4acfbe69e5021833bc47a0dd24ba6280502f7ff200f52f3b45d18b06516cb2', entrypoint: ['node', 'build/index.js'] },
	/** SonarSource's own server, the newest release on 18 Oct 2026; it needs SonarQube Server 2025.1 or later. */
	sonar: { image: 'sonarsource/sonarqube-mcp', tag: '2026.5.0', digest: 'sha256:21bb7bf785a8c9cbe19553f6957d83ef45138926bbb15ca9e1fc4895e5026b6f', entrypoint: ['/usr/local/bin/docker-entrypoint'] },
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
 * The proxy variables `base` sets, for a container: the same proxy the agent uses, with a proxy
 * on this Mac addressed as Docker Desktop's name for it, since the container's own localhost is
 * the container.
 */
export function containerProxyEnv(base: NodeJS.ProcessEnv): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of proxyVariables) {
		const value = base[name];
		if (value) {
			env[name] = name.toLowerCase() === 'no_proxy' ? value : value.replace(/^(\w+:\/\/(?:[^@/]*@)?)(?:localhost|127\.0\.0\.1)(?=[:/]|$)/i, '$1host.docker.internal');
		}
	}
	return env;
}

/**
 * `docker run` for `pin`, with `env` and the proxy variables of `base` in the child's environment only: the arguments name each
 * variable (`-e NAME`), so the values are in no process list. `secrets` never reach Docker's
 * environment or the container's settings, where `docker inspect` would show them: the container
 * starts a shell that reads them from its input, one a line, exports them and runs the image's
 * own entrypoint, which then reads MCP messages from the same input.
 */
export function containerSpec(docker: string, pin: PinnedImage, env: Readonly<Record<string, string>>, base: NodeJS.ProcessEnv = process.env, mounts: readonly string[] = [], secrets: Readonly<Record<string, string>> = {}): StdioServerSpec {
	const passed = { ...containerProxyEnv(base), ...env };
	const names = Object.keys(secrets);
	const reader = names.length
		? ['--entrypoint', '/bin/sh', pinnedReference(pin), '-c', [...names.map((_, i) => `IFS= read -r v${i}`), `export ${names.map((name, i) => `${name}="$v${i}"`).join(' ')}`, 'exec "$@"'].join(' && '), 'sh', ...pin.entrypoint]
		: [pinnedReference(pin)];
	return {
		command: docker,
		args: ['run', '-i', '--rm', ...mounts.flatMap(mount => ['-v', mount]), ...Object.keys(passed).flatMap(name => ['-e', name]), ...reader],
		// Docker's folders lead the PATH: it runs its credential helper (docker-credential-desktop) from
		// there, even for a public image, and an app opened from the Dock has a short PATH.
		env: { PATH: [...dockerFolders(docker), base.PATH].filter(Boolean).join(path.delimiter), HOME: base.HOME, DOCKER_HOST: base.DOCKER_HOST, DOCKER_CONFIG: base.DOCKER_CONFIG, ...passed },
		...names.length ? { stdin: names.map(name => `${secrets[name].replace(/[\r\n]/g, '')}\n`).join('') } : {},
	};
}

/** Docker Desktop's own bin folder, where /usr/local/bin/docker links to and its credential helper lives. */
const dockerDesktopBin = '/Applications/Docker.app/Contents/Resources/bin';

/** The folder of `docker`, and Docker Desktop's bin folder. */
function dockerFolders(docker: string): string[] {
	return [...new Set([path.dirname(docker), dockerDesktopBin])];
}

export function jiraContainer(docker: string, account: { readonly site: string; readonly email: string; readonly token: string }): ChildServer {
	return new ChildServer('jira', containerSpec(docker, teamImages.jira, {
		JIRA_URL: account.site,
		JIRA_USERNAME: account.email,
		ENABLED_TOOLS: jiraContainerTools.join(','),
	}, process.env, [], { JIRA_API_TOKEN: account.token }));
}

export function gitlabContainer(docker: string, account: { readonly url: string; readonly token: string }): ChildServer {
	return new ChildServer('gitlab', containerSpec(docker, teamImages.gitlab, {
		GITLAB_API_URL: `${account.url.replace(/\/+$/, '')}/api/v4`,
		GITLAB_TOOLS: gitlabContainerTools.join(','),
	}, process.env, [], { GITLAB_PERSONAL_ACCESS_TOKEN: account.token }));
}

/** The toolsets the SonarQube server lists; analysis reads the mounted folder, so no file's text passes through a message. */
const sonarToolsets = 'analysis,issues,quality-gates,security-hotspots,projects';

/** The folder a SonarQube server analyses is mounted read-only where the server looks for it. */
export function sonarContainer(docker: string, account: { readonly url: string; readonly token: string }, folder: string): ChildServer {
	return new ChildServer('sonar', containerSpec(docker, teamImages.sonar, {
		SONARQUBE_URL: account.url,
		SONARQUBE_TOOLSETS: sonarToolsets,
	}, process.env, [`${folder}:/app/mcp-workspace:ro`], { SONARQUBE_TOKEN: account.token }));
}

/**
 * Snyk's own server, `snyk mcp -t stdio`, from the user's Snyk CLI and with its sign-in. It runs
 * one per folder and trusts only that folder (`TRUSTED_FOLDERS`), the folder the in-process CLI
 * would test anyway; the user opened it in GeminiCode.
 */
export function snykServer(cli: string, folder: string, base: NodeJS.ProcessEnv = process.env): ChildServer {
	return new ChildServer('snyk', { command: cli, args: ['mcp', '-t', 'stdio'], env: { ...base, TRUSTED_FOLDERS: folder } }, { callTimeoutMs: 10 * 60_000 });
}

/** One child per folder, set up on first use; `stop` ends them all. */
export class FolderChildren {

	private readonly byFolder = new Map<string, ChildServer>();

	constructor(private readonly create: (folder: string) => ChildServer) { }

	for(folder: string): ChildServer {
		let server = this.byFolder.get(folder);
		if (!server) {
			server = this.create(folder);
			this.byFolder.set(folder, server);
		}
		return server;
	}

	stop(): void {
		for (const server of this.byFolder.values()) {
			server.stop();
		}
		this.byFolder.clear();
	}
}

/** The children running for the connected tools, when the user turned the tools' own servers on. */
export interface TeamChildren {
	readonly jira?: ChildServer;
	readonly gitlab?: ChildServer;
	readonly sonar?: FolderChildren;
	readonly snyk?: FolderChildren;
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

/** What SonarQube's checks of a branch or merge request ask for. */
export interface SonarScope {
	readonly project: string;
	readonly branch?: string;
	readonly mergeRequest?: string;
}

function sonarScope(scope: SonarScope): Record<string, string> {
	return scope.mergeRequest ? { pullRequest: scope.mergeRequest } : scope.branch ? { branch: scope.branch } : {};
}

/** One issue SonarQube's analysers found in a file on this Mac. */
export interface LocalSonarIssue {
	readonly rule: string;
	readonly message: string;
	readonly severity: string;
	readonly line?: number;
}

/** The SonarQube calls the adapter makes through SonarSource's server. */
export const sonarVia = {
	gate: (server: ChildServer, scope: SonarScope) => callText(server, 'get_project_quality_gate_status', { projectKey: scope.project, ...sonarScope(scope) }),
	issues: (server: ChildServer, scope: SonarScope, max = 50) => callText(server, 'search_sonar_issues_in_projects', { projectKeys: [scope.project], ...sonarScope(scope), issueStatuses: ['OPEN', 'CONFIRMED'], pageSize: max }),
	hotspots: (server: ChildServer, scope: SonarScope) => callText(server, 'search_security_hotspots', { projectKey: scope.project, ...sonarScope(scope), status: 'TO_REVIEW', pageSize: 50 }),
	/** Analyses one file of the mounted folder, by its path in the folder; the file's text never leaves the container. */
	async analyze(server: ChildServer, project: string, file: string): Promise<LocalSonarIssue[]> {
		const found = await callJson(server, 'analyze_code_snippet', { projectKey: project, filePath: file, ...isTestFile(file) ? { scope: 'TEST' } : {} });
		const issues = Array.isArray(found.issues) ? found.issues as { ruleKey?: unknown; primaryMessage?: unknown; severity?: unknown; textRange?: { startLine?: unknown } }[] : [];
		return issues.map(issue => ({
			rule: String(issue.ruleKey ?? ''),
			message: String(issue.primaryMessage ?? ''),
			severity: String(issue.severity ?? 'MINOR'),
			...typeof issue.textRange?.startLine === 'number' ? { line: issue.textRange.startLine } : {},
		}));
	},
};

/** The files SonarQube's local analysers read, by extension (its server's list of languages). */
export function isSonarAnalysable(file: string): boolean {
	return /\.(java|kt|kts|py|rb|go|js|jsx|mjs|cjs|ts|tsx|mts|cts|php|jsp|html|css|scss|less|xml|tf|ya?ml|json)$|(^|\/)Dockerfile$/.test(file);
}

function isTestFile(file: string): boolean {
	return /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|Test\.(java|kt)$/.test(file);
}

/** The Snyk calls the adapter makes through Snyk's own server. */
export const snykVia = {
	code: (server: ChildServer, folder: string) => callText(server, 'snyk_code_scan', { path: folder }),
	dependencies: (server: ChildServer, folder: string) => callText(server, 'snyk_sca_scan', { path: folder, all_projects: true }),
};

/** The most files one local analysis reads, so Checks finishes in a minute or two. */
export const localAnalysisMaxFiles = 25;

/**
 * SonarQube's analysis of `files` (paths in the folder `server` has mounted), one file at a time:
 * each file's issues, the files it skipped (a language the analysers don't read, or over the limit)
 * and the files the server couldn't analyse, with why.
 */
export async function analyzeFiles(server: ChildServer, project: string, files: readonly string[]): Promise<{ issues: (LocalSonarIssue & { file: string })[]; analysed: string[]; skipped: string[]; failed: { file: string; reason: string }[] }> {
	const wanted = files.filter(isSonarAnalysable);
	const analysed = wanted.slice(0, localAnalysisMaxFiles);
	const issues: (LocalSonarIssue & { file: string })[] = [];
	const failed: { file: string; reason: string }[] = [];
	for (const file of analysed) {
		try {
			issues.push(...(await sonarVia.analyze(server, project, file)).map(issue => ({ ...issue, file })));
		} catch (err) {
			if (err instanceof McpServerUnavailableError) {
				throw err;
			}
			failed.push({ file, reason: err instanceof Error ? err.message : String(err) });
		}
	}
	return { issues, analysed: analysed.filter(f => !failed.some(x => x.file === f)), skipped: [...files.filter(f => !isSonarAnalysable(f)), ...wanted.slice(localAnalysisMaxFiles)], failed };
}
