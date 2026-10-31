/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The one place Debug mode touches `vscode.debug` (DEBUG_MODE.md, The
// debugger bridge): starting and attaching with the Run and Debug view left
// as it was, the agents' points as the window's breakpoints, a tracker for
// the sessions Debug mode started (and their children), registered while any
// Debug mode runs and disposed with the last, and the requests a stop needs.
// Every decision is in src/acp/debug/debugBridgeLogic.ts.

import * as net from 'node:net';
import * as vscode from 'vscode';
import { type DapRequest, SessionTracker, sessionMarker, type StoppedEvent, trackedNonce } from '../../acp/debug/debugBridgeLogic';

/** One Debug mode as the bridge serves it, by its nonce. */
export interface BridgeClient {
	readonly nonce: string;
	marked(line: string, session: vscode.DebugSession): void;
	stopped(stop: StoppedEvent, session: vscode.DebugSession): void;
	exited(code: number | undefined, session: vscode.DebugSession): void;
	terminated(session: vscode.DebugSession): void;
	/** A breakpoint of the client's was removed or edited by the user. */
	breakpointsChanged(removed: readonly vscode.Breakpoint[], changed: readonly vscode.Breakpoint[]): void;
}

/** The common debug ports: Node's inspector, the next one, and debugpy's. */
const commonPorts = [9229, 9230, 5678];

export class DebugBridge implements vscode.Disposable {

	private readonly clients = new Map<string, BridgeClient>();
	private readonly trackers = new Map<string, SessionTracker>();
	/** Every debug session running in the window, for `debug_configs`; the user's are listed by name only. */
	private readonly running = new Map<string, vscode.DebugSession>();
	private registration: vscode.Disposable | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		for (const session of vscode.debug.activeDebugSession ? [vscode.debug.activeDebugSession] : []) {
			this.running.set(session.id, session);
		}
		this.disposables.push(
			vscode.debug.onDidStartDebugSession(session => this.running.set(session.id, session)),
			vscode.debug.onDidTerminateDebugSession(session => {
				this.running.delete(session.id);
				const tracker = this.trackers.get(session.id);
				this.trackers.delete(session.id);
				tracker?.end();
			}),
			vscode.debug.onDidChangeBreakpoints(event => {
				if (event.removed.length || event.changed.length) {
					for (const client of this.clients.values()) {
						client.breakpointsChanged(event.removed, event.changed);
					}
				}
			}),
		);
	}

	/** Serves `client` until the returned disposable runs; the tracker factory exists while any client does. */
	register(client: BridgeClient): vscode.Disposable {
		this.clients.set(client.nonce, client);
		this.registration ??= vscode.debug.registerDebugAdapterTrackerFactory('*', {
			createDebugAdapterTracker: session => this.trackerFor(session),
		});
		return new vscode.Disposable(() => {
			this.clients.delete(client.nonce);
			if (!this.clients.size) {
				this.registration?.dispose();
				this.registration = undefined;
			}
		});
	}

	/** The plain output of a tracked session, for exceptions and context. */
	tail(session: vscode.DebugSession, chars?: number): string {
		return this.trackers.get(session.id)?.tail.text(chars) ?? '';
	}

	private trackerFor(session: vscode.DebugSession): vscode.DebugAdapterTracker | undefined {
		const nonce = trackedNonce(session);
		const client = nonce ? this.clients.get(nonce) : undefined;
		if (!client) {
			// The user's own sessions get no tracker.
			return undefined;
		}
		const tracker = new SessionTracker({
			marked: line => client.marked(line, session),
			stopped: stop => client.stopped(stop, session),
			exited: code => client.exited(code, session),
			terminated: () => client.terminated(session),
		});
		this.trackers.set(session.id, tracker);
		return {
			onDidSendMessage: message => tracker.onMessage(message),
			onExit: () => tracker.end(),
		};
	}

	/** The sessions of `nonce`: the one started or attached, and its children. */
	sessionsOf(nonce: string): readonly vscode.DebugSession[] {
		return [...this.running.values()].filter(session => trackedNonce(session) === nonce);
	}

	/** The names of the sessions running that are not Debug mode's: what the agent could attach to. */
	otherSessions(): readonly string[] {
		return [...this.running.values()].filter(session => !trackedNonce(session) && !session.parentSession).map(session => `${session.name} (${session.type})`);
	}

	/** Starts `config` (Debug mode's resolved copy) with the user's Run and Debug view, toolbar and unsaved files left alone; resolves with its top session. */
	async start(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, timeoutMs = 15_000): Promise<vscode.DebugSession | undefined> {
		const nonce = config[sessionMarker] as string;
		let listener: vscode.Disposable | undefined;
		const started = new Promise<vscode.DebugSession | undefined>(resolve => {
			const timer = setTimeout(() => resolve(undefined), timeoutMs);
			listener = vscode.debug.onDidStartDebugSession(session => {
				if (!session.parentSession && session.configuration[sessionMarker] === nonce && session.configuration.name === config.name) {
					clearTimeout(timer);
					resolve(session);
				}
			});
		});
		try {
			const ok = await vscode.debug.startDebugging(folder, config, { suppressDebugView: true, suppressDebugToolbar: true, suppressSaveBeforeStart: true });
			if (!ok) {
				return undefined;
			}
			return await started;
		} finally {
			listener?.dispose();
		}
	}

	stop(session: vscode.DebugSession): Thenable<void> {
		return vscode.debug.stopDebugging(session);
	}

	/** `customRequest` on `session`, as the logic's requests take it. */
	requester(session: vscode.DebugSession): DapRequest {
		return (command, args) => session.customRequest(command, args);
	}

	/** Adds one of the agent's points as a breakpoint of the window. */
	addPoint(file: string, line: number, spec: { readonly condition?: string; readonly hitCondition?: string; readonly logMessage?: string }): vscode.SourceBreakpoint {
		const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(line - 1, 0)), true, spec.condition, spec.hitCondition, spec.logMessage);
		vscode.debug.addBreakpoints([breakpoint]);
		return breakpoint;
	}

	removePoints(breakpoints: readonly vscode.Breakpoint[]): void {
		if (breakpoints.length) {
			vscode.debug.removeBreakpoints([...breakpoints]);
		}
	}

	/** Whether the user has a breakpoint of their own on the line (one-based), apart from `ours`. */
	userBreakpointAt(file: string, line: number, ours: ReadonlySet<vscode.Breakpoint>): boolean {
		const uri = vscode.Uri.file(file).toString();
		return vscode.debug.breakpoints.some(breakpoint => breakpoint instanceof vscode.SourceBreakpoint && !ours.has(breakpoint)
			&& breakpoint.location.uri.toString() === uri && breakpoint.location.range.start.line === line - 1);
	}

	/** The breakpoints left from a Debug mode that did not end, by file, line, condition and message: ids do not survive a reload. */
	removeMatching(points: readonly { readonly file: string; readonly line: number; readonly condition?: string; readonly message?: string }[]): number {
		const matching = vscode.debug.breakpoints.filter(breakpoint => breakpoint instanceof vscode.SourceBreakpoint && points.some(point =>
			breakpoint.location.uri.fsPath === point.file && breakpoint.location.range.start.line === point.line - 1
			&& (breakpoint.condition ?? undefined) === (point.condition ?? undefined) && (breakpoint.logMessage ?? undefined) === (point.message ?? undefined)));
		this.removePoints(matching);
		return matching.length;
	}

	/** Whether any session of `nonce` bound the breakpoint; undefined while none says. */
	async bound(nonce: string, breakpoint: vscode.Breakpoint): Promise<boolean | undefined> {
		let answer: boolean | undefined;
		for (const session of this.sessionsOf(nonce)) {
			const dap = await Promise.resolve(session.getDebugProtocolBreakpoint(breakpoint)).then(found => found as { readonly verified?: boolean } | undefined, () => undefined);
			if (dap?.verified) {
				return true;
			}
			if (dap) {
				answer = false;
			}
		}
		return answer;
	}

	/** The adapter's id for the breakpoint in `session`, for matching a stop's `hitBreakpointIds`. */
	async dapId(session: vscode.DebugSession, breakpoint: vscode.Breakpoint): Promise<number | undefined> {
		const dap = await Promise.resolve(session.getDebugProtocolBreakpoint(breakpoint)).then(found => found as { readonly id?: number } | undefined, () => undefined);
		return typeof dap?.id === 'number' ? dap.id : undefined;
	}

	/** The common debug ports listening on 127.0.0.1. */
	async listeningPorts(): Promise<readonly number[]> {
		const open = await Promise.all(commonPorts.map(port => new Promise<boolean>(resolve => {
			const socket = net.createConnection({ host: '127.0.0.1', port });
			const done = (up: boolean) => {
				socket.destroy();
				resolve(up);
			};
			socket.setTimeout(300, () => done(false));
			socket.once('connect', () => done(true));
			socket.once('error', () => done(false));
		})));
		return commonPorts.filter((_, i) => open[i]);
	}

	dispose(): void {
		this.registration?.dispose();
		this.registration = undefined;
		this.clients.clear();
		this.trackers.clear();
		vscode.Disposable.from(...this.disposables).dispose();
	}
}
