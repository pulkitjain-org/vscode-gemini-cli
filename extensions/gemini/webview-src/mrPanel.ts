/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The team part of the Changes panel (src/host/mrPanel.ts): Open Merge Request
// and Run Checks, then the agent's merge request as one card: its quality gate,
// Snyk and ticket, then the merge checklist read live from GitLab, with the
// pipeline's failed jobs and the open review threads under their own checks,
// the options, the exact request, and Merge, on only when every line is green.
// Without the checklist, the pipeline and threads are rows of their own.

import type { ChangesTeamView, FromChangesTeam } from '../src/host/teamFlowProtocol';
import { button, el, format, icon } from './panelDom';
import { toolLogo } from './toolLogos';
import { setTip } from './tooltip';

/** Threads the user unticked, by id; kept across updates. */
const unticked = new Set<string>();
/** The merge options the user changed, kept across updates. */
const mergeChoices = new Map<'squash' | 'removeSourceBranch' | 'moveTicket', boolean>();

export function renderTeam(view: ChangesTeamView, post: (message: FromChangesTeam) => void): HTMLElement {
	const section = el('section', 'team-changes');
	const mr = view.mr;
	if (!mr) {
		if (view.openMr || view.runChecks) {
			const actions = el('div', 'team-actions');
			if (view.openMr) {
				const open = button('primary', view.openMr, () => post({ type: 'team', action: 'openMr' }));
				open.prepend(toolLogo('gitlab', 14));
				actions.append(open);
			}
			if (view.runChecks) {
				actions.append(checksButton(view.runChecks, post));
			}
			section.append(actions);
		}
		return section;
	}

	// The merge request: what GitLab, SonarQube, Snyk and Jira say about it.
	const card = el('div', 'mr-card');
	const head = el('div', 'mr-head');
	head.append(toolLogo('gitlab', 16), el('strong', 'mr-title', mr.heading), el('span', 'mr-target mono', mr.target));
	card.append(head);
	const threadIds: string[] = [];
	let failedJobs = 0;
	/** A row's failed jobs with Fix, its note and its threads with their ticks, under its line or under the merge check it repeats. */
	const extras = (row: NonNullable<ChangesTeamView['mr']>['rows'][number]): HTMLElement[] => {
		const nodes: HTMLElement[] = [];
		for (const job of row.jobs ?? []) {
			failedJobs++;
			const jobLine = el('div', 'mr-sub');
			jobLine.append(el('span', 'mr-sub-text', job.name), button('secondary small', job.fix, () => post({ type: 'team', action: 'fixJob', job: job.id })));
			nodes.push(jobLine);
		}
		if (row.note) {
			const note = el('div', 'mr-sub muted');
			note.append(el('span', 'mr-sub-text', row.note), icon('check'));
			nodes.push(note);
		}
		for (const thread of row.threads ?? []) {
			threadIds.push(thread.id);
			const item = el('label', 'mr-thread');
			const box = el('input');
			box.type = 'checkbox';
			box.checked = !unticked.has(thread.id);
			box.addEventListener('change', () => {
				if (box.checked) {
					unticked.delete(thread.id);
				} else {
					unticked.add(thread.id);
				}
				syncFix();
			});
			const text = el('span', 'mr-sub-text');
			text.append(el('strong', undefined, thread.author), document.createTextNode(` · ${thread.text}`));
			setTip(text, thread.text);
			item.append(box, text);
			nodes.push(item);
		}
		return nodes;
	};
	// With the checklist, a row it repeats (pipeline, review threads) is shown once: as its check.
	const checkKinds = new Set(mr.merge?.checks.flatMap(check => check.kind ? [check.kind] : []));
	const underChecks = new Map<'pipeline' | 'threads', HTMLElement[]>();
	for (const row of mr.rows) {
		if (row.covers && checkKinds.has(row.covers)) {
			underChecks.set(row.covers, extras(row));
			continue;
		}
		const block = el('div', 'mr-row');
		const line = el('div', 'mr-row-line');
		const label = el('span', 'mr-row-label');
		label.append(row.tool === 'review' ? icon('comment-discussion') : toolLogo(row.tool, 14), el('span', 'mr-row-text', row.label));
		if (row.detail) {
			label.append(el('span', 'muted', row.detail));
		}
		line.append(label);
		if (row.pill) {
			line.append(el('span', `pill ${row.pill.tone}`, row.pill.text));
		}
		block.append(line, ...extras(row));
		card.append(block);
	}
	if (mr.merge) {
		renderMerge(card, mr.merge, underChecks, post);
	}
	section.append(card);

	// Open in GitLab, Run Checks and Fix Pipeline and Comments, under the cards.
	const actions = el('div', 'team-actions');
	actions.append(button('secondary', mr.openIn, () => post({ type: 'team', action: 'openUrl' }), 'link-external'));
	if (view.runChecks) {
		actions.append(checksButton(view.runChecks, post));
	}
	let fix: HTMLButtonElement | undefined;
	const syncFix = () => {
		if (!fix || !mr.fixAll) {
			return;
		}
		const n = threadIds.filter(id => !unticked.has(id)).length;
		const label = failedJobs && n ? (n === 1 ? mr.fixAll.one : format(mr.fixAll.label, n)) : failedJobs ? mr.fixAll.pipelineOnly : format(mr.fixAll.commentsOnly, n);
		fix.replaceChildren(el('span', undefined, label));
		fix.disabled = !failedJobs && !n;
	};
	if (mr.fixAll) {
		fix = button('secondary', '', () => post({ type: 'team', action: 'fixMr', jobs: failedJobs > 0, threads: threadIds.filter(id => !unticked.has(id)) }));
		actions.append(fix);
		syncFix();
	}
	section.append(actions);
	return section;
}

function checksButton(label: string, post: (message: FromChangesTeam) => void): HTMLButtonElement {
	const checks = button('secondary', label, () => post({ type: 'team', action: 'runChecks' }));
	checks.prepend(toolLogo('snyk', 13), toolLogo('sonar', 13));
	return checks;
}

/**
 * The merge part of the merge request's card: each check as GitLab reports it,
 * with `underChecks`, the pipeline's jobs or the open threads, under their
 * check; the options, the request, and the button.
 */
function renderMerge(card: HTMLElement, merge: NonNullable<NonNullable<ChangesTeamView['mr']>['merge']>, underChecks: ReadonlyMap<'pipeline' | 'threads', readonly HTMLElement[]>, post: (message: FromChangesTeam) => void): void {
	card.classList.add('mr-merge');
	const head = el('div', 'mr-head mr-merge-head');
	head.append(icon('git-merge'), el('strong', 'mr-title', merge.heading), el('span', 'mr-target mono', merge.readAt));
	card.append(head);
	for (const check of merge.checks) {
		const row = el('div', `mr-check ${check.state}`);
		const mark = el('span', 'mr-check-mark');
		mark.append(icon(check.state === 'ok' ? 'check' : check.state === 'pending' ? 'ellipsis' : 'close'));
		const text = el('div', 'mr-check-text');
		text.append(el('div', undefined, check.name), el('div', 'mr-check-source mono', `${check.source} · ${check.detail}`));
		row.append(mark, text);
		if (check.retry) {
			row.append(button('link', check.retry, () => post({ type: 'team', action: 'retry' }), 'refresh'));
		}
		card.append(row);
		const under = check.kind ? underChecks.get(check.kind) : undefined;
		if (under?.length) {
			const block = el('div', 'mr-check-under');
			block.append(...under);
			card.append(block);
		}
	}

	const options = el('div', 'mr-options');
	const choice = (key: 'squash' | 'removeSourceBranch' | 'moveTicket', spec: { readonly label: string; readonly on: boolean }): HTMLInputElement => {
		const item = el('label', 'mr-option');
		const box = el('input');
		box.type = 'checkbox';
		box.checked = mergeChoices.get(key) ?? spec.on;
		box.addEventListener('change', () => {
			mergeChoices.set(key, box.checked);
			syncRequest();
		});
		item.append(box, el('span', undefined, spec.label));
		options.append(item);
		return box;
	};
	const squash = choice('squash', merge.squash);
	const removeSourceBranch = choice('removeSourceBranch', merge.removeSourceBranch);
	const moveTicket = merge.moveTicket ? choice('moveTicket', merge.moveTicket) : undefined;
	const request = el('pre', 'mr-request mono');
	const syncRequest = () => {
		const lines = [`PUT ${merge.request.path}  sha=${merge.request.sha}  squash=${squash.checked}  should_remove_source_branch=${removeSourceBranch.checked}`];
		if (merge.moveTicket && moveTicket?.checked) {
			lines.push(`then POST /issue/${merge.moveTicket.key}/transitions (Done)`);
		}
		request.textContent = lines.join('\n');
	};
	syncRequest();
	options.append(request);
	card.append(options);

	const foot = el('div', 'mr-merge-foot');
	const mergeButton = button('primary', merge.button, () => post({ type: 'team', action: 'merge', squash: squash.checked, removeSourceBranch: removeSourceBranch.checked, moveTicket: !!moveTicket?.checked }));
	mergeButton.disabled = !merge.ready;
	foot.append(mergeButton, el('span', 'mr-merge-note', merge.note));
	card.append(foot);
}
