/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// One agent's Debug mode (DEBUG_MODE.md): GeminiCode's state of the debug
// session (the phase, the hypotheses, the points, the evidence), the record
// on disk for crash recovery, the debugger points through the bridge and the
// marked lines through the editor, the endpoint's route and the picked log
// file when used, the phase guard on the agent's writes, and the bar and
// cards in its chat. `DebugModes` holds every agent's and answers the
// `geminicode-debug` server's tools for them (`DebugBackend`). Clean up is
// plain code, in the design's order, safe to run twice.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Attachment } from '../../acp/attachments';
import { attachConfig, breakpointSpec, parseJsonc, describeConfigs, describeLaunch, evaluateAt, handleStop, Holds, isLoopback, OutputTail, reloadsItself, resolveLaunchConfig, smallConfig, type StoppedEvent, type ConfigEntry, type LaunchCard } from '../../acp/debug/debugBridgeLogic';
import type { AttachArgs, DebugBackend, DebugSessionView, ExpressionAsk, InspectArgs, LaunchArgs, LaunchKind } from '../../acp/debug/debugMcp';
import { debugModeInstructions, phasePrompt } from '../../acp/debug/debugPrompts';
import { DebugRecordWriter, type DebugRecord, recordPath } from '../../acp/debug/debugRecord';
import { type DebugPhase, debugPhases, type DebugState, editRefusal, editsAllowed, initialDebugState, keepGoing, markedRegionRefusal, move, roundsExhausted } from '../../acp/debug/debugState';
import { clipValue, compareRuns, externalDebug } from '../../acp/debug/evidenceFormat';
import { EvidenceStore } from '../../acp/debug/evidenceStore';
import type { Hypothesis } from '../../acp/debug/hypotheses';
import { LogTail } from '../../acp/debug/logTail';
import { type Channel, LineOwnership, type Point, type PointInput, PointSet } from '../../acp/debug/points';
import { changesRegion, type RegionRecord } from '../../acp/debug/regions';
import { type Endpoint, markedRegion, templateLanguageOf } from '../../acp/debug/templates';
import { isInside } from '../../acp/fileAccess';
import { redact } from '../../acp/redact';
import type { DebugBridge, BridgeClient } from './debugBridge';
import type { DebugEditor, EditorSource } from './debugEditor';
import type { DebugAction, DebugBarView, DebugCardView, EvidenceFilter, EvidenceView } from './debugProtocol';
import { barStrings, hitsLabel, kindLabel, phaseLabel } from './debugStrings';

/** The chat of the agent in Debug mode, as Debug mode uses it (ChatController). */
export interface DebugChat {
	send(text: string, attachments?: readonly Attachment[], from?: 'coordinator', when?: 'now' | 'queue'): Promise<void>;
	postDebug(view: DebugBarView | undefined): void;
	/** The session's approval mode. */
	readonly mode: string | undefined;
	/** The ACP session the agent writes through, for the phase guard. */
	readonly sessionId: string | undefined;
	readonly onDidChangeActivity: vscode.Event<{ readonly busy: boolean }>;
	addNotice(text: string): void;
	focusComposer(): void;
}

export interface DebugModeHost {
	readonly bridge: DebugBridge;
	readonly editor: DebugEditor;
	readonly lines: LineOwnership;
	readonly globalStorage: string;
	readonly log: vscode.LogOutputChannel;
	chat(agent: string): DebugChat | undefined;
	/** The agent's sessions should list its debug tools, or stop listing them. */
	toolsChanged(agent: string): void;
	/** Why the agent's file policy refuses `file` (secret, git-ignored, outside), or undefined. */
	fileAccess(folder: string, file: string): Promise<string | undefined>;
	/** The endpoint's route for the agent's HTTP markers, opening the endpoint if it is closed. */
	endpoint(agent: string, nonce: string): Promise<Endpoint>;
	closeEndpoint(agent: string): void;
	openEvidence(agent: string, focus?: string): void;
	/** The Evidence page and the status bar should redraw. */
	viewChanged(agent: string): void;
	/** Debug mode ended and its card was dismissed. */
	ended(agent: string): void;
	isTrusted(folder: string): Promise<boolean>;
	ripgrep(): Promise<string | undefined>;
}

export interface DebugStart {
	readonly agent: string;
	/** The agent's working folder: its worktree, or the workspace folder. */
	readonly cwd: string;
	readonly title: string;
	readonly report: string;
}

/** The folder's lines as the shared ownership keys them: by absolute path, so agents in two worktrees of one repository never collide. */
class FolderLines extends LineOwnership {
	constructor(private readonly shared: LineOwnership, private readonly root: string) {
		super();
	}
	override owner(file: string, line: number): string | undefined {
		return this.shared.owner(path.join(this.root, file), line);
	}
	override claim(file: string, line: number, agent: string): boolean {
		return this.shared.claim(path.join(this.root, file), line, agent);
	}
	override release(file: string, line: number, agent: string): void {
		this.shared.release(path.join(this.root, file), line, agent);
	}
	override releaseAll(agent: string): void {
		this.shared.releaseAll(agent);
	}
}

const viewDelayMs = 1000;
const noEvidenceHintMs = 20_000;

function toPosix(file: string): string {
	return file.split(path.sep).join('/');
}

export class DebugMode implements DebugSessionView, BridgeClient, EditorSource, vscode.Disposable {

	readonly nonce = `gc${randomBytes(4).toString('hex')}`;
	state: DebugState = initialDebugState;
	hypotheses: readonly Hypothesis[] = [];
	readonly points: PointSet;
	readonly evidence = new EvidenceStore();
	regions: RegionRecord[] = [];
	private readonly breakpoints = new Map<string, vscode.SourceBreakpoint>();
	private readonly specs = new Map<string, { readonly condition?: string; readonly hitCondition?: string; readonly logMessage?: string }>();
	/** Sessions Debug mode started or attached, by kind. */
	private readonly started = new Map<vscode.DebugSession, { readonly attached: boolean; readonly config: vscode.DebugConfiguration; readonly kind: LaunchKind; readonly card?: LaunchCard }>();
	private lastLaunch: { readonly config: vscode.DebugConfiguration; readonly kind: LaunchKind; readonly folder: vscode.WorkspaceFolder | undefined } | undefined;
	private attached = false;
	private readonly holds = new Holds();
	private readonly heldStops = new Map<string, { readonly session: vscode.DebugSession; readonly threadId: number }>();
	private stopSeq = 0;
	private readonly snapshotsThisRun = new Map<string, number>();
	private readonly dapIds = new Map<string, Map<number, string>>();
	private readonly allowedConfigs = new Set<string>();
	private readonly allowedPrograms = new Set<string>();
	private readonly writer: DebugRecordWriter;
	private readonly startedAt = Date.now();
	private logTail: LogTail | undefined;
	private readonly logContext = new OutputTail(64 * 1024);
	private logSince: string | undefined;
	private usedHttp = false;
	private routePort: number | undefined;
	private card: DebugCardView | undefined;
	private folded = true;
	/** The bug report, carried by the first turn's note only. */
	private report: string | undefined;
	private instructed = false;
	private userSaid: string | undefined;
	private noEvidence = false;
	/** The last run before Verify, for the comparison. */
	private beforeRun: number | undefined;
	/** The user's steps from the last reproduce card, shown again at Verify. */
	private lastSteps: readonly string[] | undefined;
	private userPaused = false;
	private hintTimer: ReturnType<typeof setTimeout> | undefined;
	private viewTimer: ReturnType<typeof setTimeout> | undefined;
	private viewDirty = false;
	private ended = false;
	/** Marked lines Clean up left because they changed, with their diffs. */
	private left: { readonly record: RegionRecord; readonly diff: string; open: boolean }[] = [];
	private summary: string[] = [];
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly host: DebugModeHost, readonly start: DebugStart) {
		this.points = new PointSet(start.agent, this.nonce, new FolderLines(host.lines, start.cwd));
		this.report = start.report;
		this.writer = new DebugRecordWriter(recordPath(host.globalStorage, start.agent));
		this.disposables.push(host.bridge.register(this));
		const chat = host.chat(start.agent);
		if (chat) {
			let busy = false;
			this.disposables.push(chat.onDidChangeActivity(activity => {
				if (busy && !activity.busy) {
					this.turnEnded();
				}
				busy = activity.busy;
			}));
		}
		this.saveRecord();
		this.post();
	}

	get agent(): string {
		return this.start.agent;
	}

	get cwd(): string {
		return this.start.cwd;
	}

	get isEnded(): boolean {
		return this.ended;
	}

	private chat(): DebugChat | undefined {
		return this.host.chat(this.agent);
	}

	// --- What the editor shows ---

	describe(point: string): { readonly hypothesis: string; readonly hits: number } | undefined {
		const found = this.points.get(point);
		return found && { hypothesis: found.hypothesis, hits: this.evidence.pointStats(point)?.hits ?? 0 };
	}

	get debuggerPoints(): readonly { readonly id: string; readonly file: string; readonly line: number }[] {
		return this.points.active.filter(p => p.kind !== 'marked').map(p => ({ id: p.id, file: this.absolute(p.file), line: p.line }));
	}

	private absolute(file: string): string {
		return path.resolve(this.cwd, file);
	}

	// --- The model's turn ---

	/** The note each prompt carries while Debug mode is on: the phase, the hypotheses, the points; the mode's instructions and the bug report on the first. */
	turnNote(): string | undefined {
		if (this.ended) {
			return undefined;
		}
		const hits = this.evidence.counts();
		const text = phasePrompt({ state: this.state, hypotheses: this.hypotheses, points: this.points.all, hits, report: this.report, noEvidence: this.noEvidence, userSaid: this.userSaid, logFile: this.logTail?.file });
		const first = !this.instructed;
		this.instructed = true;
		this.report = undefined;
		this.userSaid = undefined;
		return first ? `${debugModeInstructions}\n\n${text}` : text;
	}

	/** What the YOLO rule says, when the chat is in YOLO; Debug mode never changes the mode itself. */
	blockedByMode(): string | undefined {
		return this.chat()?.mode === 'yolo' ? 'Debug mode is paused: the chat is in YOLO mode, which runs commands without asking, and a debug session runs the program. Ask the user to switch the chat to Default or Auto Edit; never switch it yourself.' : undefined;
	}

	private turnEnded(): void {
		// A program never stays paused because a turn ended.
		this.holds.releaseAll();
		if (this.ended) {
			return;
		}
		if (this.state.phase === 'verify' && this.beforeRun !== undefined && (this.evidence.currentRun?.id ?? 0) > this.beforeRun && this.card?.kind !== 'reproduce') {
			this.card = this.verifyCard();
		} else if (roundsExhausted(this.state)) {
			this.card = { kind: 'rounds', title: vscode.l10n.t("Nothing confirmed yet"), text: vscode.l10n.t("Several rounds of points and reproductions have confirmed no hypothesis. Keep going, give Gemini a hint, or stop and clean up.") };
		}
		this.post();
	}

	// --- The tools ---

	async setHypotheses(list: readonly Hypothesis[]): Promise<string> {
		this.hypotheses = list;
		if (this.state.phase === 'investigate') {
			this.moveTo('instrument');
		}
		this.post();
		const confirmed = list.filter(h => h.status === 'confirmed').map(h => h.id);
		return `Kept ${list.length} hypothes${list.length === 1 ? 'is' : 'es'}. Phase: ${phaseLabel(this.state.phase)}.${confirmed.length ? ` Confirmed: ${confirmed.join(', ')}; call debug_fix with the one to fix.` : ' Next: place points for them (debug_logpoint first), then reproduce.'}`;
	}

	async configs(): Promise<string> {
		const { entries, compounds } = await this.readLaunchJson();
		return describeConfigs(entries, compounds, this.host.bridge.otherSessions(), await this.host.bridge.listeningPorts());
	}

	private async readLaunchJson(): Promise<{ readonly entries: ConfigEntry[]; readonly compounds: { readonly name: string; readonly parts: readonly string[] }[] }> {
		const file = path.join(this.cwd, '.vscode', 'launch.json');
		const label = path.basename(this.cwd);
		let parsed = parseJsonc(await fs.readFile(file, 'utf8').catch(() => ''));
		if (!parsed) {
			const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.cwd));
			const launch = folder ? vscode.workspace.getConfiguration('launch', folder.uri) : undefined;
			parsed = launch ? { configurations: launch.get('configurations'), compounds: launch.get('compounds') } : undefined;
		}
		const record = parsed && typeof parsed === 'object' ? parsed as { configurations?: unknown; compounds?: unknown } : {};
		const entries = Array.isArray(record.configurations) ? record.configurations.map(config => ({ folder: label, config })) : [];
		const compounds = Array.isArray(record.compounds) ? record.compounds.flatMap(c => c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string'
			? [{ name: (c as { name: string }).name, parts: Array.isArray((c as { configurations?: unknown }).configurations) ? ((c as { configurations: unknown[] }).configurations).map(String) : [] }] : []) : [];
		return { entries, compounds };
	}

	async launch(args: LaunchArgs): Promise<string> {
		if (!vscode.workspace.isTrusted || !await this.host.isTrusted(this.cwd)) {
			return 'Launching is refused in a folder that is not trusted: it would run the repository\'s code. Ask the user to start the program, then use debug_attach.';
		}
		let config: unknown;
		if (args.config) {
			const { entries, compounds } = await this.readLaunchJson();
			if (compounds.some(c => c.name === args.config)) {
				return `${args.config} is a compound configuration, not supported yet: launch its parts one at a time.`;
			}
			config = entries.map(e => e.config).find(c => c && typeof c === 'object' && (c as { name?: unknown }).name === args.config);
			if (!config) {
				return `No launch configuration named ${args.config}; debug_configs lists them.`;
			}
		} else {
			const small = smallConfig(args, this.cwd, path.join);
			if (!small.ok) {
				return small.error;
			}
			config = small.config;
		}
		const resolved = resolveLaunchConfig(config, this.cwd, this.nonce);
		if (!resolved.ok) {
			return resolved.error;
		}
		const key = JSON.stringify(resolved.config);
		if (!this.allowedConfigs.has(key)) {
			const choice = await this.launchCard(resolved.card);
			if (choice === 'reject') {
				return 'The user rejected the launch.';
			}
			if (choice === 'session') {
				this.allowedConfigs.add(key);
			}
		}
		const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === this.cwd);
		return this.startSession(folder, resolved.config as vscode.DebugConfiguration, args.kind, false, resolved.card);
	}

	private async launchCard(card: LaunchCard): Promise<'once' | 'session' | 'reject'> {
		const once = vscode.l10n.t("Allow once");
		const session = vscode.l10n.t("Allow this configuration for the session");
		const detail = [
			vscode.l10n.t("Configuration: {0}", `${card.name} (${card.type})`),
			card.program ? vscode.l10n.t("Program: {0}", [card.program, ...card.args].join(' ')) : '',
			card.cwd ? vscode.l10n.t("Folder: {0}", card.cwd) : '',
			card.preLaunchTask ? vscode.l10n.t("Before start: {0}", card.preLaunchTask) : '',
			card.envNames.length ? vscode.l10n.t("Environment: {0} (values not shown)", card.envNames.join(', ')) : '',
		].filter(Boolean).join('\n');
		const picked = await vscode.window.showWarningMessage(vscode.l10n.t("Start the program under the debugger?"), { modal: true, detail }, once, session);
		return picked === once ? 'once' : picked === session ? 'session' : 'reject';
	}

	private async startSession(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, kind: LaunchKind, attached: boolean, card?: LaunchCard): Promise<string> {
		if (attached && !this.attached) {
			// The attached program was not started with the guard: the points apply unguarded from now on.
			this.attached = true;
			this.replacePoints();
		}
		if (kind !== 'server') {
			this.newRun(card?.name ?? config.name);
		}
		const session = await this.host.bridge.start(folder, config).then(s => s, err => {
			this.host.log.warn(`Debug mode: ${config.name} did not start: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		});
		if (!session) {
			return `${config.name} did not start under the debugger. ${this.host.bridge.otherSessions().length ? '' : 'Check that its debug adapter is installed (js-debug is built in; Python needs the debugpy extension).'}`.trim();
		}
		this.started.set(session, { attached, config, kind, card });
		if (!attached) {
			this.lastLaunch = { config, kind, folder };
		}
		this.host.log.info(`Debug mode: ${attached ? 'attached to' : 'launched'} ${config.name} for agent ${this.agent}`);
		this.saveRecord();
		this.checkBound();
		this.post();
		const what = card ? describeLaunch(card) : String(config.name);
		return attached
			? `Attached to ${what}. Note: the agent's points also apply to the user's own debug sessions of these files while they exist.`
			: `Started ${what} under the debugger. Its output, stops and exit are evidence${kind === 'server' ? '; reproduce with debug_reproduce when the points are in place' : ''}.`;
	}

	async attach(args: AttachArgs): Promise<string> {
		const key = args.port !== undefined ? `port ${args.port}` : `process ${args.processId}`;
		if (!this.allowedPrograms.has(key)) {
			const allow = vscode.l10n.t("Allow");
			const picked = await vscode.window.showWarningMessage(vscode.l10n.t("Attach the debugger to {0}?", args.port !== undefined ? vscode.l10n.t("the program on 127.0.0.1:{0}", args.port) : vscode.l10n.t("process {0}", String(args.processId))), { modal: true, detail: vscode.l10n.t("Gemini's points will also apply to your own debug sessions of the same files while they exist. Detaching at the end never stops the program.") }, allow);
			if (picked !== allow) {
				return 'The user declined the attach.';
			}
			this.allowedPrograms.add(key);
		}
		const config = attachConfig(args, this.nonce) as vscode.DebugConfiguration;
		if (typeof config.address === 'string' && !isLoopback(config.address)) {
			return 'Only a program on this machine (127.0.0.1) can be attached.';
		}
		const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === this.cwd);
		return this.startSession(folder, config, 'server', true);
	}

	async addPoint(input: PointInput, asks: readonly ExpressionAsk[]): Promise<string> {
		const absolute = this.absolute(input.file);
		if (!isInside(this.cwd, absolute)) {
			return `${input.file} is outside the agent's folder.`;
		}
		const denied = await this.host.fileAccess(this.cwd, absolute);
		if (denied) {
			return `No point in ${input.file}: ${denied}.`;
		}
		const relative = toPosix(path.relative(this.cwd, absolute));
		if (input.kind !== 'marked' && this.host.bridge.userBreakpointAt(absolute, input.line, new Set(this.breakpoints.values()))) {
			return `The user has a breakpoint of their own on ${relative}:${input.line}: it is left alone, and its hits are the user's. Choose another line.`;
		}
		if (asks.length && !await this.askExpressions(input, relative, asks)) {
			return 'The user rejected the expression.';
		}
		const hadEvidence = (this.evidence.currentRun ? this.evidence.countsInRun(this.evidence.currentRun.id).size : 0) > 0;
		const added = this.points.add({ ...input, file: relative });
		if (!added.ok) {
			return added.error;
		}
		const point = added.point;
		if (this.state.phase === 'analyse') {
			this.moveTo('instrument', hadEvidence);
		}
		let note = '';
		if (point.kind === 'marked') {
			const result = await this.insertMarked(point, absolute);
			if (!result.ok) {
				this.points.remove(point.id);
				return result.error;
			}
			note = result.note;
		} else {
			this.placeBreakpoint(point);
			note = this.attached ? ' The program was attached, so the point also applies to the user\'s own debug sessions of this file.' : '';
			this.checkBound();
		}
		this.saveRecord();
		this.post();
		return `Placed ${point.id} (${kindLabel(point.kind)}) at ${relative}:${point.line} for ${point.hypothesis}.${note}`;
	}

	private async askExpressions(input: PointInput, where: string, asks: readonly ExpressionAsk[]): Promise<boolean> {
		const allow = vscode.l10n.t("Allow once");
		const title = input.kind === 'breakpoint' ? vscode.l10n.t("Add a breakpoint whose condition runs code in your program?") : input.kind === 'marked' ? vscode.l10n.t("Add a marked line that runs code in your program?") : vscode.l10n.t("Add a logpoint that runs code in your program?");
		const detail = [`${where}:${input.line}  ${input.hypothesis}`, ...asks.map(ask => `${ask.expression}  (${ask.why})`), vscode.l10n.t("An expression runs in your program each time the line runs. A property can run code too, through a getter.")].join('\n');
		return await vscode.window.showWarningMessage(title, { modal: true, detail }, allow) === allow;
	}

	private placeBreakpoint(point: Point): void {
		const spec = breakpointSpec(point, this.nonce, !this.attached);
		this.specs.set(point.id, spec);
		this.breakpoints.set(point.id, this.host.bridge.addPoint(this.absolute(point.file), point.line, spec));
		this.dapIds.clear();
	}

	/** The points again without the guard, once a program the user started is attached. */
	private replacePoints(): void {
		const active = this.points.active.filter(p => p.kind !== 'marked' && this.breakpoints.has(p.id));
		this.host.bridge.removePoints(active.map(p => this.breakpoints.get(p.id)!));
		active.forEach(p => this.placeBreakpoint(p));
	}

	private checkBound(): void {
		setTimeout(() => {
			void (async () => {
				for (const [id, breakpoint] of this.breakpoints) {
					const bound = await this.host.bridge.bound(this.nonce, breakpoint);
					if (bound !== undefined) {
						this.points.setBound(id, bound);
					}
				}
				this.post();
			})();
		}, 1000);
	}

	private async insertMarked(point: Point, absolute: string): Promise<{ readonly ok: true; readonly note: string } | { readonly ok: false; readonly error: string }> {
		const language = templateLanguageOf(absolute);
		if (!language) {
			return { ok: false, error: 'Marked lines have templates for JavaScript, TypeScript and Python only; use a debugger point here.' };
		}
		const tracked = this.host.bridge.sessionsOf(this.nonce).length > 0;
		const channel: Channel = point.channel ?? (tracked ? 'console' : 'http');
		const why = point.channel ? 'as asked' : tracked ? 'the program runs under a tracked debug session' : 'no tracked debug session reaches its console';
		let endpoint: Endpoint | undefined;
		if (channel === 'http') {
			endpoint = await this.host.endpoint(this.agent, this.nonce);
			this.usedHttp = true;
			this.routePort = endpoint.port;
		}
		const result = await this.host.editor.insert(absolute, point.line, this.nonce, point.id, indent => markedRegion({ language, channel, nonce: this.nonce, point: point.id, expressions: point.expressions ?? [], indent, endpoint }));
		if (!result.ok) {
			return result;
		}
		this.regions.push(result.record);
		const restart = this.lastLaunch && !reloadsItself(this.lastLaunch.config) ? ' The program must load the code again: restart it (debug_launch again, or the user\'s Restart program).' : ' The program must load the code again before the line runs.';
		return { ok: true, note: ` Channel: ${channel} (${why}).${restart}` };
	}

	async removePoints(ids: readonly string[] | 'all'): Promise<string> {
		const chosen = ids === 'all' ? this.points.active.map(p => p.id) : ids;
		const removed: string[] = [];
		const left: string[] = [];
		for (const id of chosen) {
			const outcome = await this.removePoint(id, false);
			(outcome === 'changed' ? left : removed).push(id);
		}
		this.saveRecord();
		this.post();
		return [removed.length ? `Removed ${removed.join(', ')}.` : '', left.length ? `Left ${left.join(', ')}: the marked line was edited after it was added, so it is not removed without the user.` : ''].filter(Boolean).join(' ') || 'Nothing to remove.';
	}

	/** Removes one point: its breakpoint, or its marked line when unchanged (or with `force`). */
	private async removePoint(id: string, force: boolean): Promise<'removed' | 'changed' | 'none'> {
		const point = this.points.get(id);
		if (!point || point.status !== 'active') {
			return 'none';
		}
		if (point.kind === 'marked') {
			const region = this.regions.find(r => r.point === id);
			if (region) {
				const outcome = await this.host.editor.remove(region, force);
				if (outcome.state === 'changed') {
					return 'changed';
				}
				this.regions = this.regions.filter(r => r !== region);
			}
		} else {
			const breakpoint = this.breakpoints.get(id);
			if (breakpoint) {
				this.host.bridge.removePoints([breakpoint]);
				this.breakpoints.delete(id);
				this.specs.delete(id);
			}
		}
		this.points.remove(id);
		return 'removed';
	}

	async reproduce(steps: readonly string[] | undefined): Promise<string> {
		if (this.state.phase === 'instrument') {
			this.moveTo('reproduce');
		}
		const run = this.newRun(this.state.phase === 'verify' ? vscode.l10n.t("After the fix") : '');
		if (steps?.length) {
			this.lastSteps = steps;
			this.showReproduceCard(steps);
			return `Run ${run} started. The user sees the steps and answers Reproduced or Didn't happen; their answer comes as the next message. Meanwhile, end your turn.`;
		}
		this.lastSteps = undefined;
		this.post();
		return `Run ${run} started: reproduce the bug now (the test, a command in your terminal, the browser), then call debug_evidence.`;
	}

	private newRun(label: string): number {
		const run = this.evidence.startRun(label);
		this.snapshotsThisRun.clear();
		this.logTail?.newRun();
		this.noEvidence = false;
		return run;
	}

	private showReproduceCard(steps: readonly string[]): void {
		const verify = this.state.phase === 'verify';
		this.card = { kind: 'reproduce', title: verify ? vscode.l10n.t("Reproduce the bug again") : vscode.l10n.t("Reproduce the bug"), steps, status: vscode.l10n.t("Waiting for evidence..."), canRestart: !!this.lastLaunch && this.lastLaunch.kind === 'server' };
		this.armHint();
		this.post();
	}

	/** One timer per reproduce card: after 20 seconds with no evidence, why that may be. */
	private armHint(): void {
		if (this.hintTimer) {
			clearTimeout(this.hintTimer);
		}
		const run = this.evidence.currentRun?.id;
		this.hintTimer = setTimeout(() => {
			this.hintTimer = undefined;
			if (this.card?.kind !== 'reproduce' || run === undefined || this.evidence.countsInRun(run).size) {
				return;
			}
			const marked = this.points.active.some(p => p.kind === 'marked');
			const hint = marked && this.lastLaunch && !reloadsItself(this.lastLaunch.config)
				? vscode.l10n.t("No evidence yet. A marked line needs the program to restart before it runs.")
				: this.usedHttp
					? vscode.l10n.t("No evidence yet. The program may not reach GeminiCode's endpoint on 127.0.0.1 (its address, a page's Content-Security-Policy, or a container).")
					: vscode.l10n.t("No evidence yet. The points may be on a path the steps don't reach, or the program is not running under the debugger.");
			this.card = { ...this.card, hint };
			this.post();
		}, noEvidenceHintMs);
	}

	async inspect(args: InspectArgs): Promise<string> {
		const held = this.heldStops.get(args.stop);
		if (!held || !this.holds.get(args.stop)) {
			return `No held stop ${args.stop}: a stop is held only by a breakpoint with hold, for at most 30 seconds or until the turn ends.`;
		}
		if (args.asks.length) {
			const allow = vscode.l10n.t("Allow once");
			const picked = await vscode.window.showWarningMessage(vscode.l10n.t("Evaluate an expression that runs code in your program?"), { modal: true, detail: args.asks.join('\n') }, allow);
			if (picked !== allow) {
				return 'The user rejected the expression.';
			}
		}
		const text = await evaluateAt(this.host.bridge.requester(held.session), held.threadId, args.frame, args.expressions, new Set(args.asks));
		return externalDebug(`inspect ${args.stop}`, redact(text));
	}

	async requestLog(why: string): Promise<string> {
		const choose = vscode.l10n.t("Choose file...");
		const picked = await vscode.window.showInformationMessage(vscode.l10n.t("Gemini asks to read a log file your program writes"), { modal: true, detail: vscode.l10n.t("{0}\n\nOnly lines written after you pick it are read, by Debug mode only, until Debug mode ends.", why) }, choose);
		if (picked !== choose) {
			return 'The user declined to share a log file.';
		}
		const files = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(this.cwd), canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: vscode.l10n.t("Share with Debug mode") });
		const file = files?.[0]?.fsPath;
		if (!file) {
			return 'The user declined to share a log file.';
		}
		this.logTail?.stop();
		const tail = new LogTail(file, {
			onLines: lines => {
				for (const line of lines) {
					const matched = this.points.match(line);
					if (matched) {
						this.evidence.record(matched.point.id, 'values', matched.payload);
					} else {
						this.logContext.append(`${line}\n`);
					}
				}
				this.post();
			},
			onEnd: reason => {
				if (this.logTail === tail) {
					this.logTail = undefined;
					this.chat()?.addNotice(reason === 'deleted' ? vscode.l10n.t("Debug mode stopped reading {0}: the file was deleted.", path.basename(file)) : vscode.l10n.t("Debug mode stopped reading {0}.", path.basename(file)));
					this.saveRecord();
					this.post();
				}
			},
		});
		const opened = await tail.open();
		if (!opened.ok) {
			return `The file could not be followed: ${opened.error}`;
		}
		tail.start();
		this.logTail = tail;
		this.logSince = new Date().toLocaleTimeString();
		this.saveRecord();
		this.post();
		return `Following ${path.basename(file)} from now on: lines with markers become evidence, other lines context in debug_evidence. Your file tools still cannot read it.`;
	}

	async fix(hypothesis: string): Promise<string> {
		this.moveTo('fix');
		this.card = undefined;
		this.post();
		return `Fix phase for ${hypothesis}: edits are allowed now, through the usual approvals. Make the smallest fix, then call debug_verify.`;
	}

	async verify(): Promise<string> {
		this.beforeRun = this.evidence.currentRun?.id;
		this.moveTo('verify');
		if (this.lastSteps) {
			this.newRun(vscode.l10n.t("After the fix"));
			this.showReproduceCard(this.lastSteps);
			return 'Verify: the user sees the same steps again. Their answer comes as the next message; then compare the runs with debug_evidence.';
		}
		const launch = this.lastLaunch;
		if (launch && launch.kind !== 'server') {
			const text = await this.startSession(launch.folder, launch.config, launch.kind, false);
			return `Verify: ran the same program again. ${text} When it ends, compare the runs with debug_evidence.`;
		}
		this.newRun(vscode.l10n.t("After the fix"));
		this.post();
		return 'Verify: run the same reproduction again now (the same test or command), then compare the runs with debug_evidence.';
	}

	/** After `debug_evidence`: evidence was read, so Reproduce moves on to Analyse. */
	evidenceRead(): void {
		if (this.state.phase === 'reproduce') {
			const run = this.evidence.currentRun;
			this.noEvidence = !run || !this.evidence.countsInRun(run.id).size;
			this.moveTo('analyse');
			this.post();
		}
	}

	/** The plain output and log lines that are not points' evidence, for `debug_evidence`: exceptions and context. */
	contextNote(): string | undefined {
		const parts: string[] = [];
		for (const [session, about] of this.started) {
			const tail = this.host.bridge.tail(session, 1500).trim();
			if (tail) {
				parts.push(`Output of ${about.config.name} (last lines):\n${tail}`);
			}
		}
		const log = this.logContext.text(1500).trim();
		if (log) {
			parts.push(`Log file (last lines):\n${log}`);
		}
		if (this.userPaused) {
			parts.push('The program is paused by the user (a stop at none of your points); it is left alone.');
		}
		return parts.length ? externalDebug('output', redact(parts.join('\n\n'))) : undefined;
	}

	private moveTo(phase: DebugPhase, hadEvidence?: boolean, by: 'agent' | 'user' = 'agent'): boolean {
		const next = move(this.state, phase, { by, hadEvidence });
		if (!next) {
			return false;
		}
		this.state = next;
		return true;
	}

	// --- The bridge's events ---

	marked(line: string): void {
		const matched = this.points.match(line);
		if (!matched) {
			return;
		}
		this.evidence.record(matched.point.id, 'values', matched.payload);
		this.liveCount();
	}

	/** An event from the endpoint. */
	ingested(point: string, payload: string): void {
		if (this.points.get(point)) {
			this.evidence.record(point, 'values', payload);
			this.liveCount();
		}
	}

	private liveCount(): void {
		if (this.card?.kind === 'reproduce') {
			const run = this.evidence.currentRun?.id;
			const counts = run === undefined ? new Map<string, number>() : this.evidence.countsInRun(run);
			this.card = { ...this.card, status: vscode.l10n.t("Receiving: {0}", [...counts].map(([p, n]) => `${p} ${n}`).join(' - ')), hint: undefined };
		}
		this.post();
	}

	stopped(stop: StoppedEvent, session: vscode.DebugSession): void {
		void handleStop(stop, {
			pointFor: id => this.pointForDapId(session, id),
			request: this.host.bridge.requester(session),
			snapshots: point => this.snapshotsThisRun.get(point) ?? 0,
			stopId: () => `s${++this.stopSeq}`,
			holds: this.holds,
		}).then(outcome => {
			switch (outcome.kind) {
				case 'user':
					this.userPaused = true;
					break;
				case 'counted':
					this.evidence.drop(outcome.point);
					break;
				case 'snapshot':
				case 'held':
					this.snapshotsThisRun.set(outcome.point, (this.snapshotsThisRun.get(outcome.point) ?? 0) + 1);
					if (outcome.kind === 'held' && stop.threadId !== undefined) {
						this.heldStops.set(outcome.stop, { session, threadId: stop.threadId });
					}
					this.evidence.record(outcome.point, 'snapshot', outcome.kind === 'held' ? `held as ${outcome.stop} (debug_inspect within 30 s):\n${outcome.text}` : outcome.text);
					break;
			}
			this.liveCount();
		}, err => this.host.log.warn(`Debug mode: a stop could not be handled: ${err instanceof Error ? err.message : String(err)}`));
	}

	private async pointForDapId(session: vscode.DebugSession, id: number): Promise<Point | undefined> {
		let ids = this.dapIds.get(session.id);
		if (!ids?.has(id)) {
			ids = new Map();
			for (const [point, breakpoint] of this.breakpoints) {
				const dap = await this.host.bridge.dapId(session, breakpoint);
				if (dap !== undefined) {
					ids.set(dap, point);
				}
			}
			this.dapIds.set(session.id, ids);
		}
		const point = ids.get(id);
		return point ? this.points.get(point) : undefined;
	}

	exited(code: number | undefined, session: vscode.DebugSession): void {
		if (this.started.get(session)?.kind === 'server' || !session.parentSession) {
			this.evidence.endRun(code);
		}
		if (this.card?.kind === 'reproduce') {
			this.card = { ...this.card, status: code === undefined ? vscode.l10n.t("The program exited.") : vscode.l10n.t("The program exited (code {0}).", code) };
		}
		this.post();
	}

	terminated(session: vscode.DebugSession): void {
		if (this.started.delete(session)) {
			this.evidence.endRun();
			this.saveRecord();
			this.post();
		}
		for (const [id, held] of this.heldStops) {
			if (held.session === session) {
				this.heldStops.delete(id);
			}
		}
	}

	breakpointsChanged(removed: readonly vscode.Breakpoint[], changed: readonly vscode.Breakpoint[]): void {
		let any = false;
		for (const [id, breakpoint] of [...this.breakpoints]) {
			if (removed.includes(breakpoint)) {
				// The user removed it: the point is gone.
				this.breakpoints.delete(id);
				this.points.remove(id);
				any = true;
			} else if (changed.includes(breakpoint) && breakpoint instanceof vscode.SourceBreakpoint) {
				const spec = this.specs.get(id);
				if ((breakpoint.condition ?? undefined) !== spec?.condition || (breakpoint.logMessage ?? undefined) !== spec?.logMessage || (breakpoint.hitCondition ?? undefined) !== spec?.hitCondition) {
					// Edited by the user: theirs now, left alone at Clean up.
					this.breakpoints.delete(id);
					this.points.disown(id);
					any = true;
				}
			}
		}
		if (any) {
			this.saveRecord();
			this.post();
		}
	}

	// --- The phase guard ---

	/** Why a write of `content` to `file` by the agent's session is refused, or undefined. */
	async guardWrite(file: string, content: string): Promise<string | undefined> {
		if (this.ended || !isInside(this.cwd, file)) {
			return undefined;
		}
		const inFile = this.regions.filter(r => r.file === file);
		if (inFile.length) {
			const before = await fs.readFile(file, 'utf8').catch(() => '');
			if (changesRegion(before, content, inFile)) {
				return markedRegionRefusal;
			}
		}
		return editsAllowed(this.state) ? undefined : editRefusal(this.state);
	}

	// --- The user's buttons ---

	async action(action: DebugAction, arg?: string): Promise<void> {
		const chat = this.chat();
		const say = (text: string, userSaid: string) => {
			this.userSaid = userSaid;
			void chat?.send(text, [], undefined, 'queue');
		};
		switch (action) {
			case 'stop':
				await this.cleanup('stop');
				return;
			case 'evidence':
				this.host.openEvidence(this.agent, arg);
				return;
			case 'fold':
				this.folded = !this.folded;
				break;
			case 'skipToFix':
				if (this.moveTo('fix', undefined, 'user')) {
					this.card = undefined;
					say(vscode.l10n.t("Go ahead and fix it: I allow edits without a confirmed hypothesis."), 'Skip to fix');
				}
				break;
			case 'backToInvestigate':
				if (this.moveTo('investigate', undefined, 'user')) {
					this.card = undefined;
				}
				break;
			case 'restartProgram':
				await this.restartProgram();
				break;
			case 'stopProgram':
				for (const [session, about] of [...this.started]) {
					if (!about.attached) {
						await this.host.bridge.stop(session);
					}
				}
				break;
			case 'removeAllPoints':
				await this.removePoints('all');
				break;
			case 'removePoint':
				if (arg) {
					const outcome = await this.removePoint(arg, false);
					if (outcome === 'changed') {
						const anyway = vscode.l10n.t("Remove anyway");
						if (await vscode.window.showWarningMessage(vscode.l10n.t("The marked line {0} was edited after Debug mode added it. Remove it anyway?", arg), { modal: true }, anyway) === anyway) {
							await this.removePoint(arg, true);
						}
					}
					this.saveRecord();
				}
				break;
			case 'openPoint': {
				const point = arg ? this.points.get(arg) : undefined;
				if (point) {
					await this.host.editor.reveal(this.absolute(point.file), point.line);
				}
				return;
			}
			case 'reproduced':
				if (this.state.phase === 'reproduce') {
					this.moveTo('analyse');
				}
				this.card = this.state.phase === 'verify' ? undefined : this.card?.kind === 'reproduce' ? undefined : this.card;
				say(vscode.l10n.t("I reproduced the bug."), 'Reproduced');
				break;
			case 'didntHappen':
				if (this.state.phase === 'reproduce') {
					this.moveTo('analyse');
				}
				this.card = undefined;
				say(vscode.l10n.t("The bug didn't happen this time."), 'Didn\'t happen');
				break;
			case 'fixed':
				this.card = undefined;
				await this.cleanup('fixed');
				return;
			case 'stillBroken':
				this.moveTo('fix', undefined, 'user');
				this.card = undefined;
				say(vscode.l10n.t("It is still broken."), 'Still broken');
				break;
			case 'regressionTest':
				this.moveTo('fix', undefined, 'user');
				this.card = undefined;
				say(vscode.l10n.t("Add a regression test for this bug, run it once, then call debug_verify."), 'Add a regression test');
				break;
			case 'keepGoing':
				this.state = keepGoing(this.state);
				this.card = undefined;
				break;
			case 'hint':
				this.state = keepGoing(this.state);
				this.card = undefined;
				chat?.focusComposer();
				break;
			case 'removeAnyway':
			case 'keepRegion':
			case 'showDiff':
				await this.leftRegion(action, arg);
				break;
			case 'stopLog':
				this.logTail?.stop();
				this.logTail = undefined;
				this.saveRecord();
				break;
			case 'dismiss':
				if (this.ended) {
					this.chat()?.postDebug(undefined);
					this.host.ended(this.agent);
					return;
				}
				this.card = undefined;
				break;
			case 'start':
				return;
		}
		this.post();
	}

	private async restartProgram(): Promise<void> {
		const launch = this.lastLaunch;
		if (!launch) {
			return;
		}
		for (const [session, about] of [...this.started]) {
			if (!about.attached) {
				await this.host.bridge.stop(session);
			}
		}
		await this.startSession(launch.folder, launch.config, launch.kind, false);
		if (this.card?.kind === 'reproduce') {
			this.armHint();
		}
	}

	private verifyCard(): DebugCardView {
		const before = this.beforeRun ?? 1;
		const after = this.evidence.currentRun?.id ?? before;
		const rows = compareRuns(this.evidence, this.points.all.filter(p => p.status !== 'removed'), before, after).map(c => ({
			point: c.point,
			where: c.where,
			before: `${hitsLabel(c.before.hits)}${c.before.last === undefined ? '' : ` ${clipValue(c.before.last, 60)}`}`,
			after: `${hitsLabel(c.after.hits)}${c.after.last === undefined ? '' : ` ${clipValue(c.after.last, 60)}`}`,
			changed: c.changed,
		}));
		const run = this.evidence.runs.find(r => r.id === after);
		const note = run?.exitCode === undefined ? undefined : run.exitCode === 0 ? vscode.l10n.t("The program exited with code 0.") : vscode.l10n.t("The program exited with code {0}.", run.exitCode);
		return { kind: 'verify', title: vscode.l10n.t("Before and after the fix"), rows, ...note ? { note } : {}, offerTest: this.lastLaunch?.kind !== 'test' };
	}

	// --- Clean up ---

	/**
	 * Every way out: the steps in order, each safe to repeat. With `quick`
	 * (the window closing) only what is fast runs; marked lines then wait for
	 * the next start, where the record offers them.
	 */
	async cleanup(reason: 'fixed' | 'stop' | 'closed' | 'off' | 'window', quick = false): Promise<void> {
		if (this.ended) {
			return;
		}
		this.ended = true;
		if (this.hintTimer) {
			clearTimeout(this.hintTimer);
			this.hintTimer = undefined;
		}
		const counts = this.points.counts();
		// 1. The agent's logpoints and breakpoints; ones the user edited are theirs.
		this.host.bridge.removePoints([...this.breakpoints.values()]);
		this.breakpoints.clear();
		// 2. Held threads continue; launched sessions end; attached ones detach without ending the program.
		this.holds.releaseAll();
		const sessions = [...this.started.keys()];
		await Promise.all(sessions.map(session => Promise.resolve(this.host.bridge.stop(session)).then(undefined, () => undefined)));
		this.started.clear();
		// 3. Marked lines: removed only when unchanged.
		const removedFiles = new Set<string>();
		let removedRegions = 0;
		if (!quick) {
			for (const record of [...this.regions]) {
				const outcome = await this.host.editor.remove(record);
				if (outcome.state === 'changed') {
					this.left.push({ record, diff: outcome.diff, open: false });
					continue;
				}
				if (outcome.state !== 'missing') {
					removedRegions++;
					removedFiles.add(record.file);
				}
				this.regions = this.regions.filter(r => r !== record);
			}
		}
		// 4. The endpoint's route.
		this.host.closeEndpoint(this.agent);
		this.routePort = undefined;
		// 5. The log file grant.
		const log = this.logTail?.file;
		this.logTail?.stop();
		this.logTail = undefined;
		// 6. Evidence goes; the record goes unless marked lines are left.
		this.evidence.clear();
		this.points.removeAll();
		this.host.lines.releaseAll(this.agent);
		this.state = { ...this.state, phase: 'cleanup' };
		if (this.regions.length) {
			this.saveRecord();
			void this.writer.flush();
		} else {
			void this.writer.delete();
		}
		this.host.toolsChanged(this.agent);
		this.host.editor.changed();
		this.host.log.info(`Debug mode ended for agent ${this.agent} (${reason}): ${counts.logpoints} logpoints, ${counts.breakpoints} breakpoints, ${removedRegions} marked lines removed, ${this.left.length} left`);
		if (quick) {
			return;
		}
		// 7. The sweep: any copy of the nonce left in the agent's folder.
		const strays = await this.sweep();
		this.summary = [
			vscode.l10n.t("Removed {0} logpoints, {1} breakpoints and {2} marked lines in {3} files.", counts.logpoints, counts.breakpoints, removedRegions, removedFiles.size),
			...sessions.length ? [sessions.length === 1 ? vscode.l10n.t("Ended 1 debug session.") : vscode.l10n.t("Ended {0} debug sessions.", sessions.length)] : [],
			...log ? [vscode.l10n.t("Stopped reading {0}.", path.basename(log))] : [],
			...strays.map(file => vscode.l10n.t("Left: {0} still has Debug mode's marker.", file)),
			...reason === 'off' ? [vscode.l10n.t("Debug mode was turned off in settings.")] : [],
		];
		this.post();
	}

	private async leftRegion(action: 'removeAnyway' | 'keepRegion' | 'showDiff', point: string | undefined): Promise<void> {
		const entry = this.left.find(l => l.record.point === point);
		if (!entry) {
			return;
		}
		if (action === 'showDiff') {
			entry.open = !entry.open;
			return;
		}
		if (action === 'removeAnyway') {
			await this.host.editor.remove(entry.record, true);
		}
		this.left = this.left.filter(l => l !== entry);
		this.regions = this.regions.filter(r => r !== entry.record);
		if (this.regions.length) {
			this.saveRecord();
		} else {
			await this.writer.delete();
		}
	}

	/** Files in the agent's folder that still hold the nonce, by the app's ripgrep with the ignore rules off. */
	private async sweep(): Promise<readonly string[]> {
		const rg = await this.host.ripgrep();
		if (!rg) {
			return [];
		}
		return new Promise(resolve => {
			execFile(rg, ['--files-with-matches', '--no-ignore', '--hidden', '--fixed-strings', '--max-count', '1', '--glob', '!.git', this.nonce, this.cwd], { timeout: 10_000, maxBuffer: 256 * 1024 }, (_err, stdout) => {
				resolve(String(stdout ?? '').split('\n').filter(Boolean).map(file => toPosix(path.relative(this.cwd, file))).slice(0, 20));
			});
		});
	}

	// --- The record and the view ---

	private saveRecord(): void {
		if (this.ended && !this.regions.length) {
			return;
		}
		const record: DebugRecord = {
			version: 1,
			agent: this.agent,
			nonce: this.nonce,
			folder: this.cwd,
			title: this.start.title,
			startedAt: this.startedAt,
			points: this.points.active.filter(p => p.kind !== 'marked' && this.breakpoints.has(p.id)).map(p => {
				const spec = this.specs.get(p.id);
				return { id: p.id, kind: p.kind, file: this.absolute(p.file), line: p.line, ...spec?.condition ? { condition: spec.condition } : {}, ...spec?.logMessage ? { message: spec.logMessage } : {} };
			}),
			regions: this.regions,
			sessions: this.started.size ? [this.nonce] : [],
			...this.logTail ? { logFile: this.logTail.file } : {},
			...this.routePort !== undefined ? { routePort: this.routePort } : {},
		};
		this.writer.update(record);
	}

	/** Sends the view to the chat at most once a second, and tells the Evidence page and the status bar. */
	private post(): void {
		if (this.viewTimer) {
			this.viewDirty = true;
			return;
		}
		this.postNow();
		this.viewTimer = setTimeout(() => {
			this.viewTimer = undefined;
			if (this.viewDirty) {
				this.viewDirty = false;
				this.post();
			}
		}, viewDelayMs);
	}

	private postNow(): void {
		this.chat()?.postDebug(this.view());
		this.host.viewChanged(this.agent);
		this.host.editor.refresh();
	}

	/** The bar's view, for a chat attached again. */
	view(): DebugBarView {
		const strings = barStrings();
		if (this.ended) {
			return {
				strings, phases: [], summary: '', points: [], launched: false, folded: true, ended: true,
				card: { kind: 'cleanup', title: vscode.l10n.t("Debug mode ended"), lines: this.summary, left: this.left.map(l => ({ id: l.record.point, text: vscode.l10n.t("{0} was edited after it was added.", `${path.basename(l.record.file)}:${l.record.line}`), ...l.open ? { diff: l.diff } : {} })) },
			};
		}
		const index = debugPhases.indexOf(this.state.phase);
		const phases = debugPhases.filter(p => p !== 'cleanup').map((phase, i) => ({ label: phaseLabel(phase), state: i < index ? 'done' as const : i === index ? 'current' as const : 'todo' as const }));
		const open = this.hypotheses.filter(h => h.status === 'open').length;
		const active = this.points.active;
		const hits = this.evidence.totals.hits;
		const summary = [
			open === 1 ? vscode.l10n.t("1 hypothesis open") : vscode.l10n.t("{0} hypotheses open", open),
			active.length === 1 ? vscode.l10n.t("1 point") : vscode.l10n.t("{0} points", active.length),
			hits === 1 ? vscode.l10n.t("1 event") : vscode.l10n.t("{0} events", hits),
		].join(' - ');
		return {
			strings,
			phases,
			summary,
			points: active.map(p => {
				const n = this.evidence.pointStats(p.id)?.hits ?? 0;
				return { id: p.id, where: `${p.file}:${p.line}`, hypothesis: p.hypothesis, kind: p.kind, kindLabel: kindLabel(p.kind), hits: p.bound === false ? vscode.l10n.t("{0} - not bound", hitsLabel(n)) : hitsLabel(n) };
			}),
			...this.logTail ? { logFile: `${this.logTail.file} (${vscode.l10n.t("since {0}", this.logSince ?? '')})` } : {},
			launched: !!this.lastLaunch,
			folded: this.folded,
			...this.card ? { card: this.card } : {},
		};
	}

	/** The Evidence page's rows for `filter`. */
	evidenceView(filter: EvidenceFilter, focus?: string): EvidenceView {
		const points = this.points.all;
		const byId = new Map(points.map(p => [p.id, p]));
		const search = filter.search?.toLowerCase();
		const matching = this.evidence.query({ ...filter.point ? { points: [filter.point] } : {} }).filter(event =>
			(filter.run === undefined || event.run === filter.run)
			&& (!filter.hypothesis || byId.get(event.point)?.hypothesis === filter.hypothesis)
			&& (!search || event.text.toLowerCase().includes(search)));
		const rows = matching.slice(0, filter.limit).map(event => {
			const point = byId.get(event.point);
			return { point: event.point, event: event.id, run: event.run, time: `+${(event.time / 1000).toFixed(3)} s`, where: point ? `${point.file}:${point.line}` : '', hypothesis: point?.hypothesis ?? '', kind: event.kind, text: clipValue(event.text, 2000) };
		});
		const totals = this.evidence.totals;
		const runs = this.evidence.runs;
		const comparison = runs.length >= 2 ? compareRuns(this.evidence, points.filter(p => p.status !== 'removed'), runs[runs.length - 2].id, runs[runs.length - 1].id).map(c => ({
			point: c.point, where: c.where, before: `${hitsLabel(c.before.hits)}${c.before.last === undefined ? '' : ` ${clipValue(c.before.last, 80)}`}`, after: `${hitsLabel(c.after.hits)}${c.after.last === undefined ? '' : ` ${clipValue(c.after.last, 80)}`}`, changed: c.changed,
		})) : undefined;
		return {
			title: vscode.l10n.t("Evidence - {0}", this.start.title),
			runs: runs.map(r => ({ id: r.id, label: r.label })),
			hypotheses: this.hypotheses.map(h => h.id),
			points: points.map(p => ({ id: p.id, where: `${p.file}:${p.line}`, hypothesis: p.hypothesis })),
			rows,
			more: matching.length > rows.length,
			totals: vscode.l10n.t("{0} events - {1} dropped (rate) - {2} values redacted", totals.hits, totals.drops, totals.redactions),
			...comparison ? { comparison } : {},
			...this.ended ? { ended: true } : {},
			...focus ? { focus } : {},
		};
	}

	/** For the status bar. */
	get counts(): { readonly points: number; readonly events: number } {
		return { points: this.points.active.length, events: this.evidence.totals.hits };
	}

	dispose(): void {
		if (this.viewTimer) {
			clearTimeout(this.viewTimer);
		}
		if (this.hintTimer) {
			clearTimeout(this.hintTimer);
		}
		this.holds.releaseAll();
		this.logTail?.stop();
		this.writer.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

/** Every agent's Debug mode in this window, answering the `geminicode-debug` server's tools for them. */
export class DebugModes implements DebugBackend, vscode.Disposable {

	private readonly modes = new Map<string, DebugMode>();

	constructor(private readonly host: DebugModeHost) { }

	get(agent: string): DebugMode | undefined {
		return this.modes.get(agent);
	}

	get all(): readonly DebugMode[] {
		return [...this.modes.values()];
	}

	/** The modes still running (not ended). */
	get running(): readonly DebugMode[] {
		return this.all.filter(mode => !mode.isEnded);
	}

	enter(start: DebugStart): DebugMode {
		this.modes.get(start.agent)?.dispose();
		const mode = new DebugMode(this.host, start);
		this.modes.set(start.agent, mode);
		this.host.toolsChanged(start.agent);
		return mode;
	}

	/** Forgets an ended mode once its card is dismissed or a new one starts. */
	forget(agent: string): void {
		const mode = this.modes.get(agent);
		if (mode) {
			this.modes.delete(agent);
			mode.dispose();
		}
	}

	/** The phase guard for a write by session `sessionId`: the mode of the agent whose session it is. */
	async guardWrite(sessionId: string, file: string, content: string): Promise<string | undefined> {
		for (const mode of this.running) {
			if (this.host.chat(mode.agent)?.sessionId === sessionId) {
				return mode.guardWrite(file, content);
			}
		}
		return undefined;
	}

	// DebugBackend: the server lists the tools only for a running mode.

	session(agent: string): DebugSessionView | undefined {
		const mode = this.modes.get(agent);
		return mode && !mode.isEnded ? mode : undefined;
	}

	private mode(agent: string): DebugMode {
		const mode = this.session(agent) as DebugMode | undefined;
		if (!mode) {
			throw new Error('Debug mode is off for this session.');
		}
		return mode;
	}

	setHypotheses(agent: string, list: readonly Hypothesis[]): Promise<string> {
		return this.mode(agent).setHypotheses(list);
	}

	configs(agent: string): Promise<string> {
		return this.mode(agent).configs();
	}

	launch(agent: string, args: LaunchArgs): Promise<string> {
		return this.mode(agent).launch(args);
	}

	attach(agent: string, args: AttachArgs): Promise<string> {
		return this.mode(agent).attach(args);
	}

	addPoint(agent: string, input: PointInput, asks: readonly ExpressionAsk[]): Promise<string> {
		return this.mode(agent).addPoint(input, asks);
	}

	removePoints(agent: string, ids: readonly string[] | 'all'): Promise<string> {
		return this.mode(agent).removePoints(ids);
	}

	reproduce(agent: string, steps: readonly string[] | undefined): Promise<string> {
		return this.mode(agent).reproduce(steps);
	}

	inspect(agent: string, args: InspectArgs): Promise<string> {
		return this.mode(agent).inspect(args);
	}

	requestLog(agent: string, why: string): Promise<string> {
		return this.mode(agent).requestLog(why);
	}

	fix(agent: string, hypothesis: string): Promise<string> {
		return this.mode(agent).fix(hypothesis);
	}

	verify(agent: string): Promise<string> {
		return this.mode(agent).verify();
	}

	dispose(): void {
		for (const mode of this.modes.values()) {
			void mode.cleanup('window', true);
			mode.dispose();
		}
		this.modes.clear();
	}
}
