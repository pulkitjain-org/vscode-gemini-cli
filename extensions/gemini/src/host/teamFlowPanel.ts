/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { errorMessage } from '../acp/errors';
import type { FlowRecordStore } from '../acp/flowRecords';
import { FromTeamFlow, TeamFlowState, TeamFlowStrings, TeamFlowView, ToTeamFlow } from './teamFlowProtocol';
import { createNonce, escapeAttribute } from './webviewHtml';

export const teamFlowViewType = 'gemini.teamFlow';

/** How to start the flow again after a quit: the store, the command that opens it and its arguments. */
export interface FlowRecording {
	readonly store: FlowRecordStore;
	readonly command: string;
	readonly args: readonly unknown[];
	readonly about?: string;
}

/**
 * One team flow (Open Merge Request, Move Ticket, Review, Checks) as an editor tab drawn by webview-src/teamFlow.ts. The
 * host holds the state: `update` re-renders the page, while what the user
 * types comes back with `set` and is kept in `fields` without a re-render.
 * An action runs one at a time, with `busy` shown, and its error on the page.
 * With `recording`, a record of the flow sits on disk until it finishes or
 * is closed, so a flow cut off by a quit shows on Home as unfinished.
 */
export class TeamFlowPanel<V extends TeamFlowView> implements vscode.Disposable {

	readonly panel: vscode.WebviewPanel;
	private state: TeamFlowState;
	/** What the user typed or ticked, by field. */
	readonly fields = new Map<string, unknown>();
	private running = false;
	private readonly onDidDisposeEmitter = new vscode.EventEmitter<void>();
	readonly onDidDispose = this.onDidDisposeEmitter.event;
	private disposed = false;
	private record: Promise<string> | undefined;

	constructor(
		extensionUri: vscode.Uri,
		title: string,
		icon: 'jira' | 'gitlab' | 'sonar' | 'snyk' | 'figma',
		loading: string,
		private readonly onAction: (action: string, value: unknown) => Promise<void> | void,
		column: vscode.ViewColumn = vscode.ViewColumn.Active,
		recording?: FlowRecording,
	) {
		const media = vscode.Uri.joinPath(extensionUri, 'media');
		this.panel = vscode.window.createWebviewPanel(teamFlowViewType, title, column, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
		this.panel.iconPath = vscode.Uri.joinPath(media, 'tools', `${icon}.svg`);
		this.state = { loading };
		this.panel.webview.html = html(this.panel.webview, media);
		this.panel.webview.onDidReceiveMessage((message: FromTeamFlow) => this.onMessage(message));
		this.panel.onDidDispose(() => {
			this.disposed = true;
			void this.closeRecord();
			this.onDidDisposeEmitter.fire();
			this.onDidDisposeEmitter.dispose();
		});
		if (recording) {
			this.record = recording.store.open({ command: recording.command, args: recording.args, title, ...recording.about ? { about: recording.about } : {} }).then(id => {
				// Closed before the record was written: take it back.
				if (this.disposed) {
					void recording.store.close(id);
				}
				return id;
			}, () => '');
			this.closeRecord = async () => {
				const id = await this.record;
				if (id) {
					await recording.store.close(id);
				}
			};
		}
	}

	/** Removes the flow's record: it finished, or it was closed. */
	private closeRecord: () => Promise<void> = async () => undefined;

	get isDisposed(): boolean {
		return this.disposed;
	}

	get view(): V | undefined {
		return this.state.view as V | undefined;
	}

	/** Changes the view and re-renders. */
	update(change: Partial<V>): void {
		const view: V = Object.assign({}, this.state.view as V, change);
		this.replace({ ...this.state, loading: undefined, view });
	}

	/** Replaces the whole state and re-renders. */
	private replace(state: TeamFlowState): void {
		if (this.disposed) {
			return;
		}
		this.state = state;
		if ((state.view as { done?: unknown } | undefined)?.done) {
			// The flow did what it was for; a quit now leaves nothing to pick up.
			void this.closeRecord();
		}
		this.post();
	}

	setView(view: V): void {
		this.replace({ view });
	}

	fail(error: unknown): void {
		this.replace({ ...this.state, loading: undefined, busy: undefined, error: errorMessage(error) });
	}

	field<T>(name: string, fallback: T): T {
		return this.fields.has(name) ? this.fields.get(name) as T : fallback;
	}

	/** Runs `work` with `busy` shown; shows its error on the page. One at a time. */
	async busy(label: string, work: () => Promise<void>): Promise<void> {
		if (this.running || this.disposed) {
			return;
		}
		this.running = true;
		this.replace({ ...this.state, busy: label, error: undefined });
		try {
			await work();
			if (!this.disposed && this.state.busy === label) {
				this.replace({ ...this.state, busy: undefined });
			}
		} catch (err) {
			this.fail(err);
		} finally {
			this.running = false;
		}
	}

	dispose(): void {
		this.panel.dispose();
	}

	private post(): void {
		void this.panel.webview.postMessage({ type: 'state', state: this.state } satisfies ToTeamFlow);
	}

	private onMessage(message: FromTeamFlow): void {
		switch (message.type) {
			case 'ready':
				this.post();
				return;
			case 'set':
				this.fields.set(message.field, message.value);
				return;
			case 'act':
				if (message.action === 'close') {
					this.dispose();
					return;
				}
				Promise.resolve(this.onAction(message.action, message.value)).catch(err => this.fail(err));
				return;
		}
	}
}

function html(webview: vscode.Webview, media: vscode.Uri): string {
	const nonce = createNonce();
	const strings: TeamFlowStrings = {
		close: vscode.l10n.t("Close"),
		cancel: vscode.l10n.t("Cancel"),
		back: vscode.l10n.t("Back"),
		next: vscode.l10n.t("Next"),
		change: vscode.l10n.t("Change"),
		openIn: vscode.l10n.t("Open in {0}"),
		openMr: vscode.l10n.t("Open Merge Request"),
		targetHeading: vscode.l10n.t("Merge into"),
		targetHint: vscode.l10n.t("Pick the branch this merge request merges into. Release branches come first."),
		suggested: vscode.l10n.t("from the ticket's fix version"),
		release: vscode.l10n.t("release"),
		title: vscode.l10n.t("Title"),
		description: vscode.l10n.t("Description"),
		regenerate: vscode.l10n.t("Regenerate"),
		generating: vscode.l10n.t("Gemini is writing the description..."),
		descriptionHint: vscode.l10n.t("Written by Gemini from the diff and the ticket. Edit freely; Regenerate replaces it."),
		attachments: vscode.l10n.t("Attachments"),
		attachmentsHint: vscode.l10n.t("Choose what to add to the description."),
		addFile: vscode.l10n.t("Add File..."),
		updateJira: vscode.l10n.t("Update {0}"),
		updateJiraHint: vscode.l10n.t("Opens the Jira step next"),
		deleteBranch: vscode.l10n.t("Delete branch when merged"),
		draft: vscode.l10n.t("Draft"),
		reviewers: vscode.l10n.t("Reviewers"),
		addReviewer: vscode.l10n.t("Add..."),
		searchPeople: vscode.l10n.t("Search people"),
		noPeople: vscode.l10n.t("Nobody matches."),
		pushesAs: vscode.l10n.t("Pushes the branch to {0} as {1}"),
		existingMr: vscode.l10n.t("This branch already has merge request !{0}."),
		moveTicket: vscode.l10n.t("Move Ticket"),
		moveTo: vscode.l10n.t("Move to"),
		noMoves: vscode.l10n.t("The workflow allows no moves from this status."),
		fieldNeeded: vscode.l10n.t("{0} (needed for this move)"),
		choose: vscode.l10n.t("Choose..."),
		comment: vscode.l10n.t("Comment"),
		addComment: vscode.l10n.t("Add a comment"),
		commentHint: vscode.l10n.t("Written by Gemini; edit it before moving."),
		visibleTo: vscode.l10n.t("Visible to {0}"),
		everyone: vscode.l10n.t("Visible to everyone who can see the ticket"),
		move: vscode.l10n.t("Move"),
		moveAndLog: vscode.l10n.t("Move and Log Time"),
		logTime: vscode.l10n.t("Log time"),
		logTimeHint: vscode.l10n.t("Adds a work log to the ticket."),
		timeSpent: vscode.l10n.t("Time spent"),
		timeSpentPlaceholder: vscode.l10n.t("1h 30m"),
		badTime: vscode.l10n.t("Use hours and minutes, such as 1h 30m."),
		date: vscode.l10n.t("Date"),
		workComment: vscode.l10n.t("What you worked on (optional)"),
		logIt: vscode.l10n.t("Log Time"),
		reviewTitle: vscode.l10n.t("Review !{0}"),
		reviewing: vscode.l10n.t("Gemini is reviewing the merge request in its own worktree..."),
		preparing: vscode.l10n.t("Checking out the merge request..."),
		unparsed: vscode.l10n.t("The review didn't end with draft comments. Ask the agent to list its findings as the JSON block, then press Read Again."),
		readAgain: vscode.l10n.t("Read Again"),
		geminiReview: vscode.l10n.t("Gemini's review."),
		openDiff: vscode.l10n.t("Open in Diff"),
		yourReview: vscode.l10n.t("Your review"),
		yourReviewHint: vscode.l10n.t("{0} comments ticked, posted as you on their lines. Edit any of them first."),
		postAndRequest: vscode.l10n.t("Post {0} Comments and Request Changes"),
		post: vscode.l10n.t("Post {0} Comments"),
		approve: vscode.l10n.t("Approve"),
		approved: vscode.l10n.t("You approved it"),
		files: vscode.l10n.t("Files"),
		noFindings: vscode.l10n.t("Nothing to raise."),
		kindBug: vscode.l10n.t("Bug"),
		kindShouldFix: vscode.l10n.t("Should fix"),
		kindNit: vscode.l10n.t("Nit"),
		kindQuestion: vscode.l10n.t("Question"),
		openAgent: vscode.l10n.t("Open the Agent"),
		checksTitle: vscode.l10n.t("Checks"),
		fix: vscode.l10n.t("Fix"),
		fixAll: vscode.l10n.t("Fix All with This Agent"),
		fixChosen: vscode.l10n.t("Fix {0} with This Agent"),
		fixAllNew: vscode.l10n.t("Fix All with a New Agent"),
		fixChosenNew: vscode.l10n.t("Fix {0} with a New Agent"),
		runAgain: vscode.l10n.t("Run Again"),
		noIssues: vscode.l10n.t("No issues found."),
		fixNote: vscode.l10n.t("No agent works on this branch yet. Fix starts one in this checkout with the findings as its first prompt."),
	};
	const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'teamFlow.js'));
	const styles = ['codicon.css', 'menu.css', 'panels.css', 'teamFlow.css'].map(file => `<link href="${webview.asWebviewUri(vscode.Uri.joinPath(media, file))}" rel="stylesheet">`).join('\n\t');
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data: ${webview.cspSource}; img-src data: ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	${styles}
	<title>Team flow</title>
</head>
<body class="team-flow">
	<main id="flow"></main>
	<script nonce="${nonce}" type="module" src="${script}" data-strings="${escapeAttribute(JSON.stringify(strings))}"></script>
</body>
</html>`;
}
