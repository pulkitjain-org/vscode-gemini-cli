/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat view's page: its HTML, and every string the view shows, which come
// from the extension host so they are localized.

import * as vscode from 'vscode';
import type { ChatStrings, ForkStrings, ProjectChatStrings, ReactionStrings, ResearchStrings, SideStrings } from '../chatProtocol';
import { reactionsOn } from '../chatReactions';
import { configSection } from '../configuration';
import { foldWorkOn } from '../foldWork';
import { spellCheckOn } from '../spellCheck';
import { createNonce, escapeAttribute } from '../webviewHtml';

/** A project chat's strings, from dist/onDemand.js (projectStrings.ts); set as the extension activates. */
let projectStringsOf: (() => ProjectChatStrings) | undefined;

export function setProjectStrings(load: () => ProjectChatStrings): void {
	projectStringsOf = load;
}

/** The chat view's page for `webview`, loading its script and styles from `mediaUri`; `project` adds a project chat's strings, `fork` Fork Agent's. */
export function chatHtml(webview: vscode.Webview, mediaUri: vscode.Uri, project: boolean, fork: boolean): string {
	const nonce = createNonce();
	const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'chat.js'));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'chat.css'));
	const menuStyle = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'menu.css'));
	const codicons = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'codicon.css'));
	const glassStyle = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'glass.css'));
	// Loaded by the view when it first shows code.
	const highlighter = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'highlight.js'));
	// Loaded by the view when a reply first has math.
	const katex = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'katex.js'));
	const katexStyle = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'katex-style.css'));
	// Loaded by the view when the reaction button is first hovered or focused.
	const emojiPicker = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'emojiPicker.js'));
	const figmaDesign = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'figmaDesign.js'));
	const threadCard = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'threadCard.js'));
	const projectSettings = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'projectSettings.js'));
	const sideChat = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'sideChat.js'));
	const strings: ChatStrings = {
		placeholder: vscode.l10n.t("Ask Gemini anything about this workspace · / for commands, @ for files"),
		fromCoordinator: vscode.l10n.t("From coordinator"),
		// A project chat's strings load with the code they serve, from dist/onDemand.js: most chats aren't project chats.
		...(project && projectStringsOf ? { project: projectStringsOf() } : {}),
		...(fork ? { fork: forkStrings() } : {}),
		side: sideStrings(),
		research: researchStrings(),
		...(project ? {} : { reactions: reactionStrings() }),
		placeholderFollowUp: vscode.l10n.t("Ask a follow-up · /research reads widely, /btw asks on the side"),
		placeholderWorking: process.platform === 'darwin' ? vscode.l10n.t("↩ to steer, ⌘↩ to queue · ⌥⌘; asks on the side") : vscode.l10n.t("Enter to steer, Ctrl+Enter to queue · Ctrl+Alt+; asks on the side"),
		send: process.platform === 'darwin' ? vscode.l10n.t("Send (Return)") : vscode.l10n.t("Send (Enter)"),
		sendNow: process.platform === 'darwin' ? vscode.l10n.t("Send now (Return). ⌘Return queues it for after this turn.") : vscode.l10n.t("Send now (Enter). Ctrl+Enter queues it for after this turn."),
		stop: vscode.l10n.t("Stop (Esc Esc)"),
		includeEdits: vscode.l10n.t("Include your edits to {0}"),
		includeEditsTip: vscode.l10n.t("Copies the edits you made to these tried files into the agent's folder before your message, so it builds on them."),
		queued: vscode.l10n.t("Queued: goes after this turn"),
		queuedFromCoordinator: vscode.l10n.t("From coordinator: goes after this turn"),
		steering: vscode.l10n.t("Sending after the current step"),
		queueSendNow: vscode.l10n.t("Send now"),
		queueEdit: vscode.l10n.t("Edit"),
		queueRemove: vscode.l10n.t("Remove"),
		queueAttached: vscode.l10n.t("{0} attached"),
		replyFinished: vscode.l10n.t("Reply finished"),
		welcomeTitle: vscode.l10n.t("What are we building?"),
		welcome: vscode.l10n.t("Ask Gemini to explain, change or create code in this workspace. It asks before it edits files."),
		hintMention: vscode.l10n.t("to add files as context"),
		hintNewLine: vscode.l10n.t("for a new line"),
		hintCommands: vscode.l10n.t("for commands"),
		scrollToBottom: vscode.l10n.t("Jump to latest"),
		latest: vscode.l10n.t("Latest"),
		thinking: vscode.l10n.t("Thinking"),
		activityWorking: vscode.l10n.t("Working"),
		activityWaiting: vscode.l10n.t("Waiting on you"),
		activityWriting: vscode.l10n.t("Writing the reply"),
		activityDone: vscode.l10n.t("Done in {0}"),
		activityStopHint: vscode.l10n.t("Esc twice to stop"),
		activityStopAgain: vscode.l10n.t("Press Esc again to stop"),
		thought: vscode.l10n.t("Thought"),
		thoughtFor: vscode.l10n.t("Thought for {0}s"),
		plan: vscode.l10n.t("Plan"),
		subagent: vscode.l10n.t("Subagent: {0}"),
		subagentWorking: vscode.l10n.t("working"),
		subagentFinished: vscode.l10n.t("finished in {0}"),
		subagentFailed: vscode.l10n.t("failed"),
		unknownUpdate: vscode.l10n.t("Update not shown in this version: {0}"),
		terminal: vscode.l10n.t("Terminal output"),
		openDiff: vscode.l10n.t("Open diff"),
		copy: vscode.l10n.t("Copy"),
		copied: vscode.l10n.t("Copied"),
		run: {
			run: vscode.l10n.t("Run in Terminal"),
			more: vscode.l10n.t("More Ways to Run"),
			insert: vscode.l10n.t("Insert Without Running"),
			newTerminal: vscode.l10n.t("Run in New Terminal"),
			runIn: vscode.l10n.t("Run in {0}"),
			pick: vscode.l10n.t("Run in which repository?"),
			cancel: vscode.l10n.t("Cancel"),
			streaming: vscode.l10n.t("Run is ready once the reply finishes this block"),
			running: vscode.l10n.t("Running"),
			passed: vscode.l10n.t("Exit code 0, in {0}"),
			failed: vscode.l10n.t("Exit code {0}, in {1}"),
			sendOutput: vscode.l10n.t("Send Output to Gemini"),
			openTerminal: vscode.l10n.t("Open Terminal"),
			openTerminalDetail: vscode.l10n.t("in the agent's folder"),
		},
		mode: vscode.l10n.t("Mode"),
		model: vscode.l10n.t("Model"),
		permissionAnswered: vscode.l10n.t("You chose: {0}"),
		permissionCancelled: vscode.l10n.t("Not answered; the request was cancelled."),
		permissionHint: vscode.l10n.t("Esc rejects"),
		permission: {
			once: vscode.l10n.t("Allow once"),
			session: vscode.l10n.t("Allow {0} for this session"),
			reject: vscode.l10n.t("Reject"),
			hint: vscode.l10n.t("Answer from the chat box: {0} allows once, {1} allows for this session, {2} rejects."),
			hintNoSession: vscode.l10n.t("Answer from the chat box: {0} allows once, {1} rejects."),
			othersChanging: vscode.l10n.t("\"{0}\" also has unreviewed changes in this file."),
			othersDetail: vscode.l10n.t("Edits from both agents will mix. Give this agent its own branch to keep them apart."),
			showTheirChanges: vscode.l10n.t("Show Its Changes"),
		},
		noticeActions: {
			retry: vscode.l10n.t("Retry"),
			switchModel: vscode.l10n.t("Switch Model\u2026"),
			signIn: vscode.l10n.t("Sign In"),
			continue: vscode.l10n.t("Continue"),
			showLog: vscode.l10n.t("Show Log"),
			stop: vscode.l10n.t("Stop"),
			newSession: vscode.l10n.t("Continue in a New Session"),
			fixErrors: vscode.l10n.t("Fix"),
		},
		outputHidden: vscode.l10n.t("{0} lines hidden"),
		outputShowAll: vscode.l10n.t("Show All"),
		outputGone: vscode.l10n.t("The full output is no longer kept."),
		durationSeconds: vscode.l10n.t("{0} s"),
		durationMs: vscode.l10n.t("{0} ms"),
		permissionWaiting: vscode.l10n.t("Gemini is waiting for your answer: {0}"),
		confirmClass: vscode.l10n.t("confirm class"),
		confirmWhy: vscode.l10n.t("Shown exactly as {0} will record it under your account. This card never offers \"Allow for this session\": it asks every time."),
		firstToken: vscode.l10n.t("first token {0}"),
		compact: {
			suggested: vscode.l10n.t("This chat's context is {0}% full."),
			suggestedText: vscode.l10n.t("Compact summarizes the older work and keeps the latest prompts as they were, so each turn sends less. You can undo it."),
			compact: vscode.l10n.t("Compact"),
			notNow: vscode.l10n.t("Not Now"),
			running: vscode.l10n.t("Compacting: Gemini is summarizing the earlier work..."),
			done: vscode.l10n.t("Compacted: {0} to {1} tokens"),
			keptOne: vscode.l10n.t("The older work is summarized; the last prompt is kept as it was."),
			kept: vscode.l10n.t("The older work is summarized; the last {0} prompts are kept as they were."),
			keptNone: vscode.l10n.t("The work so far is summarized, with no prompt kept as it was."),
			undo: vscode.l10n.t("Undo"),
			viewSummary: vscode.l10n.t("View Summary"),
			undone: vscode.l10n.t("Compact undone: the chat is back on its full session."),
			failed: vscode.l10n.t("Couldn't compact: {0}"),
			popover: vscode.l10n.t("Compact"),
			popoverNote: vscode.l10n.t("Summarize the older work to free up context."),
		},
		cutOff: {
			title: vscode.l10n.t("This turn was interrupted when GeminiCode quit."),
			text: vscode.l10n.t("Whatever the agent changed before that is in Changes and on disk; nothing else was done. The session is restored from the CLI's chat file, and nothing was sent to Gemini since. Session approvals ended with the process, so the next command asks again."),
			retry: vscode.l10n.t("Retry the Turn"),
			keep: vscode.l10n.t("Keep and Continue"),
		},
		trace: {
			title: vscode.l10n.t("Where the time went: this turn"),
			source: vscode.l10n.t("from the CLI's OpenTelemetry file · gemini_cli.* metrics"),
			hop: vscode.l10n.t("Hop"),
			share: vscode.l10n.t("Share of {0}"),
			thisTurn: vscode.l10n.t("This turn"),
			budget: vscode.l10n.t("Budget p50"),
			tokens: vscode.l10n.t("Tokens: {0} in (cached {1}) · {2} out · {3} requests"),
			file: vscode.l10n.t("Trace file: {0} · prompts not logged"),
			open: vscode.l10n.t("Open"),
		},
		workedFor: vscode.l10n.t("Worked for {0}"),
		stoppedForMessage: vscode.l10n.t("Stopped for your message · {0}"),
		steerWaiting: vscode.l10n.t("Waiting to stop safely: a tool is finishing"),
		steerStopNow: vscode.l10n.t("Stop Now"),
		steerStopNowTip: vscode.l10n.t("Stop the turn now. A tool that finished but whose result the agent hasn't read yet is lost, and the agent may run it again."),
		work: {
			stoppedAfter: vscode.l10n.t("Stopped after {0}"),
			stopped: vscode.l10n.t("Stopped"),
			steps: vscode.l10n.t("{0} steps"),
			oneStep: vscode.l10n.t("1 step"),
			counts: {
				read: [vscode.l10n.t("read 1 file"), vscode.l10n.t("read {0} files")],
				search: [vscode.l10n.t("searched 1 pattern"), vscode.l10n.t("searched {0} patterns")],
				execute: [vscode.l10n.t("ran 1 command"), vscode.l10n.t("ran {0} commands")],
				edit: [vscode.l10n.t("edited 1 file"), vscode.l10n.t("edited {0} files")],
				fetch: [vscode.l10n.t("fetched 1 page"), vscode.l10n.t("fetched {0} pages")],
				other: [vscode.l10n.t("used 1 tool"), vscode.l10n.t("used {0} tools")],
			},
			runs: {
				read: vscode.l10n.t("Read {0} files"),
				search: vscode.l10n.t("Searched {0} patterns"),
				execute: vscode.l10n.t("Ran {0} commands"),
				edit: vscode.l10n.t("Edited {0} files"),
				fetch: vscode.l10n.t("Fetched {0} pages"),
				other: vscode.l10n.t("Used {0} tools"),
			},
			failed: vscode.l10n.t("{0} failed"),
			failedFixed: vscode.l10n.t("{0} failed, fixed"),
			fixedLater: vscode.l10n.t("got through when run again"),
			changed: vscode.l10n.t("Changed"),
			showOutput: vscode.l10n.t("Show output"),
		},
		copyReply: vscode.l10n.t("Copy reply"),
		copyMessage: vscode.l10n.t("Copy message"),
		undoTurn: vscode.l10n.t("Undo"),
		undoTurnTooltip: vscode.l10n.t("Put back the files this reply changed"),
		rewindPrompt: vscode.l10n.t("Rewind to here"),
		undoTurnFiles: vscode.l10n.t("Put back the {0} files this reply changed"),
		turnUndone: vscode.l10n.t("Changes undone"),
		retry: vscode.l10n.t("Retry"),
		retryTooltip: vscode.l10n.t("Send this message again"),
		buildPlan: vscode.l10n.t("Build This Plan"),
		buildPlanTooltip: vscode.l10n.t("Leave Plan mode and carry out this plan"),
		reviewPlan: vscode.l10n.t("Review Plan"),
		reviewPlanTooltip: vscode.l10n.t("Open the plan to edit it and comment on its sections, then send the comments to Gemini"),
		planBuild: {
			more: vscode.l10n.t("Other ways to build"),
			buildIn: vscode.l10n.t("Build in {0}"),
			asking: vscode.l10n.t("Build, Asking for Each Edit"),
			beforePlan: vscode.l10n.t("The mode you were in before planning"),
			defaultMode: vscode.l10n.t("Default mode"),
			models: vscode.l10n.t("Builds with {0}; planned with {1}."),
		},
		switchBranch: vscode.l10n.t("Branch {0}: switch or create a branch"),
		createBranchAndCommit: vscode.l10n.t("Create a branch and commit these changes"),
		commit: vscode.l10n.t("Commit\u2026"),
		commitTo: {
			button: vscode.l10n.t("Commit to {0}"),
			tip: vscode.l10n.t("Commit the agent's changes to {0}"),
			more: vscode.l10n.t("More ways to commit"),
			newBranch: vscode.l10n.t("Create Branch and Commit\u2026"),
			message: vscode.l10n.t("Commit message"),
			writing: vscode.l10n.t("Writing a commit message\u2026"),
			generated: vscode.l10n.t("Generated from the changes \u00b7 edit before committing"),
			commit: vscode.l10n.t("Commit"),
			cancel: vscode.l10n.t("Cancel"),
		},
		enhance: vscode.l10n.t("Enhance prompt"),
		enhanceShort: vscode.l10n.t("Enhance"),
		previewMarkdown: vscode.l10n.t("Preview ({0})"),
		previewLabel: vscode.l10n.t("Preview"),
		writeLabel: vscode.l10n.t("Write"),
		followAgent: vscode.l10n.t("Follow the agent: open each file it reads or edits"),
		promptOutline: process.platform === 'darwin' ? vscode.l10n.t("Your prompts (⌥⌘↑ and ⌥⌘↓ to jump between them)") : vscode.l10n.t("Your prompts (Ctrl+Alt+Up and Ctrl+Alt+Down to jump between them)"),
		previewEmpty: vscode.l10n.t("Nothing to preview yet."),
		enhanceTooltip: vscode.l10n.t("Rewrite this as a clearer, more precise prompt ({0})"),
		enhancing: vscode.l10n.t("Enhancing the prompt"),
		enhanced: vscode.l10n.t("Prompt enhanced. Review it, then send."),
		enhancingNote: vscode.l10n.t("Rewriting as a precise prompt \u00b7 Esc to cancel"),
		enhancedNote: vscode.l10n.t("Enhanced. Edit it, send it, or Revert to your words ({0} works too)."),
		stillEnhancing: vscode.l10n.t("Still working\u2026"),
		enhanceWaiting: vscode.l10n.t("Gemini is busy or rate-limited and is retrying\u2026"),
		cancel: vscode.l10n.t("Cancel"),
		revert: vscode.l10n.t("Revert"),
		revertTooltip: vscode.l10n.t("Put back what you wrote"),
		workspaceTooltip: vscode.l10n.t("Workspace {0}"),
		repoTooltip: vscode.l10n.t("Repository {0} on {1}, at {2}"),
		repositories: vscode.l10n.t("Repositories"),
		worktree: vscode.l10n.t("worktree"),
		restoreTitle: vscode.l10n.t("Restore a session"),
		restoreHint: vscode.l10n.t("Saved by the Gemini CLI for this folder"),
		restore: vscode.l10n.t("Restore"),
		showAllSessions: vscode.l10n.t("Show all {0} sessions\u2026"),
		commandFromApp: vscode.l10n.t("GeminiCode"),
		usage: vscode.l10n.t("Usage and quota"),
		usageThisChat: vscode.l10n.t("This chat"),
		usageTurns: vscode.l10n.t("{0} replies"),
		usageOneTurn: vscode.l10n.t("1 reply"),
		usageInput: vscode.l10n.t("Input"),
		usageOutput: vscode.l10n.t("Output"),
		usageModel: vscode.l10n.t("Model"),
		usageTotal: vscode.l10n.t("Total"),
		usageInputNote: vscode.l10n.t("Input counts the conversation again for each model call, as the CLI's /stats does."),
		usageNoTurns: vscode.l10n.t("No replies yet."),
		usageNoCounts: vscode.l10n.t("No token counts for these replies. Gemini reports them for new replies."),
		usageSomeCounted: vscode.l10n.t("Counts for {0} of {1} replies."),
		usageQuota: vscode.l10n.t("Today's quota"),
		usageUsed: vscode.l10n.t("{0}% used"),
		usageResetsHours: vscode.l10n.t("resets in {0}h"),
		usageResetsMinutes: vscode.l10n.t("resets in {0}m"),
		usageChecking: vscode.l10n.t("Checking\u2026"),
		usageCheckedJustNow: vscode.l10n.t("Checked just now"),
		usageUpgrade: vscode.l10n.t("Get higher limits"),
		usageCheckedMinutes: vscode.l10n.t("Checked {0} min ago"),
		usageQuotaOff: vscode.l10n.t("Turned off in Settings (Gemini \u203a Usage Meter)."),
		usageQuotaNone: vscode.l10n.t("Shown when you sign in with Google. API keys have no daily quota to read."),
		usageQuotaFailed: vscode.l10n.t("Couldn't read the quota. Try again in a moment."),
		plusMenu: vscode.l10n.t("Add files, context, modes and more"),
		menuSearch: vscode.l10n.t("Search modes, files, commands\u2026"),
		menuFiles: vscode.l10n.t("Files"),
		menuFilesDetail: vscode.l10n.t("Attach files or images"),
		menuContext: vscode.l10n.t("Context"),
		menuContextDetail: vscode.l10n.t("Add workspace files (@)"),
		menuFollow: vscode.l10n.t("Follow the agent"),
		menuFollowDetail: vscode.l10n.t("Open each file it reads or edits"),
		followAgentOn: vscode.l10n.t("Following the agent: each file it reads or edits opens. Click to stop."),
		menuUsageDetail: vscode.l10n.t("Context {0}%"),
		menuCommands: vscode.l10n.t("Skills and commands"),
		fromYourTools: vscode.l10n.t("From your tools"),
		jiraTicket: vscode.l10n.t("Jira ticket"),
		gitlabItem: vscode.l10n.t("GitLab merge request or issue"),
		confluencePage: vscode.l10n.t("Confluence page"),
		figmaFrame: vscode.l10n.t("Figma frame"),
		pasteLink: vscode.l10n.t("paste link"),
		figmaDesign: vscode.l10n.t("Figma Design..."),
		figmaDesignEnd: vscode.l10n.t("a link for each size"),
		figmaDesignTitle: vscode.l10n.t("Add Figma Design"),
		figmaDesignHint: vscode.l10n.t("Paste the frame link for each screen size. Pasting several links at once fills the rows in order."),
		figmaSetUpDesignSystem: vscode.l10n.t("Set Up Your Design System"),
		figmaSetUpDesignSystemTip: vscode.l10n.t("Read your design system from Figma once, so agents build every design with its tokens and components"),
		figmaSize: vscode.l10n.t("Size"),
		figmaLinkFor: vscode.l10n.t("Frame link for {0}"),
		figmaAddSize: vscode.l10n.t("Add Size"),
		figmaAddDesign: vscode.l10n.t("Add Design"),
		figmaUpdateDesign: vscode.l10n.t("Update Design"),
		figmaOtherFile: vscode.l10n.t("{0}: from another Figma file. Figma reads one open file at a time, so the agent will ask you to switch files when it gets there."),
		figmaRepeated: vscode.l10n.t("{0} is used for more than one frame."),
		figmaNotLink: vscode.l10n.t("Paste a Figma frame link: in Figma, select the frame and choose Copy Link to Selection."),
		figmaDesignChip: vscode.l10n.t("Figma design"),
		figmaDesignFailed: vscode.l10n.t("Add Figma Design couldn't open. Try again."),
		figmaEditDesign: vscode.l10n.t("Change the design's sizes"),
		openMergeRequest: vscode.l10n.t("Open Merge Request"),
		openMergeRequestTip: vscode.l10n.t("Open a merge request on GitLab for this agent's branch"),
		toolChipLoading: vscode.l10n.t("Reading\u2026"),
		openToolItem: vscode.l10n.t("Open {0}"),
		indexToolVerbs: {
			searchCode: vscode.l10n.t("Search code for {0}"),
			findSymbol: vscode.l10n.t("Look up {0}"),
			related: vscode.l10n.t("Find files related to {0}"),
			outline: vscode.l10n.t("Outline {0}"),
			outlineFolder: vscode.l10n.t("Outline the folder"),
			searchDocs: vscode.l10n.t("Search docs for {0}"),
			typeOf: vscode.l10n.t("Type of {0}"),
			checkErrors: vscode.l10n.t("Check changed files for errors"),
			checkErrorsIn: vscode.l10n.t("Check {0} for errors"),
			callersOf: vscode.l10n.t("Callers of {0}"),
			callsIn: vscode.l10n.t("Calls in {0}"),
		},
		teamToolVerbs: {
			read: vscode.l10n.t("Read {0}"),
			search: vscode.l10n.t("Search Jira for {0}"),
			comment: vscode.l10n.t("Comment on {0}"),
			move: vscode.l10n.t("Move {0}"),
			logTime: vscode.l10n.t("Log {0} on {1}"),
			openMr: vscode.l10n.t("Open merge request into {0}"),
			merge: vscode.l10n.t("Merge {0}"),
			reply: vscode.l10n.t("Reply on {0}"),
			listReview: vscode.l10n.t("List merge requests waiting for my review"),
			listMine: vscode.l10n.t("List my merge requests"),
			jobLog: vscode.l10n.t("Read the CI log of {0}"),
			qualityGate: vscode.l10n.t("Check the SonarQube quality gate"),
			sonarIssues: vscode.l10n.t("Read SonarQube issues"),
			snykTest: vscode.l10n.t("Run Snyk on the dependencies"),
			snykCode: vscode.l10n.t("Run Snyk Code on the source"),
			design: vscode.l10n.t("Read the Figma design"),
			screenshot: vscode.l10n.t("Take a screenshot of the Figma frame"),
			designAt: vscode.l10n.t("Read the Figma design ({0})"),
			screenshotAt: vscode.l10n.t("Take a screenshot of the Figma frame ({0})"),
			searchPages: vscode.l10n.t("Search Confluence for \"{0}\""),
			readPage: vscode.l10n.t("Read the Confluence page"),
			draftPage: vscode.l10n.t("Draft the Confluence page \"{0}\""),
			currentMr: vscode.l10n.t("this branch's merge request"),
			effectComment: vscode.l10n.t("Comment"),
			effectWork: vscode.l10n.t("Work description"),
			effectTitle: vscode.l10n.t("Title"),
			effectDescription: vscode.l10n.t("Description"),
			effectDraft: vscode.l10n.t("Draft"),
			effectSquash: vscode.l10n.t("Squash"),
			effectDeleteBranch: vscode.l10n.t("Delete source branch"),
			effectProjectDefault: vscode.l10n.t("project default"),
		},
		back: vscode.l10n.t("Back"),
		branchSearch: vscode.l10n.t("Switch branch"),
		createBranch: vscode.l10n.t("Create branch\u2026"),
		newBranchName: vscode.l10n.t("New branch name"),
		createBranchNamed: vscode.l10n.t("Create {0}"),
		invalidBranchName: vscode.l10n.t("Enter a valid branch name."),
		noBranches: vscode.l10n.t("No matching branches"),
		loading: vscode.l10n.t("Loading\u2026"),
		currentBranch: vscode.l10n.t("current"),
		copyPath: vscode.l10n.t("Copy Path"),
		revealFolder: process.platform === 'darwin' ? vscode.l10n.t("Reveal in Finder") : process.platform === 'win32' ? vscode.l10n.t("Reveal in File Explorer") : vscode.l10n.t("Open Containing Folder"),
		showAgents: vscode.l10n.t("Show Agents"),
		addFolder: vscode.l10n.t("Add Folder to Workspace..."),
		modeChip: vscode.l10n.t("Mode: {0}. Click to change it."),
		modeChipReset: vscode.l10n.t("Back to {0}"),
		modeRecommended: vscode.l10n.t("Recommended here"),
		modeDetails: {
			default: vscode.l10n.t("Asks before every change and command"),
			autoEdit: vscode.l10n.t("Edits apply at once; review them with Keep and Undo. Commands still ask."),
			plan: vscode.l10n.t("Reads and plans; changes nothing"),
			yolo: vscode.l10n.t("Runs everything without asking"),
		},
		usageRing: vscode.l10n.t("Context {0}% used. Click for usage and quota."),
		followedFile: vscode.l10n.t("{0}, the file the agent is on. Click to show it."),
		closeFollowed: vscode.l10n.t("Close {0}"),
		usageContext: vscode.l10n.t("Context window"),
		usageThisChatScope: vscode.l10n.t("this chat"),
		usageAccount: vscode.l10n.t("your account"),
		usageContextNone: vscode.l10n.t("Shown after Gemini's first reply in this chat."),
		usageContextOf: vscode.l10n.t("of {0} tokens"),
		usageContextNote: vscode.l10n.t("Gemini summarises older messages at {0}%."),
		usageCached: vscode.l10n.t("Cached"),
		usageCachedNote: vscode.l10n.t("Cached: input served from Gemini's cache, from the CLI's session file."),
		usageDetails: vscode.l10n.t("Details by model"),
		usageHideDetails: vscode.l10n.t("Hide details"),
		usageAllModels: vscode.l10n.t("All {0} models"),
		usageFewerModels: vscode.l10n.t("Fewer models"),
		contextParts: {
			conversation: vscode.l10n.t("Conversation"),
			servers: vscode.l10n.t("MCP servers ({0})"),
			rules: vscode.l10n.t("Rule files ({0})"),
			geminicode: vscode.l10n.t("GeminiCode tools"),
			cli: vscode.l10n.t("CLI system prompt"),
			ruleFiles: vscode.l10n.t("Rule files loaded"),
			kilobytes: vscode.l10n.t("{0} KB"),
			aboutTokens: vscode.l10n.t("about {0} tokens"),
			large: vscode.l10n.t("{0} is large: every turn carries it. Trim it or split it with @imports."),
			measured: vscode.l10n.t("Measured {0}"),
			measureAgain: vscode.l10n.t("Measure Again"),
			measuring: vscode.l10n.t("Measuring what each turn carries\u2026"),
			notMeasured: vscode.l10n.t("Not measured yet."),
			failed: vscode.l10n.t("Couldn't measure: {0}"),
			compactNote: vscode.l10n.t("/compact frees the conversation part"),
		},
		mentions: {
			files: vscode.l10n.t("Files"),
			folders: vscode.l10n.t("Folders"),
			symbols: vscode.l10n.t("Symbols"),
			workspace: vscode.l10n.t("Workspace"),
			problems: vscode.l10n.t("Problems"),
			problemsDetail: vscode.l10n.t("{0} errors, {1} warnings"),
			changes: vscode.l10n.t("Uncommitted changes"),
			changesDetail: vscode.l10n.t("{0} files"),
			terminal: vscode.l10n.t("Last terminal command"),
			terminalFailed: vscode.l10n.t("{0} \u00b7 failed"),
		},
		cmdEnter: {
			placeholderWorking: process.platform === 'darwin' ? vscode.l10n.t("⌘↩ to steer, ⇧⌘↩ to queue · ⌥⌘; asks on the side") : vscode.l10n.t("Ctrl+Enter to steer, Shift+Ctrl+Enter to queue · Ctrl+Alt+; asks on the side"),
			send: process.platform === 'darwin' ? vscode.l10n.t("Send (⌘Return)") : vscode.l10n.t("Send (Ctrl+Enter)"),
			sendNow: process.platform === 'darwin' ? vscode.l10n.t("Send now (⌘Return). ⇧⌘Return queues it for after this turn.") : vscode.l10n.t("Send now (Ctrl+Enter). Shift+Ctrl+Enter queues it for after this turn."),
		},
		noFiles: vscode.l10n.t("No matching files"),
		noCommands: vscode.l10n.t("No matching commands"),
		pickerFiles: vscode.l10n.t("Files to attach"),
		pickerCommands: vscode.l10n.t("Commands"),
		commandFromCli: vscode.l10n.t("Gemini CLI"),
		commandFromTeam: vscode.l10n.t("Team"),
		commandFromSkill: vscode.l10n.t("Skill"),
		remove: vscode.l10n.t("Remove"),
		sharedPage: vscode.l10n.t("Shared page: {0}"),
		showSharedPage: vscode.l10n.t("Show the page ({0})"),
		sideOn: vscode.l10n.t("On {0}"),
		sideLinks: vscode.l10n.t("The agent's changes, browser, terminal and files"),
		sideChanges: vscode.l10n.t("Changes"),
		sideChangesTip: vscode.l10n.t("Review the agent's changes: {0} lines added, {1} removed"),
		sideBrowser: vscode.l10n.t("Browser"),
		sideBrowserTip: vscode.l10n.t("Show the agent's page in the browser, or open a new one"),
		sideTerminal: vscode.l10n.t("Terminal"),
		sideTerminalTip: vscode.l10n.t("Open a terminal in the agent's folder"),
		sideFiles: vscode.l10n.t("Files"),
		sideFilesTip: vscode.l10n.t("Browse the agent's files"),
		stopSharing: vscode.l10n.t("Stop sharing this page"),
		fileTooLarge: vscode.l10n.t("{0} is too large to send."),
		attachFiles: vscode.l10n.t("Attach files. You can also drop files here; hold Shift when dragging from the Explorer."),
		dropFiles: vscode.l10n.t("Drop files to attach"),
		calloutNote: vscode.l10n.t("Note"),
		calloutTip: vscode.l10n.t("Tip"),
		calloutImportant: vscode.l10n.t("Important"),
		calloutWarning: vscode.l10n.t("Warning"),
		calloutCaution: vscode.l10n.t("Caution"),
		openFile: vscode.l10n.t("Open file"),
		cannotAttach: vscode.l10n.t("{0} can't be attached: only text files, images and PDFs can be dropped here. Use the attach button to add other files."),
	};
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data: ${webview.cspSource}; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${codicons}" rel="stylesheet">
	<link href="${menuStyle}" rel="stylesheet">
	<link href="${style}" rel="stylesheet">
	<link href="${glassStyle}" rel="stylesheet">
	<title>Gemini</title>
</head>
<body spellcheck="false">
	<svg class="defs" aria-hidden="true"><linearGradient id="gemini-spark-gradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f8df7"/><stop offset=".55" stop-color="#9b72cb"/><stop offset="1" stop-color="#d96570"/></linearGradient></svg>
	<main id="transcript" class="transcript"></main>
	<nav id="outline" class="prompt-outline" hidden></nav>
	<nav id="side-links" class="side-links" hidden></nav>
	<div id="announce" class="announce" aria-live="polite"></div>
	<div id="dock" class="dock">
		<button type="button" id="scroll-down" class="scroll-down" hidden><i class="codicon codicon-arrow-down" aria-hidden="true"></i><i class="codicon codicon-chevron-down" aria-hidden="true"></i><span class="scroll-down-label"></span></button>
		<div id="activity" class="activity" hidden><span class="activity-icon" aria-hidden="true"><i class="codicon codicon-check"></i></span><span class="activity-label"></span><span class="activity-clock"></span><span class="activity-detail"></span><span class="activity-hint"></span></div>
		<div id="status" class="status" role="status"></div>
		<form id="composer" class="composer">
			<div class="working-bar" aria-hidden="true"></div>
			<div id="resize" class="composer-resize"></div>
			<div class="drop-overlay" aria-hidden="true"><i class="codicon codicon-cloud-upload"></i><span id="drop-label"></span></div>
			<div id="picker" class="picker" role="listbox" hidden></div>
			<div id="usage-popover" class="usage-popover" role="dialog" hidden></div>
			<div id="queue" class="queue" role="list" hidden></div>
			<label id="tried-edits" class="tried-edits" hidden><input type="checkbox" id="tried-edits-on" checked><span></span></label>
			<div id="attachments" class="attachments" hidden></div>
			<div class="composer-tabs" role="tablist"><button type="button" id="tab-write" class="composer-tab" role="tab" aria-selected="true" aria-controls="input"></button><button type="button" id="tab-preview" class="composer-tab" role="tab" aria-selected="false" aria-controls="preview"></button></div>
			<div id="preview" class="composer-preview markdown" role="tabpanel" tabindex="0" hidden></div>
			<div class="input-wrap">
				<textarea id="input" rows="1" spellcheck="${spellCheckOn()}" aria-label="${escapeAttribute(vscode.l10n.t("Message to Gemini"))}"></textarea>
				<div class="input-mirror" aria-hidden="true"></div>
				<span id="enhance-float" class="enhance-float" hidden><button type="button" id="revert" class="enhance-chip" hidden><i class="codicon codicon-discard" aria-hidden="true"></i><span></span></button><button type="button" id="enhance" class="enhance-chip"><svg class="enhance-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 3.5C6.88 7 9 9.12 12.5 9.5C9 9.88 6.88 12 6.5 15.5C6.12 12 4 9.88 0.5 9.5C4 9.12 6.12 7 6.5 3.5Z"/><path d="M12.75 0.5C12.92 2.1 13.9 3.08 15.5 3.25C13.9 3.42 12.92 4.4 12.75 6C12.58 4.4 11.6 3.42 10 3.25C11.6 3.08 12.58 2.1 12.75 0.5Z"/></svg><i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i><span></span><span class="enhance-key"></span></button></span>
			</div>
			<div id="enhance-row" class="enhance-row" hidden>
				<span id="enhance-note" class="enhance-note" role="status" hidden></span>
			</div>
			<div class="composer-bar">
				<button type="button" id="plus" class="plus-button" aria-haspopup="menu" aria-expanded="false" aria-controls="plus-menu"><i class="codicon codicon-add" aria-hidden="true"></i></button>
				<span id="mode-chip" class="mode-chip" hidden><button type="button" class="mode-chip-label"><i class="codicon" aria-hidden="true"></i><span></span></button><button type="button" class="mode-chip-reset"><i class="codicon codicon-close" aria-hidden="true"></i></button></span>
				<span class="spacer"></span>
				<button type="button" id="model" class="model-button" hidden><span></span><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button>
				<button type="submit" id="send" class="round-button"><i class="codicon codicon-arrow-up" aria-hidden="true"></i></button>
				<button type="button" id="stop" class="round-button stop" hidden><i class="codicon codicon-debug-stop" aria-hidden="true"></i></button>
			</div>
			<div id="plus-menu" class="plus-menu" hidden></div>
			<div id="model-menu" class="model-menu" hidden></div>
		</form>
		<div class="composer-foot">
			<button type="button" id="branch" class="foot-button branch" hidden><i class="codicon codicon-git-branch" aria-hidden="true"></i><span></span><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button>
			<button type="button" id="review-chip" class="foot-button review-chip" hidden><i class="codicon codicon-comment-discussion" aria-hidden="true"></i><span></span></button>
			<button type="button" id="workspace" class="foot-button workspace" hidden><i class="codicon codicon-folder" aria-hidden="true"></i><span></span><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button>
			<span id="repos" class="foot-repos" hidden></span>
			<button type="button" id="commit" class="foot-button commit" hidden><i class="codicon codicon-git-commit" aria-hidden="true"></i><span></span></button>
			<button type="button" id="commit-more" class="foot-button commit-more" hidden><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button>
			<span id="followed" class="foot-followed" hidden><button type="button" class="foot-button followed-name"><i class="codicon codicon-eye" aria-hidden="true"></i><span></span></button><button type="button" class="followed-close"><i class="codicon codicon-close" aria-hidden="true"></i></button></span>
			<span class="spacer"></span>
			<button type="button" id="usage-ring" class="foot-button usage-ring" aria-expanded="false" aria-controls="usage-popover"><svg class="ring" viewBox="0 0 16 16" aria-hidden="true"><circle class="ring-track" cx="8" cy="8" r="6"/><circle class="ring-fill" cx="8" cy="8" r="6" pathLength="100" stroke-dasharray="0 100" transform="rotate(-90 8 8)"/></svg><span></span></button>
			<div id="branch-menu" class="foot-menu" hidden></div>
			<div id="workspace-menu" class="foot-menu" hidden></div>
			<div id="repos-menu" class="foot-menu" hidden></div>
			<div id="commit-menu" class="foot-menu" hidden></div>
			<div id="commit-box" class="usage-popover commit-box" role="dialog" hidden><label class="usage-heading" for="commit-message"></label><textarea id="commit-message" class="commit-message" rows="4" spellcheck="${spellCheckOn()}"></textarea><p class="usage-note commit-note" role="status"></p><div class="permission-actions"><button type="button" class="secondary commit-cancel"></button><button type="button" class="primary commit-confirm"></button></div></div>
		</div>
	</div>
	<script nonce="${nonce}" type="module" src="${script}" data-highlighter="${highlighter}" data-katex="${katex}" data-katex-style="${katexStyle}" data-fold-work="${foldWorkOn()}" data-emoji-picker="${emojiPicker}" data-figma-design="${figmaDesign}" data-thread-card="${threadCard}" data-project-settings="${projectSettings}" data-side-chat="${sideChat}" data-reactions="${!project && reactionsOn()}" data-research="${!project}" data-strings="${escapeAttribute(JSON.stringify(strings))}"></script>
</body>
</html>`;
}

function reactionStrings(): ReactionStrings {
	return {
		add: vscode.l10n.t("React to this reply"),
		more: vscode.l10n.t("All emoji"),
		quick: [vscode.l10n.t("Go ahead"), vscode.l10n.t("Not what I meant"), vscode.l10n.t("Explain more simply"), vscode.l10n.t("Thanks (no reply)")],
		reacted: vscode.l10n.t("You reacted {0} to Gemini's reply"),
		chip: vscode.l10n.t("Reaction: {0}"),
		agentReacted: vscode.l10n.t("Gemini reacted {0}"),
		queued: vscode.l10n.t("{0} on Gemini's reply"),
		showReply: vscode.l10n.t("Show the reply"),
		picker: vscode.l10n.t("Emoji"),
		search: vscode.l10n.t("Search emoji"),
		recent: vscode.l10n.t("Recent"),
		withMeaning: vscode.l10n.t("With a meaning"),
		readsIt: vscode.l10n.t("Gemini says in one line how it reads this, then acts on it"),
		chipMeaning: vscode.l10n.t("Reaction {0}: {1}"),
		noResults: vscode.l10n.t("No emoji found"),
		groups: [
			vscode.l10n.t("Smileys and emotion"),
			vscode.l10n.t("People and body"),
			vscode.l10n.t("Animals and nature"),
			vscode.l10n.t("Food and drink"),
			vscode.l10n.t("Travel and places"),
			vscode.l10n.t("Activities"),
			vscode.l10n.t("Objects"),
			vscode.l10n.t("Symbols"),
			vscode.l10n.t("Flags"),
		],
	};
}

function researchStrings(): ResearchStrings {
	return {
		title: vscode.l10n.t("Research"),
		readOnly: vscode.l10n.t("Read-only"),
		states: {
			planning: vscode.l10n.t("Splitting the question"),
			reading: vscode.l10n.t("Reading"),
			verifying: vscode.l10n.t("Checking the serious findings"),
			merging: vscode.l10n.t("Writing the report"),
			done: vscode.l10n.t("Done"),
			stopped: vscode.l10n.t("Stopped"),
			failed: vscode.l10n.t("Failed"),
		},
		slice: { queued: vscode.l10n.t("queued"), reading: vscode.l10n.t("reading"), done: vscode.l10n.t("done"), failed: vscode.l10n.t("not finished") },
		reading: vscode.l10n.t("{0} files read"),
		findings: vscode.l10n.t("{0} findings"),
		summary: vscode.l10n.t("{0} parts read, {1} findings"),
		stop: vscode.l10n.t("Stop"),
		sendToAgent: vscode.l10n.t("Send to Agent"),
		copy: vscode.l10n.t("Copy"),
		suggest: vscode.l10n.t("Run as Research: read the code in parallel, read-only"),
		dontSuggest: vscode.l10n.t("Don't suggest Research in this chat"),
	};
}

function sideStrings(): SideStrings {
	return {
		title: vscode.l10n.t("Side question"),
		note: vscode.l10n.t("The agent keeps working"),
		placeholder: vscode.l10n.t("Ask about this chat"),
		ask: vscode.l10n.t("Ask"),
		close: vscode.l10n.t("Close"),
		earlier: vscode.l10n.t("Earlier question (⇧←)"),
		later: vscode.l10n.t("Later question (⇧→)"),
		empty: vscode.l10n.t("Ask about the conversation so far: what the agent changed, why it chose something, what's left. It answers from the chat alone, without stopping the agent or adding to its history."),
		answering: vscode.l10n.t("Answering…"),
		stop: vscode.l10n.t("Stop"),
		sendToAgent: vscode.l10n.t("Send to Agent"),
		sendToAgentTip: vscode.l10n.t("Put the question and this answer in the message box, to edit and send to the agent"),
		fork: vscode.l10n.t("Fork into Agent"),
		forkTip: vscode.l10n.t("Look into it with tools, in a fork of this agent that starts with this question"),
		copy: vscode.l10n.t("Copy"),
		copied: vscode.l10n.t("Copied the answer"),
		hint: vscode.l10n.t("Esc closes · /btw or ⌥⌘; asks from anywhere in the chat"),
	};
}

function forkStrings(): ForkStrings {
	return {
		button: vscode.l10n.t("Fork"),
		buttonTip: vscode.l10n.t("Fork Agent: a new agent that starts from this conversation"),
		fromHere: vscode.l10n.t("Fork from Here: a new agent that starts from the conversation up to this reply"),
		title: vscode.l10n.t("Fork \"{0}\""),
		fromHereNote: vscode.l10n.t("The fork starts from the conversation up to the reply to \"{0}\"."),
		name: vscode.l10n.t("Name"),
		context: vscode.l10n.t("Context"),
		whole: vscode.l10n.t("Whole session"),
		wholeHint: vscode.l10n.t("An exact copy, tool output included."),
		compact: vscode.l10n.t("Compacted"),
		compactHint: vscode.l10n.t("A summary of the older work, plus the latest prompts as they were."),
		conversation: vscode.l10n.t("Conversation only"),
		conversationHint: vscode.l10n.t("Prompts and replies, without tool output."),
		tokens: vscode.l10n.t("~{0} tokens"),
		wholeLarge: vscode.l10n.t("Large: every turn of the fork sends all of it, and it may not fit the model's context."),
		where: vscode.l10n.t("Where it works"),
		ownBranch: vscode.l10n.t("New branch off {0}"),
		ownBranchPlain: vscode.l10n.t("New branch"),
		ownBranchHint: vscode.l10n.t("With the parent's uncommitted changes; the parent's folder is left as it is. Merge Back asks whether to merge into the parent's branch or its base."),
		branch: vscode.l10n.t("Branch"),
		sameFolder: vscode.l10n.t("Same folder"),
		sameFolderHint: vscode.l10n.t("For questions, reviews and plans: both agents change the same files."),
		threadHint: vscode.l10n.t("The fork is a new thread in this project, with a card in the project chat. The coordinator is told about it."),
		noGit: vscode.l10n.t("This folder isn't in a Git repository, so the fork works in the same folder."),
		message: vscode.l10n.t("First message (optional)"),
		messagePlaceholder: vscode.l10n.t("What the fork should do"),
		model: vscode.l10n.t("Model"),
		sameModel: vscode.l10n.t("Same as this agent's"),
		cancel: vscode.l10n.t("Cancel"),
		start: vscode.l10n.t("Fork"),
		close: vscode.l10n.t("Close"),
		card: vscode.l10n.t("Forked \"{0}\""),
		cardBranch: vscode.l10n.t("on {0}"),
		cardShared: vscode.l10n.t("in this folder"),
		cardRemoved: vscode.l10n.t("removed"),
		open: vscode.l10n.t("Open"),
		merge: vscode.workspace.getConfiguration(configSection).get<string>('agents.mergeBack') === 'commit' ? vscode.l10n.t("Merge Back") : vscode.l10n.t("Try in Workspace"),
		from: vscode.l10n.t("Forked from \"{0}\""),
		fromContext: {
			whole: vscode.l10n.t("with the whole session"),
			compact: vscode.l10n.t("with a compacted session"),
			conversation: vscode.l10n.t("with the conversation, without tool output"),
		},
	};
}

