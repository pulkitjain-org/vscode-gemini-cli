/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// Plan Review's page: its sections with their marks, a comment added from a
// section's +, a section edited in place (from the keyboard too, never while
// Gemini works, and never over Gemini's newer text), Send and Build in the
// footer, and the banner once Gemini has revised the plan. Then the host's
// side (planReviewPage.ts), with a stand-in agent: the banner goes once the
// revision's own turn is over, comments that never went are unsent again,
// and the state lives in files, moved from global state.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { HTMLButtonElement, HTMLElement, HTMLTextAreaElement } from 'happy-dom';
import type { PlanComment } from '../../src/acp/planReview';
import { PlanReviewStore, type PlanReviewState } from '../../src/acp/planReviewStore';
import type { PlanView } from '../../src/host/planReviewProtocol';
import { fakePanels, fireWatcher, hostExport, page, posted, sendToPage, showPlanReviewPage, startScript } from './pages';

const { document } = page;

const markdown = '# MCP integration plan\n\n## Approach\nAdd an `McpServerStore`.\n\n## Risks\nA server that never answers blocks the start.\n';

function view(extra: Record<string, unknown> = {}) {
	return {
		title: 'MCP integration plan', file: 'mcp-integration-plan.md', agent: 'MCP integration', markdown,
		comments: [], edited: [], revising: false, changed: [], missing: false, busy: false, canBuild: true, ...extra,
	};
}

const query = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T | null;
const all = (selector: string) => [...document.querySelectorAll(selector)] as HTMLElement[];
const button = (text: string) => all('button').find(node => node.textContent?.includes(text)) as HTMLButtonElement | undefined;
const key = (node: HTMLElement, name: string) => node.dispatchEvent(new page.KeyboardEvent('keydown', { key: name, bubbles: true }));
const type = (area: HTMLTextAreaElement, text: string) => {
	area.value = text;
	area.dispatchEvent(new page.Event('input'));
};

beforeAll(async () => {
	await showPlanReviewPage();
	await startScript('planReview');
});

describe('Plan Review page', () => {
	it('shows the plan by section, with the footer\'s Build and Send', () => {
		sendToPage({ type: 'view', view: view() });
		expect({
			ready: posted[0],
			title: query('.plan-title')?.textContent,
			sections: all('.plan-sec').map(node => node.dataset.section),
			send: { disabled: button('Send Comments to Gemini')?.disabled },
			build: { disabled: button('Approve Plan')?.disabled, primary: button('Approve Plan')?.classList.contains('primary') },
		}).toEqual({
			ready: { type: 'ready' },
			title: 'MCP integration plan',
			sections: ['h:mcp integration plan', 'h:approach', 'h:risks'],
			send: { disabled: true },
			build: { disabled: false, primary: true },
		});
	});

	it('adds a comment from a section\'s +, quoting its opening words', () => {
		posted.length = 0;
		(query('.plan-sec[data-section="h:risks"] .plan-add') as HTMLButtonElement).click();
		const area = query<HTMLTextAreaElement>('.plan-comment-box textarea')!;
		area.value = 'Use 3 s and retry in the background.';
		area.dispatchEvent(new page.Event('input'));
		button('Add Comment')!.click();
		expect(posted).toEqual([{ type: 'addComment', section: 'h:risks', quote: 'A server that never answers blocks the start.', text: 'Use 3 s and retry in the background.' }]);
	});

	it('marks a commented section and counts what there is to send', () => {
		sendToPage({ type: 'view', view: view({ comments: [{ id: 'c1', section: 'h:risks', heading: 'Risks', quote: 'A server…', text: 'Use 3 s.', createdAt: 1 }] }) });
		expect({
			marked: all('.plan-sec.has-cm').map(node => node.dataset.section),
			rail: all('.plan-rail .plan-cm-text').map(node => node.textContent),
			send: button('Send Comments to Gemini')?.textContent,
			sendPrimary: button('Send Comments to Gemini')?.classList.contains('primary'),
		}).toEqual({ marked: ['h:risks'], rail: ['Use 3 s.'], send: 'Send Comments to GeminiSend Comments1', sendPrimary: true });
		posted.length = 0;
		button('Send Comments to Gemini')!.click();
		expect(posted).toEqual([{ type: 'send' }]);
	});

	it('edits a section in place and saves it', () => {
		posted.length = 0;
		(query('.plan-sec[data-section="h:approach"] .plan-content') as HTMLElement).click();
		const area = query<HTMLTextAreaElement>('.plan-editor textarea')!;
		expect(area.value).toBe('## Approach\nAdd an `McpServerStore`.');
		area.value = '## Approach\nExtend teamToolsMcp.ts.';
		area.dispatchEvent(new page.Event('input'));
		button('Done')!.click();
		expect(posted).toEqual([{ type: 'saveSection', section: 'h:approach', markdown: '## Approach\nExtend teamToolsMcp.ts.', original: '## Approach\nAdd an `McpServerStore`.' }]);
	});

	it('says Gemini is revising, then which sections it changed', () => {
		const sent = [{ id: 'c1', section: 'h:risks', heading: 'Risks', quote: 'A server…', text: 'Use 3 s.', createdAt: 1, sentAt: 2 }];
		sendToPage({ type: 'view', view: view({ comments: sent, revising: true, canBuild: false }) });
		const revising = query('.plan-banner')?.textContent;
		sendToPage({ type: 'view', view: view({ comments: sent, changed: ['h:risks'] }) });
		expect({
			revising,
			revised: query('.plan-banner')?.textContent,
			changed: all('.plan-sec.changed').map(node => node.dataset.section),
			sentCard: query('.plan-rail .plan-cm-on')?.textContent,
		}).toEqual({
			revising: 'Comments sent. Gemini is revising the plan; the page updates when it\'s done.',
			revised: 'Gemini revised the plan: 1 section changed.Show What ChangedClear Sent Comments',
			changed: ['h:risks'],
			sentCard: 'On “Risks” · sent',
		});
	});

	it('edits a section from the keyboard, and not while Gemini works', () => {
		sendToPage({ type: 'view', view: view() });
		const content = query('.plan-sec[data-section="h:risks"] .plan-content')!;
		const reachable = { role: content.getAttribute('role'), tabIndex: content.tabIndex };
		key(content, 'Enter');
		const opened = query<HTMLTextAreaElement>('.plan-editor textarea')?.value;
		key(query('.plan-editor textarea')!, 'Escape');
		sendToPage({ type: 'view', view: view({ busy: true }) });
		const busy = query('.plan-sec[data-section="h:risks"] .plan-content')!;
		key(busy, ' ');
		expect({ reachable, opened, busy: { disabled: busy.getAttribute('aria-disabled'), editor: !!query('.plan-editor') } }).toEqual({
			reachable: { role: 'button', tabIndex: 0 },
			opened: '## Risks\nA server that never answers blocks the start.',
			busy: { disabled: 'true', editor: false },
		});
	});

	it('saves an open edit before another section is edited, and keeps it open for a comment', () => {
		sendToPage({ type: 'view', view: view() });
		posted.length = 0;
		(query('.plan-sec[data-section="h:approach"] .plan-content') as HTMLElement).click();
		type(query<HTMLTextAreaElement>('.plan-editor textarea')!, '## Approach\nExtend teamToolsMcp.ts.');
		(query('.plan-sec[data-section="h:risks"] .plan-add') as HTMLButtonElement).click();
		const withComment = { editor: query<HTMLTextAreaElement>('.plan-editor textarea')?.value, box: !!query('.plan-comment-box') };
		(all('.plan-comment-box button').find(node => node.textContent === 'Cancel') as HTMLButtonElement).click();
		(query('.plan-sec[data-section="h:risks"] .plan-content') as HTMLElement).click();
		expect({ withComment, posted, editing: query('.plan-editor')?.closest('.plan-sec')?.getAttribute('data-section') }).toEqual({
			withComment: { editor: '## Approach\nExtend teamToolsMcp.ts.', box: true },
			posted: [{ type: 'saveSection', section: 'h:approach', markdown: '## Approach\nExtend teamToolsMcp.ts.', original: '## Approach\nAdd an `McpServerStore`.' }],
			editing: 'h:risks',
		});
		key(query('.plan-editor textarea')!, 'Escape');
	});

	it('keeps the user\'s text in the editor when Gemini changed the section meanwhile', () => {
		const theirs = '## Approach\nAdd an `McpServerStore`, read at startup.';
		sendToPage({ type: 'view', view: view({ markdown: markdown.replace('Add an `McpServerStore`.', 'Add an `McpServerStore`, read at startup.') }) });
		sendToPage({ type: 'conflict', section: 'h:approach', mine: '## Approach\nExtend teamToolsMcp.ts.', theirs });
		const area = query<HTMLTextAreaElement>('.plan-editor textarea')!;
		const notice = query('.plan-conflict span')?.textContent;
		button('Show New Text')!.click();
		const shown = query('.plan-theirs')?.textContent;
		posted.length = 0;
		button('Done')!.click();
		expect({ mine: area.value, notice, shown, posted }).toEqual({
			mine: '## Approach\nExtend teamToolsMcp.ts.',
			notice: 'Gemini changed this section while you were editing, so your edit wasn\'t saved. Your text is still here: Done now saves it over Gemini\'s.',
			shown: theirs,
			// Done again is the user's choice to put theirs over Gemini's.
			posted: [{ type: 'saveSection', section: 'h:approach', markdown: '## Approach\nExtend teamToolsMcp.ts.', original: theirs }],
		});
	});

	it('keeps an error, and the text that wasn\'t saved, through the next view', () => {
		sendToPage({ type: 'error', message: 'That section is no longer there.', text: '## Gone\nMy words.' });
		sendToPage({ type: 'view', view: view() });
		expect({ error: query('.plan-banner.error .plan-banner-text')?.textContent, kept: query<HTMLTextAreaElement>('.plan-kept')?.value }).toEqual({ error: 'That section is no longer there.', kept: '## Gone\nMy words.' });
	});

	it('edits a comment from the panel in the panel\'s card', () => {
		sendToPage({ type: 'view', view: view({ comments: [{ id: 'c1', section: 'h:risks', heading: 'Risks', quote: 'A server…', text: 'Use 3 s.', createdAt: 1 }] }) });
		const rail = all('.plan-rail button').find(node => node.textContent === 'Edit')!;
		rail.click();
		const active = document.activeElement as HTMLElement | null;
		expect({ inRail: !!active?.closest('.plan-rail'), value: (active as HTMLTextAreaElement | null)?.value }).toEqual({ inRail: true, value: 'Use 3 s.' });
		key(active!, 'Escape');
	});

	it('says when the plan file is gone', () => {
		sendToPage({ type: 'view', view: view({ markdown: '', missing: true }) });
		expect(query('.plan-empty')?.textContent).toBe('The plan file isn\'t there any more: it was moved or deleted.');
	});
});

describe('Plan Review host', () => {
	const settle = () => new Promise(resolve => setTimeout(resolve, 30));
	/** Waits until the host's file work makes `check` true. */
	const until = (check: () => unknown) => vi.waitFor(() => {
		if (!check()) {
			throw new Error('Not yet');
		}
	}, { timeout: 3000, interval: 10 });
	const views = (posts: { type: string;[key: string]: unknown }[]) => posts.filter(each => each.type === 'view').map(each => each.view as PlanView);
	const lastView = (posts: { type: string;[key: string]: unknown }[]) => views(posts).at(-1);
	const revised = markdown.replace('blocks the start.', 'waits 3 s, then retries in the background.');
	const comment = { type: 'addComment', section: 'h:risks', quote: 'A server that never answers blocks the start.', text: 'Use 3 s and retry in the background.' };
	type Reviews = { open(agentId: string, file: string): Promise<void> };

	/**
	 * A plan file and its review, opened for an agent that `send` drives:
	 * by default an idle agent, whose message's turn revises the plan.
	 */
	async function openReview(options: { legacy?: unknown; stored?: PlanReviewState; busy?: boolean; missing?: boolean; send?: (turn: (on: boolean) => void, file: string) => Promise<boolean> } = {}) {
		const folder = mkdtempSync(path.join(tmpdir(), 'plan-review-'));
		const file = path.join(folder, 'plan.md');
		if (!options.missing) {
			writeFileSync(file, markdown);
		}
		const storage = path.join(folder, 'state');
		if (options.stored) {
			await new PlanReviewStore(storage).write(file, options.stored);
		}
		const state = new Map<string, unknown>(options.legacy ? [[`gemini.planReview:${file}`, options.legacy]] : []);
		const listeners: ((id: string) => void)[] = [];
		let busy = !!options.busy;
		const turn = (on: boolean) => {
			busy = on;
			listeners.forEach(listener => listener('a1'));
		};
		const PlanReviews = await hostExport<new (host: unknown) => Reviews>('src/host/planReviewPage.ts', 'PlanReviews');
		const reviews = new PlanReviews({
			extensionUri: 'extension',
			storageFolder: storage,
			globalState: { keys: () => [...state.keys()], get: (key: string) => state.get(key), update: async (key: string, value: unknown) => void (value === undefined ? state.delete(key) : state.set(key, value)) },
			title: () => 'MCP integration',
			column: async () => 1,
			busy: () => busy,
			canBuild: () => !busy,
			send: options.send ? () => options.send!(turn, file) : async () => {
				// An idle agent: the message's turn revises the plan, and the send resolves once it is over, as the chat's does.
				turn(true);
				writeFileSync(file, revised);
				turn(false);
				return true;
			},
			build: async () => true,
			showDiff: async () => undefined,
			onDidChangeAgent: (listener: (id: string) => void) => (listeners.push(listener), { dispose() { } }),
		});
		await reviews.open('a1', file);
		const panel = fakePanels().at(-1)!;
		panel.receive!({ type: 'ready' });
		await until(() => views(panel.posted).length);
		return { reviews, panel, file, folder, storage, state, turn, done: () => rmSync(folder, { recursive: true, force: true }) };
	}

	it('clears Revising once the turn the comments started is over, and marks what changed', async () => {
		const { panel, done } = await openReview();
		panel.receive!(comment);
		await until(() => lastView(panel.posted)?.comments.length);
		panel.receive!({ type: 'send' });
		await until(() => lastView(panel.posted)?.changed.length);
		done();
		expect({ revising: lastView(panel.posted)?.revising, changed: lastView(panel.posted)?.changed }).toEqual({ revising: false, changed: ['h:risks'] });
	});

	it('sent while the agent works, waits for its own turn, not the one running', async () => {
		let sent!: (went: boolean) => void;
		let turn!: (on: boolean) => void;
		const { panel, file, done } = await openReview({ busy: true, send: (each) => new Promise<boolean>(resolve => (turn = each, sent = resolve)) });
		panel.receive!(comment);
		await until(() => lastView(panel.posted)?.comments.length);
		panel.receive!({ type: 'send' });
		await until(() => lastView(panel.posted)?.revising);
		const queued = lastView(panel.posted)?.revising;
		// The running turn ends, then the review's own turn runs and changes the plan.
		turn(false);
		await settle();
		const afterRunning = lastView(panel.posted)?.revising;
		turn(true);
		writeFileSync(file, revised);
		turn(false);
		sent(true);
		await until(() => !lastView(panel.posted)?.revising);
		done();
		expect({ queued, afterRunning, revising: lastView(panel.posted)?.revising, changed: lastView(panel.posted)?.changed }).toEqual({ queued: true, afterRunning: true, revising: false, changed: ['h:risks'] });
	});

	it('leaves the comments unsent when the message never went', async () => {
		const { panel, done } = await openReview({ busy: true, send: async () => false });
		panel.receive!(comment);
		await until(() => lastView(panel.posted)?.comments.length);
		panel.receive!({ type: 'send' });
		await until(() => panel.posted.at(-1)?.type === 'error');
		done();
		const last = lastView(panel.posted)!;
		expect({ revising: last.revising, sent: last.comments.map((each: PlanComment) => each.sentAt), error: panel.posted.at(-1)?.type }).toEqual({ revising: false, sent: [undefined], error: 'error' });
	});

	it('won\'t save a section over the agent\'s newer text', async () => {
		const { panel, file, done } = await openReview();
		const agents = markdown.replace('Add an `McpServerStore`.', 'Add an `McpServerStore`, read at startup.');
		writeFileSync(file, agents);
		panel.receive!({ type: 'saveSection', section: 'h:approach', markdown: '## Approach\nExtend teamToolsMcp.ts.', original: '## Approach\nAdd an `McpServerStore`.' });
		await until(() => panel.posted.at(-1)?.type === 'conflict');
		const text = readFileSync(file, 'utf8');
		done();
		expect({ file: text === agents, posted: panel.posted.at(-1) }).toEqual({
			file: true,
			posted: { type: 'conflict', section: 'h:approach', mine: '## Approach\nExtend teamToolsMcp.ts.', theirs: '## Approach\nAdd an `McpServerStore`, read at startup.' },
		});
	});

	it('says so, after the view, when the section is gone, and hands back the text', async () => {
		const { panel, done } = await openReview();
		panel.receive!({ type: 'saveSection', section: 'h:gone', markdown: '## Gone\nMy words.', original: '## Gone' });
		await until(() => panel.posted.at(-1)?.type === 'error');
		done();
		expect(panel.posted.slice(-2).map(each => each.type === 'error' ? { type: each.type, text: each.text } : { type: each.type })).toEqual([{ type: 'view' }, { type: 'error', text: '## Gone\nMy words.' }]);
	});

	it('reads the file again after its own write is seen, so a later identical write counts', async () => {
		const { panel, done } = await openReview();
		panel.receive!({ type: 'saveSection', section: 'h:approach', markdown: '## Approach\nExtend teamToolsMcp.ts.', original: '## Approach\nAdd an `McpServerStore`.' });
		await until(() => panel.posted.some(each => each.type === 'saved'));
		await settle();
		const counts = [views(panel.posted).length];
		fireWatcher();
		await settle();
		counts.push(views(panel.posted).length);
		fireWatcher();
		await until(() => views(panel.posted).length > counts[1]);
		counts.push(views(panel.posted).length);
		done();
		expect([counts[1] - counts[0], counts[2] - counts[1]]).toEqual([0, 1]);
	});

	it('shows one page for two quick opens of the same plan', async () => {
		const { reviews, panel, file, done } = await openReview();
		const before = fakePanels().length;
		await Promise.all([reviews.open('a1', file), reviews.open('a1', file)]);
		done();
		expect({ panels: fakePanels().length - before, same: fakePanels().at(-1) === panel }).toEqual({ panels: 0, same: true });
	});

	it('moves a review out of global state', async () => {
		const legacy = { comments: [{ id: 'c1', section: 'h:risks', quote: 'A server…', text: 'Use 3 s.', createdAt: 1 }], edited: ['h:approach'] };
		const { panel, file, storage, state, done } = await openReview({ legacy });
		const kept = await new PlanReviewStore(storage).read(file);
		done();
		expect({ view: lastView(panel.posted)?.comments.length, legacyKeys: [...state.keys()], kept: { comments: kept.comments.map(each => each.id), edited: kept.edited } }).toEqual({ view: 1, legacyKeys: [], kept: { comments: ['c1'], edited: ['h:approach'] } });
	});

	it('unsends comments a reloaded window was still sending, rather than count them sent', async () => {
		const sent = { id: 'c1', section: 'h:risks', quote: 'A server…', text: 'Use 3 s.', createdAt: 1, sentAt: 2 };
		const { panel, done } = await openReview({ stored: { comments: [sent], edited: [], before: markdown, revising: true, changed: [], unsend: { sentAt: 2, edited: ['h:approach'] } } });
		await until(() => panel.posted.at(-1)?.type === 'error');
		done();
		const last = lastView(panel.posted)!;
		expect({ revising: last.revising, sent: last.comments.map((each: PlanComment) => each.sentAt), edited: last.edited }).toEqual({ revising: false, sent: [undefined], edited: ['h:approach'] });
	});

	it('says the plan file is missing, and keeps an edit that can\'t be saved', async () => {
		const { panel, done } = await openReview({ missing: true });
		const missing = lastView(panel.posted)?.missing;
		panel.receive!({ type: 'saveSection', section: 'h:approach', markdown: '## Approach\nMine.', original: '## Approach' });
		await until(() => panel.posted.at(-1)?.type === 'error');
		done();
		expect({ missing, error: panel.posted.at(-1) }).toEqual({ missing: true, error: { type: 'error', message: 'The plan file isn\'t there any more, so your edit wasn\'t saved. Here is your text.', text: '## Approach\nMine.' } });
	});
});
