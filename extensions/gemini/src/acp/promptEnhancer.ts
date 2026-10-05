/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Prompt enhancement: rewrites a chat draft into a precise prompt. It is one
// direct request to a fast model, as inline edit makes, when those are on and
// the sign-in allows them: about 1 KB, against the 47 KB of agent prompt and
// tools a request through the CLI carries (FINDINGS.md). Otherwise, or when the
// direct request fails, the Gemini CLI makes the call, in a session of its own
// on the agent process every chat shares. Each such rewrite gets a fresh
// session, so earlier rewrites never leak into it, in an empty folder, so the
// CLI adds no folder context and the sessions stay out of the project's chat
// history. Plan mode keeps the agent from changing anything.

import { promises as fs } from 'node:fs';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentConnection } from './agentConnection';
import type { AgentRuntime, AgentRuntimeState } from './agentRuntime';
import type { TranscriptItem } from './chatTranscript';
import { AgentError, classifyAgentError } from './errors';
import { cleanEnhancedPrompt, enhancePromptPrompt, type EnhancePromptInput } from './quickPrompts';
import { readSessionSettings, type SessionSelector } from './sessionSettings';

export interface PromptEnhancerOptions {
	/** An empty folder for the rewrite sessions. */
	readonly cwd: string;
	/** Starts the agent when it is not running; a rewrite then waits for it. */
	readonly start?: () => void;
	/** How long a rewrite may take; the CLI waits out rate limits itself. */
	readonly timeoutMs?: number;
	/**
	 * Sends the rewrite as a direct request; resolves undefined when direct
	 * requests are off or cannot use the sign-in, and the CLI makes it instead.
	 */
	readonly direct?: (request: DirectEnhanceRequest) => Promise<string | undefined>;
	/** How long the direct request may take before the CLI is asked instead. */
	readonly directTimeoutMs?: number;
	/** Called with how long each rewrite took, and on which model or route. */
	readonly onDidEnhance?: (info: { readonly ms: number; readonly model: string | undefined }) => void;
	/** Called when the direct request failed and the CLI makes the rewrite instead. */
	readonly onDirectFailed?: (error: unknown) => void;
}

export interface DirectEnhanceRequest {
	readonly system: string;
	readonly prompt: string;
	readonly temperature: number;
	readonly signal: AbortSignal;
}

/** The user cancelled the rewrite. */
export class EnhanceCancelledError extends Error {
	constructor() {
		super('Prompt enhancement was cancelled.');
		this.name = 'EnhanceCancelledError';
	}
}

/** A session opened, put in Plan mode and on the fast model, waiting for its one prompt. */
interface ReadySession {
	readonly connection: AgentConnection;
	readonly sessionId: string;
	readonly model: string | undefined;
	readonly canClose: boolean;
	/**
	 * Where the agent's reply goes, while `collecting`: gemini-cli also sends
	 * message chunks outside a turn, such as "[MODE_UPDATE] plan" when the mode
	 * is set. The registration stays for the session's life so no update is
	 * queued unread.
	 */
	readonly reply: { text: string; collecting: boolean };
	readonly registration: { dispose(): void };
}

const defaultTimeoutMs = 60_000;
/** Direct rewrites took 2.4 to 4.8 s, and up to 7.3 s in a burst of five (FINDINGS.md). */
const defaultDirectTimeoutMs = 15_000;
/** After a direct request fails, how long rewrites skip it. */
const directRetryAfterMs = 5 * 60_000;
/** How many of the chat's latest messages a rewrite sees, so "the same" or "it" can be resolved. */
const historyMessages = 6;

/** The chat's latest messages from the user and the agent, oldest first. */
export function enhanceHistory(items: readonly TranscriptItem[]): NonNullable<EnhancePromptInput['history']> {
	const messages: { role: 'user' | 'agent'; text: string }[] = [];
	for (let i = items.length - 1; i >= 0 && messages.length < historyMessages; i--) {
		const item = items[i];
		if ((item.kind === 'user' || item.kind === 'agent') && item.text.trim()) {
			messages.unshift({ role: item.kind, text: item.text });
		}
	}
	return messages;
}

/**
 * The model to rewrite with: the first Flash-Lite model the agent offers, else
 * the first Flash model, else the session's own. Rewrites are short, so the
 * lightest model is fastest and its quality is enough (FINDINGS.md).
 */
export function enhanceModel(model: SessionSelector | undefined): string | undefined {
	const matching = (pattern: RegExp) => model?.available.find(choice => pattern.test(choice.id))?.id;
	return matching(/flash-lite/i) ?? matching(/flash/i);
}

export class PromptEnhancer {

	/** The next rewrite's session, opened ahead so a click only waits for the model. */
	private spare: Promise<ReadySession> | undefined;
	private disposed = false;
	/** Whether the last direct request worked; while it does, no spare session is opened. */
	private directWorks = true;
	/** When a direct request last failed; for a while after, rewrites go straight to the CLI. */
	private directFailedAt = -Infinity;
	private folderReady: Promise<unknown> | undefined;
	private readonly runtimeListener: { dispose(): void };

	constructor(private readonly runtime: AgentRuntime, private readonly options: PromptEnhancerOptions) {
		// A spare session belongs to the process that opened it.
		this.runtimeListener = runtime.onDidChangeState(() => this.dropSpare());
	}

	/** Opens the next rewrite's session now, when the agent is ready and none is waiting. */
	prepare(): void {
		if (this.spare || this.disposed || this.runtime.state.kind !== 'ready' || (this.options.direct && this.directWorks)) {
			return;
		}
		const spare = this.open();
		this.spare = spare;
		spare.catch(() => {
			if (this.spare === spare) {
				this.spare = undefined;
			}
		});
	}

	/**
	 * The draft rewritten as a precise prompt. Rejects with
	 * {@link EnhanceCancelledError} when `signal` aborts, and with an error
	 * whose message can be shown when the agent fails or takes too long.
	 */
	async enhance(input: EnhancePromptInput, signal?: AbortSignal): Promise<string> {
		const started = Date.now();
		const { system, prompt } = enhancePromptPrompt(input);
		const direct = await this.tryDirect(system, prompt, signal);
		if (direct !== undefined) {
			this.options.onDidEnhance?.({ ms: Date.now() - started, model: 'a direct request' });
			return cleanEnhancedPrompt(direct, input.draft);
		}
		// Before taking the spare, so a rewrite cancelled while the agent starts leaves it for the next.
		await abortable(this.whenReady(), signal);
		const pending = this.spare ?? this.open();
		this.spare = undefined;
		let session: ReadySession | undefined;
		try {
			session = await abortable(pending, signal);
			session.reply.collecting = true;
			const turn = session.connection.prompt(session.sessionId, [{ type: 'text', text: `${system}\n\n${prompt}` }]);
			try {
				await abortable(withTimeout(turn, this.options.timeoutMs ?? defaultTimeoutMs), signal);
			} catch (err) {
				void session.connection.cancel(session.sessionId).catch(() => undefined);
				throw err;
			}
			const reply = session.reply.text;
			if (!reply.trim()) {
				throw new Error('Gemini sent back no prompt. Try again.');
			}
			this.options.onDidEnhance?.({ ms: Date.now() - started, model: session.model });
			return cleanEnhancedPrompt(reply, input.draft);
		} catch (err) {
			if (err instanceof EnhanceCancelledError || err instanceof TimeoutError) {
				throw err;
			}
			throw new Error(classifyAgentError(err).message);
		} finally {
			if (session) {
				this.release(session);
			} else {
				// Cancelled while the session was opening: free it once it has.
				pending.then(opened => this.release(opened), () => undefined);
			}
			this.prepare();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.runtimeListener.dispose();
		this.dropSpare();
	}

	private dropSpare(): void {
		const spare = this.spare;
		this.spare = undefined;
		spare?.then(session => this.release(session), () => undefined);
	}

	/** The direct request's reply, or undefined when the CLI should make the rewrite. */
	private async tryDirect(system: string, prompt: string, signal: AbortSignal | undefined): Promise<string | undefined> {
		if (!this.options.direct || Date.now() - this.directFailedAt < directRetryAfterMs) {
			return undefined;
		}
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		signal?.addEventListener('abort', onAbort, { once: true });
		const timer = setTimeout(() => abort.abort(), this.options.directTimeoutMs ?? defaultDirectTimeoutMs);
		try {
			const reply = await abortable(this.options.direct({ system, prompt, temperature: 0.3, signal: abort.signal }), signal);
			if (reply === undefined) {
				this.directWorks = false;
				return undefined;
			}
			if (!reply.trim()) {
				throw new Error('Gemini sent back no prompt.');
			}
			this.directWorks = true;
			return reply;
		} catch (err) {
			if (signal?.aborted) {
				throw new EnhanceCancelledError();
			}
			this.directWorks = false;
			this.directFailedAt = Date.now();
			this.options.onDirectFailed?.(err);
			return undefined;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
		}
	}

	/** Resolves once the agent process is ready, starting it if it is not running; not the chat's own session. */
	private whenReady(): Promise<void> {
		if (this.runtime.state.kind === 'idle') {
			this.options.start?.();
		}
		const failed = (state: AgentRuntimeState) => state.kind === 'error' ? new AgentError(state.error) : new Error('The Gemini agent is not running.');
		const state = this.runtime.state;
		if (state.kind === 'ready') {
			return Promise.resolve();
		}
		if (state.kind !== 'connecting') {
			return Promise.reject(failed(state));
		}
		return new Promise((resolve, reject) => {
			const listener = this.runtime.onDidChangeState(next => {
				if (next.kind !== 'connecting') {
					listener.dispose();
					if (next.kind === 'ready') {
						resolve();
					} else {
						reject(failed(next));
					}
				}
			});
		});
	}

	private async open(): Promise<ReadySession> {
		this.folderReady ??= fs.mkdir(this.options.cwd, { recursive: true }).catch(err => {
			this.folderReady = undefined;
			throw err;
		});
		await this.folderReady;
		const { connection, agent, session } = await this.runtime.newSession(this.options.cwd);
		const reply = { text: '', collecting: false };
		const registration = this.runtime.register(session.sessionId, {
			sessionUpdate: (update: acp.SessionUpdate) => {
				if (reply.collecting && update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
					reply.text += update.content.text;
				}
			},
			// Plan mode should never ask; refuse anything that does.
			requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
		});
		const canClose = !!agent.agentCapabilities?.sessionCapabilities?.close;
		try {
			const settings = readSessionSettings(session);
			if (settings.mode && settings.mode.currentId !== 'plan' && settings.mode.available.some(choice => choice.id === 'plan')) {
				await connection.setMode(session.sessionId, 'plan');
			}
			const model = enhanceModel(settings.model);
			if (model && model !== settings.model?.currentId) {
				await connection.setModel(session.sessionId, model);
			}
			return { connection, sessionId: session.sessionId, model: model ?? settings.model?.currentId, canClose, reply, registration };
		} catch (err) {
			this.release({ connection, sessionId: session.sessionId, model: undefined, canClose, reply, registration });
			throw err;
		}
	}

	/** Stops listening to a used or unused session, and frees it when the agent can. */
	private release(session: ReadySession): void {
		session.registration.dispose();
		if (session.canClose) {
			void session.connection.close(session.sessionId).catch(() => undefined);
		}
	}
}

class TimeoutError extends Error {
	constructor(ms: number) {
		super(`Gemini took longer than ${Math.round(ms / 1000)} seconds, usually because it is rate-limited. Try again in a minute.`);
		this.name = 'TimeoutError';
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => timer = setTimeout(() => reject(new TimeoutError(ms)), ms));
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** `promise`, or {@link EnhanceCancelledError} as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		return Promise.reject(new EnhanceCancelledError());
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new EnhanceCancelledError());
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
}
