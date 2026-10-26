/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Prompt enhancement: rewrites a chat draft into a precise prompt. It is one
// direct request to a fast model, as inline edit makes, when those are on and
// the sign-in allows them: about 1 KB, against the 12,000 tokens of agent
// prompt and tools a request through the CLI carries (FINDINGS.md). Otherwise,
// when the direct request fails, or while it is slow (the CLI then starts
// alongside, and the first answer wins), the Gemini CLI makes the call, in a session
// of its own on the agent process every chat shares. Each such rewrite gets a
// fresh session, so earlier rewrites never leak into it, in an empty folder, so
// the CLI adds no folder context and the sessions stay out of the project's
// chat history. Plan mode keeps the agent from changing anything.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentConnection } from './agentConnection';
import type { AgentRuntime, AgentRuntimeState } from './agentRuntime';
import type { TranscriptItem } from './chatTranscript';
import { AgentError, classifyAgentError } from './errors';
import { cleanEnhancedPrompt, enhancePromptPrompt, partialEnhancedPrompt, type EnhancePromptInput } from './quickPrompts';
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
	/** How long the direct request may take; the CLI makes the rewrite after it. */
	readonly directTimeoutMs?: number;
	/** How long the direct request runs alone before the CLI starts the rewrite too; the first answer wins. */
	readonly hedgeAfterMs?: number;
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
	/** Streams the rewrite: called with the text so far as it arrives. */
	readonly onText?: (text: string) => void;
}

/** The user cancelled the rewrite. */
export class EnhanceCancelledError extends Error {
	constructor() {
		super('Prompt enhancement was cancelled.');
		this.name = 'EnhanceCancelledError';
	}
}

/** A rewrite, and the model or route that made it. */
interface Answer {
	readonly text: string;
	readonly model: string | undefined;
}

/** Which way a rewrite is made: a direct request, or a session on the CLI. */
type Route = 'direct' | 'cli';

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
	readonly reply: { text: string; collecting: boolean; onText?: (text: string) => void };
	readonly registration: { dispose(): void };
}

const defaultTimeoutMs = 60_000;
/** Direct rewrites took 2.5 to 4.7 s, and up to 6.2 s in a burst of five (FINDINGS.md). */
const defaultDirectTimeoutMs = 15_000;
/**
 * How long the direct request runs alone before the CLI starts the rewrite
 * too. Direct rewrites usually answer in 2.5 to 4.7 s; past that, waiting out
 * the 15 s cap and then starting the CLI took up to 24 s in all.
 */
const defaultHedgeAfterMs = 4_000;
/** The model `onDidEnhance` names for a direct rewrite. */
const directModel = 'a direct request';
/** What `Promise.race` resolves with once the direct request has run for {@link defaultHedgeAfterMs}. */
const hedged = Symbol('hedged');
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

/** The open file as a rewrite is told of it, `src/cart.ts (typescript)`; undefined outside the agent's folder `cwd`. */
export function activeFileLabel(cwd: string, filePath: string, languageId: string): string | undefined {
	const relative = path.relative(cwd, filePath);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? `${relative.split(path.sep).join('/')} (${languageId})` : undefined;
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
	 * `onText` is called with the rewrite so far as it arrives, tidied for
	 * showing, from one route at a time; it starts again from nothing if the
	 * CLI takes over.
	 *
	 * A direct request that has not answered after a few seconds is not waited
	 * out: the CLI starts the rewrite too, the first answer is used, and the
	 * other route is stopped (`session/cancel` for the CLI's turn).
	 */
	async enhance(input: EnhancePromptInput, signal?: AbortSignal, onText?: (text: string) => void): Promise<string> {
		const started = Date.now();
		const { system, prompt } = enhancePromptPrompt(input);
		const view = new StreamView(onText);
		const finish = (answer: Answer) => {
			this.options.onDidEnhance?.({ ms: Date.now() - started, model: answer.model });
			return cleanEnhancedPrompt(answer.text, input.draft);
		};
		if (!this.directAllowed()) {
			return finish(await this.viaCli(system, prompt, signal, view.sink('cli')));
		}
		const stopDirect = new AbortController();
		const direct = this.tryDirect(system, prompt, signal, stopDirect.signal, view.sink('direct'));
		let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
		const hedge = new Promise<typeof hedged>(resolve => hedgeTimer = setTimeout(() => resolve(hedged), this.options.hedgeAfterMs ?? defaultHedgeAfterMs));
		let first: string | undefined | typeof hedged;
		try {
			first = await Promise.race([direct, hedge]);
		} finally {
			clearTimeout(hedgeTimer);
		}
		if (first !== hedged) {
			if (first !== undefined) {
				return finish({ text: first, model: directModel });
			}
			view.drop('direct');
			return finish(await this.viaCli(system, prompt, signal, view.sink('cli')));
		}
		// The direct request is slow: the CLI starts the rewrite too, and the first answer wins.
		const stopCli = new AbortController();
		const cli = this.viaCli(system, prompt, signal ? AbortSignal.any([signal, stopCli.signal]) : stopCli.signal, view.sink('cli'));
		cli.catch(() => view.drop('cli'));
		const directAnswer = direct.then(text => {
			if (text === undefined) {
				view.drop('direct');
				throw new Error('The direct request did not answer.');
			}
			return { text, model: directModel };
		});
		let answer: Answer;
		try {
			answer = await Promise.any([directAnswer, cli]);
		} catch (err) {
			if (signal?.aborted) {
				throw new EnhanceCancelledError();
			}
			// Both failed: the CLI's error says why, as it did when the CLI only ran after the direct request.
			throw err instanceof AggregateError ? err.errors[1] : err;
		}
		if (answer.model === directModel) {
			view.drop('cli');
			stopCli.abort();
		} else {
			view.drop('direct');
			stopDirect.abort();
		}
		return finish(answer);
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

	/** Whether this rewrite may try a direct request: they are on, and none failed lately. */
	private directAllowed(): boolean {
		return !!this.options.direct && Date.now() - this.directFailedAt >= directRetryAfterMs;
	}

	/**
	 * The direct request's reply, or undefined when the CLI should make the
	 * rewrite. `stop` ends it when the CLI answered first; that is not a failure.
	 */
	private async tryDirect(system: string, prompt: string, signal: AbortSignal | undefined, stop: AbortSignal, onText: ((text: string) => void) | undefined): Promise<string | undefined> {
		const direct = this.options.direct;
		if (!direct) {
			return undefined;
		}
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		signal?.addEventListener('abort', onAbort, { once: true });
		stop.addEventListener('abort', onAbort, { once: true });
		const timer = setTimeout(() => abort.abort(), this.options.directTimeoutMs ?? defaultDirectTimeoutMs);
		try {
			const reply = await abortable(direct({ system, prompt, temperature: 0.3, signal: abort.signal, ...(onText ? { onText } : {}) }), signal);
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
			if (stop.aborted) {
				return undefined;
			}
			this.directWorks = false;
			this.directFailedAt = Date.now();
			this.options.onDirectFailed?.(err);
			return undefined;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			stop.removeEventListener('abort', onAbort);
		}
	}

	/** The rewrite from the CLI, in a session of its own; its turn is cancelled when `signal` aborts. */
	private async viaCli(system: string, prompt: string, signal: AbortSignal | undefined, onText: ((text: string) => void) | undefined): Promise<Answer> {
		// Before taking the spare, so a rewrite cancelled while the agent starts leaves it for the next.
		await abortable(this.whenReady(), signal);
		const pending = this.spare ?? this.open();
		this.spare = undefined;
		let session: ReadySession | undefined;
		try {
			session = await abortable(pending, signal);
			session.reply.collecting = true;
			session.reply.onText = onText;
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
			return { text: reply, model: session.model };
		} catch (err) {
			if (err instanceof EnhanceCancelledError || err instanceof TimeoutError) {
				throw err;
			}
			throw new Error(classifyAgentError(err).message);
		} finally {
			if (session) {
				// No more of the reply is shown once this route is done, won or lost.
				session.reply.collecting = false;
				session.reply.onText = undefined;
				this.release(session);
			} else {
				// Cancelled while the session was opening: free it once it has.
				pending.then(opened => this.release(opened), () => undefined);
			}
			this.prepare();
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
		const reply: ReadySession['reply'] = { text: '', collecting: false };
		const registration = this.runtime.register(session.sessionId, {
			sessionUpdate: (update: acp.SessionUpdate) => {
				if (reply.collecting && update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
					reply.text += update.content.text;
					reply.onText?.(reply.text);
				}
			},
			// Plan mode should never ask; refuse anything that does.
			requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
		});
		const canClose = !!agent.agentCapabilities?.sessionCapabilities?.close;
		try {
			const settings = readSessionSettings(session);
			const model = enhanceModel(settings.model);
			// Both at once: two round trips before the rewrite would be one too many.
			await Promise.all([
				settings.mode && settings.mode.currentId !== 'plan' && settings.mode.available.some(choice => choice.id === 'plan') ? connection.setMode(session.sessionId, 'plan') : undefined,
				model && model !== settings.model?.currentId ? connection.setModel(session.sessionId, model) : undefined,
			]);
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

/**
 * Shows the streamed text of one route at a time: the first to stream keeps
 * the view until it is dropped (it failed, or the other answered first), and
 * then the other route's text so far is shown.
 */
class StreamView {

	private shown: Route | undefined;
	private readonly latest = new Map<Route, string>();
	private readonly dropped = new Set<Route>();

	constructor(private readonly show: ((text: string) => void) | undefined) { }

	/** Where `route` streams its raw text, or undefined when nothing is shown. */
	sink(route: Route): ((text: string) => void) | undefined {
		const show = this.show;
		if (!show) {
			return undefined;
		}
		return text => {
			if (this.dropped.has(route)) {
				return;
			}
			this.latest.set(route, text);
			this.shown ??= route;
			if (this.shown === route) {
				show(partialEnhancedPrompt(text));
			}
		};
	}

	drop(route: Route): void {
		this.dropped.add(route);
		if (this.shown !== route) {
			return;
		}
		this.shown = undefined;
		const other: Route = route === 'direct' ? 'cli' : 'direct';
		const text = this.latest.get(other);
		if (text !== undefined && !this.dropped.has(other)) {
			this.shown = other;
			this.show?.(partialEnhancedPrompt(text));
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
