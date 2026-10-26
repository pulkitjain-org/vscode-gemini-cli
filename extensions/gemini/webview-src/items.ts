/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Renders transcript items. Agent and user Markdown is rendered by markdown-it
// with raw HTML disabled, so message text can never inject markup; everything
// else is set with textContent.

import MarkdownIt from 'markdown-it';
import { basename } from '../src/acp/attachments';
import type { PromptAttachmentLabel, TranscriptItem } from '../src/acp/chatTranscript';
import type { ReactionRef } from '../src/acp/reactions';
import type { ThreadAction, ViewSession } from '../src/host/chatProtocol';
import { attachmentIcon, codeLanguage, format, formatDuration, formatTokens, formatSentAt, permissionDefaults, planIcon, replyBefore, subagentName, thoughtSeconds, toolKindIcon, type ItemOf } from './chatLogic';
import { highlightCode } from './codeHighlight';
import { applyInlineStyles } from './inlineStyles';
import { renderMath } from './math';
import { mathPlugin } from './mathRule';
import { enhanceMarkdown } from './markdownExtras';
import { isSafeLink } from './linkPolicy';
import { button, copyButton, el, icon, onIntent, setLabel, setTip } from './dom';
import { canRun } from '../src/acp/runCommands';
import { addRunButtons } from './runButtons';
import { indexToolTitle, teamToolTitle } from '../src/acp/toolLinks';
import { toolLogo } from './toolLogos';
import { toneOf } from './repoTones';
import { thoughtPreview } from './streaming';
import { thoughtSummary } from './workFold';
import { agentBadge, reactionLines, replyReactions } from './reactionBar';
import { planBuildButtons } from './planBuild';
import { expanded, state, strings, subagentTimes, thoughtTimes, ui, vscode } from './view';

const mac = /Mac/.test(navigator.platform);

const markdown = new MarkdownIt({ html: false, linkify: true }).use(mathPlugin);
// Only links with a scheme or www.; file names such as README.md are not web addresses.
markdown.linkify.set({ fuzzyLink: false });
// Only web and mail links: never another app's URL handler.
markdown.validateLink = isSafeLink;
// The user's own messages keep their line breaks, as typed.
const userMarkdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
userMarkdown.linkify.set({ fuzzyLink: false });
userMarkdown.validateLink = isSafeLink;

/** Called when the user expands or collapses a tool call's output. */
export type ToggleToolCall = (item: ItemOf<'toolCall'>) => void;

export function render(item: TranscriptItem, toggleToolCall: ToggleToolCall): HTMLElement {
	switch (item.kind) {
		case 'user':
			return renderUserMessage(item, item.id);
		case 'agent':
			return renderMarkdown(item.text);
		case 'thought':
			return renderThought(item);
		case 'toolCall':
			return renderToolCall(item, toggleToolCall);
		case 'plan':
			return renderPlan(item);
		case 'permission':
			return renderPermission(item);
		case 'other':
			return renderNotice(format(strings.unknownUpdate, item.type), 'info');
		case 'notice':
			return renderNotice(item.text, item.severity, item.retry ? item.id : undefined);
		case 'cutOff':
			return renderCutOff(item);
		case 'compact':
			return renderCompact(item);
		case 'fork':
			return renderFork(item);
		case 'trace':
			return renderTrace(item);
		case 'turnEnd':
			return renderTurnEnd(item);
		case 'thread':
			return renderThreadCard(item);
	}
}

/** Lines added and removed, in green and red. */
function counts(added: number, removed: number): HTMLElement {
	const node = el('span', 'thread-counts');
	node.append(el('span', 'added', `+${added}`), el('span', 'removed', `\u2212${removed}`));
	return node;
}

/** A project's thread: its state, what it is doing, its branch and changes, and what can be done with it. */
function renderThreadCard(item: ItemOf<'thread'>): HTMLElement {
	const project = strings.project;
	const card = el('div', `thread-card state-${item.state}${item.removed ? ' removed' : ''}`);
	const send = (action: ThreadAction, repo?: string) => vscode.postMessage({ type: 'threadAction', thread: item.thread, action, ...(repo ? { repo } : {}) });
	const title = button('thread-title', item.title, () => send('open'));
	title.prepend(el('span', 'thread-dot'));
	// A thread that isn't running starts as the pointer reaches its title, so its chat is ready by the click.
	if (!item.removed) {
		onIntent(title, () => vscode.postMessage({ type: 'prepareThread', thread: item.thread }));
	}
	card.append(title);
	const state = project?.states[item.state] ?? item.state;
	const repos = item.repos ?? [];
	const mergedRepos = repos.filter(repo => repo.merged).length;
	const partly = !item.merged && mergedRepos > 0 && project ? format(project.mergedCount, mergedRepos, repos.length) : undefined;
	const line = item.removed ? project?.undone : item.merged ? project?.merged : partly ?? (item.detail ? `${state} \u00b7 ${item.detail}` : state);
	// Under the title: the branch, then each repository it works in, then how long it has run.
	const meta = el('div', 'thread-meta');
	if (item.branch) {
		const branch = el('span', 'thread-branch');
		branch.append(icon('git-branch'), el('span', undefined, item.branch));
		meta.append(branch);
	}
	for (const repo of repos) {
		meta.append(toneOf(el('span', 'repo-pill', repo.key), repo.key));
	}
	if (!repos.length && item.changes?.files) {
		meta.append(counts(item.changes.added, item.changes.removed));
	}
	const extra = [item.track && project ? format(project.track, item.track) : undefined, formatDuration(Date.now() - item.startedAt)].filter(Boolean).join(' \u00b7 ');
	meta.append(el('span', 'thread-meta-end', extra));
	card.append(meta);
	// A thread in several repositories: a row for each, merged back one at a time.
	if (repos.length && !item.removed && project) {
		const list = el('div', 'thread-repos');
		for (const repo of repos) {
			const row = el('div', `thread-repo${repo.merged ? ' merged' : ''}`);
			row.append(toneOf(el('span', 'thread-repo-dot'), repo.key), el('span', 'thread-repo-name', repo.key));
			row.append(repo.files ? counts(repo.added, repo.removed) : el('span', 'thread-repo-state', '\u2014'));
			if (repo.merged) {
				row.append(el('span', 'thread-repo-state', project.repoMerged));
			} else if (item.state === 'done' && !item.merged) {
				row.append(button('secondary thread-repo-merge', project.actions.merge, () => send('merge', repo.key)));
			}
			list.append(row);
		}
		card.append(list);
	}
	card.append(el('div', 'thread-line', line ?? state));
	if (item.removed || !project) {
		return card;
	}
	const actions: [ThreadAction, boolean][] = item.state === 'waiting'
		? [['open', true]]
		: item.state === 'planned'
			? [['approve', true], ['open', false]]
			: item.state === 'error'
				? [['retry', true], ['open', false]]
				: item.state === 'done' && !item.merged && item.changes?.files
					? repos.length ? [['review', true], ['undo', false]] : [['merge', true], ['review', false], ['undo', false]]
					// Done with nothing to merge, such as an assessment: its answer is in the thread.
					: item.state === 'done' && !item.merged
						? [['open', true], ['undo', false]]
						: item.state === 'done'
							? [['open', false]]
							: [['open', false], ['stop', false]];
	const row = el('div', 'permission-actions');
	for (const [action, primary] of actions) {
		row.append(button(primary ? 'primary' : 'secondary', action === 'open' && item.state === 'waiting' ? project.openToAnswer : project.actions[action], () => send(action)));
	}
	card.append(row);
	return card;
}

function renderTurnEnd(item: ItemOf<'turnEnd'>): HTMLElement {
	const node = el('div', 'turn-end');
	// Hidden when the turn's fold says it (transcript.ts, `has-fold`).
	node.append(el('span', 'worked-for', format(strings.workedFor, formatDuration(item.durationMs))));
	if (item.firstTokenMs !== undefined) {
		node.append(el('span', 'turn-dot', '·'), el('span', 'first-token', format(strings.firstToken, shortMs(item.firstTokenMs))));
	}
	if (item.at) {
		node.append(el('span', 'turn-dot', '\u00b7'), sentAt(item.at));
	}
	node.append(copyButton('copy-reply', strings.copyReply, () => replyBefore(state.items, item.id)));
	if (strings.fork) {
		const fork = button('turn-action fork-reply', strings.fork.button, () => vscode.postMessage({ type: 'requestFork', turnEnd: item.id }), 'gemini-fork');
		setLabel(fork, strings.fork.fromHere);
		node.append(fork);
	}
	if (item.retry) {
		const retry = button('turn-action', strings.retry, () => vscode.postMessage({ type: 'retry', itemId: item.id }), 'refresh');
		setLabel(retry, strings.retryTooltip);
		node.append(retry);
	}
	if (item.buildPlan) {
		node.append(...planBuildButtons(item));
	}
	if (item.undo === 'available') {
		const undo = button('turn-action undo-turn', strings.undoTurn, () => vscode.postMessage({ type: 'undoTurn', itemId: item.id }), 'discard');
		setLabel(undo, item.files && item.files > 1 ? format(strings.undoTurnFiles, item.files) : strings.undoTurnTooltip);
		node.append(undo);
	} else if (item.undo === 'undone') {
		node.append(el('span', 'turn-undone', strings.turnUndone));
	}
	node.append(...replyReactions(item));
	return node;
}

/** A message's time, with the full date and time as its tooltip. */
function sentAt(at: number): HTMLElement {
	const time = el('time', 'sent-at', formatSentAt(at, Date.now()));
	time.dateTime = new Date(at).toISOString();
	setTip(time, new Date(at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' }));
	return time;
}

/** The user's message, with its time and Copy under it, shown on hover. */
function renderUserMessage(item: { readonly text: string; readonly attachments?: readonly PromptAttachmentLabel[]; readonly at?: number; readonly from?: 'coordinator'; readonly reactions?: readonly ReactionRef[]; readonly agentReaction?: string }, id?: string): HTMLElement {
	const reactions = item.reactions ?? [];
	if (!item.text && !item.attachments?.length && reactions.length) {
		// A reaction sent on its own: a line, not a bubble.
		const turn = el('div', 'user-turn reaction-turn');
		turn.append(...reactionLines(reactions));
		return turn;
	}
	const turn = el('div', `user-turn${item.from ? ' from-coordinator' : ''}`);
	turn.append(...reactionLines(reactions));
	const node = el('div', `message user${item.agentReaction ? ' has-reaction' : ''}`);
	if (item.agentReaction) {
		node.append(agentBadge(item.agentReaction));
	}
	if (item.from) {
		node.append(el('span', 'from-badge', strings.fromCoordinator));
	}
	turn.append(node);
	if (item.text) {
		const text = el('div', 'user-text markdown');
		text.append(...renderUserMarkdown(item.text));
		node.append(text);
	}
	if (item.attachments?.length) {
		const chips = el('div', 'attachment-chips');
		for (const attachment of item.attachments) {
			const { path, line } = attachment;
			if (attachment.kind === 'page') {
				// The page shared with the agent then; it opens the page shared now.
				const page = button('chip shared-page', format(strings.sharedPage, attachment.label), () => vscode.postMessage({ type: 'openSharedPage' }), 'globe');
				setTip(page, format(strings.showSharedPage, path ?? attachment.label));
				chips.append(page);
				continue;
			}
			const ref = attachment.ref;
			if (attachment.tool && ref) {
				// A Jira ticket, GitLab item or Figma frame the message carried: opens in its tool.
				const tool = button('chip tool-chip', '', () => vscode.postMessage({ type: 'openToolRef', ref }));
				tool.append(toolLogo(attachment.tool, 14), el('span', undefined, attachment.label));
				setLabel(tool, format(strings.openToolItem, attachment.label));
				chips.append(tool);
				continue;
			}
			const chip = path
				? button('chip', attachment.label, () => vscode.postMessage({ type: 'openLocation', path, line }), attachmentIcon(attachment.kind, attachment.label))
				: el('span', 'chip static');
			if (!path) {
				chip.append(icon(attachmentIcon(attachment.kind, attachment.label)), el('span', undefined, attachment.label));
			}
			chip.title = path ?? attachment.label;
			chips.append(chip);
		}
		node.append(chips);
	}
	const meta = el('div', 'user-meta');
	if (item.at) {
		meta.append(sentAt(item.at));
	}
	if (item.text && id && !strings.project) {
		const rewind = button('icon-button copy-message rewind-prompt', '', () => vscode.postMessage({ type: 'rewind', itemId: id }), 'history');
		setLabel(rewind, strings.rewindPrompt);
		meta.append(rewind);
	}
	if (item.text) {
		meta.append(copyButton('copy-message', strings.copyMessage, () => item.text));
	}
	if (meta.childElementCount) {
		turn.append(meta);
	}
	return turn;
}

function renderMarkdown(text: string): HTMLElement {
	const node = el('div', 'message agent markdown');
	node.append(...renderBlocks(text));
	return node;
}

/** The user's Markdown as nodes, with line breaks as typed. */
export function renderUserMarkdown(text: string): Node[] {
	return renderBlocks(text, userMarkdown);
}

/**
 * Markdown as nodes, with each code block under a header that names its
 * language and copies it, and a reply's shell blocks Run too. Without
 * `highlight`, code is left plain and Run is off: for the tail of a streaming
 * reply, whose last code block is still growing.
 */
export function renderBlocks(text: string, renderer = markdown, highlight = true): Node[] {
	const node = el('div');
	node.innerHTML = renderer.render(text);
	applyInlineStyles(node);
	enhanceMarkdown(node);
	renderMath(node);
	for (const pre of node.querySelectorAll('pre')) {
		const wrapper = el('div', 'code-block');
		pre.replaceWith(wrapper);
		const header = el('div', 'code-header');
		const code = pre.querySelector('code');
		const language = codeLanguage(code?.className ?? '');
		const copy = copyButton('copy', strings.copy, () => pre.textContent ?? '');
		header.append(el('span', 'code-language', language), copy);
		wrapper.append(header, pre);
		if (renderer === markdown && canRun(language)) {
			addRunButtons(wrapper, copy, language, pre.textContent ?? '', highlight);
		}
		if (code && highlight) {
			highlightCode(code, language.toLowerCase());
		}
	}
	return [...node.childNodes];
}

function thoughtLabel(item: { readonly id: string }, thinking: boolean): string {
	const times = thoughtTimes.get(item.id);
	if (times?.end !== undefined) {
		return format(strings.thoughtFor, thoughtSeconds(times.start, times.end));
	}
	return thinking ? strings.thinking : strings.thought;
}

function renderThought(item: { readonly id: string; readonly text: string }): HTMLElement {
	const details = el('details', 'thought');
	const summary = el('summary');
	summary.dataset.focusKey = `thought:${item.id}`;
	summary.append(icon('chevron-right', 'chevron'), el('span'));
	const text = el('div', 'thought-text');
	// Animate opening by the user only, not the updates while it streams.
	summary.addEventListener('click', () => text.classList.toggle('reveal', !details.open));
	details.append(summary, text);
	updateThought(details, item);
	return details;
}

/**
 * Brings a thought's element up to date in place: its label, its preview and
 * its text, with streamed text added to the end. The element is kept, so a
 * thought the user opened stays open, and text selected in it stays selected.
 */
export function updateThought(details: HTMLElement, item: { readonly id: string; readonly text: string }): void {
	const summary = details.firstElementChild!;
	const label = summary.children[1];
	const thinking = state.busy && state.items.at(-1)?.id === item.id;
	label.classList.toggle('shimmer', thinking);
	const name = thoughtLabel(item, thinking);
	if (label.textContent !== name) {
		label.textContent = name;
	}
	// While it thinks, show what about, so a long think does not look idle; after, what it was about.
	const preview = thinking ? thoughtPreview(item.text) : thoughtSummary(item.text);
	const previewNode = summary.querySelector('.thought-preview');
	if (!preview) {
		previewNode?.remove();
	} else if (!previewNode) {
		summary.append(el('span', 'thought-preview', preview));
	} else if (previewNode.textContent !== preview) {
		previewNode.textContent = preview;
	}
	const text = details.lastElementChild!;
	const shown = text.textContent ?? '';
	const last = text.lastChild;
	if (shown && item.text.startsWith(shown) && last instanceof Text) {
		last.appendData(item.text.slice(shown.length));
	} else if (shown !== item.text) {
		text.textContent = item.text;
	}
}

function statusIcon(value: ItemOf<'toolCall'>['status']): HTMLElement {
	switch (value) {
		case 'pending': return icon('circle-large-outline', 'status-icon pending');
		case 'in_progress': return icon('loading', 'status-icon codicon-modifier-spin');
		case 'completed': return icon('check', 'status-icon completed');
		case 'failed': return icon('error', 'status-icon failed');
	}
}

/** "working", "finished in 42s" or "failed", from when this view first saw the call working. */
function subagentStatus(item: ItemOf<'toolCall'>): string {
	let times = subagentTimes.get(item.id);
	if (!times && (item.status === 'pending' || item.status === 'in_progress')) {
		times = { start: Date.now() };
		subagentTimes.set(item.id, times);
	}
	if (item.status === 'failed') {
		return strings.subagentFailed;
	}
	if (item.status !== 'completed') {
		return strings.subagentWorking;
	}
	if (times && times.end === undefined) {
		times.end = Date.now();
	}
	return times?.end !== undefined ? format(strings.subagentFinished, formatDuration(times.end - times.start)) : '';
}

function renderToolCall(item: ItemOf<'toolCall'>, toggleToolCall: ToggleToolCall): HTMLElement {
	const subagent = subagentName(item.title);
	const card = el('div', `tool-call status-${item.status}${subagent ? ' subagent' : ''}`);
	const row = el('div', 'tool-row');
	if (subagent) {
		// A subagent works in its own context; the CLI sends only its start and its report.
		const label = el('span', 'tool-title');
		label.append(el('span', 'tool-verb', format(strings.subagent, subagent)));
		const status = subagentStatus(item);
		row.append(icon('hubot', 'kind-icon'), label, ...status ? [el('span', 'subagent-status', status)] : [], statusIcon(item.status));
		row.title = item.title;
		card.append(row);
		appendToolBody(card, row, item, toggleToolCall);
		return card;
	}
	// "Read src/cart/total.ts": the verb in the text colour, what it acted on quieter.
	// A team tool's call ("Read ACME-412") shows its tool's logo.
	// An index call ("Search code for "discount code"") reads as a search.
	const team = teamToolTitle(item.title, strings.teamToolVerbs);
	const indexed = team ? undefined : indexToolTitle(item.title, strings.indexToolVerbs);
	const [verb, target] = splitToolTitle(team?.title ?? indexed ?? item.title);
	const title = el('span', 'tool-title');
	title.append(el('span', 'tool-verb', verb));
	if (target) {
		title.append(` ${target}`);
	}
	const kindIcon = team ? toolLogo(team.tool, 14) : icon(indexed ? 'search' : toolKindIcon(item.toolKind));
	kindIcon.classList.add('kind-icon');
	row.append(kindIcon, title);
	row.title = item.title;

	for (const location of item.locations) {
		// A file the title already names needs no chip of its own; the title opens it.
		const named = !item.details.some(detail => detail.type === 'text' || detail.type === 'terminal') && item.locations.length === 1 && item.title.includes(basename(location.path));
		const open = () => vscode.postMessage({ type: 'openLocation', path: location.path, line: location.line });
		if (named) {
			title.classList.add('tool-link');
			title.addEventListener('click', open);
			title.title = location.path;
			continue;
		}
		const label = location.line ? `${basename(location.path)}:${location.line}` : basename(location.path);
		const chip = button('chip', label, open);
		chip.title = location.path;
		row.append(chip);
	}
	for (const detail of item.details) {
		if (detail.type === 'diff') {
			const chip = button('chip diff-chip', '', () => vscode.postMessage({ type: 'openDiff', itemId: item.id, path: detail.path }));
			chip.append(el('span', 'added', `+${detail.added}`), el('span', 'removed', `-${detail.removed}`));
			chip.title = `${strings.openDiff}: ${detail.path}`;
			row.append(chip);
		}
	}
	row.append(statusIcon(item.status));
	card.append(row);
	appendToolBody(card, row, item, toggleToolCall);
	return card;
}

/** Whether a tool call has output to show under its row. */
function hasOutput(detail: ItemOf<'toolCall'>['details'][number]): boolean {
	return detail.type === 'terminal' || (detail.type === 'text' && /\S/.test(detail.text));
}

/** The tool call's output, built only when it is first shown: a long chat's outputs mostly stay folded. */
function toolBody(item: ItemOf<'toolCall'>): HTMLElement {
	const body = el('div', 'tool-body');
	for (const detail of item.details) {
		if (detail.type === 'terminal') {
			body.append(el('div', 'tool-note', strings.terminal));
		} else if (detail.type === 'text' && hasOutput(detail)) {
			body.append(el('pre', 'tool-output', detail.text));
		}
	}
	return body;
}

/** The tool call's output, folded under its row until the row is clicked. */
function appendToolBody(card: HTMLElement, row: HTMLElement, item: ItemOf<'toolCall'>, toggleToolCall: ToggleToolCall): void {
	if (!item.details.some(hasOutput)) {
		return;
	}
	const open = expanded.has(item.id);
	card.classList.add('expandable');
	card.classList.toggle('expanded', open);
	row.prepend(icon('chevron-right', 'chevron'));
	row.tabIndex = 0;
	row.dataset.focusKey = `tool:${item.id}`;
	row.setAttribute('role', 'button');
	row.setAttribute('aria-expanded', String(open));
	row.addEventListener('click', () => toggleToolCall(item));
	row.addEventListener('keydown', event => {
		// Not when a file or diff chip inside the row has focus.
		if (event.target === row && (event.key === 'Enter' || event.key === ' ')) {
			event.preventDefault();
			toggleToolCall(item);
		}
	});
	if (open) {
		card.append(toolBody(item));
	}
}

/** Opens or closes a tool call's output in place, so its row keeps focus; the output is built the first time it opens. */
export function setToolCallOpen(card: HTMLElement, item: ItemOf<'toolCall'>, open: boolean): void {
	card.classList.toggle('expanded', open);
	card.querySelector(':scope > .tool-row')?.setAttribute('aria-expanded', String(open));
	let body = card.querySelector(':scope > .tool-body');
	if (open) {
		body ??= card.appendChild(toolBody(item));
		body.classList.add('reveal');
	} else {
		body?.classList.remove('reveal');
	}
}

/** A tool call's title as its first word and the rest. */
function splitToolTitle(title: string): readonly [string, string] {
	const space = title.indexOf(' ');
	return space === -1 ? [title, ''] : [title.slice(0, space), title.slice(space + 1)];
}

function renderPlan(item: ItemOf<'plan'>): HTMLElement {
	const plan = el('div', 'plan');
	plan.append(el('div', 'plan-title', strings.plan));
	const list = el('ul');
	for (const entry of item.entries) {
		const li = el('li', `plan-${entry.status}`);
		li.append(icon(planIcon(entry.status), entry.status === 'in_progress' ? 'codicon-modifier-spin' : ''), el('span', undefined, entry.content));
		list.append(li);
	}
	plan.append(list);
	return plan;
}

/** The tools' names for the confirm-class card's line; brand names, not translated. */
const teamToolNames: Record<string, string> = { jira: 'Jira', gitlab: 'GitLab', sonar: 'SonarQube', snyk: 'Snyk', figma: 'Figma' };

function renderPermission(item: ItemOf<'permission'>): HTMLElement {
	const card = el('div', `permission${item.answer ? ' answered' : ''}${item.confirm ? ' confirm' : ''}`);
	const header = el('div', 'permission-title');
	// A team tool's change (a Jira comment, a merge request) shows as a friendly title and the exact text it would post.
	const team = teamToolTitle(item.title, strings.teamToolVerbs);
	header.append(team ? toolLogo(team.tool, 14) : icon(item.answer ? 'shield' : 'question'), el('span', undefined, team?.title ?? item.title));
	if (item.confirm && !item.answer) {
		header.append(el('span', 'permission-pill', strings.confirmClass));
	}
	card.append(header);
	if (!item.answer) {
		// A confirm-class action shows its effect as the tool will record it; a comment or reply, the text it would post.
		if (team?.effect) {
			card.append(el('pre', 'permission-effect', team.effect));
		} else if (team?.text) {
			card.append(el('div', 'permission-quote', team.text));
		}
		if (item.confirm) {
			card.append(el('div', 'permission-why', format(strings.confirmWhy, team ? teamToolNames[team.tool] : '')));
		}
	}
	if (item.diffPaths.length) {
		const files = el('div', 'permission-files');
		for (const filePath of item.diffPaths) {
			const chip = button('chip', basename(filePath), () => vscode.postMessage({ type: 'openDiff', itemId: item.id, path: filePath }), 'diff');
			chip.title = `${strings.openDiff}: ${filePath}`;
			files.append(chip);
		}
		card.append(files);
	}
	if (item.answer) {
		card.append(el('div', 'permission-answer', item.answer.kind !== 'selected' ? strings.permissionCancelled : item.answer.automatic ? item.answer.name : format(strings.permissionAnswered, item.answer.name)));
		return card;
	}
	const actions = el('div', 'permission-actions');
	const choose = (optionId: string) => vscode.postMessage({ type: 'permission', id: item.id, optionId });
	// "Allow" once is the primary action; other allows and rejections look secondary.
	const { primary, reject } = permissionDefaults(item.options);
	for (const option of item.options) {
		const choice = button(option === primary ? 'primary' : item.confirm && option.kind.startsWith('reject') ? 'secondary reject' : 'secondary', option.name, () => choose(option.optionId));
		choice.dataset.focusKey = `permission:${item.id}:${option.optionId}`;
		actions.append(choice);
	}
	if (reject) {
		actions.append(el('span', 'hint', strings.permissionHint));
		card.addEventListener('keydown', event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				choose(reject.optionId);
			}
		});
	}
	card.append(actions);
	return card;
}

/** `retryId`: a project's failed wake, whose Retry sends what it carried again. */
export function renderNotice(text: string, severity: 'info' | 'error', retryId?: string): HTMLElement {
	const node = el('div', `notice ${severity}`);
	node.append(icon(severity === 'error' ? 'error' : 'info'), el('span', undefined, text));
	if (retryId) {
		const retry = button('turn-action notice-retry', strings.retry, () => vscode.postMessage({ type: 'retry', itemId: retryId }), 'refresh');
		setLabel(retry, strings.project?.retryWake ?? strings.retryTooltip);
		node.append(retry);
	}
	return node;
}

/** "1.4 s" or "380 ms", from the host's templates with the number as the locale writes it. */
function shortMs(ms: number): string {
	return ms >= 1000
		? format(strings.durationSeconds, (ms / 1000).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }))
		: format(strings.durationMs, Math.round(ms).toLocaleString());
}

/** The turn GeminiCode's quit cut off: what is on disk, and Retry the Turn or Keep and Continue. */
function renderCutOff(item: ItemOf<'cutOff'>): HTMLElement {
	const card = el('div', `cut-off${item.dismissed ? ' dismissed' : ''}`);
	if (item.dismissed) {
		return card;
	}
	card.append(el('strong', undefined, strings.cutOff.title), el('span', 'cut-off-text', strings.cutOff.text));
	const actions = el('div', 'permission-actions cut-off-actions');
	if (item.prompt) {
		actions.append(button('primary', strings.cutOff.retry, () => vscode.postMessage({ type: 'retryCutOff', itemId: item.id }), 'refresh'));
	}
	actions.append(button('secondary', strings.cutOff.keep, () => vscode.postMessage({ type: 'dismissCutOff', itemId: item.id })));
	card.append(actions);
	return card;
}

/**
 * Fork Agent: in a fork's chat, the line where its parent's conversation
 * ends; in the parent's, a card for the fork with Open and Merge Back.
 */
function renderFork(item: ItemOf<'fork'>): HTMLElement {
	const text = strings.fork;
	if (item.role === 'from') {
		const line = el('div', 'compact-line fork-line');
		const label = el('span', 'compact-label');
		label.append(icon('gemini-fork'), el('span', undefined, text ? `${format(text.from, item.title)} \u00b7 ${text.fromContext[item.context]}` : item.title));
		line.append(el('span', 'compact-rule'), label, el('span', 'compact-rule'));
		return line;
	}
	const card = el('div', `fork-card${item.removed ? ' removed' : ''}`);
	const head = el('div', 'fork-card-head');
	head.append(icon('gemini-fork'), el('strong', undefined, text ? format(text.card, item.title) : item.title));
	const where = item.removed ? text?.cardRemoved : item.branch ? text && format(text.cardBranch, item.branch) : text?.cardShared;
	if (where) {
		head.append(el('span', 'fork-card-where', where));
	}
	card.append(head);
	if (text && !item.removed) {
		const send = (action: 'open' | 'merge') => vscode.postMessage({ type: 'forkAction', agent: item.agent, action });
		const actions = el('div', 'fork-card-actions');
		actions.append(button('turn-action', text.open, () => send('open'), 'go-to-file'));
		if (item.branch) {
			actions.append(button('turn-action', text.merge, () => send('merge'), 'git-merge'));
		}
		card.append(actions);
	}
	return card;
}

/**
 * Compact: the suggestion card while the context is filling up, then a line
 * across the chat where the session was compacted, with View Summary and Undo.
 */
function renderCompact(item: ItemOf<'compact'>): HTMLElement {
	const text = strings.compact;
	const send = (type: 'compact' | 'undoCompact' | 'dismissCompact' | 'viewCompactSummary') => vscode.postMessage({ type, itemId: item.id });
	switch (item.state) {
		case 'dismissed':
			return el('div', 'compact-card dismissed');
		case 'suggested': {
			const card = el('div', 'compact-card');
			card.append(el('strong', undefined, format(text.suggested, item.percent ?? 0)), el('span', 'compact-text', text.suggestedText));
			const actions = el('div', 'permission-actions compact-actions');
			actions.append(button('primary', text.compact, () => send('compact'), 'fold'), button('secondary', text.notNow, () => send('dismissCompact')));
			card.append(actions);
			return card;
		}
		case 'failed':
			return renderNotice(format(text.failed, item.error ?? ''), 'error');
	}
	const line = el('div', `compact-line state-${item.state}`);
	const label = el('span', 'compact-label');
	if (item.state === 'running') {
		label.append(icon('loading', 'codicon-modifier-spin'), el('span', undefined, text.running));
	} else if (item.state === 'undone') {
		label.append(icon('discard'), el('span', undefined, text.undone));
	} else {
		label.append(icon('fold'), el('span', undefined, format(text.done, formatTokens(item.before ?? 0), formatTokens(item.after ?? 0))));
		setTip(label, item.kept === 0 ? text.keptNone : item.kept === 1 ? text.keptOne : format(text.kept, item.kept ?? 0));
	}
	line.append(el('span', 'compact-rule'), label);
	if (item.state === 'done') {
		line.append(button('turn-action', text.viewSummary, () => send('viewCompactSummary'), 'book'), button('turn-action', text.undo, () => send('undoCompact'), 'discard'));
	}
	line.append(el('span', 'compact-rule'));
	return line;
}

/** Where the turn's time went, hop by hop against the budget, with the tokens and the trace file. */
function renderTrace(item: ItemOf<'trace'>): HTMLElement {
	const { readout } = item;
	const card = el('section', 'trace-card');
	const head = el('div', 'trace-head');
	head.append(el('h3', undefined, strings.trace.title), el('span', 'trace-source', strings.trace.source));
	card.append(head);
	const grid = el('div', 'trace-grid');
	for (const heading of [strings.trace.hop, format(strings.trace.share, formatDuration(readout.totalMs)), strings.trace.thisTurn, strings.trace.budget]) {
		grid.append(el('span', 'trace-col', heading));
	}
	for (const hop of readout.hops) {
		const track = el('span', 'trace-track');
		const bar = el('span', `trace-bar ${hop.tone}`);
		bar.style.width = `${hop.share > 0 ? Math.max(1, Math.round(hop.share * 100)) : 0}%`;
		track.append(bar);
		grid.append(el('span', undefined, hop.name), track, el('span', 'trace-value', hop.value), el('span', 'trace-value', hop.budget));
	}
	card.append(grid);
	const tokens = format(strings.trace.tokens, readout.input.toLocaleString(), readout.cached.toLocaleString(), readout.output.toLocaleString(), String(readout.requests));
	card.append(el('div', 'trace-line', tokens));
	const file = el('div', 'trace-line trace-file');
	file.append(el('span', 'trace-file-name', format(strings.trace.file, item.file)), button('turn-action', strings.trace.open, () => vscode.postMessage({ type: 'openTrace', file: item.file }), 'go-to-file'));
	card.append(file);
	return card;
}

/** The saved sessions last sent, so the empty chat shows them again when it is drawn again. */
let savedSessions: { readonly sessions: readonly ViewSession[]; readonly total: number; readonly retention: string } = { sessions: [], total: 0, retention: '' };

/** The empty chat's card of saved sessions to reopen; nothing when there are none. */
export function showSavedSessions(sessions: readonly ViewSession[], total: number, retention: string): void {
	savedSessions = { sessions, total, retention };
	const empty = ui.transcript.querySelector('.empty');
	empty?.querySelector('.restore-card')?.remove();
	const card = restoreCard();
	if (empty && card) {
		empty.append(card);
	}
}

function restoreCard(): HTMLElement | undefined {
	const { sessions, total } = savedSessions;
	if (!sessions.length) {
		return undefined;
	}
	const card = el('section', 'restore-card');
	const header = el('h3', 'restore-header');
	header.append(icon('history'), el('span', undefined, strings.restoreTitle));
	card.append(header, el('p', 'restore-hint', strings.restoreHint));
	for (const session of sessions) {
		const row = el('div', 'restore-row');
		const text = el('div', 'restore-text');
		text.append(el('span', 'restore-title', session.title), el('span', 'restore-detail', session.detail));
		text.title = session.title;
		row.append(text, button('restore-button', strings.restore, () => vscode.postMessage({ type: 'restoreSession', id: session.id })));
		card.append(row);
	}
	if (total > sessions.length) {
		card.append(button('restore-more', format(strings.showAllSessions, total), () => vscode.postMessage({ type: 'pickSession' })));
	}
	if (savedSessions.retention) {
		card.append(el('p', 'restore-hint restore-retention', savedSessions.retention));
	}
	return card;
}

export function renderEmpty(): HTMLElement {
	const node = el('div', 'empty');
	const hints = el('ul', 'empty-hints');
	for (const [key, text] of [['@', strings.hintMention], ['/', strings.hintCommands], [state.cmdEnter ? (mac ? '↩' : 'Enter') : mac ? '⇧↩' : 'Shift+Enter', strings.hintNewLine], ['', strings.dropFiles]] as const) {
		const hint = el('li');
		hint.append(key ? el('kbd', undefined, key) : icon('cloud-upload'), el('span', undefined, text));
		hints.append(hint);
	}
	node.append(icon('sparkle', 'empty-icon'), el('h2', 'empty-title', strings.welcomeTitle), el('p', undefined, strings.welcome), hints);
	const card = restoreCard();
	if (card) {
		node.append(card);
	}
	return node;
}
