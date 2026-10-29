/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The extension host's side of the indexer process. The process starts on
// the first request, never at activation, with the app's own Node at the
// lowest priority it sets itself; it is started again after a crash (with a
// growing delay, giving up after a few, then trying once more ten minutes
// later), and stopped after ten minutes with nothing to do. The host only forwards requests: every file read, parse and
// database write happens in the process.

import { fork, type ChildProcess } from 'node:child_process';
import { Emitter } from '../events';
import type { HostMessage, IndexerMessage, IndexerMethod, IndexerParams, IndexerResult, IndexStatus } from './indexerProtocol';

export interface IndexClientOptions {
	/** The indexer's entry point: `indexer.js` beside `extension.js`. */
	readonly script: string;
	readonly execPath: string;
	/** Where indexes live: ~/.geminicode/index. */
	readonly baseDir: string;
	/** The app's ripgrep, for searching folders whose index isn't built yet. */
	readonly ripgrep?: string | Promise<string | undefined>;
	readonly log: (message: string) => void;
	readonly idleStopMs?: number;
	readonly restartDelaysMs?: readonly number[];
	/** After giving up, how long before the process may start again. */
	readonly cooldownMs?: number;
	readonly fork?: typeof fork;
	readonly now?: () => number;
}

const defaultIdleStopMs = 10 * 60 * 1000;
const defaultRestartDelaysMs = [1_000, 4_000, 16_000];
const defaultCooldownMs = 10 * 60 * 1000;
/** A process that ran this long resets the crash count. */
const healthyAfterMs = 5 * 60 * 1000;
const heapMb = 512;

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

export class IndexClient {

	private readonly onDidChangeStatusEmitter = new Emitter<IndexStatus>();
	readonly onDidChangeStatus = this.onDidChangeStatusEmitter.event;
	/** The process (re)started; folders it should know about need `ensure` again. */
	private readonly onDidStartEmitter = new Emitter<void>();
	readonly onDidStart = this.onDidStartEmitter.event;
	/** `failed` changed: the process gave up, or its cooldown ended. */
	private readonly onDidChangeFailedEmitter = new Emitter<boolean>();
	readonly onDidChangeFailed = this.onDidChangeFailedEmitter.event;

	private child: ChildProcess | undefined;
	private starting: Promise<ChildProcess> | undefined;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private workerIdle = true;
	private lastRequestAt = 0;
	private idleTimer: ReturnType<typeof setInterval> | undefined;
	private crashes = 0;
	private startedAt = 0;
	private notBefore = 0;
	/** When the process gave up after crashing again and again; 0 while it hasn't. */
	private stoppedAt = 0;
	private cooldownTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	/** The process is being stopped on purpose, so its exit is no crash. */
	private expectedExit = false;

	private readonly now: () => number;

	constructor(private readonly options: IndexClientOptions) {
		this.now = options.now ?? Date.now;
	}

	/** Whether the process is running now. */
	get running(): boolean {
		return !!this.child;
	}

	/**
	 * Whether the process gave up after crashing again and again: until its
	 * cooldown ends, sessions get neither the index tools nor the hint.
	 */
	get failed(): boolean {
		return this.stoppedAt > 0 && this.now() - this.stoppedAt < this.cooldownMs;
	}

	private get cooldownMs(): number {
		return this.options.cooldownMs ?? defaultCooldownMs;
	}

	async request<M extends IndexerMethod>(method: M, params: IndexerParams<M>): Promise<Awaited<IndexerResult<M>>> {
		if (this.disposed) {
			throw new Error('The indexer has stopped.');
		}
		if (this.failed) {
			throw new Error('The indexer stopped after crashing several times. The Gemini log has the details.');
		}
		if (this.stoppedAt) {
			// The cooldown is over: try again from scratch.
			this.stoppedAt = 0;
			this.crashes = 0;
		}
		const wait = this.notBefore - this.now();
		if (!this.child && wait > 0) {
			await new Promise(resolve => setTimeout(resolve, wait));
		}
		const child = this.child ?? await (this.starting ??= this.start().finally(() => this.starting = undefined));
		this.lastRequestAt = this.now();
		const id = this.nextId++;
		return new Promise<Awaited<IndexerResult<M>>>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			child.send({ id, method, params } satisfies HostMessage, err => {
				if (err) {
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	/** Like `request`, for messages whose answer doesn't matter (file changes); failures are logged. */
	notify<M extends IndexerMethod>(method: M, params: IndexerParams<M>): void {
		this.request(method, params).catch(err => this.options.log(`Indexer ${method} failed: ${err instanceof Error ? err.message : String(err)}`));
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.cooldownTimer);
		this.stop();
		this.onDidChangeStatusEmitter.dispose();
		this.onDidStartEmitter.dispose();
		this.onDidChangeFailedEmitter.dispose();
	}

	private async start(): Promise<ChildProcess> {
		const ripgrep = await this.options.ripgrep;
		const child = (this.options.fork ?? fork)(this.options.script, [], {
			execPath: this.options.execPath,
			execArgv: [`--max-old-space-size=${heapMb}`, '--disable-warning=ExperimentalWarning'],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GEMINICODE_INDEX_DIR: this.options.baseDir, GEMINICODE_RIPGREP: ripgrep ?? '' },
			stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
			serialization: 'advanced',
		});
		this.child = child;
		this.startedAt = this.now();
		this.workerIdle = true;
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (text: string) => this.options.log(`Indexer: ${text.trim()}`));
		child.on('message', message => this.receive(message as IndexerMessage));
		child.once('exit', (code, signal) => this.exited(child, code, signal));
		child.once('error', err => this.options.log(`Indexer failed to start: ${err.message}`));
		this.idleTimer ??= setInterval(() => this.stopIfIdle(), 60_000);
		this.idleTimer.unref?.();
		queueMicrotask(() => this.onDidStartEmitter.fire());
		return child;
	}

	private receive(message: IndexerMessage): void {
		if (message.kind === 'answer') {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error !== undefined) {
				pending?.reject(new Error(message.error));
			} else {
				pending?.resolve(message.result);
			}
			return;
		}
		switch (message.event) {
			case 'status':
				this.onDidChangeStatusEmitter.fire(message.status);
				break;
			case 'idle':
				this.workerIdle = message.idle;
				break;
			case 'log':
				this.options.log(`Indexer: ${message.message}`);
				break;
		}
	}

	private exited(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
		if (this.child !== child) {
			return;
		}
		this.child = undefined;
		for (const pending of this.pending.values()) {
			pending.reject(new Error('The indexer stopped while answering.'));
		}
		this.pending.clear();
		if (this.disposed || this.expectedExit) {
			this.expectedExit = false;
			return;
		}
		this.options.log(`Indexer exited (code ${code}, signal ${signal}).`);
		if (this.now() - this.startedAt > healthyAfterMs) {
			this.crashes = 0;
		}
		const delays = this.options.restartDelaysMs ?? defaultRestartDelaysMs;
		if (this.crashes >= delays.length) {
			this.stoppedAt = this.now();
			this.options.log(`The indexer crashed ${this.crashes + 1} times; sessions go without the index for ${Math.round(this.cooldownMs / 60_000)} minutes.`);
			this.onDidChangeFailedEmitter.fire(true);
			clearTimeout(this.cooldownTimer);
			this.cooldownTimer = setTimeout(() => {
				this.cooldownTimer = undefined;
				if (!this.disposed) {
					this.onDidChangeFailedEmitter.fire(false);
				}
			}, this.cooldownMs);
			this.cooldownTimer.unref?.();
			return;
		}
		this.notBefore = this.now() + delays[this.crashes++];
	}

	private stopIfIdle(): void {
		if (this.child && this.workerIdle && !this.pending.size && this.now() - this.lastRequestAt > (this.options.idleStopMs ?? defaultIdleStopMs)) {
			this.stop();
		}
	}

	private stop(): void {
		clearInterval(this.idleTimer);
		this.idleTimer = undefined;
		const child = this.child;
		if (child) {
			this.expectedExit = true;
			child.kill('SIGTERM');
		}
	}
}
