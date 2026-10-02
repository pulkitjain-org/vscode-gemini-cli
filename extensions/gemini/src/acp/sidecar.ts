/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AgentCommand, spawnAgent } from './agentProcess';
import { AgentErrorKind, FATAL_EXIT_CODES } from './errors';
import { Emitter } from './events';

export type SidecarState =
	| { readonly kind: 'stopped' }
	| { readonly kind: 'starting' }
	| { readonly kind: 'running'; readonly process: ChildProcessWithoutNullStreams }
	| { readonly kind: 'restarting'; readonly attempt: number; readonly delayMs: number; readonly exitCode: number | null }
	| { readonly kind: 'failed'; readonly reason: AgentErrorKind; readonly exitCode: number | null; readonly message: string };

export interface SidecarOptions {
	/** Re-read on every (re)start so setting changes apply. */
	readonly command: () => AgentCommand;
	readonly cwd: string | undefined;
	/** Delays before successive automatic restarts; their count bounds the restarts. */
	readonly restartDelaysMs?: readonly number[];
	/** A process that stays up this long resets the restart count. */
	readonly healthyAfterMs?: number;
	readonly spawn?: typeof spawnAgent;
}

const defaultRestartDelaysMs = [1_000, 4_000, 15_000];

/**
 * Runs `gemini --acp` and keeps it running: crash detection, bounded restarts
 * with backoff, and state events. Each `running` state carries a new process,
 * so the client must reconnect and start a new session on every one.
 */
export class AgentSidecar {

	private readonly onDidChangeStateEmitter = new Emitter<SidecarState>();
	readonly onDidChangeState = this.onDidChangeStateEmitter.event;

	private readonly onStderrEmitter = new Emitter<string>();
	/** Agent stderr, one line per event. */
	readonly onStderr = this.onStderrEmitter.event;

	private _state: SidecarState = { kind: 'stopped' };
	private restarts = 0;
	private restartTimer: ReturnType<typeof setTimeout> | undefined;
	private healthyTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly restartDelaysMs: readonly number[];
	private readonly healthyAfterMs: number;
	private readonly spawn: typeof spawnAgent;

	constructor(private readonly options: SidecarOptions) {
		this.restartDelaysMs = options.restartDelaysMs ?? defaultRestartDelaysMs;
		this.healthyAfterMs = options.healthyAfterMs ?? 60_000;
		this.spawn = options.spawn ?? spawnAgent;
	}

	get state(): SidecarState {
		return this._state;
	}

	/** Starts the agent, or restarts it (resetting the restart budget) if it is already running. */
	start(): void {
		this.restarts = 0;
		this.launch();
	}

	stop(): void {
		this.clearTimers();
		const current = this._state;
		this.setState({ kind: 'stopped' });
		if (current.kind === 'running') {
			current.process.kill();
		}
	}

	dispose(): void {
		this.stop();
		this.onDidChangeStateEmitter.dispose();
		this.onStderrEmitter.dispose();
	}

	private launch(): void {
		this.clearTimers();
		const previous = this._state;
		if (previous.kind === 'running') {
			// Mark stopped first so the old process's exit is not treated as a crash.
			this.setState({ kind: 'stopped' });
			previous.process.kill();
		}
		this.setState({ kind: 'starting' });

		let child: ChildProcessWithoutNullStreams;
		try {
			child = this.spawn(this.options.command(), this.options.cwd);
		} catch (err) {
			this.setState({ kind: 'failed', reason: 'agent-exited', exitCode: null, message: String(err) });
			return;
		}

		let stderrTail = '';
		let pending = '';
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			stderrTail = (stderrTail + chunk).slice(-2_000);
			const lines = (pending + chunk).split(/\r?\n/);
			pending = lines.pop() ?? '';
			for (const line of lines) {
				this.onStderrEmitter.fire(line);
			}
		});

		let exited = false;
		const onExit = (exitCode: number | null, error?: Error) => {
			if (exited) {
				return;
			}
			exited = true;
			if (pending) {
				this.onStderrEmitter.fire(pending);
			}
			const state = this._state;
			if (state.kind !== 'running' || state.process !== child) {
				return; // stopped or replaced on purpose
			}
			this.clearTimers();
			const fatal = exitCode === null ? undefined : FATAL_EXIT_CODES.get(exitCode);
			const message = error?.message ?? (stderrTail.trim().split(/\r?\n/).pop() || `Agent exited with code ${exitCode}`);
			if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
				this.setState({ kind: 'failed', reason: 'agent-not-found', exitCode, message });
			} else if (fatal) {
				this.setState({ kind: 'failed', reason: fatal, exitCode, message });
			} else if (this.restarts < this.restartDelaysMs.length) {
				const delayMs = this.restartDelaysMs[this.restarts++];
				this.setState({ kind: 'restarting', attempt: this.restarts, delayMs, exitCode });
				this.restartTimer = setTimeout(() => this.launch(), delayMs);
			} else {
				this.setState({ kind: 'failed', reason: 'agent-exited', exitCode, message });
			}
		};
		child.once('exit', code => onExit(code));
		child.once('error', err => onExit(null, err));

		this.setState({ kind: 'running', process: child });
		this.healthyTimer = setTimeout(() => this.restarts = 0, this.healthyAfterMs);
	}

	private clearTimers(): void {
		clearTimeout(this.restartTimer);
		clearTimeout(this.healthyTimer);
		this.restartTimer = this.healthyTimer = undefined;
	}

	private setState(state: SidecarState): void {
		this._state = state;
		this.onDidChangeStateEmitter.fire(state);
	}
}
