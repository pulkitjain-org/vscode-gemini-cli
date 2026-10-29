/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A project thread's card in the coordinator's chat, loaded the first time a
// card shows (media/threadCard.js): most chats are not project chats. The
// card says where the thread's work is (in its folder, being tried in the
// user's workspace, or kept) on a three-step line, with one main button for
// the next step, a ⋯ menu for the rest, a tooltip on every button, and a
// short guide the first time the user tries a thread's work.
//
// Everything with state of its own (strings, postMessage, tooltips, menus,
// repository colours) comes from the chat's bundle through `ThreadCardDeps`.

import type { ThreadCard } from '../src/acp/chatTranscript';
import type { FromWebview, ThreadAction } from '../src/host/chatProtocol';
import type { ProjectChatStrings } from '../src/host/chatStrings';
import type { Menu, MenuOptions } from './menu';

export interface ThreadCardDeps {
	readonly strings: ProjectChatStrings;
	post(message: FromWebview): void;
	el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K];
	button(className: string, label: string, onClick: () => void, iconName?: string): HTMLButtonElement;
	icon(name: string): HTMLElement;
	setTip(node: HTMLElement, tip: string): void;
	onIntent(node: HTMLElement, callback: () => void): void;
	toneOf<T extends HTMLElement>(node: T, key: string): T;
	counts(added: number, removed: number): HTMLElement;
	format(template: string, ...values: (string | number)[]): string;
	formatDuration(ms: number): string;
	readonly Menu: new (options: MenuOptions) => Menu;
}

/** The ⋯ menu, one for every card, moved to the button that opens it. */
let shared: { readonly menu: Menu; rows: readonly { readonly name: string; readonly icon: string; run(): void }[]; anchor?: HTMLElement } | undefined;

/** Draws `item` into `card`, replacing what it held. */
export function renderThreadCard(item: ThreadCard, d: ThreadCardDeps, card: HTMLElement): void {
	const p = d.strings;
	const send = (action: ThreadAction, repo?: string) => d.post({ type: 'threadAction', thread: item.thread, action, ...repo ? { repo } : {} });
	card.className = `thread-card state-${item.state}${item.removed ? ' removed' : ''}${item.tried?.conflicts?.length ? ' paused' : ''}`;
	card.replaceChildren();

	const title = d.button('thread-title', item.title, () => send('open'));
	title.prepend(d.el('span', 'thread-dot'));
	// A thread that isn't running starts as the pointer reaches its title, so its chat is ready by the click.
	if (!item.removed) {
		d.onIntent(title, () => d.post({ type: 'prepareThread', thread: item.thread }));
	}
	card.append(title);

	const repos = item.repos ?? [];
	// Under the title: the branch, then each repository it works in, then how long it has run.
	const meta = d.el('div', 'thread-meta');
	if (item.branch) {
		const branch = d.el('span', 'thread-branch');
		branch.append(d.icon('git-branch'), d.el('span', undefined, item.branch));
		meta.append(branch);
	}
	for (const repo of repos) {
		meta.append(d.toneOf(d.el('span', 'repo-pill', repo.key), repo.key));
	}
	if (!repos.length && item.changes?.files) {
		meta.append(d.counts(item.changes.added, item.changes.removed));
	}
	const extra = [item.track ? d.format(p.track, item.track) : undefined, d.formatDuration(Date.now() - item.startedAt)].filter(Boolean).join(' · ');
	meta.append(d.el('span', 'thread-meta-end', extra));
	card.append(meta);

	const tryFlow = !item.mergeCommits;
	const hasWork = !!item.tried || !!item.changes?.files || repos.some(repo => repo.files);
	// Where the work is, for a thread that has some: in its folder, being tried in the workspace, or kept.
	if (tryFlow && hasWork && !item.removed && !item.discarded) {
		card.append(steps(item, d));
	}
	// A thread in several repositories: each one's changes; with merge commits, merged back one at a time.
	if (repos.length && !item.removed) {
		const list = d.el('div', 'thread-repos');
		for (const repo of repos) {
			const row = d.el('div', `thread-repo${repo.merged ? ' merged' : ''}`);
			row.append(d.toneOf(d.el('span', 'thread-repo-dot'), repo.key), d.el('span', 'thread-repo-name', repo.key));
			row.append(repo.files ? d.counts(repo.added, repo.removed) : d.el('span', 'thread-repo-state', '—'));
			if (repo.merged) {
				row.append(d.el('span', 'thread-repo-state', p.repoMerged));
			} else if (!tryFlow && item.state === 'done' && !item.merged) {
				row.append(d.button('secondary thread-repo-merge', p.actions.merge, () => send('merge', repo.key)));
			}
			list.append(row);
		}
		card.append(list);
	}
	card.append(d.el('div', `thread-line${item.tried?.conflicts?.length ? ' error' : ''}`, line(item, d)));
	if (item.removed) {
		return;
	}

	const actions = buttons(item);
	const row = d.el('div', 'permission-actions');
	for (const [action, primary] of actions) {
		if (action === 'more') {
			row.append(moreButton(item, d, send));
			continue;
		}
		const label = action === 'open' && item.state === 'waiting' ? p.openToAnswer
			: action === 'open' && item.tried && item.state === 'done' ? p.askForChanges
				: p.actions[action];
		const node = d.button(primary ? 'primary' : 'secondary', label, () => send(action));
		const tip = p.tips[action];
		if (tip) {
			d.setTip(node, tip);
		}
		row.append(node);
	}
	card.append(row);

	if (item.guide) {
		const guide = d.el('div', 'thread-guide');
		guide.append(d.el('strong', undefined, p.guide.title));
		const list = d.el('ol');
		for (const step of p.guide.steps) {
			list.append(d.el('li', undefined, step));
		}
		const done = d.button('secondary', p.guide.gotIt, () => send('dismissGuide'));
		guide.append(list, done);
		card.append(guide);
	}
}

type CardButton = readonly [ThreadAction | 'more', boolean];

/** The card's buttons for where the thread stands: the next step first and highlighted. */
function buttons(item: ThreadCard): readonly CardButton[] {
	const tried = item.tried;
	switch (item.state) {
		case 'waiting':
			return [['open', true]];
		case 'planned':
			return [['approve', true], ['open', false]];
		case 'error':
			return [['retry', true], ['open', false]];
		case 'done':
			break;
		default:
			// Working: a try can still be taken back.
			return [['open', false], ['stop', false], ...tried?.state === 'trying' ? [['takeBack', false] as const] : []];
	}
	if (item.discarded) {
		return [['restore', true], ['open', false], ['remove', false]];
	}
	if (item.mergeCommits) {
		return item.merged ? [['open', false]]
			: item.changes?.files ? (item.repos?.length ? [['review', true], ['remove', false]] : [['merge', true], ['review', false], ['remove', false]])
				: [['open', true], ['remove', false]];
	}
	if (tried?.state === 'trying') {
		const send: readonly CardButton[] = tried.edits?.length ? [['send', false]] : [];
		return tried.conflicts?.length
			? [['resolve', true], ...send, ['takeBack', false], ['more', false]]
			: [['keep', true], ['takeBack', false], ['open', false], ...send, ['more', false]];
	}
	if (tried?.state === 'kept') {
		return [['open', true], ['more', false]];
	}
	if (item.changes?.files || item.repos?.some(repo => repo.files)) {
		return [['try', true], ['review', false], ['more', false]];
	}
	// Done with nothing to try, such as an assessment: its answer is in the thread.
	return [['open', true], ['more', false]];
}

/** The line under the meta: where the work is, or what the thread is doing. */
function line(item: ThreadCard, d: ThreadCardDeps): string {
	const p = d.strings;
	const lines = p.tryLines;
	const tried = item.tried;
	const names = (files: readonly string[]) => files.map(file => file.split('/').pop() ?? file).join(', ');
	if (item.removed) {
		return p.undone;
	}
	if (item.discarded) {
		return lines.discarded;
	}
	if (tried?.state === 'trying') {
		if (item.state === 'working') {
			return lines.working;
		}
		if (tried.conflicts?.length) {
			return d.format(lines.paused, names(tried.conflicts));
		}
		return [
			tried.files === 1 ? lines.tryingOne : d.format(lines.trying, tried.files),
			tried.updates ? d.format(lines.updated, tried.updates) : '',
			tried.unmerged?.length ? d.format(lines.unmerged, names(tried.unmerged)) : '',
			tried.edits?.length ? d.format(lines.yourEdits, names(tried.edits)) : '',
		].filter(Boolean).join(' ');
	}
	if (tried?.state === 'kept' && item.state !== 'working') {
		return tried.files === 1 ? lines.keptOne : d.format(lines.kept, tried.files);
	}
	const state = p.states[item.state] ?? item.state;
	const repos = item.repos ?? [];
	const mergedRepos = repos.filter(repo => repo.merged).length;
	if (item.merged) {
		return p.merged;
	}
	if (mergedRepos > 0) {
		return d.format(p.mergedCount, mergedRepos, repos.length);
	}
	if (item.state === 'done' && !item.mergeCommits && item.changes?.files) {
		return item.changes.files === 1 ? lines.doneOne : d.format(lines.done, item.changes.files);
	}
	return item.detail ? `${state} · ${item.detail}` : state;
}

/** In the thread, Trying in your workspace, Kept: the steps, with the current one lit. */
function steps(item: ThreadCard, d: ThreadCardDeps): HTMLElement {
	const current = item.tried?.state === 'trying' ? 1 : item.tried?.state === 'kept' ? 2 : 0;
	const node = d.el('div', 'thread-steps');
	const labels = [d.strings.steps.thread, d.strings.steps.trying, d.strings.steps.kept];
	labels.forEach((label, index) => {
		if (index) {
			node.append(d.el('span', 'thread-step-sep', '\u203a'));
		}
		const step = d.el('span', `thread-step${index < current ? ' done' : index === current ? ' now' : ''}${index === 2 ? ' kept' : ''}`);
		step.append(d.el('i'), d.el('span', undefined, label));
		node.append(step);
	});
	return node;
}

/** The ⋯ button: How trying works, the thread's terminal and checks, Discard and Remove. */
function moreButton(item: ThreadCard, d: ThreadCardDeps, send: (action: ThreadAction) => void): HTMLButtonElement {
	const p = d.strings;
	const node = d.button('secondary thread-more', '', () => {
		const menu = sharedMenu(d);
		if (menu.menu.isOpenFrom(node)) {
			menu.menu.close();
			return;
		}
		menu.rows = [
			...item.tried?.state === 'trying' ? [{ name: p.actions.guide, icon: 'question', run: () => send('guide') }] : [],
			{ name: p.actions.terminal, icon: 'terminal', run: () => send('terminal') },
			{ name: p.actions.checks, icon: 'checklist', run: () => send('checks') },
			...item.state === 'done' && (item.changes?.files || item.tried) ? [{ name: p.actions.discard, icon: 'discard', run: () => send('discard') }] : [],
			// Work discarded before later turns changed the folder: Restore asks, and saves that newer work first.
			...item.state === 'done' && item.restorable ? [{ name: p.actions.restore, icon: 'history', run: () => send('restore') }] : [],
			{ name: p.actions.remove, icon: 'trash', run: () => send('remove') },
		];
		menu.anchor = node;
		menu.menu.setAnchor(node);
		menu.menu.open();
	}, 'ellipsis');
	node.setAttribute('aria-label', p.more);
	d.setTip(node, p.more);
	return node;
}

function sharedMenu(d: ThreadCardDeps): NonNullable<typeof shared> {
	if (shared) {
		return shared;
	}
	const element = d.el('div', 'thread-menu');
	element.hidden = true;
	// An anchor of its own, so no card's button gets the menu's own click handler.
	const anchor = d.el('span');
	anchor.hidden = true;
	document.body.append(element, anchor);
	const state: { menu?: Menu; rows: readonly { readonly name: string; readonly icon: string; run(): void }[] } = { rows: [] };
	state.menu = new d.Menu({
		element,
		anchor,
		label: d.strings.more,
		// In the page's body, so placed by its button each time: under it, or over it near the bottom.
		onOpen: () => {
			const box = (shared?.anchor ?? anchor).getBoundingClientRect();
			element.style.left = `${Math.max(8, Math.min(box.left, innerWidth - 228))}px`;
			const below = innerHeight - box.bottom > 200;
			element.style.top = below ? `${box.bottom + 4}px` : 'auto';
			element.style.bottom = below ? 'auto' : `${innerHeight - box.top + 4}px`;
		},
		sections: () => [{ rows: state.rows.map(row => ({ name: row.name, icon: row.icon, run: () => {
			state.menu!.close();
			row.run();
		} })) }],
		empty: () => '',
		tip: d.setTip,
	});
	shared = state as NonNullable<typeof shared>;
	return shared;
}
