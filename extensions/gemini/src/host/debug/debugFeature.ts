/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Debug mode's feature in dist/debug.js, constructed the first time one of
// its commands runs, or at a start that finds a Debug mode that did not end
// (DEBUG_MODE.md, Records and crash recovery). It registers the real
// commands, holds every agent's Debug mode, the shared bridge, editor and
// endpoint, the Evidence pages and the status bar item, answers the
// `geminicode-debug` server's tools, and puts the phase guard on the
// agents' writes. What it needs of the extension comes through
// `DebugFeatureDeps`, so the chunk keeps no copy of the extension's state.

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { McpTool, McpToolResult } from '../../acp/browserMcp';
import { formatSnapshot, takeSnapshot } from '../../acp/debug/debugBridgeLogic';
import { callDebugTool, debugTools } from '../../acp/debug/debugMcp';
import { deleteDebugRecord, listDebugRecords } from '../../acp/debug/debugRecord';
import { externalDebug } from '../../acp/debug/evidenceFormat';
import { IngestRoutes, type IngestServer, startIngest } from '../../acp/debug/ingest';
import { LineOwnership } from '../../acp/debug/points';
import { appRipgrep } from '../../acp/index/ripgrepPath';
import { redact } from '../../acp/redact';
import { DebugBridge } from './debugBridge';
import { DebugEditor } from './debugEditor';
import type { DebugEntry, DebugFeatureApi } from './debugEntry';
import type { AgentsView } from '../agentsView';
import type { FolderTrust } from '../folderTrust';
import type { WriteGuard } from '../../acp/fileAccess';
import { agentColumn } from '../editorPlacement';
import { type DebugChat, type DebugMode, type DebugModeHost, DebugModes } from './debugMode';
import type { DebugAction } from './debugProtocol';
import { hitsLabel } from './debugStrings';
import { EvidencePage } from './evidencePage';

export interface DebugFeatureDeps {
	readonly context: Pick<vscode.ExtensionContext, 'extensionUri' | 'globalStorageUri'>;
	readonly log: vscode.LogOutputChannel;
	readonly agents: Pick<AgentsView, 'controllerOf' | 'agentPlace' | 'summaries' | 'activeAgentId' | 'agentLastInFront' | 'open' | 'onDidChangeAgents'>;
	/** Tells an agent's sessions their debug tools changed (tools/list_changed). */
	readonly entry: Pick<DebugEntry, 'server'>;
	/** Folder trust, and where the phase guard goes on the agents' writes. */
	readonly service: { readonly trust: Pick<FolderTrust, 'isTrusted'>; writeGuard: WriteGuard | undefined };
	/** Why the agent's file policy refuses `file` (secret, git-ignored, outside its folder), or undefined. */
	fileAccess(folder: string, file: string): Promise<string | undefined>;
}

const enabled = () => vscode.workspace.getConfiguration('gemini').get<boolean>('debugMode.enabled') === true;
const maxModes = 2;

function agentOf(arg: unknown): string | undefined {
	if (typeof arg === 'string') {
		return arg;
	}
	const node = arg as { readonly kind?: unknown; readonly record?: { readonly id?: unknown } } | undefined;
	return node?.kind === 'agent' && typeof node.record?.id === 'string' ? node.record.id : undefined;
}

export class DebugFeature implements DebugFeatureApi {

	private readonly bridge = new DebugBridge();
	private readonly editor: DebugEditor;
	private readonly modes: DebugModes;
	private readonly lines = new LineOwnership();
	private readonly pages = new Map<string, EvidencePage>();
	private readonly routes = new IngestRoutes();
	private readonly routeTokens = new Map<string, string>();
	private ingest: Promise<IngestServer> | undefined;
	private readonly status = vscode.window.createStatusBarItem('gemini.debugMode', vscode.StatusBarAlignment.Left, 50);
	private readonly disposables: vscode.Disposable[] = [];

	private readonly storage: string;

	constructor(private readonly deps: DebugFeatureDeps) {
		this.storage = deps.context.globalStorageUri.fsPath;
		this.editor = new DebugEditor(() => this.modes.all, {
			lens: (point, hypothesis, hits) => vscode.l10n.t("Gemini debug code ({0}, {1}) - {2}", point, hypothesis, hitsLabel(hits)),
			remove: vscode.l10n.t("Remove"),
			note: (point, hypothesis, hits) => vscode.l10n.t("Gemini {0} ({1}) - {2}", point, hypothesis, hitsLabel(hits)),
		});
		const host: DebugModeHost = {
			bridge: this.bridge,
			editor: this.editor,
			lines: this.lines,
			globalStorage: this.storage,
			log: deps.log,
			chat: agent => this.chat(agent),
			toolsChanged: agent => void deps.entry.server.notifyToolsChanged(agent),
			fileAccess: (folder, file) => deps.fileAccess(folder, file),
			endpoint: (agent, nonce) => this.endpoint(agent, nonce),
			closeEndpoint: agent => this.closeEndpoint(agent),
			openEvidence: (agent, focus) => void this.showEvidence(agent, focus),
			viewChanged: agent => {
				this.pages.get(agent)?.update();
				this.updateStatus();
			},
			ended: agent => {
				this.modes.forget(agent);
				this.updateStatus();
			},
			isTrusted: folder => deps.service.trust.isTrusted(folder),
			ripgrep: () => appRipgrep(vscode.env.appRoot),
		};
		this.modes = new DebugModes(host);
		this.status.name = vscode.l10n.t("Gemini Debug mode");
		deps.service.writeGuard = (sessionId, file, content) => this.modes.guardWrite(sessionId, file, content);
		this.disposables.push(
			this.status,
			this.bridge,
			this.editor,
			vscode.commands.registerCommand('gemini.debug.start', (arg?: unknown, report?: unknown) => this.start(agentOf(arg), typeof report === 'string' ? report : undefined)),
			vscode.commands.registerCommand('gemini.debug.askWhy', (arg?: unknown) => this.askWhy(arg)),
			vscode.commands.registerCommand('gemini.debug.stop', (arg?: unknown) => this.stop(agentOf(arg) ?? this.activeAgent())),
			vscode.commands.registerCommand('gemini.debug.showEvidence', (arg?: unknown, focus?: unknown) => this.showEvidence(agentOf(arg) ?? this.activeAgent(), typeof focus === 'string' ? focus : undefined)),
			vscode.commands.registerCommand('gemini.debug.action', (agent?: unknown, action?: unknown, arg?: unknown) => this.action(agentOf(agent), action as DebugAction, typeof arg === 'string' ? arg : undefined)),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('gemini.debugMode.enabled') && !enabled()) {
					// Turned off while a chat uses it: Clean up runs, and the chat says why.
					for (const mode of this.modes.running) {
						void mode.cleanup('off');
					}
				}
			}),
			deps.agents.onDidChangeAgents(() => {
				// A closed chat or a removed agent: Clean up runs before it goes.
				for (const mode of this.modes.running) {
					if (!this.place(mode.agent) || !this.chat(mode.agent)) {
						void mode.cleanup('closed');
					}
				}
			}),
		);
	}

	private chat(agent: string): DebugChat | undefined {
		return this.deps.agents.controllerOf(agent);
	}

	/** Where an agent works, its name, and whether it is a project's coordinator, which has no code. */
	private place(agent: string): { readonly cwd: string; readonly title: string; readonly coordinator: boolean } | undefined {
		const place = this.deps.agents.agentPlace(agent);
		return place && { cwd: place.cwd, title: place.title, coordinator: this.deps.agents.summaries().find(a => a.id === agent)?.project?.role === 'coordinator' };
	}

	/** The agent whose tab is in front, else the one used last. */
	private activeAgent(): string | undefined {
		return this.deps.agents.activeAgentId() ?? this.deps.agents.agentLastInFront();
	}

	// --- The server ---

	tools(agent: string): readonly McpTool[] {
		return this.modes.session(agent) ? debugTools : [];
	}

	async call(agent: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
		const mode = this.modes.session(agent) as DebugMode | undefined;
		const blocked = mode?.blockedByMode();
		if (blocked) {
			return { content: [{ type: 'text', text: blocked }], isError: true };
		}
		let result: McpToolResult;
		try {
			result = await callDebugTool(this.modes, agent, name, args);
		} catch (err) {
			return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
		}
		if (name === 'debug_evidence' && !result.isError && mode) {
			mode.evidenceRead();
			const note = mode.contextNote();
			if (note) {
				result = { ...result, content: [...result.content, { type: 'text', text: note }] };
			}
		}
		return result;
	}

	turnNote(agent: string): string | undefined {
		return (this.modes.session(agent) as DebugMode | undefined)?.turnNote();
	}

	// --- The commands ---

	private async start(agent: string | undefined, report?: string): Promise<void> {
		if (!enabled()) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Debug mode is off. Turn on Gemini: Debug Mode in settings to use it."));
			return;
		}
		agent ??= this.activeAgent();
		const place = agent ? this.place(agent) : undefined;
		if (!agent || !place) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Open an agent first."));
			return;
		}
		if (place.coordinator) {
			void vscode.window.showInformationMessage(vscode.l10n.t("A project's coordinator has no code to debug: start Debug mode in one of its threads."));
			return;
		}
		const current = this.modes.session(agent);
		if (current) {
			await this.deps.agents.open(agent);
			return;
		}
		if (this.modes.running.length >= maxModes) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Two agents are in Debug mode already, the most at once. Stop one first."));
			return;
		}
		await this.deps.agents.open(agent);
		const chat = this.chat(agent);
		if (!chat) {
			void vscode.window.showInformationMessage(vscode.l10n.t("Open an agent first."));
			return;
		}
		if (chat.mode === 'yolo' || chat.mode === 'plan') {
			// GeminiCode never changes the mode on the user's behalf.
			void vscode.window.showWarningMessage(chat.mode === 'yolo'
				? vscode.l10n.t("Debug mode doesn't run in YOLO mode: a debug session starts your program, and YOLO runs commands without asking. Switch this chat to Default or Auto Edit in its mode menu, then start Debug mode again.")
				: vscode.l10n.t("Debug mode runs in Default or Auto Edit. Switch this chat out of Plan mode in its mode menu, then start Debug mode again."), { modal: true });
			return;
		}
		const text = report ?? await vscode.window.showInputBox({
			title: vscode.l10n.t("Debug with Gemini"),
			prompt: vscode.l10n.t("Describe the bug: what you did, what you expected, what happened."),
			ignoreFocusOut: true,
		});
		if (!text?.trim()) {
			return;
		}
		this.modes.forget(agent);
		this.modes.enter({ agent, cwd: place.cwd, title: place.title, report: text.trim() });
		this.updateStatus();
		await chat.send(text.trim(), [], undefined, 'queue');
	}

	/** Ask Gemini why: a failed test in the Testing view, or the stopped thread of the user's own debug session, read once and kept nowhere. */
	private async askWhy(arg: unknown): Promise<void> {
		const test = arg as { readonly label?: unknown; readonly uri?: vscode.Uri; readonly range?: vscode.Range } | undefined;
		if (test && typeof test.label === 'string') {
			const where = test.uri ? `${vscode.workspace.asRelativePath(test.uri)}${test.range ? `:${test.range.start.line + 1}` : ''}` : '';
			const report = where
				? vscode.l10n.t("The test \"{0}\" in {1} fails. Find out why from evidence, and use the test as the reproduction.", test.label, where)
				: vscode.l10n.t("The test \"{0}\" fails. Find out why from evidence, and use the test as the reproduction.", test.label);
			return this.start(this.activeAgent(), report);
		}
		const session = vscode.debug.activeDebugSession;
		const item = vscode.debug.activeStackItem;
		if (session && item && item.session === session) {
			const snapshot = await takeSnapshot((command, args) => session.customRequest(command, args), item.threadId);
			const report = vscode.l10n.t("My program stopped in the debugger and I don't know why. Find out from evidence.\n\n{0}", externalDebug('stopped thread', redact(formatSnapshot(snapshot))));
			return this.start(this.activeAgent(), report);
		}
		void vscode.window.showInformationMessage(vscode.l10n.t("Pick a failed test, or stop your program in the debugger, then ask again."));
	}

	private async stop(agent: string | undefined): Promise<void> {
		const mode = agent ? this.modes.session(agent) as DebugMode | undefined : this.modes.running[0];
		await mode?.cleanup('stop');
		this.updateStatus();
	}

	private async showEvidence(agent: string | undefined, focus?: string): Promise<void> {
		const mode = agent ? this.modes.get(agent) : this.modes.running[0];
		if (!mode) {
			void vscode.window.showInformationMessage(vscode.l10n.t("No agent is in Debug mode."));
			return;
		}
		const open = this.pages.get(mode.agent);
		if (open) {
			open.follow(mode, focus);
			return;
		}
		const page = new EvidencePage(this.deps.context.extensionUri, mode, await agentColumn(mode.agent, undefined), focus);
		this.pages.set(mode.agent, page);
		page.onDidDispose(() => {
			if (this.pages.get(mode.agent) === page) {
				this.pages.delete(mode.agent);
			}
		});
	}

	private async action(agent: string | undefined, action: DebugAction, arg: string | undefined): Promise<void> {
		if (!agent) {
			return;
		}
		if (action === 'start') {
			return this.start(agent);
		}
		await this.modes.get(agent)?.action(action, arg);
		this.updateStatus();
	}

	// --- The endpoint, for HTTP markers only ---

	private async endpoint(agent: string, nonce: string): Promise<{ readonly host: string; readonly port: number; readonly token: string }> {
		this.ingest ??= startIngest({
			routes: this.routes,
			onAnswer: answer => {
				const mode = answer.agent ? this.modes.get(answer.agent) : undefined;
				for (const event of answer.events) {
					mode?.ingested(event.point, event.payload);
				}
			},
		});
		const server = await this.ingest;
		let token = this.routeTokens.get(agent);
		if (!token) {
			token = this.routes.open(agent, nonce).token;
			this.routeTokens.set(agent, token);
		}
		return { host: '127.0.0.1', port: server.port, token };
	}

	private closeEndpoint(agent: string): void {
		this.routes.close(agent);
		this.routeTokens.delete(agent);
		if (!this.routes.size && this.ingest) {
			const closing = this.ingest;
			this.ingest = undefined;
			void closing.then(server => server.close(), () => undefined);
		}
	}

	// --- The status bar ---

	private updateStatus(): void {
		const running = this.modes.running;
		if (!running.length) {
			this.status.hide();
			return;
		}
		const points = running.reduce((n, mode) => n + mode.counts.points, 0);
		const events = running.reduce((n, mode) => n + mode.counts.events, 0);
		this.status.text = `$(bug) ${vscode.l10n.t("Debugging: {0} points, {1} events", points, events)}`;
		this.status.tooltip = vscode.l10n.t("Open the Evidence page");
		this.status.command = { title: vscode.l10n.t("Evidence"), command: 'gemini.debug.showEvidence', arguments: [running[0].agent] };
		this.status.show();
	}

	// --- Crash recovery ---

	/** A Debug mode that did not end: its breakpoints go now; its marked lines wait for the user's Clean up. */
	async recover(): Promise<void> {
		for (const { file, record } of await listDebugRecords(this.storage)) {
			if (this.modes.session(record.agent)) {
				continue;
			}
			const removed = this.bridge.removeMatching(record.points);
			if (removed) {
				this.deps.log.info(`Debug mode: removed ${removed} breakpoints left by agent ${record.agent}'s Debug mode`);
			}
			if (!record.regions.length) {
				await deleteDebugRecord(file);
				continue;
			}
			const files = [...new Set(record.regions.map(region => region.file))];
			const clean = vscode.l10n.t("Clean up");
			const open = vscode.l10n.t("Open");
			void vscode.window.showWarningMessage(vscode.l10n.t("Debug code was left in {0} files by a Debug mode that ended with the window ({1}).", files.length, record.title || path.basename(record.folder)), clean, open).then(async picked => {
				if (picked === open) {
					await this.editor.reveal(record.regions[0].file, record.regions[0].line);
					return;
				}
				if (picked !== clean) {
					return;
				}
				const anyway = vscode.l10n.t("Remove anyway");
				for (const region of record.regions) {
					const outcome = await this.editor.remove(region);
					if (outcome.state === 'changed' && await vscode.window.showWarningMessage(vscode.l10n.t("{0} was edited after Debug mode added it. Remove it anyway?", `${path.basename(region.file)}:${region.line}`), { modal: true, detail: outcome.diff }, anyway) === anyway) {
						await this.editor.remove(region, true);
					}
				}
				await deleteDebugRecord(file);
			});
		}
	}

	dispose(): void {
		this.deps.service.writeGuard = undefined;
		// The window is closing: the quick steps of Clean up run; marked lines wait for the next start.
		this.modes.dispose();
		for (const page of this.pages.values()) {
			page.dispose();
		}
		this.pages.clear();
		void this.ingest?.then(server => server.close(), () => undefined);
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
