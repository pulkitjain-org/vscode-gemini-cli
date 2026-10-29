/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AgentCommand, spawnAgent } from './agentProcess';
import { AgentErrorKind, FATAL_EXIT_CODES } from './errors';
import { Emitter } from './events';

/** The exit code the CLI uses to ask its parent wrapper to start it again. */
export const RELAUNCH_EXIT_CODE = 199;
const maxRelaunches = 3;

export type SidecarState =
	| { readonly kind: 'stopped' }
	| { readonly kind: 'starting' }
	| { readonly kind: 'running'; readonly process: ChildProcessWithoutNullStreams }
	| { readonly kind: 'restarting'; readonly attempt: number; readonly delayMs: number; readonly exitCode: number | null }
	| { readonly kind: 'failed'; readonly reason: AgentErrorKind; readonly exitCode: number | null; readonly message: string };

export interface SidecarOptions {
	/** Re-read on every (re)start so setting changes apply; it may read files, so it can be async. */
	readonly command: () => AgentCommand | Promise<AgentCommand>;
	readonly cwd: string | undefined;
	/** Delays before successive automatic restarts; their count bounds the restarts. */
	readonly restartDelaysMs?: readonly number[];
	/** A process that stays up this long resets the restart count. */
	readonly healthyAfterMs?: number;
	readonly spawn?: typeof spawnAgent;
}

const defaultRestartDelaysMs = [1_000, 4_000, 15_000];
/** How long a stopped CLI gets to exit on SIGTERM before it is killed. */
const killAfterMs = 3_000;
/** The longest stderr line kept while waiting for its end. */
const maxStderrLine = 64 * 1024;

/**
 * Ends the CLI. On Windows a `.cmd` shim runs it under cmd.exe, which `kill`
 * alone would end without the CLI, so the whole tree goes. Elsewhere a CLI
 * that ignores SIGTERM, for example while a shell tool runs, is killed.
 */
function stopProcess(child: ChildProcessWithoutNullStreams): void {
	if (process.platform === 'win32' && child.pid) {
		try {
			spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
			return;
		} catch {
			// Fall through to kill.
		}
	}
	child.kill();
	if (child.exitCode === null && child.signalCode === null) {
		const timer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
		timer.unref?.();
		child.once('exit', () => clearTimeout(timer));
	}
}

/**
 * Agent processes still running. The CLI ends when its stdin closes, which
 * happens when this process dies however it dies; on an ordinary exit, such
 * as the extension host shutting down without disposing the sidecar, they
 * are also killed here, since exit handlers can only run synchronous code.
 */
const running = new Set<ChildProcessWithoutNullStreams>();
let killOnExit = false;

function track(child: ChildProcessWithoutNullStreams): void {
	running.add(child);
	child.once('exit', () => running.delete(child));
	if (!killOnExit) {
		killOnExit = true;
		process.once('exit', () => {
			for (const agent of running) {
				agent.kill('SIGKILL');
			}
		});
	}
}

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
	/** Immediate relaunches the CLI asked for (exit code 199) since the agent last ran healthy. */
	private relaunches = 0;
	private restartTimer: ReturnType<typeof setTimeout> | undefined;
	private healthyTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly restartDelaysMs: readonly number[];
	private readonly healthyAfterMs: number;
	private readonly spawn: typeof spawnAgent;
	/** Bumped by every launch and stop, so a launch whose command arrives late does nothing. */
	private launches = 0;

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
		this.relaunches = 0;
		this.launch();
	}

	stop(): void {
		this.launches++;
		this.clearTimers();
		const current = this._state;
		this.setState({ kind: 'stopped' });
		if (current.kind === 'running') {
			stopProcess(current.process);
		}
	}

	dispose(): void {
		this.stop();
		this.onDidChangeStateEmitter.dispose();
		this.onStderrEmitter.dispose();
	}

	/**
	 * Ends `child` when it is the running process, as a crash would: the
	 * sidecar restarts it with backoff. For a process that still runs but can
	 * no longer be talked to.
	 */
	endProcess(child: ChildProcessWithoutNullStreams): void {
		const state = this._state;
		if (state.kind === 'running' && state.process === child) {
			stopProcess(child);
		}
	}

	private launch(): void {
		this.clearTimers();
		const previous = this._state;
		if (previous.kind === 'running') {
			// Mark stopped first so the old process's exit is not treated as a crash.
			this.setState({ kind: 'stopped' });
			stopProcess(previous.process);
		}
		this.setState({ kind: 'starting' });
		const launch = ++this.launches;
		void (async () => this.options.command())().then(
			command => launch === this.launches && this.run(command),
			err => launch === this.launches && this.setState({ kind: 'failed', reason: 'agent-exited', exitCode: null, message: String(err) }));
	}

	private run(command: AgentCommand): void {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = this.spawn(command, this.options.cwd);
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
			if (pending.length > maxStderrLine) {
				// Output with no line ends, such as a progress bar: pass it on in pieces.
				lines.push(pending);
				pending = '';
			}
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
			if (exitCode === RELAUNCH_EXIT_CODE && this.relaunches < maxRelaunches) {
				// The CLI asks its parent to start it again (for example after a
				// settings change). We run it without that parent wrapper
				// (GEMINI_CLI_NO_RELAUNCH), so do what the wrapper would: start it now.
				this.relaunches++;
				this.setState({ kind: 'restarting', attempt: this.restarts, delayMs: 0, exitCode });
				this.launch();
			} else if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
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
		track(child);

		this.setState({ kind: 'running', process: child });
		this.healthyTimer = setTimeout(() => this.restarts = this.relaunches = 0, this.healthyAfterMs);
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
