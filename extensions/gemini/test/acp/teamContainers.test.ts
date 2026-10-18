/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/acp/auditLog';
import { GitLabClient } from '../../src/acp/gitlab';
import { JiraClient } from '../../src/acp/jira';
import { ChildServer, ChildServerOptions, McpServerUnavailableError } from '../../src/acp/mcpStdio';
import { changedFiles } from '../../src/acp/checksBranch';
import { SnykCli } from '../../src/acp/snyk';
import { analyzeFiles, containerSpec, findDocker, FolderChildren, pinnedReference, teamImages } from '../../src/acp/teamContainers';
import type { TeamDefaults } from '../../src/acp/teamDefaults';
import { callTeamTool, TeamToolContext, teamWrite } from '../../src/acp/teamTools';
import type { FakeMcpScript } from '../fake-mcp/fakeMcpServer';

const fakeServer = path.join(import.meta.dirname, '..', 'fake-mcp', 'fakeMcpServer.ts');
const dirs: string[] = [];
const children: ChildServer[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
	children.splice(0).forEach(c => c.stop());
	servers.splice(0).forEach(s => s.close());
	await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-children-'));
	dirs.push(dir);
	return dir;
}

/** A child server running the fake MCP server with `script`, and a reader for the calls it received. */
async function child(name: string, script: FakeMcpScript, options: ChildServerOptions = {}) {
	const dir = await tempDir();
	const scriptPath = path.join(dir, 'script.json');
	const callsPath = path.join(dir, 'calls.jsonl');
	await fs.writeFile(scriptPath, JSON.stringify(script));
	const server = new ChildServer(name, { command: process.execPath, args: [fakeServer, scriptPath, callsPath], env: process.env }, { startTimeoutMs: 10_000, callTimeoutMs: 10_000, ...options });
	children.push(server);
	const calls = async () => (await fs.readFile(callsPath, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { name: string; arguments: Record<string, unknown> });
	return { server, calls };
}

/** A Jira that answers every request, recording it, so a fallback to the in-process connector shows. */
async function fakeJira() {
	const requests: string[] = [];
	const server = http.createServer((req, res) => {
		requests.push(`${req.method} ${req.url}`);
		req.resume();
		req.on('end', () => {
			res.writeHead(201, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ id: '5150' }));
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function context(options: { jira?: ChildServer; gitlab?: ChildServer; jiraSite?: string; defaults?: TeamDefaults; folder?: string; unavailable?: string[] }): Promise<TeamToolContext> {
	return {
		audit: new AuditLog(await tempDir()),
		connected: () => new Set(['jira', 'gitlab']),
		connectors: () => ({
			jira: new JiraClient({ site: options.jiraSite ?? 'http://127.0.0.1:9', email: 'me@acme.com', token: 't' }),
			gitlab: new GitLabClient({ url: 'https://gitlab.acme.internal', token: 't' }),
		}),
		folder: () => options.folder,
		defaults: async () => options.defaults ?? {},
		children: () => ({ ...options.jira ? { jira: options.jira } : {}, ...options.gitlab ? { gitlab: options.gitlab } : {} }),
		childUnavailable: (server, reason) => options.unavailable?.push(`${server}: ${reason}`),
	};
}

describe('the team\'s servers as children', () => {
	it('starts a server on its first call, and again after it stops', async () => {
		const { server, calls } = await child('jira', { tools: { jira_get_issue: { json: { key: 'ACME-412' } }, jira_add_comment: { json: { id: '1' } } }, exitDuring: 'jira_add_comment' });
		expect(await calls()).toEqual([]);
		const first = await server.call('jira_get_issue', { issue_key: 'ACME-412' });
		const during = await server.call('jira_add_comment', { issue_key: 'ACME-412', body: 'x' }).catch((err: Error) => err);
		const again = await server.call('jira_get_issue', { issue_key: 'ACME-413' });
		expect({
			first: first.content,
			// Stopping during a call is not "unavailable": the call may have happened, so nothing retries it another way.
			during: [during instanceof McpServerUnavailableError, /stopped during jira_add_comment/.test(String(during))],
			again: again.content,
			calls: (await calls()).map(c => `${c.name} ${c.arguments.issue_key}`),
		}).toEqual({
			first: [{ type: 'text', text: '{"key":"ACME-412"}' }],
			during: [false, true],
			again: [{ type: 'text', text: '{"key":"ACME-412"}' }],
			calls: ['jira_get_issue ACME-412', 'jira_add_comment ACME-412', 'jira_get_issue ACME-413'],
		});
	});

	it('waits for every call to end before stopping an idle server', async () => {
		const { server } = await child('snyk', { tools: { snyk_sca_scan: { text: 'No vulnerable paths found.', delayMs: 300 }, snyk_version: { text: '1.1300.0' } } }, { idleMs: 50 });
		const scan = server.call('snyk_sca_scan', { path: '/work' });
		await server.call('snyk_version', {});
		expect((await scan).content).toEqual([{ type: 'text', text: 'No vulnerable paths found.' }]);
	});

	it('moves a ticket through mcp-atlassian with the same audit record as the in-process connector', async () => {
		const { server, calls } = await child('jira', {
			tools: {
				jira_get_transitions: { json: [{ id: '21', name: 'Start', to_status: 'In Progress' }, { id: '31', name: 'Submit for review', to_status: 'In Review' }] },
				jira_transition_issue: { json: { message: 'Issue ACME-412 transitioned successfully' } },
				jira_add_comment: { json: { id: '77104' } },
			},
		});
		const ctx = await context({ jira: server, defaults: { jira: { commentVisibility: 'Developers' } } });
		const result = await teamWrite(ctx, { caller: 'ui', folder: '/work/acme-checkout' }, 'jira_transition', { key: 'ACME-412', to: 'In Review', comment: 'Ready.' });
		expect({ result, calls: await calls() }).toEqual({
			result: { ok: true, text: 'Moved ACME-412 to In Review with the comment.', remote: 'transition 31 → In Review · comment 77104' },
			calls: [
				{ name: 'jira_get_transitions', arguments: { issue_key: 'ACME-412' } },
				// The team's visibility applies, so the move goes alone and the comment after it.
				{ name: 'jira_transition_issue', arguments: { issue_key: 'ACME-412', transition_id: '31' } },
				{ name: 'jira_add_comment', arguments: { issue_key: 'ACME-412', body: 'Ready.', visibility: '{"type":"role","value":"Developers"}' } },
			],
		});
	});

	it('goes through the in-process connector when the container can\'t start, and says so', async () => {
		const jira = await fakeJira();
		const { server } = await child('jira', { exitCode: 125, tools: {} });
		const unavailable: string[] = [];
		const ctx = await context({ jira: server, jiraSite: jira.url, unavailable });
		const result = await callTeamTool(ctx, 'agent-1', 'jira_comment', { key: 'ACME-412', text: 'Looked at it.' });
		expect({ isError: result.isError, requests: jira.requests, unavailable: unavailable.map(u => u.replace(/:.*/, '')) }).toEqual({ isError: undefined, requests: ['POST /rest/api/3/issue/ACME-412/comment'], unavailable: ['jira'] });
	});

	it('opens a merge request through gitlab-mcp for the folder\'s project and branch', async () => {
		const folder = await tempDir();
		const git = (...args: string[]) => execFileSync('git', ['-C', folder, '-c', 'user.name=T', '-c', 'user.email=t@e', ...args]);
		git('init', '--quiet', '-b', 'feature/gift-cap');
		git('commit', '--quiet', '--allow-empty', '-m', 'start');
		git('remote', 'add', 'origin', 'https://gitlab.acme.internal/shop/checkout.git');
		const { server, calls } = await child('gitlab', { tools: { create_merge_request: { json: { iid: 12, web_url: 'https://gitlab.acme.internal/shop/checkout/-/merge_requests/12' } } } });
		const ctx = await context({ gitlab: server, folder });
		const result = await teamWrite(ctx, { caller: 'ui', folder }, 'gitlab_create_mr', { title: 'Cap the gift message', description: 'ACME-412', reviewers: [7] });
		expect({ result, calls: await calls() }).toEqual({
			result: { ok: true, text: 'Opened !12: https://gitlab.acme.internal/shop/checkout/-/merge_requests/12', remote: '!12', data: { iid: 12, url: 'https://gitlab.acme.internal/shop/checkout/-/merge_requests/12' } },
			calls: [{ name: 'create_merge_request', arguments: { project_id: 'shop/checkout', title: 'Cap the gift message', description: 'ACME-412', source_branch: 'feature/gift-cap', target_branch: 'main', remove_source_branch: true, reviewer_ids: [7] } }],
		});
	});

	it('runs the pinned image with the token only in the container\'s environment', () => {
		const spec = containerSpec('/opt/docker/bin/docker', teamImages.jira, { JIRA_URL: 'https://acme.atlassian.net', JIRA_API_TOKEN: 'secret-token' }, { PATH: '/usr/bin', HOME: '/Users/me' });
		expect({ spec, docker: findDocker(file => file === '/opt/homebrew/bin/docker') }).toEqual({
			spec: {
				command: '/opt/docker/bin/docker',
				args: ['run', '-i', '--rm', '-e', 'JIRA_URL', '-e', 'JIRA_API_TOKEN', pinnedReference(teamImages.jira)],
				// Docker's folder leads the PATH, for its credential helper.
				env: { PATH: '/opt/docker/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin', HOME: '/Users/me', DOCKER_HOST: undefined, DOCKER_CONFIG: undefined, JIRA_URL: 'https://acme.atlassian.net', JIRA_API_TOKEN: 'secret-token' },
			},
			docker: '/opt/homebrew/bin/docker',
		});
		expect(pinnedReference(teamImages.gitlab)).toMatch(/^zereight050\/gitlab-mcp:2\.3\.3@sha256:[0-9a-f]{64}$/);
	});

	it('analyses a branch\'s changed files on this Mac, by path in the mounted folder, skipping what it can\'t read', async () => {
		const repo = await tempDir();
		const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@e', ...args]);
		git('init', '--quiet', '-b', 'main');
		await fs.mkdir(path.join(repo, 'web', 'src'), { recursive: true });
		await fs.writeFile(path.join(repo, 'web', 'src', 'old.ts'), 'export const a = 1;\n');
		await fs.writeFile(path.join(repo, 'web', 'src', 'gone.ts'), 'export const b = 1;\n');
		git('add', '.');
		git('commit', '--quiet', '-m', 'base');
		git('checkout', '--quiet', '-b', 'feature/cap');
		await fs.writeFile(path.join(repo, 'web', 'src', 'cart.ts'), 'const unused = 1;\nexport const cap = 200;\n');
		git('add', '.');
		git('commit', '--quiet', '-m', 'cap');
		await fs.writeFile(path.join(repo, 'web', 'src', 'old.ts'), 'export const a = 2;\n');
		await fs.writeFile(path.join(repo, 'web', 'logo.png'), 'png');
		await fs.rm(path.join(repo, 'web', 'src', 'gone.ts'));
		// An agent working in the repository's web/ folder: paths are relative to it, as the mount is.
		const files = await changedFiles(path.join(repo, 'web'), 'main');
		const { server, calls } = await child('sonar', { tools: { analyze_code_snippet: { json: { issues: [{ ruleKey: 'typescript:S1481', primaryMessage: 'Remove the unused local variable "unused".', severity: 'MINOR', textRange: { startLine: 1, endLine: 1 } }], issueCount: 1 } } } });
		const found = await analyzeFiles(server, 'shop-checkout', files);
		expect({ files, found, calls: (await calls()).map(c => c.arguments) }).toEqual({
			files: ['logo.png', 'src/cart.ts', 'src/old.ts'],
			found: {
				issues: [
					{ rule: 'typescript:S1481', message: 'Remove the unused local variable "unused".', severity: 'MINOR', line: 1, file: 'src/cart.ts' },
					{ rule: 'typescript:S1481', message: 'Remove the unused local variable "unused".', severity: 'MINOR', line: 1, file: 'src/old.ts' },
				],
				analysed: ['src/cart.ts', 'src/old.ts'],
				skipped: ['logo.png'],
				failed: [],
			},
			calls: [{ projectKey: 'shop-checkout', filePath: 'src/cart.ts' }, { projectKey: 'shop-checkout', filePath: 'src/old.ts' }],
		});
	});

	it('tests code through Snyk\'s own server for the folder, and through the CLI when the server fails', async () => {
		const folder = await tempDir();
		const { server, calls } = await child('snyk', { tools: { snyk_code_scan: { text: 'Found 1 issue: Path Traversal in src/files.ts:12' } } });
		const { server: broken } = await child('snyk', { exitCode: 1, tools: {} });
		const cli = new SnykCli('snyk', async () => ({ code: 0, stdout: JSON.stringify({ runs: [{ results: [] }] }), stderr: '' }));
		const ctx = (snyk: typeof server): TeamToolContext => ({
			connected: () => new Set(['snyk']),
			connectors: () => ({ snyk: cli }),
			folder: () => folder,
			defaults: async () => ({}),
			children: () => ({ snyk: new FolderChildren(() => snyk) }),
		});
		const viaServer = await callTeamTool(ctx(server), 'agent-1', 'snyk_code_test', {});
		const viaCli = await callTeamTool(ctx(broken), 'agent-1', 'snyk_code_test', {});
		expect({
			viaServer: viaServer.content,
			calls: await calls(),
			viaCli: viaCli.content.map(c => c.type === 'text' ? c.text.split('\n')[0] : ''),
		}).toEqual({
			viaServer: [{ type: 'text', text: `<external source="snyk" ref="${folder}">\nFound 1 issue: Path Traversal in src/files.ts:12\n</external>` }],
			calls: [{ name: 'snyk_code_scan', arguments: { path: folder } }],
			viaCli: ['Snyk Code (source): no issues found.'],
		});
	});
});

