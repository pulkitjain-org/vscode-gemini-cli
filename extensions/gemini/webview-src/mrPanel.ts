/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The team part of the Changes panel (src/host/mrPanel.ts): Open Merge Request
// and Run Checks, then the agent's merge request with its pipeline, quality
// gate, Snyk, review threads and Fix Pipeline and Comments.

import type { ChangesTeamView, FromChangesTeam } from '../src/host/teamFlowProtocol';
import { button, el, format, icon } from './panelDom';
import { toolLogo } from './toolLogos';

/** Threads the user unticked, by id; kept across updates. */
const unticked = new Set<string>();

export function renderTeam(view: ChangesTeamView, post: (message: FromChangesTeam) => void): HTMLElement {
	const section = el('section', 'team-changes');
	if (view.openMr || view.runChecks) {
		const actions = el('div', 'team-actions');
		if (view.openMr) {
			const open = button('primary', view.openMr, () => post({ type: 'team', action: 'openMr' }));
			open.prepend(toolLogo('gitlab', 14));
			actions.append(open);
		}
		if (view.runChecks) {
			const checks = button('secondary', view.runChecks, () => post({ type: 'team', action: 'runChecks' }));
			checks.prepend(toolLogo('snyk', 13), toolLogo('sonar', 13));
			actions.append(checks);
		}
		section.append(actions);
	}
	const mr = view.mr;
	if (!mr) {
		return section;
	}
	const card = el('div', 'mr-card');
	const head = el('div', 'mr-head');
	const heading = el('div', 'mr-heading');
	heading.append(toolLogo('gitlab', 16), el('strong', undefined, mr.heading));
	const link = button('link', mr.openIn, () => post({ type: 'team', action: 'openUrl' }), 'link-external');
	head.append(heading, link);
	card.append(head, el('div', 'mr-subtitle', mr.subtitle));
	const threadIds: string[] = [];
	let failedJobs = 0;
	for (const row of mr.rows) {
		const block = el('div', 'mr-row');
		const line = el('div', 'mr-row-line');
		const label = el('span', 'mr-row-label');
		label.append(row.tool === 'review' ? icon('comment-discussion') : toolLogo(row.tool, 14), el('strong', undefined, row.label));
		if (row.detail) {
			label.append(el('span', 'muted', row.detail));
		}
		line.append(label);
		if (row.pill) {
			line.append(el('span', `pill ${row.pill.tone}`, row.pill.text));
		}
		block.append(line);
		for (const job of row.jobs ?? []) {
			failedJobs++;
			const jobLine = el('div', 'mr-sub');
			jobLine.append(el('span', 'mr-sub-text', job.name), button('secondary small', job.fix, () => post({ type: 'team', action: 'fixJob', job: job.id })));
			block.append(jobLine);
		}
		if (row.note) {
			const note = el('div', 'mr-sub muted');
			note.append(el('span', 'mr-sub-text', row.note), icon('check'));
			block.append(note);
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
			text.title = thread.text;
			item.append(box, text);
			block.append(item);
		}
		card.append(block);
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
		fix = button('primary wide', '', () => post({ type: 'team', action: 'fixMr', jobs: failedJobs > 0, threads: threadIds.filter(id => !unticked.has(id)) }));
		card.append(fix);
		syncFix();
	}
	if (mr.merge) {
		// The merge checks as GitLab reports them; the button is on only when every one holds.
		const block = el('div', 'mr-row mr-merge');
		const line = el('div', 'mr-row-line');
		const label = el('span', 'mr-row-label');
		label.append(icon('git-merge'), el('strong', undefined, mr.merge.heading));
		line.append(label, el('span', `pill ${mr.merge.ready ? 'ok' : 'muted'}`, `${mr.merge.checks.filter(c => c.ok).length}/${mr.merge.checks.length}`));
		block.append(line);
		for (const check of mr.merge.checks) {
			const row = el('div', `mr-sub mr-check ${check.ok ? 'ok' : 'missing'}`);
			const text = el('span', 'mr-sub-text');
			text.append(icon(check.ok ? 'pass' : 'circle-large-outline'), el('span', undefined, check.name), el('span', 'muted', ` · ${check.detail}`));
			text.title = check.detail;
			row.append(text);
			block.append(row);
		}
		const merge = button(mr.merge.ready ? 'primary wide' : 'secondary wide', mr.merge.button, () => post({ type: 'team', action: 'merge' }));
		merge.disabled = !mr.merge.ready;
		block.append(merge, el('div', 'mr-sub muted', mr.merge.note));
		card.append(block);
	}
	section.append(card);
	return section;
}
