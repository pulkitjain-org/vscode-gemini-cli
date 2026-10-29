/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @vitest-environment happy-dom

// A project thread's card through a try: the step it is at, its line, its
// buttons with their tooltips, the ⋯ menu's rows and the first-try guide.

import { beforeAll, describe, expect, it } from 'vitest';
import type { HTMLButtonElement, HTMLElement } from 'happy-dom';
import type { ThreadCard } from '../../src/acp/chatTranscript';
import type { FromWebview } from '../../src/host/chatProtocol';
import type { ProjectChatStrings } from '../../src/host/chatStrings';
import { hostExport, page, startScript } from './pages';

const { document } = page;
/** The card's module, webview-src/threadCard.ts, and what it is given (`ThreadCardDeps`). */
type Deps = Record<string, unknown>;
let renderThreadCard: (item: ThreadCard, deps: Deps, card: HTMLElement) => void;
let strings: ProjectChatStrings;
const posted: FromWebview[] = [];
const tips = new Map<HTMLElement, string>();
/** The ⋯ menu as the card made it: its element, the rows it last opened with, and whether it is open. */
const menu: { element?: HTMLElement; rows: readonly { name: string; run(): void }[]; open: boolean } = { rows: [], open: false };

beforeAll(async () => {
	strings = (await hostExport<() => ProjectChatStrings>('src/host/chat/projectStrings.ts', 'projectStrings'))();
	renderThreadCard = (await startScript('threadCard')).renderThreadCard as typeof renderThreadCard;
});

function deps(): Deps {
	const el = (tag: string, className?: string, text?: string) => {
		const node = document.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		return node;
	};
	return {
		strings,
		post: (message: FromWebview) => posted.push(message),
		el,
		button: (className: string, label: string, onClick: () => void) => {
			const node = el('button', className, label);
			node.addEventListener('click', onClick);
			return node;
		},
		icon: (name: string) => el('i', `codicon codicon-${name}`),
		setTip: (node: HTMLElement, tip: string) => tips.set(node, tip),
		onIntent: () => undefined,
		toneOf: (node: HTMLElement) => node,
		counts: (added: number, removed: number) => el('span', 'thread-counts', `+${added} -${removed}`),
		format: (template: string, ...values: (string | number)[]) => template.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)])),
		formatDuration: () => '2h',
		Menu: class {
			private anchor: HTMLElement | undefined;
			constructor(private readonly options: { element: HTMLElement; onOpen?(): void; sections(query: string): readonly { rows: readonly { name: string; run(): void }[] }[] }) {
				menu.element = options.element;
			}
			setAnchor(anchor: HTMLElement): void {
				this.anchor = anchor;
			}
			isOpenFrom(anchor: HTMLElement): boolean {
				return menu.open && this.anchor === anchor;
			}
			open(): void {
				menu.open = true;
				this.options.onOpen?.();
				menu.rows = this.options.sections('').flatMap(section => section.rows);
			}
			close(): void {
				menu.open = false;
			}
		},
	};
}

const base: ThreadCard = { id: 'thread-t1', kind: 'thread', thread: 't1', title: 'Assess Menu & Header Revamp', state: 'done', branch: 'gemini/assess-menu', changes: { files: 7, added: 870, removed: 82 }, startedAt: 0 };

function draw(item: ThreadCard) {
	const card = document.createElement('div');
	renderThreadCard(item, deps(), card);
	const buttons = [...card.querySelectorAll('.permission-actions button')] as HTMLButtonElement[];
	return {
		card,
		step: card.querySelector('.thread-step.now')?.textContent ?? null,
		line: card.querySelector('.thread-line')?.textContent,
		buttons: buttons.map(button => button.textContent || button.getAttribute('aria-label')),
		primary: buttons.find(button => button.classList.contains('primary'))?.textContent,
	};
}

describe('thread card', () => {
	it('walks a thread through Try in Workspace, an update, and Keep Changes', () => {
		const done = draw(base);
		const trying = draw({ ...base, tried: { state: 'trying', files: 7 }, guide: true });
		const working = draw({ ...base, state: 'working', tried: { state: 'trying', files: 7 } });
		const updated = draw({ ...base, tried: { state: 'trying', files: 8, updates: 1, edits: ['src/header.tsx'] } });
		const kept = draw({ ...base, tried: { state: 'kept', files: 8 } });
		expect([done, trying, working, updated, kept].map(({ step, line, buttons, primary }) => ({ step, line, buttons, primary }))).toEqual([
			{ step: 'In the thread', line: 'Done · 7 files changed in its own folder', buttons: ['Try in Workspace', 'Review Changes', 'More'], primary: 'Try in Workspace' },
			{ step: 'Trying in your workspace', line: 'In your workspace: 7 files, unstaged.', buttons: ['Keep Changes', 'Take Back', 'Ask for Changes', 'More'], primary: 'Keep Changes' },
			{ step: 'Trying in your workspace', line: 'Working on your request. Your workspace updates when it finishes.', buttons: ['Open', 'Stop', 'Take Back'], primary: undefined },
			{ step: 'Trying in your workspace', line: 'In your workspace: 8 files, unstaged. Updated after each turn: 1 so far. You changed header.tsx yourself.', buttons: ['Keep Changes', 'Take Back', 'Ask for Changes', 'Send My Edits to the Thread', 'More'], primary: 'Keep Changes' },
			{ step: 'Kept', line: 'Kept: 8 files, unstaged in your workspace. The thread is finished.', buttons: ['Ask for Changes', 'More'], primary: 'Ask for Changes' },
		]);
		expect(trying.card.querySelector('.thread-guide')?.textContent).toContain('How trying works');
	});

	it('pauses on a conflict, offers Restore once discarded, and says Removed with no buttons', () => {
		const paused = draw({ ...base, tried: { state: 'trying', files: 7, conflicts: ['src/header.tsx'], edits: ['src/menu.tsx'] } });
		const discarded = draw({ ...base, discarded: true });
		const removed = draw({ ...base, removed: true });
		expect([paused, discarded, removed].map(({ step, line, buttons }) => ({ step, line, buttons }))).toEqual([
			{ step: 'Trying in your workspace', line: 'Updating is paused: header.tsx has conflict markers to resolve.', buttons: ['Open the Conflict', 'Send My Edits to the Thread', 'Take Back', 'More'] },
			{ step: null, line: 'Discarded. Its folder is back where it started; the work is saved.', buttons: ['Restore Discarded Work', 'Open', 'Remove Thread…'] },
			{ step: null, line: 'Removed: its branch and folder are gone', buttons: [] },
		]);
	});

	it('gives every button a tooltip, and sends what was clicked; the ⋯ menu has the rest', () => {
		posted.length = 0;
		const { card } = draw({ ...base, tried: { state: 'trying', files: 7 } });
		const buttons = [...card.querySelectorAll('.permission-actions button')] as HTMLButtonElement[];
		buttons.find(button => button.textContent === 'Keep Changes')!.click();
		buttons.find(button => button.classList.contains('thread-more'))!.click();
		// In the page's body, the menu is placed by its button, or it opens out of sight.
		const placed = { className: menu.element?.className, top: menu.element?.style.top, left: menu.element?.style.left };
		menu.rows.find(row => row.name === 'Run Checks There')!.run();
		expect({
			tips: buttons.map(button => tips.get(button)?.split('.')[0]),
			posted,
			rows: menu.rows.map(row => row.name),
			placed,
			open: menu.open,
		}).toEqual({
			tips: ['Make these changes yours and finish the thread', 'Remove this thread\'s changes from your workspace', 'Open the thread\'s chat to ask for changes', 'More'],
			posted: [{ type: 'threadAction', thread: 't1', action: 'keep' }, { type: 'threadAction', thread: 't1', action: 'checks' }],
			rows: ['How Trying Works', 'Open Terminal in Thread Folder', 'Run Checks There', 'Discard Changes…', 'Remove Thread…'],
			placed: { className: 'thread-menu', top: '4px', left: '8px' },
			open: false,
		});
	});

	it('says one file in the singular, and names a file an update couldn\'t merge without pausing', () => {
		const one = draw({ ...base, changes: { files: 1, added: 2, removed: 0 } });
		const unmerged = draw({ ...base, tried: { state: 'trying', files: 7, unmerged: ['assets/logo.png'] } });
		expect([one, unmerged].map(({ card, line, buttons }) => ({ paused: card.classList.contains('paused'), line, buttons }))).toEqual([
			{ paused: false, line: 'Done · 1 file changed in its own folder', buttons: ['Try in Workspace', 'Review Changes', 'More'] },
			{ paused: false, line: 'In your workspace: 7 files, unstaged. Couldn\'t merge logo.png with your edits (a binary file, a link, or deleted on one side), so it\'s as you had it.', buttons: ['Keep Changes', 'Take Back', 'Ask for Changes', 'More'] },
		]);
	});

	it('offers work discarded before later turns from the ⋯ menu', () => {
		const { card } = draw({ ...base, restorable: true });
		(card.querySelector('.thread-more') as HTMLButtonElement).click();
		expect(menu.rows.map(row => row.name)).toEqual(['Open Terminal in Thread Folder', 'Run Checks There', 'Discard Changes…', 'Restore Discarded Work', 'Remove Thread…']);
		menu.rows.find(row => row.name === 'Restore Discarded Work')!.run();
		expect(posted.at(-1)).toEqual({ type: 'threadAction', thread: 't1', action: 'restore' });
	});

	it('offers only Open for a thread that only planned', () => {
		expect(draw({ ...base, changes: undefined }).buttons).toEqual(['Open', 'More']);
	});

	it('offers the merge commit instead when Merge Back makes one', () => {
		expect(draw({ ...base, mergeCommits: true }).buttons).toEqual(['Merge Back', 'Review Changes', 'Remove Thread…']);
	});
});
