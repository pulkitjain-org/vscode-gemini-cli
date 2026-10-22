/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A stand-in Jira Cloud, GitLab and SonarQube on this Mac, for the site's
// screenshots and clips: mock people, tickets and merge requests, so no real
// account, ticket or name reaches the public site. It answers the REST calls
// GeminiCode's connectors make (extensions/gemini/src/acp/jira.ts, gitlab.ts,
// sonar.ts) and serves the demo repositories over git's smart HTTP from
// <demo root>/gitlab, which setup-demo.sh creates. Merge request diffs and
// commits come from those repositories, so a review reads real code.
//
//   node gemini/site/demo/demo-tools.mts /Users/Shared/geminicode-shots
//
// Jira answers on http://localhost:8781, GitLab on :8782 and SonarQube on
// :8783 (DEMO_JIRA_PORT, DEMO_GITLAB_PORT, DEMO_SONAR_PORT change them). Any
// token and email are accepted. Writes (comments, moves, merge requests,
// approvals) are kept in memory until the server stops.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const root = path.resolve(process.argv[2] ?? process.env.DEMO_ROOT ?? '/Users/Shared/geminicode-shots');
const gitRoot = path.join(root, 'gitlab');
const ports = {
	jira: Number(process.env.DEMO_JIRA_PORT ?? 8781),
	gitlab: Number(process.env.DEMO_GITLAB_PORT ?? 8782),
	sonar: Number(process.env.DEMO_SONAR_PORT ?? 8783),
};
const started = Date.now();
const minutesAgo = (minutes: number) => started - minutes * 60_000;

// ---------------------------------------------------------------- people

interface Person {
	readonly id: number;
	readonly accountId: string;
	readonly username: string;
	readonly name: string;
	readonly email: string;
}

function person(id: number, username: string, name: string): Person {
	return { id, accountId: `712020:demo-${username.replace('.', '-')}`, username, name, email: `${username}@acme.test` };
}

const people = {
	sam: person(11, 'sam.rivera', 'Sam Rivera'),
	priya: person(12, 'priya.nair', 'Priya Nair'),
	jonas: person(13, 'jonas.weber', 'Jonas Weber'),
	mei: person(14, 'mei.chen', 'Mei Chen'),
	diego: person(15, 'diego.alvarez', 'Diego Alvarez'),
};
/** The signed-in user, whatever token is pasted. */
const me = people.sam;
const everyone = Object.values(people);

function matching(query: string | null): Person[] {
	const q = (query ?? '').trim().toLowerCase();
	return everyone.filter(p => !q || p.name.toLowerCase().includes(q) || p.username.includes(q) || p.email.includes(q));
}

// ---------------------------------------------------------------- Jira data

type Category = 'new' | 'indeterminate' | 'done';

const statuses: readonly { readonly id: string; readonly name: string; readonly category: Category }[] = [
	{ id: '11', name: 'To Do', category: 'new' },
	{ id: '21', name: 'In Progress', category: 'indeterminate' },
	{ id: '31', name: 'In Review', category: 'indeterminate' },
	{ id: '41', name: 'Done', category: 'done' },
];
const versions = [{ id: '10014', name: '1.5.0' }, { id: '10015', name: '1.5.1' }];
const sprint = { id: 14, name: 'Checkout Sprint 14', state: 'active', startDate: new Date(minutesAgo(8 * 24 * 60)).toISOString(), endDate: new Date(started + 6 * 24 * 3_600_000).toISOString() };
const sprintField = 'customfield_10020';

interface JiraComment {
	readonly id: string;
	readonly author: Person;
	readonly created: number;
	readonly body: unknown;
	readonly visibility?: unknown;
}

interface Ticket {
	readonly key: string;
	readonly summary: string;
	readonly type: string;
	readonly priority: string;
	status: string;
	assignee?: Person;
	readonly reporter: Person;
	readonly labels: readonly string[];
	fixVersions: string[];
	readonly inSprint: boolean;
	updated: number;
	readonly description: string;
	readonly comments: JiraComment[];
	readonly worklogs: { readonly id: string; readonly author: Person; readonly seconds: number; readonly started: number }[];
	readonly attachments: { readonly id: string; readonly name: string; readonly type: string; readonly data: Buffer }[];
}

let nextJiraId = 10400;
const jiraId = () => String(nextJiraId++);

function ticket(key: string, summary: string, fields: Partial<Ticket> & { readonly minutes: number; readonly comments?: { readonly by: Person; readonly minutes: number; readonly text: string }[] }): Ticket {
	return {
		key, summary, type: fields.type ?? 'Story', priority: fields.priority ?? 'Medium', status: fields.status ?? 'To Do',
		assignee: fields.assignee, reporter: fields.reporter ?? people.diego, labels: fields.labels ?? [], fixVersions: fields.fixVersions ?? [],
		inSprint: fields.inSprint ?? true, updated: minutesAgo(fields.minutes), description: fields.description ?? '',
		comments: (fields.comments ?? []).map(c => ({ id: jiraId(), author: c.by, created: minutesAgo(c.minutes), body: adf(c.text) })),
		worklogs: fields.worklogs ?? [], attachments: [],
	};
}

const tickets: Ticket[] = [
	ticket('ACME-412', 'Retry invoice uploads with backoff', {
		status: 'In Review', assignee: me, fixVersions: ['1.5.0'], minutes: 25, labels: ['billing'],
		description: 'Invoice PDFs fail to reach storage on the first network error, and finance has to upload them again by hand.\n\nRetry an upload up to three times, waiting 1 s, 2 s and 4 s. Give up on a 4xx answer, which retrying won\'t fix.\n\nAcceptance:\n- A 503 followed by a 200 uploads once\n- A 403 fails at once\n- The error names the last HTTP status',
		comments: [{ by: people.jonas, minutes: 180, text: 'Storage answers 429 now and then too. Please treat it like a 5xx.' }],
		worklogs: [{ id: '20001', author: me, seconds: 3 * 3600, started: minutesAgo(26 * 60) }],
	}),
	ticket('ACME-418', 'Cart totals show fractions of a cent', {
		type: 'Bug', priority: 'High', status: 'In Review', assignee: people.priya, fixVersions: ['1.5.0'], minutes: 40, reporter: people.mei,
		description: 'Three pencils at $0.10 show a subtotal of $0.30000000000000004 on the cart page, and the charge is off by a fraction of a cent.\n\nRound money to whole cents once, at the end.',
	}),
	ticket('ACME-421', 'Apply TAKE5 before SAVE10', {
		type: 'Bug', priority: 'High', status: 'In Progress', assignee: me, fixVersions: ['1.5.0'], minutes: 95,
		description: 'With both codes, $5 off has to come off before 10%, whatever order the shopper typed them in. Today SAVE10 then TAKE5 charges $13.00 on a $20 cart instead of $13.50.',
		comments: [{ by: people.diego, minutes: 300, text: 'Support has three tickets about this since Monday.' }],
	}),
	ticket('ACME-424', 'Gift message at checkout', {
		status: 'To Do', assignee: me, fixVersions: ['1.5.1'], minutes: 6 * 60,
		description: 'Let shoppers add a gift message of up to 200 characters on the checkout page, and print it on the packing slip.\n\nDesign: https://www.figma.com/design/Ac3Demo42/Checkout?node-id=12-48',
	}),
	ticket('ACME-405', 'Show tax on the cart page', { status: 'Done', assignee: me, fixVersions: ['1.5.0'], minutes: 2 * 24 * 60 }),
	ticket('ACME-409', 'Invoice PDF footer is cut off', { type: 'Bug', status: 'In Progress', assignee: people.mei, minutes: 70 }),
	ticket('ACME-427', 'Rename invoice fields to camelCase', { type: 'Task', priority: 'Low', status: 'To Do', assignee: me, inSprint: false, minutes: 3 * 24 * 60 }),
];

function findTicket(key: string): Ticket | undefined {
	return tickets.find(t => t.key === key.toUpperCase());
}

/** Atlassian Document Format from plain text: a paragraph per block, "- " lines as a bullet list. */
function adf(text: string): unknown {
	const content = text.split(/\n{2,}/).map(block => {
		const lines = block.split('\n');
		const items = lines.filter(line => line.startsWith('- '));
		const textNode = (value: string) => {
			const link = /https?:\/\/\S+/.exec(value);
			return link ? [{ type: 'text', text: value.slice(0, link.index) }, { type: 'inlineCard', attrs: { url: link[0] } }].filter(n => n.type !== 'text' || n.text) : [{ type: 'text', text: value }];
		};
		if (items.length && items.length === lines.length - 1 && !lines[0].startsWith('- ')) {
			return [{ type: 'paragraph', content: textNode(lines[0]) }, { type: 'bulletList', content: items.map(item => ({ type: 'listItem', content: [{ type: 'paragraph', content: textNode(item.slice(2)) }] })) }];
		}
		return [{ type: 'paragraph', content: lines.flatMap((line, i) => [...i ? [{ type: 'hardBreak' }] : [], ...textNode(line)]) }];
	}).flat();
	return { type: 'doc', version: 1, content };
}

function jiraTime(ms: number): string {
	return new Date(ms).toISOString().replace('Z', '+0000');
}

function jiraUser(p: Person | undefined, site: string): unknown {
	return p ? { accountId: p.accountId, displayName: p.name, emailAddress: p.email, active: true, accountType: 'atlassian', self: `${site}/rest/api/3/user?accountId=${p.accountId}`, avatarUrls: {} } : null;
}

function statusOf(name: string) {
	return statuses.find(s => s.name === name) ?? statuses[0];
}

function issueJson(t: Ticket, site: string): unknown {
	const status = statusOf(t.status);
	return {
		id: t.key.replace(/\D/g, ''),
		key: t.key,
		self: `${site}/rest/api/3/issue/${t.key}`,
		fields: {
			summary: t.summary,
			status: { name: status.name, id: status.id, statusCategory: { key: status.category } },
			issuetype: { name: t.type },
			priority: { name: t.priority },
			fixVersions: t.fixVersions.map(name => ({ name, id: versions.find(v => v.name === name)?.id })),
			updated: jiraTime(t.updated),
			description: adf(t.description),
			assignee: jiraUser(t.assignee, site),
			reporter: jiraUser(t.reporter, site),
			labels: t.labels,
			project: { key: 'ACME', name: 'Acme Checkout' },
			comment: { total: t.comments.length, comments: t.comments.map(c => ({ id: c.id, author: jiraUser(c.author, site), created: jiraTime(c.created), updated: jiraTime(c.created), body: c.body })) },
			[sprintField]: t.inSprint ? [sprint] : null,
			attachment: t.attachments.map(a => ({ id: a.id, filename: a.name, size: a.data.length, mimeType: a.type, content: `${site}/rest/api/3/attachment/content/${a.id}` })),
		},
	};
}

/** The tickets a JQL query names, for the handful of queries GeminiCode writes. */
function searchJql(jql: string): Ticket[] {
	const [where, order] = jql.split(/\border\s+by\b/i);
	let found = [...tickets];
	if (/currentUser\(\)/i.test(where)) {
		found = found.filter(t => t.assignee === me && (statusOf(t.status).category !== 'done' || t.inSprint));
	}
	const keys = /\bkey\s*(?:=|in)\s*\(?([^)]*?)\)?(?:\s+(?:and|or)\b|$)/i.exec(where);
	if (keys) {
		const wanted = keys[1].split(',').map(k => k.trim().replace(/"/g, '').toUpperCase());
		found = found.filter(t => wanted.includes(t.key));
	}
	const text = /\b(?:text|summary)\s*~\s*"([^"]*)"/i.exec(where);
	if (text) {
		const words = text[1].toLowerCase().split(/\s+/).filter(Boolean);
		found = found.filter(t => words.every(w => `${t.key} ${t.summary} ${t.description}`.toLowerCase().includes(w)));
	}
	if (/statusCategory\s*!=\s*Done/i.test(where) && !/currentUser\(\)/i.test(where)) {
		found = found.filter(t => statusOf(t.status).category !== 'done');
	}
	if (!order || /updated/i.test(order)) {
		found.sort((a, b) => b.updated - a.updated);
	}
	return found;
}

function transitionsOf(t: Ticket) {
	return statuses.filter(s => s.name !== t.status).map(s => ({
		id: s.id,
		name: s.name === 'Done' ? 'Done' : s.name === 'In Review' ? 'Ready for Review' : s.name === 'In Progress' ? 'Start Progress' : 'Back to To Do',
		to: { name: s.name, statusCategory: { key: s.category } },
		fields: s.name === 'Done' ? { fixVersions: { name: 'Fix versions', required: false, schema: { type: 'array' }, allowedValues: versions } } : {},
	}));
}

// ---------------------------------------------------------------- GitLab data

interface Project {
	readonly id: number;
	readonly path: string;
	readonly name: string;
	readonly description: string;
}

const projects: readonly Project[] = [
	{ id: 7, path: 'acme/acme-checkout', name: 'acme-checkout', description: 'The cart, discount and tax code behind the Acme store.' },
	{ id: 8, path: 'acme/billing-api', name: 'billing-api', description: 'Invoices and their PDFs.' },
];

interface Note {
	readonly id: number;
	readonly author: Person;
	readonly body: string;
	readonly created: number;
	readonly resolvable: boolean;
	resolved: boolean;
	resolvedBy?: Person;
	readonly position?: Record<string, unknown>;
}

interface Discussion {
	readonly id: string;
	readonly notes: Note[];
}

interface Job {
	readonly id: number;
	readonly name: string;
	readonly stage: string;
	status: string;
	readonly log: string;
}

interface Pipeline {
	readonly id: number;
	status: string;
	readonly jobs: Job[];
}

interface MergeRequest {
	readonly project: Project;
	readonly iid: number;
	readonly title: string;
	readonly description: string;
	readonly author: Person;
	readonly assignee?: Person;
	readonly reviewers: Person[];
	readonly source: string;
	readonly target: string;
	readonly draft: boolean;
	state: 'opened' | 'merged' | 'closed';
	readonly created: number;
	updated: number;
	pipeline?: Pipeline;
	readonly approvedBy: Person[];
	readonly approvalsRequired: number;
	readonly discussions: Discussion[];
	mergedSha?: string;
}

let nextGitLabId = 5100;
const gitlabId = () => nextGitLabId++;
const discussionId = () => (gitlabId().toString(16) + 'd15c0a5e'.repeat(5)).slice(0, 40);

function project(ref: string): Project | undefined {
	const decoded = decodeURIComponent(ref);
	return projects.find(p => String(p.id) === decoded || p.path === decoded);
}

const failedTestLog = [
	'\u001b[0KRunning with gitlab-runner 17.5.1 (demo)',
	'$ npm ci',
	'added 46 packages in 3s',
	'$ npm test',
	'',
	'> acme-checkout@1.4.2 test',
	'> vitest run',
	'',
	' RUN  v3.2.4 /builds/acme/acme-checkout',
	'',
	' \u2713 test/tax.test.ts (7 tests) 3ms',
	' \u2713 test/total.test.ts (4 tests) 4ms',
	' \u2713 test/checkout.test.ts (14 tests) 8412ms',
	' \u276f test/discount.test.ts (10 tests | 1 failed) 6ms',
	'   \u00d7 SAVE10 then TAKE5 2ms',
	'',
	' FAIL  test/discount.test.ts > SAVE10 then TAKE5',
	'AssertionError: expected 13.5 to be 13 // Object.is equality',
	'',
	'- Expected',
	'+ Received',
	'',
	'- 13',
	'+ 13.5',
	'',
	' \u276f test/discount.test.ts:11:81',
	'',
	' Test Files  1 failed | 3 passed (4)',
	'      Tests  1 failed | 34 passed (35)',
	'',
	'ERROR: Job failed: exit code 1',
].join('\n');

function pipeline(status: string, failedTest = false): Pipeline {
	const done = status === 'success' || status === 'failed';
	return {
		id: gitlabId(),
		status,
		jobs: [
			{ id: gitlabId(), name: 'lint', stage: 'test', status: done || status === 'running' ? 'success' : status, log: '$ npm run lint\nNo problems found.\nJob succeeded' },
			{ id: gitlabId(), name: 'test', stage: 'test', status: failedTest ? 'failed' : status, log: failedTest ? failedTestLog : '$ npm test\n Test Files  4 passed (4)\n      Tests  35 passed (35)\nJob succeeded' },
		],
	};
}

function seedNote(by: Person, minutes: number, body: string, position?: { readonly path: string; readonly line: number }): Note {
	return { id: gitlabId(), author: by, body, created: minutesAgo(minutes), resolvable: !!position, resolved: false, ...position ? { position: { position_type: 'text', new_path: position.path, old_path: position.path, new_line: position.line, old_line: null } } : {} };
}

function thread(...notes: Note[]): Discussion {
	return { id: discussionId(), notes };
}

const mergeRequests: MergeRequest[] = [
	{
		project: projects[0], iid: 418, title: 'Round cart totals to whole cents', author: people.priya, reviewers: [me], source: 'ACME-418-round-cents', target: 'main',
		description: 'Closes ACME-418.\n\nThree pencils showed a subtotal of $0.30000000000000004. `cartTotal` now rounds to whole cents once, after the discount and tax, and the cart page uses the same rounding.\n\n- `src/cart/total.ts`: round at the end, use `TAX_RATE`\n- `web/index.html`: format the total with two decimals\n- tests for the rounding',
		draft: false, state: 'opened', created: minutesAgo(5 * 60), updated: minutesAgo(40), pipeline: pipeline('success'), approvedBy: [], approvalsRequired: 1,
		discussions: [
			thread(seedNote(people.priya, 280, 'Ready for review. This fixes the $0.30000000000000004 subtotal from the cart page.')),
			thread(seedNote(people.jonas, 120, 'Finance rounds tax per line, not on the total. Can we check with them before this ships?', { path: 'src/cart/total.ts', line: 14 })),
		],
	},
	{
		project: projects[1], iid: 412, title: 'Retry invoice uploads with backoff', author: me, reviewers: [people.jonas], source: 'ACME-412-upload-retries', target: 'main',
		description: 'Closes ACME-412.\n\nRetries an invoice upload up to three times, waiting 1 s, 2 s and 4 s, on a network error, a 5xx or a 429. A 4xx other than 429 fails at once.',
		draft: false, state: 'opened', created: minutesAgo(26 * 60), updated: minutesAgo(25), pipeline: pipeline('success'), approvedBy: [people.jonas], approvalsRequired: 1,
		discussions: [(() => {
			const d = thread(seedNote(people.jonas, 200, 'Could the wait come from a parameter, so the tests don\'t sleep?', { path: 'src/upload.ts', line: 4 }), seedNote(me, 150, 'Done: `uploadInvoice` takes `wait` now, and the tests pass a no-op.'));
			d.notes.forEach(n => {
				n.resolved = true;
				n.resolvedBy = people.jonas;
			});
			return d;
		})()],
	},
	{
		project: projects[0], iid: 421, title: 'Apply TAKE5 before SAVE10', author: me, reviewers: [people.priya], source: 'ACME-421-discount-order', target: 'main',
		description: 'Closes ACME-421.\n\n`applyDiscounts` takes the fixed TAKE5 off before the percentage SAVE10, whatever the order the codes were typed in.',
		draft: false, state: 'opened', created: minutesAgo(3 * 60), updated: minutesAgo(95), pipeline: pipeline('failed', true), approvedBy: [], approvalsRequired: 1,
		discussions: [
			thread(seedNote(people.priya, 100, 'Sorting on every call allocates a new array. Fine here, but a comment saying why the order matters would help the next person.', { path: 'src/cart/discount.ts', line: 14 })),
			thread(seedNote(people.priya, 98, 'The test name "SAVE10 then TAKE5" still expects the old total.', { path: 'test/discount.test.ts', line: 11 })),
		],
	},
	{
		project: projects[1], iid: 409, title: 'Keep the invoice PDF footer on the page', author: people.mei, reviewers: [me], source: 'ACME-409-pdf-footer', target: 'main',
		description: 'Closes ACME-409.\n\nThe footer moved up by its own height, so it no longer runs off an A4 page.',
		draft: true, state: 'opened', created: minutesAgo(90), updated: minutesAgo(70), pipeline: pipeline('running'), approvedBy: [], approvalsRequired: 1, discussions: [],
	},
];

function findMr(p: Project, iid: number): MergeRequest | undefined {
	return mergeRequests.find(mr => mr.project === p && mr.iid === iid);
}

// ---------------------------------------------------------------- git

function bare(p: Project): string {
	return path.join(gitRoot, `${p.path}.git`);
}

async function git(p: Project, args: readonly string[]): Promise<string> {
	const { stdout } = await run('git', ['--git-dir', bare(p), ...args], { maxBuffer: 32 * 1024 * 1024 });
	return stdout;
}

async function revParse(p: Project, ref: string): Promise<string | undefined> {
	try {
		return (await git(p, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`])).trim() || undefined;
	} catch {
		return undefined;
	}
}

interface Refs {
	readonly base_sha: string;
	readonly head_sha: string;
	readonly start_sha: string;
}

async function diffRefs(mr: MergeRequest): Promise<Refs | undefined> {
	const head = mr.mergedSha ?? await revParse(mr.project, mr.source);
	const start = await revParse(mr.project, mr.target);
	if (!head || !start) {
		return undefined;
	}
	const base = (await git(mr.project, ['merge-base', start, head]).catch(() => start)).trim();
	return { base_sha: base, head_sha: head, start_sha: start };
}

async function fileDiffs(mr: MergeRequest): Promise<{ old_path: string; new_path: string; diff: string; new_file: boolean; deleted_file: boolean; renamed_file: boolean; a_mode: string; b_mode: string }[]> {
	const refs = await diffRefs(mr);
	if (!refs) {
		return [];
	}
	const out = await git(mr.project, ['diff', '--no-color', '--no-renames', '--unified=3', refs.base_sha, refs.head_sha]);
	return out.split(/^diff --git /m).filter(Boolean).map(chunk => {
		const [header] = chunk.split('\n', 1);
		const names = /^a\/(.+) b\/(.+)$/.exec(header);
		const hunk = chunk.indexOf('\n@@');
		return {
			old_path: names?.[1] ?? '',
			new_path: names?.[2] ?? '',
			diff: hunk < 0 ? '' : chunk.slice(hunk + 1),
			new_file: /^new file mode/m.test(chunk),
			deleted_file: /^deleted file mode/m.test(chunk),
			renamed_file: false,
			a_mode: '100644',
			b_mode: '100644',
		};
	});
}

/** Answers git's smart HTTP with `git http-backend`, so clones, fetches and pushes work. */
function serveGit(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
	const backend = spawn('git', ['http-backend'], {
		env: {
			...process.env,
			GIT_PROJECT_ROOT: gitRoot,
			GIT_HTTP_EXPORT_ALL: '1',
			PATH_INFO: decodeURIComponent(url.pathname),
			QUERY_STRING: url.search.slice(1),
			REQUEST_METHOD: req.method ?? 'GET',
			CONTENT_TYPE: req.headers['content-type'] ?? '',
			...req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {},
			...req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {},
			...req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {},
			// Set, so pushes are allowed.
			REMOTE_USER: me.username,
			REMOTE_ADDR: '127.0.0.1',
		},
	});
	req.pipe(backend.stdin);
	let head = Buffer.alloc(0);
	let headersDone = false;
	backend.stdout.on('data', (data: Buffer) => {
		if (headersDone) {
			res.write(data);
			return;
		}
		head = Buffer.concat([head, data]);
		const end = head.indexOf('\r\n\r\n');
		if (end < 0) {
			return;
		}
		headersDone = true;
		let status = 200;
		for (const line of head.subarray(0, end).toString().split('\r\n')) {
			const colon = line.indexOf(':');
			const name = line.slice(0, colon).trim();
			const value = line.slice(colon + 1).trim();
			if (/^status$/i.test(name)) {
				status = parseInt(value, 10);
			} else if (name) {
				res.setHeader(name, value);
			}
		}
		res.statusCode = status;
		res.write(head.subarray(end + 4));
	});
	backend.stdout.on('end', () => res.end());
	backend.stderr.on('data', (data: Buffer) => process.stderr.write(`git http-backend: ${data}`));
	backend.on('error', () => {
		res.statusCode = 500;
		res.end('git http-backend failed to start');
	});
}

// ---------------------------------------------------------------- GitLab JSON

function gitlabUser(p: Person | undefined): unknown {
	return p ? { id: p.id, username: p.username, name: p.name, state: 'active', avatar_url: null, web_url: `http://localhost:${ports.gitlab}/${p.username}` } : null;
}

function unresolved(mr: MergeRequest): number {
	return mr.discussions.filter(d => d.notes.some(n => n.resolvable && !n.resolved)).length;
}

function mergeStatus(mr: MergeRequest): string {
	if (mr.state !== 'opened') {
		return 'not_open';
	}
	if (mr.draft) {
		return 'draft_status';
	}
	if (mr.pipeline?.status === 'running' || mr.pipeline?.status === 'pending') {
		return 'ci_still_running';
	}
	if (mr.pipeline?.status === 'failed') {
		return 'ci_must_pass';
	}
	if (unresolved(mr)) {
		return 'discussions_not_resolved';
	}
	if (mr.approvedBy.length < mr.approvalsRequired) {
		return 'not_approved';
	}
	return 'mergeable';
}

function webUrl(mr: MergeRequest): string {
	return `http://localhost:${ports.gitlab}/${mr.project.path}/-/merge_requests/${mr.iid}`;
}

async function mrJson(mr: MergeRequest): Promise<unknown> {
	const refs = await diffRefs(mr);
	const files = await fileDiffs(mr).catch(() => []);
	return {
		id: mr.project.id * 10_000 + mr.iid,
		iid: mr.iid,
		project_id: mr.project.id,
		title: mr.draft ? `Draft: ${mr.title}` : mr.title,
		description: mr.description,
		state: mr.state,
		draft: mr.draft,
		work_in_progress: mr.draft,
		web_url: webUrl(mr),
		source_branch: mr.source,
		target_branch: mr.target,
		source_project_id: mr.project.id,
		target_project_id: mr.project.id,
		author: gitlabUser(mr.author),
		assignee: gitlabUser(mr.assignee ?? mr.author),
		assignees: [gitlabUser(mr.assignee ?? mr.author)],
		reviewers: mr.reviewers.map(gitlabUser),
		created_at: new Date(mr.created).toISOString(),
		updated_at: new Date(mr.updated).toISOString(),
		detailed_merge_status: mergeStatus(mr),
		merge_status: mergeStatus(mr) === 'mergeable' ? 'can_be_merged' : 'cannot_be_merged',
		has_conflicts: false,
		blocking_discussions_resolved: unresolved(mr) === 0,
		sha: refs?.head_sha,
		merge_commit_sha: mr.mergedSha ?? null,
		references: { short: `!${mr.iid}`, full: `${mr.project.path}!${mr.iid}` },
		head_pipeline: mr.pipeline ? { id: mr.pipeline.id, status: mr.pipeline.status, web_url: `http://localhost:${ports.gitlab}/${mr.project.path}/-/pipelines/${mr.pipeline.id}` } : null,
		diff_refs: refs ?? null,
		changes_count: String(files.length),
		user_notes_count: mr.discussions.reduce((sum, d) => sum + d.notes.length, 0),
		squash: false,
		force_remove_source_branch: true,
	};
}

function noteJson(n: Note): unknown {
	return {
		id: n.id, type: n.position ? 'DiffNote' : n.resolvable ? 'DiscussionNote' : null, body: n.body, author: gitlabUser(n.author),
		created_at: new Date(n.created).toISOString(), updated_at: new Date(n.created).toISOString(), system: false,
		resolvable: n.resolvable, resolved: n.resolvable ? n.resolved : false, resolved_by: n.resolvedBy ? gitlabUser(n.resolvedBy) : null,
		...n.position ? { position: n.position } : {},
	};
}

function discussionJson(d: Discussion): unknown {
	return { id: d.id, individual_note: d.notes.length === 1 && !d.notes[0].resolvable, notes: d.notes.map(noteJson) };
}

// ---------------------------------------------------------------- HTTP helpers

interface Reply {
	readonly status?: number;
	readonly json?: unknown;
	readonly text?: string;
	readonly html?: string;
	readonly bytes?: { readonly type: string; readonly data: Buffer };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

function json(body: Buffer): Record<string, unknown> {
	try {
		return body.length ? JSON.parse(body.toString()) as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

async function form(req: http.IncomingMessage, body: Buffer): Promise<{ name: string; type: string; data: Buffer }[]> {
	const parsed = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': String(req.headers['content-type'] ?? '') }, body }).formData();
	const files: { name: string; type: string; data: Buffer }[] = [];
	for (const value of parsed.values()) {
		if (typeof value !== 'string') {
			files.push({ name: value.name, type: value.type || 'application/octet-stream', data: Buffer.from(await value.arrayBuffer()) });
		}
	}
	return files;
}

function send(res: http.ServerResponse, reply: Reply): void {
	res.statusCode = reply.status ?? 200;
	if (reply.bytes) {
		res.setHeader('Content-Type', reply.bytes.type);
		res.end(reply.bytes.data);
	} else if (reply.html !== undefined) {
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.end(reply.html);
	} else if (reply.text !== undefined) {
		res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		res.end(reply.text);
	} else if (reply.json !== undefined) {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify(reply.json));
	} else {
		res.end();
	}
}

const notFound: Reply = { status: 404, json: { message: '404 Not found', errorMessages: ['Not found'] } };

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

/** A plain page for links the app opens in a browser, so a click lands somewhere readable. */
function page(title: string, lines: readonly string[]): Reply {
	return {
		html: `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 16px;color:#1d1d1f}small{color:#6e6e73}</style><small>Demo server for GeminiCode screenshots</small><h1>${escapeHtml(title)}</h1>${lines.map(line => `<p>${escapeHtml(line)}</p>`).join('')}`,
	};
}

function serve(name: string, port: number, handle: (req: http.IncomingMessage, url: URL, body: Buffer, res: http.ServerResponse) => Promise<Reply | undefined>): void {
	http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://localhost:${port}`);
		const finish = (reply: Reply) => {
			send(res, reply);
			console.log(`${name} ${req.method} ${url.pathname}${url.search} ${reply.status ?? 200}`);
		};
		void (async () => {
			try {
				// Git streams its own body; everything else is read whole.
				if (name === 'gitlab' && /\.git(\/|$)/.test(url.pathname)) {
					serveGit(req, res, url);
					console.log(`${name} ${req.method} ${url.pathname}${url.search} (git)`);
					return;
				}
				const body = await readBody(req);
				const reply = await handle(req, url, body, res);
				finish(reply ?? notFound);
			} catch (err) {
				console.error(err);
				finish({ status: 500, json: { message: err instanceof Error ? err.message : String(err) } });
			}
		})();
	}).listen(port, '127.0.0.1', () => console.log(`${name} on http://localhost:${port}`));
}

function authorized(req: http.IncomingMessage, header: string): boolean {
	return !!req.headers[header];
}

// ---------------------------------------------------------------- Jira routes

serve('jira', ports.jira, async (req, url, body) => {
	const site = `http://localhost:${ports.jira}`;
	const p = url.pathname;
	const method = req.method ?? 'GET';
	const browse = /^\/browse\/([A-Z]+-\d+)$/.exec(p);
	if (browse) {
		const t = findTicket(browse[1]);
		return t ? page(`${t.key} ${t.summary}`, [`${t.type} \u00b7 ${t.status} \u00b7 ${t.assignee?.name ?? 'Unassigned'}`, ...t.description.split('\n\n')]) : notFound;
	}
	if (!p.startsWith('/rest/')) {
		return page('Acme Jira (demo)', ['Any email and API token sign in as Sam Rivera.']);
	}
	if (!authorized(req, 'authorization')) {
		return { status: 401, json: { errorMessages: ['You are not authenticated.'] } };
	}
	if (p === '/rest/api/3/myself') {
		return { json: { ...jiraUser(me, site) as object, timeZone: 'Europe/Berlin', ...url.searchParams.get('expand') === 'groups' ? { groups: { size: 2, items: [{ name: 'acme-developers' }, { name: 'jira-software-users' }] } } : {} } };
	}
	if (p === '/rest/api/3/field') {
		return { json: [{ id: 'summary', name: 'Summary', schema: { type: 'string', system: 'summary' } }, { id: sprintField, name: 'Sprint', custom: true, schema: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }] };
	}
	if (p === '/rest/api/3/search/jql' && method === 'POST') {
		const query = json(body);
		const found = searchJql(String(query.jql ?? '')).slice(0, Number(query.maxResults ?? 50));
		return { json: { issues: found.map(t => issueJson(t, site)), isLast: true } };
	}
	if (p === '/rest/api/3/user/viewissue/search' || p === '/rest/api/3/user/assignable/search') {
		return { json: matching(url.searchParams.get('query')).map(person => jiraUser(person, site)) };
	}
	const role = /^\/rest\/api\/3\/project\/([^/]+)\/role$/.exec(p);
	if (role) {
		return { json: { Developers: `${site}/rest/api/3/project/ACME/role/10002`, Administrators: `${site}/rest/api/3/project/ACME/role/10003`, 'atlassian-addons-project-access': `${site}/rest/api/3/project/ACME/role/10004` } };
	}
	const content = /^\/rest\/api\/3\/attachment\/content\/(\d+)$/.exec(p);
	if (content) {
		const file = tickets.flatMap(t => t.attachments).find(a => a.id === content[1]);
		return file ? { bytes: { type: file.type, data: file.data } } : notFound;
	}
	const issue = /^\/rest\/api\/3\/issue\/([^/]+)(\/[a-z]+)?$/.exec(p);
	const t = issue && findTicket(decodeURIComponent(issue[1]));
	if (!issue || !t) {
		return issue ? { status: 404, json: { errorMessages: ['Issue does not exist or you do not have permission to see it.'] } } : undefined;
	}
	const sub = issue[2] ?? '';
	const touch = () => {
		t.updated = Date.now();
	};
	switch (`${method} ${sub}`) {
		case 'GET ':
			return { json: issueJson(t, site) };
		case 'GET /transitions':
			return { json: { transitions: transitionsOf(t) } };
		case 'POST /transitions': {
			const request = json(body);
			const to = statuses.find(s => s.id === String((request.transition as { id?: string } | undefined)?.id));
			if (!to) {
				return { status: 400, json: { errorMessages: ['Transition id is not valid for this issue.'] } };
			}
			t.status = to.name;
			const fix = (request.fields as { fixVersions?: { id: string }[] } | undefined)?.fixVersions;
			if (fix) {
				t.fixVersions = fix.map(f => versions.find(v => v.id === f.id)?.name ?? f.id);
			}
			const comment = (request.update as { comment?: { add?: { body?: unknown } }[] } | undefined)?.comment?.[0]?.add?.body;
			if (comment) {
				t.comments.push({ id: jiraId(), author: me, created: Date.now(), body: comment });
			}
			touch();
			return { status: 204 };
		}
		case 'POST /comment': {
			const request = json(body);
			const made: JiraComment = { id: jiraId(), author: me, created: Date.now(), body: request.body, visibility: request.visibility };
			t.comments.push(made);
			touch();
			return { status: 201, json: { id: made.id, author: jiraUser(me, site), body: made.body, created: jiraTime(made.created) } };
		}
		case 'POST /attachments': {
			const made = (await form(req, body)).map(file => ({ id: jiraId(), ...file }));
			t.attachments.push(...made);
			touch();
			return { json: made.map(a => ({ id: a.id, filename: a.name, size: a.data.length, mimeType: a.type, content: `${site}/rest/api/3/attachment/content/${a.id}` })) };
		}
		case 'GET /worklog':
			return { json: { total: t.worklogs.length, worklogs: t.worklogs.map(w => ({ id: w.id, author: jiraUser(w.author, site), timeSpentSeconds: w.seconds, started: jiraTime(w.started) })) } };
		case 'POST /worklog': {
			const request = json(body);
			const made = { id: jiraId(), author: me, seconds: Number(request.timeSpentSeconds ?? 0), started: Date.now() };
			t.worklogs.push(made);
			touch();
			return { status: 201, json: { id: made.id, timeSpentSeconds: made.seconds } };
		}
		case 'PUT /assignee': {
			const id = json(body).accountId;
			t.assignee = everyone.find(person => person.accountId === id);
			touch();
			return { status: 204 };
		}
	}
	return undefined;
});

// ---------------------------------------------------------------- GitLab routes

serve('gitlab', ports.gitlab, async (req, url, body) => {
	const p = url.pathname;
	const method = req.method ?? 'GET';
	const q = url.searchParams;
	if (!p.startsWith('/api/v4/')) {
		const mrPage = /^\/(.+)\/-\/merge_requests\/(\d+)$/.exec(p);
		const mr = mrPage && project(mrPage[1]) && findMr(project(mrPage[1])!, Number(mrPage[2]));
		if (mr) {
			return page(`!${mr.iid} ${mr.title}`, [`${mr.project.path} \u00b7 ${mr.source} into ${mr.target} \u00b7 by ${mr.author.name}`, ...mr.description.split('\n\n')]);
		}
		if (p.includes('personal_access_tokens')) {
			return page('Personal access tokens (demo)', ['Any token works with the demo server. Paste demo-token into GeminiCode\'s Connections page.']);
		}
		return page('Acme GitLab (demo)', projects.map(pr => `${pr.path}: ${pr.description}`));
	}
	if (!authorized(req, 'private-token') && !authorized(req, 'authorization')) {
		return { status: 401, json: { message: '401 Unauthorized' } };
	}
	const api = p.slice('/api/v4'.length);
	if (api === '/user') {
		return { json: { ...gitlabUser(me) as object, email: me.email } };
	}
	if (api === '/version') {
		return { json: { version: '17.5.1-ee', revision: 'demo' } };
	}
	if (api === '/personal_access_tokens/self') {
		return { json: { id: 1, name: 'GeminiCode', scopes: ['api'], active: true, revoked: false, expires_at: new Date(started + 90 * 24 * 3_600_000).toISOString().slice(0, 10) } };
	}
	if (api === '/merge_requests') {
		const scope = q.get('scope');
		const reviewer = q.get('reviewer_id');
		const assignee = q.get('assignee_id');
		const list = mergeRequests.filter(mr => (!q.get('state') || mr.state === q.get('state'))
			&& (scope !== 'created_by_me' || mr.author === me)
			&& (!reviewer || mr.reviewers.some(r => String(r.id) === reviewer))
			&& (!assignee || String((mr.assignee ?? mr.author).id) === assignee));
		list.sort((a, b) => b.updated - a.updated);
		return { json: await Promise.all(list.map(mrJson)) };
	}
	const scoped = /^\/projects\/([^/]+)(\/.*)?$/.exec(api);
	const pr = scoped && project(scoped[1]);
	if (!scoped || !pr) {
		return scoped ? { status: 404, json: { message: '404 Project Not Found' } } : undefined;
	}
	const rest = scoped[2] ?? '';
	if (rest === '') {
		return {
			json: {
				id: pr.id, name: pr.name, path: pr.name, path_with_namespace: pr.path, description: pr.description, default_branch: 'main',
				web_url: `http://localhost:${ports.gitlab}/${pr.path}`, http_url_to_repo: `http://localhost:${ports.gitlab}/${pr.path}.git`,
				only_allow_merge_if_pipeline_succeeds: true, only_allow_merge_if_all_discussions_are_resolved: true, squash_option: 'default_off', remove_source_branch_after_merge: true,
			},
		};
	}
	if (rest === '/repository/branches') {
		const search = (q.get('search') ?? '').toLowerCase();
		const out = await git(pr, ['for-each-ref', 'refs/heads', '--sort=-committerdate', '--format=%(refname:short)%09%(committerdate:iso-strict)%09%(objectname)']);
		return {
			json: out.trim().split('\n').filter(Boolean).map(line => line.split('\t')).filter(([name]) => !search || name.toLowerCase().includes(search)).map(([name, date, sha]) => ({
				name, protected: name === 'main' || name.startsWith('release/'), default: name === 'main', merged: false, commit: { id: sha, committed_date: date },
			})),
		};
	}
	if (rest === '/members/all') {
		return { json: matching(q.get('query')).map(person => ({ ...gitlabUser(person) as object, access_level: 30 })) };
	}
	if (rest === '/uploads' && method === 'POST') {
		const [file] = await form(req, body);
		const where = `/uploads/${gitlabId().toString(16)}/${encodeURIComponent(file?.name ?? 'file')}`;
		const image = /^image\//.test(file?.type ?? '');
		return { status: 201, json: { alt: file?.name, url: where, full_path: `/${pr.path}${where}`, markdown: `${image ? '!' : ''}[${file?.name}](${where})` } };
	}
	const trace = /^\/jobs\/(\d+)\/trace$/.exec(rest);
	if (trace) {
		const job = mergeRequests.flatMap(mr => mr.pipeline?.jobs ?? []).find(j => String(j.id) === trace[1]);
		return job ? { text: job.log } : notFound;
	}
	const jobs = /^\/pipelines\/(\d+)\/jobs$/.exec(rest);
	if (jobs) {
		const found = mergeRequests.map(mr => mr.pipeline).find(pl => pl && String(pl.id) === jobs[1]);
		const failedOnly = q.getAll('scope[]').includes('failed');
		return found ? { json: found.jobs.filter(j => !failedOnly || j.status === 'failed').map(j => ({ id: j.id, name: j.name, stage: j.stage, status: j.status, web_url: `http://localhost:${ports.gitlab}/${pr.path}/-/jobs/${j.id}` })) } : notFound;
	}
	const issue = /^\/issues\/(\d+)$/.exec(rest);
	if (issue) {
		return { json: { iid: Number(issue[1]), title: 'Uploads fail behind the office proxy', description: 'Seen from the Berlin office only.', state: 'opened', labels: ['billing'], web_url: `http://localhost:${ports.gitlab}/${pr.path}/-/issues/${issue[1]}` } };
	}
	if (rest === '/merge_requests' && method === 'GET') {
		const source = q.get('source_branch');
		const list = mergeRequests.filter(mr => mr.project === pr && (!q.get('state') || mr.state === q.get('state')) && (!source || mr.source === source));
		return { json: await Promise.all(list.map(mrJson)) };
	}
	if (rest === '/merge_requests' && method === 'POST') {
		const request = json(body);
		const title = String(request.title ?? '');
		const draft = /^draft:\s*/i.test(title);
		const iid = Math.max(...mergeRequests.filter(mr => mr.project === pr).map(mr => mr.iid)) + 1;
		const made: MergeRequest = {
			project: pr, iid, title: title.replace(/^draft:\s*/i, ''), description: String(request.description ?? ''), author: me,
			reviewers: everyone.filter(person => (request.reviewer_ids as number[] | undefined)?.includes(person.id)),
			source: String(request.source_branch), target: String(request.target_branch), draft, state: 'opened', created: Date.now(), updated: Date.now(),
			pipeline: pipeline('running'), approvedBy: [], approvalsRequired: 1, discussions: [],
		};
		mergeRequests.push(made);
		// The new pipeline passes after a while, as a real one would.
		setTimeout(() => {
			if (made.pipeline) {
				made.pipeline.status = 'success';
				made.pipeline.jobs.forEach(j => j.status = 'success');
				made.updated = Date.now();
			}
		}, 45_000);
		return { status: 201, json: await mrJson(made) };
	}
	const mrPath = /^\/merge_requests\/(\d+)(\/.*)?$/.exec(rest);
	const mr = mrPath && findMr(pr, Number(mrPath[1]));
	if (!mrPath || !mr) {
		return mrPath ? { status: 404, json: { message: '404 Not found' } } : undefined;
	}
	const sub = mrPath[2] ?? '';
	const touch = () => {
		mr.updated = Date.now();
	};
	if (sub === '' && method === 'GET') {
		return { json: await mrJson(mr) };
	}
	if (sub === '/diffs') {
		return { json: await fileDiffs(mr) };
	}
	if (sub === '/approvals') {
		return { json: { approved: mr.approvedBy.length >= mr.approvalsRequired, approvals_required: mr.approvalsRequired, approvals_left: Math.max(0, mr.approvalsRequired - mr.approvedBy.length), approved_by: mr.approvedBy.map(a => ({ user: gitlabUser(a) })) } };
	}
	if (sub === '/approval_state') {
		return { json: { approval_rules_overwritten: false, rules: [{ id: 1, name: 'Checkout reviewers', rule_type: 'regular', approvals_required: mr.approvalsRequired, approved: mr.approvedBy.length >= mr.approvalsRequired, approved_by: mr.approvedBy.map(gitlabUser), eligible_approvers: everyone.filter(e => e !== mr.author).map(gitlabUser) }] } };
	}
	if (sub === '/discussions' && method === 'GET') {
		const per = Number(q.get('per_page') ?? 20);
		const pageNo = Number(q.get('page') ?? 1);
		return { json: mr.discussions.slice((pageNo - 1) * per, pageNo * per).map(discussionJson) };
	}
	if (sub === '/discussions' && method === 'POST') {
		const request = json(body);
		const position = request.position as Record<string, unknown> | undefined;
		const made: Discussion = { id: discussionId(), notes: [{ id: gitlabId(), author: me, body: String(request.body ?? ''), created: Date.now(), resolvable: true, resolved: false, ...position ? { position: { ...position, old_line: position.old_line ?? null } } : {} }] };
		mr.discussions.push(made);
		touch();
		return { status: 201, json: discussionJson(made) };
	}
	const discussion = /^\/discussions\/([^/]+)(\/notes)?$/.exec(sub);
	if (discussion) {
		const d = mr.discussions.find(x => x.id === decodeURIComponent(discussion[1]));
		if (!d) {
			return notFound;
		}
		if (discussion[2] && method === 'POST') {
			const note: Note = { id: gitlabId(), author: me, body: String(json(body).body ?? ''), created: Date.now(), resolvable: d.notes[0].resolvable, resolved: d.notes[0].resolved };
			d.notes.push(note);
			touch();
			return { status: 201, json: noteJson(note) };
		}
		if (method === 'PUT') {
			const resolved = q.get('resolved') === 'true' || json(body).resolved === true;
			d.notes.forEach(n => {
				n.resolved = resolved;
				n.resolvedBy = resolved ? me : undefined;
			});
			touch();
			return { json: discussionJson(d) };
		}
	}
	if (sub === '/notes' && method === 'POST') {
		const note: Note = { id: gitlabId(), author: me, body: String(json(body).body ?? ''), created: Date.now(), resolvable: false, resolved: false };
		mr.discussions.push({ id: discussionId(), notes: [note] });
		touch();
		return { status: 201, json: noteJson(note) };
	}
	if (sub === '/approve' && method === 'POST') {
		if (!mr.approvedBy.includes(me)) {
			mr.approvedBy.push(me);
		}
		touch();
		return { status: 201, json: { approved_by: mr.approvedBy.map(a => ({ user: gitlabUser(a) })) } };
	}
	if (sub === '/unapprove' && method === 'POST') {
		const at = mr.approvedBy.indexOf(me);
		if (at < 0) {
			return { status: 404, json: { message: '404 Not found' } };
		}
		mr.approvedBy.splice(at, 1);
		touch();
		return { status: 201, json: {} };
	}
	if (/^\/reviewers\/\d+$/.test(sub) && method === 'PUT') {
		touch();
		return { json: { user: gitlabUser(me), state: json(body).state ?? 'reviewed' } };
	}
	if (sub === '/merge' && method === 'PUT') {
		const refs = await diffRefs(mr);
		const request = json(body);
		if (mergeStatus(mr) !== 'mergeable') {
			return { status: 405, json: { message: '405 Method Not Allowed' } };
		}
		if (request.sha && request.sha !== refs?.head_sha) {
			return { status: 409, json: { message: 'SHA does not match HEAD of source branch' } };
		}
		mr.state = 'merged';
		mr.mergedSha = refs?.head_sha;
		touch();
		return { json: { ...await mrJson(mr) as object, merge_commit_sha: refs?.head_sha } };
	}
	return undefined;
});

// ---------------------------------------------------------------- SonarQube routes

serve('sonar', ports.sonar, async (req, url) => {
	const p = url.pathname;
	const q = url.searchParams;
	const failing = q.get('pullRequest') === '421';
	if (!p.startsWith('/api/')) {
		return page('Acme SonarQube (demo)', ['Any token signs in as Sam Rivera.']);
	}
	if (!authorized(req, 'authorization')) {
		return { status: 401, json: { errors: [{ msg: 'Authentication required' }] } };
	}
	switch (p) {
		case '/api/authentication/validate':
			return { json: { valid: true } };
		case '/api/users/current':
			return { json: { isLoggedIn: true, login: me.username, name: me.name } };
		case '/api/server/version':
			return { text: '2025.4.0.105899' };
		case '/api/qualitygates/project_status':
			return {
				json: {
					projectStatus: {
						status: failing ? 'ERROR' : 'OK',
						conditions: [{ status: failing ? 'ERROR' : 'OK', metricKey: 'new_coverage', comparator: 'LT', errorThreshold: '80', actualValue: failing ? '62.5' : '91.3' }],
					},
				},
			};
		case '/api/measures/component':
			return { json: { component: { key: q.get('component'), measures: [{ metric: 'coverage', value: failing ? '78.4' : '84.2' }, { metric: 'new_coverage', period: { value: failing ? '62.5' : '91.3' } }] } } };
		case '/api/issues/search':
			return {
				json: {
					issues: failing ? [{ key: 'AZ-demo-1', rule: 'typescript:S3358', severity: 'MAJOR', type: 'CODE_SMELL', message: 'Extract this nested ternary operation into an independent statement.', component: `${q.get('componentKeys')}:src/cart/discount.ts`, line: 14 }] : [],
				},
			};
		case '/api/hotspots/search':
			return { json: { hotspots: [] } };
	}
	return undefined;
});

if (!existsSync(gitRoot)) {
	console.warn(`No repositories in ${gitRoot}: run setup-demo.sh first, or merge request diffs will be empty.`);
}
