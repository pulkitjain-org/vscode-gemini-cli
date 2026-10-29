/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Picks benchmark tasks from closed Jira tickets whose merge request merged.
// Reads Jira Cloud (REST v3) and GitLab (REST v4) with the tokens given, and
// writes one task file per ticket into gemini/bench/tasks. See README.md.
//
//   node --experimental-transform-types gemini/bench/select.mts --jira <site> --jira-email <email> --jira-token <token>
//     --gitlab <url> --gitlab-token <token> --jql '<jql>' --grader '<command>' [--max 30] [--min-lines 20] [--max-lines 400]

import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
	options: {
		jira: { type: 'string' }, 'jira-email': { type: 'string' }, 'jira-token': { type: 'string' },
		gitlab: { type: 'string' }, 'gitlab-token': { type: 'string' },
		jql: { type: 'string' }, grader: { type: 'string' },
		max: { type: 'string', default: '30' }, 'min-lines': { type: 'string', default: '20' }, 'max-lines': { type: 'string', default: '400' },
		out: { type: 'string', default: path.join(import.meta.dirname, 'tasks') },
	},
});
for (const name of ['jira', 'jira-email', 'jira-token', 'gitlab', 'gitlab-token', 'jql', 'grader'] as const) {
	if (!args[name]) {
		console.error(`--${name} is needed.`);
		process.exit(2);
	}
}
const jira = args.jira!.replace(/\/+$/, '');
const gitlab = args.gitlab!.replace(/\/+$/, '');
const jiraHeaders = { Authorization: `Basic ${Buffer.from(`${args['jira-email']}:${args['jira-token']}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/json' };
const gitlabHeaders = { 'PRIVATE-TOKEN': args['gitlab-token']!, Accept: 'application/json' };

async function get<T>(url: string, headers: Record<string, string>, init: RequestInit = {}): Promise<T> {
	const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers as Record<string, string> } });
	if (!response.ok) {
		throw new Error(`${response.status} from ${url}`);
	}
	return response.json() as Promise<T>;
}

/** Plain text from Atlassian Document Format, enough for a prompt. */
function adfToText(node: unknown): string {
	if (typeof node === 'string') {
		return node;
	}
	if (!node || typeof node !== 'object') {
		return '';
	}
	const n = node as { type?: string; text?: string; content?: unknown[] };
	const inner = () => (n.content ?? []).map(adfToText).join('');
	switch (n.type) {
		case 'text': return n.text ?? '';
		case 'hardBreak': return '\n';
		case 'paragraph': case 'heading': return `${inner()}\n\n`;
		case 'listItem': return `- ${inner().trim()}\n`;
		case 'codeBlock': return `\`\`\`\n${inner()}\n\`\`\`\n\n`;
		default: return inner();
	}
}

interface Issue { key: string; fields: { summary: string; description?: unknown } }
interface Mr { iid: number; project_id: number; state: string; title: string; source_branch: string; web_url: string; diff_refs?: { base_sha: string }; sha: string }
interface Diff { new_path: string; diff: string }

const search = await get<{ issues: Issue[] }>(`${jira}/rest/api/3/search/jql`, jiraHeaders, { method: 'POST', body: JSON.stringify({ jql: args.jql, fields: ['summary', 'description'], maxResults: 200 }) });
mkdirSync(args.out!, { recursive: true });
let kept = 0;
for (const issue of search.issues) {
	if (kept >= Number(args.max)) {
		break;
	}
	// The merged merge request that names the ticket in its branch or title.
	const mrs = await get<Mr[]>(`${gitlab}/api/v4/merge_requests?scope=all&state=merged&search=${encodeURIComponent(issue.key)}&in=title&per_page=5`, gitlabHeaders).catch(() => []);
	const mr = mrs.find(m => m.title.includes(issue.key) || m.source_branch.toUpperCase().includes(issue.key)) ?? mrs[0];
	if (!mr?.diff_refs?.base_sha) {
		console.log(`${issue.key}: no merged merge request, skipped`);
		continue;
	}
	const diffs = await get<Diff[]>(`${gitlab}/api/v4/projects/${mr.project_id}/merge_requests/${mr.iid}/diffs?per_page=100`, gitlabHeaders);
	const lines = diffs.reduce((n, d) => n + d.diff.split('\n').filter(l => /^[+-](?![+-])/.test(l)).length, 0);
	const tests = diffs.filter(d => /(^|\/)(test|tests|spec|__tests__)\//.test(d.new_path) || /\.(test|spec)\.[jt]sx?$/.test(d.new_path));
	if (lines < Number(args['min-lines']) || lines > Number(args['max-lines']) || !tests.length) {
		console.log(`${issue.key}: ${lines} lines, ${tests.length} test files, skipped`);
		continue;
	}
	const project = await get<{ ssh_url_to_repo: string; http_url_to_repo: string }>(`${gitlab}/api/v4/projects/${mr.project_id}`, gitlabHeaders);
	const task = {
		key: issue.key,
		repo: project.ssh_url_to_repo || project.http_url_to_repo,
		baseSha: mr.diff_refs.base_sha,
		mergeRequest: mr.web_url,
		prompt: `${issue.fields.summary}\n\n${adfToText(issue.fields.description).trim()}`.trim(),
		grader: { command: args.grader, timeoutMs: 600_000 },
		touchedFiles: diffs.map(d => d.new_path),
		lines,
	};
	writeFileSync(path.join(args.out!, `${issue.key}.json`), `${JSON.stringify(task, null, '\t')}\n`);
	console.log(`${issue.key}: kept (${lines} lines, ${tests.length} test files, !${mr.iid})`);
	kept++;
}
console.log(`${kept} tasks in ${args.out}. Read each before keeping it.`);
