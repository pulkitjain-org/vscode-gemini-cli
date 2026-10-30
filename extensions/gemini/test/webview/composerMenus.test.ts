/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// The composer's menus and footer: the mode menu's suggestion, Build This
// Plan's chevron, Commit to a branch with its message box, the usage
// popover's context breakdown, the @ picker's groups, and which key sends.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HTMLElement, HTMLTextAreaElement } from 'happy-dom';
import type { TranscriptItem } from '../../src/acp/chatTranscript';
import { page, posted, sendToPage, showChatPage, startScript } from './pages';

const { document } = page;
const byId = (id: string) => document.getElementById(id) as HTMLElement;
const input = () => byId('input') as unknown as HTMLTextAreaElement;
const texts = (nodes: Iterable<HTMLElement>) => [...nodes].map(node => node.textContent);
const settings = {
	mode: { currentId: 'plan', available: ['default', 'autoEdit', 'plan'].map(id => ({ id, name: { default: 'Default', autoEdit: 'Auto Edit', plan: 'Plan' }[id]!, description: 'from the CLI' })) },
};
const git = { branch: 'feature/login', canCommit: true, commitTo: 'feature/login', recommendMode: 'autoEdit' };

beforeAll(async () => {
	await showChatPage();
	await startScript('chat');
	sendToPage({ type: 'reset', items: [], busy: false, status: { phase: 'ready', text: '' }, settings });
});

beforeEach(() => {
	posted.length = 0;
});

describe('the mode menu', () => {
	it('says what each mode does in GeminiCode\'s words, and tags Auto Edit where it is recommended, without switching to it', () => {
		sendToPage({ type: 'git', git });
		byId('plus').click();
		const rows = [...byId('plus-menu').querySelectorAll('.menu-row')].filter(row => row.querySelector('.codicon-shield, .codicon-edit, .codicon-checklist')) as HTMLElement[];
		expect({
			rows: rows.map(row => [row.querySelector('.menu-name')?.textContent, row.querySelector('.menu-badge')?.textContent ?? null, row.querySelector('.menu-detail')?.textContent]),
			switched: posted.some(message => message.type === 'setMode'),
		}).toEqual({
			rows: [
				['Default', null, 'Asks before every change and command'],
				['Auto Edit', 'Recommended here', 'Edits apply at once; review them with Keep and Undo. Commands still ask.'],
				['Plan', null, 'Reads and plans; changes nothing'],
			],
			switched: false,
		});
		byId('plus').click();
	});
});

describe('the model menu', () => {
	it('ends in Set as Default for the CLI, which asks the host to save the session\'s model', () => {
		const model = { currentId: 'gemini-3.8-flash', available: [{ id: 'auto', name: 'Auto', description: 'routes' }, { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', description: 'fast' }] };
		sendToPage({ type: 'settings', settings: { ...settings, model } });
		byId('plus').click();
		const modelRow = [...byId('plus-menu').querySelectorAll('.menu-row')].find(row => row.querySelector('.menu-name')?.textContent === 'Model') as HTMLElement;
		modelRow.click();
		const rows = [...byId('plus-menu').querySelectorAll('.menu-row')] as HTMLElement[];
		const last = rows[rows.length - 1];
		last.click();
		expect({
			names: rows.map(row => row.querySelector('.menu-name')?.textContent),
			posted: posted.filter(message => message.type === 'setCliDefaultModel'),
		}).toEqual({
			names: ['Back', 'Auto', 'Gemini 3.8 Flash', 'Set as Default for the CLI'],
			posted: [{ type: 'setCliDefaultModel', id: 'gemini-3.8-flash' }],
		});
		sendToPage({ type: 'settings', settings });
	});
});

describe('Approve Plan', () => {
	it('approves in the mode before Plan, offers the CLI\'s choices on its chevron, and names both models when they differ', () => {
		const items: TranscriptItem[] = [
			{ id: 'u1', kind: 'user', text: 'Plan the lockout' },
			{ id: 'a1', kind: 'agent', text: '1. Add a test for the lockout window.' },
			{ id: 'e1', kind: 'turnEnd', durationMs: 1000, buildPlan: true, build: { mode: 'autoEdit', other: 'default', models: { plan: 'gemini-3-pro', build: 'gemini-3.8-flash' } } },
		];
		sendToPage({ type: 'items', items });
		const end = document.querySelector('.turn-end') as HTMLElement;
		const chevron = end.querySelector('.plan-build-more') as HTMLElement;
		chevron.click();
		const menu = document.querySelector('.plan-build-menu') as HTMLElement;
		const rows = [...menu.querySelectorAll('.menu-row')] as HTMLElement[];
		const shown = {
			models: end.querySelector('.plan-build-models')?.textContent,
			rows: rows.map(row => [row.querySelector('.menu-name')?.textContent, row.querySelector('.menu-detail')?.textContent, row.getAttribute('aria-checked')]),
		};
		rows[1].click();
		expect({ ...shown, posted: posted.filter(message => message.type === 'buildPlan'), closed: menu.hidden }).toEqual({
			models: 'Builds with gemini-3.8-flash; planned with gemini-3-pro.',
			rows: [['Yes, automatically accept edits', 'Build in Auto Edit', 'true'], ['Yes, manually accept edits', 'Build, Asking for Each Edit', 'false'], ['Not yet', undefined, null]],
			posted: [{ type: 'buildPlan', itemId: 'e1', mode: 'default' }],
			closed: true,
		});
	});
});

describe('Commit', () => {
	it('commits to the branch it is on with a message the extension writes, and offers a new branch on its chevron', () => {
		sendToPage({ type: 'git', git });
		const box = byId('commit-box');
		const message = box.querySelector('textarea') as unknown as HTMLTextAreaElement;
		const confirm = box.querySelector('.commit-confirm') as HTMLElement & { disabled: boolean };
		byId('commit').click();
		const writing = { label: byId('commit').textContent, open: !box.hidden, note: box.querySelector('.commit-note')?.textContent, disabled: confirm.disabled };
		sendToPage({ type: 'commitMessage', message: 'Add per-IP rate limiting to the login endpoint' });
		const written = { message: message.value, note: box.querySelector('.commit-note')?.textContent, disabled: confirm.disabled };
		message.value = 'Rate-limit login attempts';
		message.dispatchEvent(new page.Event('input'));
		confirm.click();
		sendToPage({ type: 'commitDone', ok: true });
		byId('commit-more').click();
		const menuRows = texts(byId('commit-menu').querySelectorAll('.menu-name') as Iterable<HTMLElement>);
		(byId('commit-menu').querySelector('.menu-row') as HTMLElement).click();
		expect({ writing, written, closed: box.hidden, menuRows, posted }).toEqual({
			writing: { label: 'Commit to feature/login', open: true, note: 'Writing a commit message…', disabled: true },
			written: { message: 'Add per-IP rate limiting to the login endpoint', note: 'Generated from the changes · edit before committing', disabled: false },
			closed: true,
			menuRows: ['Create Branch and Commit…'],
			posted: [{ type: 'writeCommitMessage' }, { type: 'commitToBranch', message: 'Rate-limit login attempts' }, { type: 'createBranchAndCommit' }],
		});
	});

	it('stays Create Branch & Commit on the default branch', () => {
		sendToPage({ type: 'git', git: { branch: 'main', canCommit: true } });
		byId('commit').click();
		expect({ label: byId('commit').textContent, chevron: byId('commit-more').hidden, box: byId('commit-box').hidden, posted })
			.toEqual({ label: 'Commit…', chevron: true, box: true, posted: [{ type: 'createBranchAndCommit' }] });
	});
});

describe('the usage popover\'s context breakdown', () => {
	it('shows each part, the rule files with a warning for a large one, and measures again on request; /context only opens it', () => {
		sendToPage({ type: 'context', context: { used: 398_000, limit: 1_048_576, cached: 0, canCompact: false } });
		sendToPage({ type: 'toggleUsage', open: true });
		sendToPage({
			type: 'contextBreakdown', breakdown: {
				state: 'ready', measuredAt: Date.now(),
				parts: { cli: 9_000, rules: 18_000, geminicode: 11_000, servers: 3, serverTokens: 61_000, total: 99_000 },
				rules: [{ name: 'GEMINI.md', path: '/w/GEMINI.md', bytes: 70_656 }, { name: 'AGENTS.md', path: '/w/AGENTS.md', bytes: 4_096 }],
			},
		});
		sendToPage({ type: 'toggleUsage', open: true });
		const popover = byId('usage-popover');
		const parts = popover.querySelector('.context-parts') as HTMLElement;
		const shown = {
			open: !popover.hidden,
			readQuota: posted.filter(message => message.type === 'readQuota').length,
			parts: [...parts.querySelectorAll(':scope > .usage-row:not(.context-foot)')].map(row => row.textContent),
			rules: [...parts.querySelectorAll('.context-rule')].map(row => [row.textContent, row.classList.contains('large')]),
			warning: parts.querySelector('.context-warning')?.textContent,
		};
		(parts.querySelector('.context-foot .usage-more') as HTMLElement).click();
		expect({ ...shown, measure: posted.filter(message => message.type === 'measureContext').length }).toEqual({
			open: true,
			readQuota: 1,
			parts: ['Conversation299K', 'MCP servers (3)61K', 'Rule files (2)18K', 'GeminiCode tools11K', 'CLI system prompt9K'],
			rules: [['GEMINI.md69 KB · about 18K tokens', true], ['AGENTS.md4 KB', false]],
			warning: 'GEMINI.md is large: every turn carries it. Trim it or split it with @imports.',
			measure: 1,
		});
		page.dispatchEvent(new page.KeyboardEvent('keydown', { key: 'Escape' }));
		document.dispatchEvent(new page.KeyboardEvent('keydown', { key: 'Escape' }));
	});
});

describe('the @ picker', () => {
	it('groups files, folders, symbols and the Workspace rows, and has the extension attach the ones it makes', () => {
		const field = input();
		field.focus();
		field.value = 'fix @log';
		field.setSelectionRange(field.value.length, field.value.length);
		field.dispatchEvent(new page.Event('input'));
		const search = posted.findLast(message => message.type === 'searchFiles');
		const problems = { kind: 'problems', errors: 3, warnings: 2 };
		sendToPage({
			type: 'files', requestId: search?.requestId, files: [{ path: '/w/src/auth/login.ts', relative: 'src/auth/login.ts' }], mentions: [
				{ kind: 'folder', path: '/w/src/auth', relative: 'src/auth' },
				{ kind: 'symbol', name: 'loginHandler', symbolKind: 'function', path: '/w/src/auth/login.ts', relative: 'src/auth/login.ts', line: 42, endLine: 60 },
				problems,
				{ kind: 'terminal', command: 'npm test', failed: true },
			],
		});
		const picker = byId('picker');
		const shown = {
			headings: texts(picker.querySelectorAll('.picker-heading') as Iterable<HTMLElement>),
			rows: [...picker.querySelectorAll('.picker-row')].map(row => [row.querySelector('.picker-name')?.textContent, row.querySelector('.picker-folder')?.textContent]),
		};
		field.value = 'fix @';
		field.setSelectionRange(field.value.length, field.value.length);
		field.dispatchEvent(new page.Event('input'));
		const next = posted.findLast(message => message.type === 'searchFiles');
		sendToPage({ type: 'files', requestId: next?.requestId, files: [], mentions: [problems] });
		(picker.querySelector('.picker-row') as HTMLElement).dispatchEvent(new page.MouseEvent('mousedown', { bubbles: true }));
		expect({ ...shown, attach: posted.filter(message => message.type === 'attachMention'), text: field.value }).toEqual({
			headings: ['Files', 'Folders', 'Symbols'],
			rows: [['login.ts', 'src/auth'], ['src/auth', ''], ['loginHandler', 'src/auth/login.ts:42']],
			attach: [{ type: 'attachMention', mention: problems }],
			text: 'fix ',
		});
		field.value = '';
	});
});

describe('the send key', () => {
	it('sends with ⌘Return, and makes a new line with Return, when gemini.chat.sendWith is cmdEnter', () => {
		const field = input();
		sendToPage({ type: 'sendWith', cmdEnter: true });
		field.value = 'hello';
		field.dispatchEvent(new page.Event('input'));
		const enter = new page.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		field.dispatchEvent(enter);
		const afterEnter = posted.filter(message => message.type === 'prompt').length;
		const mac = /Mac/.test(page.navigator.platform);
		field.dispatchEvent(new page.KeyboardEvent('keydown', { key: 'Enter', metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
		sendToPage({ type: 'sendWith', cmdEnter: false });
		expect({ afterEnter, newLine: !enter.defaultPrevented, sent: posted.filter(message => message.type === 'prompt').map(message => message.text) })
			.toEqual({ afterEnter: 0, newLine: true, sent: ['hello'] });
	});
});
