/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The CLI wraps every `authenticate` and `session/new` failure as a JSON-RPC
// error -32000 with a message string, so typed errors never reach us.
// This table maps the known message strings to kinds. Every pattern is copied
// from the CLI source of the version in `since`, and each one has a fixture in
// test/fixtures/agentErrors.json that Compat CI runs against new CLI versions.
// An unknown message falls back to `unknown` and is shown as is.

export type AgentErrorKind =
	/** No auth type selected yet, or an API key is expected: call `authenticate`. */
	| 'auth-required'
	/** The OAuth login itself failed; it has to be completed in a terminal. */
	| 'auth-failed'
	/** The account needs GOOGLE_CLOUD_PROJECT set. */
	| 'project-id-required'
	/** GOOGLE_CLOUD_PROJECT holds a project number instead of a project ID. */
	| 'project-id-numeric'
	/** The CLI executable was not found. */
	| 'agent-not-found'
	/** The agent process exited before answering. */
	| 'agent-exited'
	/** Auto Edit or YOLO was refused because the CLI does not trust the folder yet. */
	| 'untrusted-folder'
	/** The CLI could not reach Google: no connection, a VPN or proxy in the way, or a certificate it does not trust. */
	| 'network'
	/** The agent did not answer a setup request (`initialize`, `session/new`, ...) in time. */
	| 'timeout'
	/** The connection to the agent closed under a running request, as when it restarts. */
	| 'agent-restarted'
	| 'unknown';

export interface AgentErrorInfo {
	readonly kind: AgentErrorKind;
	/** The agent's own message, shown to the user when nothing better is known. */
	readonly message: string;
	readonly code?: number;
}

interface ErrorPattern {
	readonly kind: AgentErrorKind;
	readonly pattern: RegExp;
	/** First CLI version known to send this text. */
	readonly since: string;
}

export const AGENT_ERROR_PATTERNS: readonly ErrorPattern[] = [
	{ kind: 'auth-required', pattern: /^Authentication required\.?$/i, since: '0.61.0' },
	{ kind: 'auth-required', pattern: /^Gemini API key is missing or not configured\.?$/i, since: '0.61.0' },
	{ kind: 'project-id-required', pattern: /requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var/i, since: '0.61.0' },
	{ kind: 'project-id-numeric', pattern: /^Invalid Google Cloud Project ID: ".*"\. The GOOGLE_CLOUD_PROJECT/i, since: '0.61.0' },
	{ kind: 'auth-failed', pattern: /^Failed to authenticate with (user|authorization) code/i, since: '0.61.0' },
	{ kind: 'untrusted-folder', pattern: /^Cannot enable privileged approval modes in an untrusted folder\.?$/i, since: '0.62.0' },
];

/** JSON-RPC code the CLI uses for every auth and setup failure. */
export const AGENT_SETUP_ERROR_CODE = -32000;

/**
 * Process exit codes the CLI uses for fatal errors that a restart cannot fix.
 * The sidecar does not restart on these.
 */
export const FATAL_EXIT_CODES: ReadonlyMap<number, AgentErrorKind> = new Map([
	[41, 'auth-failed'], // FatalAuthenticationError
]);

export function classifyAgentError(error: unknown): AgentErrorInfo {
	if (error instanceof AgentError) {
		// Already classified, such as a timeout the client raised itself.
		return error.info;
	}
	const code = typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined;
	const raw = (error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : String(error)).trim();
	// Outside `authenticate` and `session/new`, the CLI sends a generic
	// "Internal error" with its own message in `data.details`.
	const details = (error as { data?: { details?: unknown } })?.data?.details;
	const message = typeof details === 'string' && details.trim() ? details.trim() : raw;
	for (const { kind, pattern } of AGENT_ERROR_PATTERNS) {
		if (pattern.test(message)) {
			return { kind, message, code };
		}
	}
	if (isNetworkError(message)) {
		return { kind: 'network', message, code };
	}
	if (isConnectionClosed(error)) {
		return { kind: 'agent-restarted', message, code };
	}
	return { kind: 'unknown', message, code };
}

/**
 * Failures to reach Google, as Node and the CLI's HTTP clients word them:
 * DNS (`ENOTFOUND`, `EAI_AGAIN`), refused or dropped connections, timeouts,
 * a proxy in the way, and certificates Node does not trust (a VPN or a
 * proxy that inspects TLS).
 */
const networkError = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b|fetch failed|socket hang up|network is unreachable|getaddrinfo|tunneling socket|proxy (authentication|error|connection|connect)|\b407 Proxy|self[- ]signed certificate|unable to (get|verify) (local issuer|the first) certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_CERT/i;

/** Whether `message` says the CLI could not reach Google (see `networkError`). */
export function isNetworkError(message: string): boolean {
	return networkError.test(message);
}

/**
 * Whether `error` is the ACP SDK's own error for a connection that closed
 * under a request ("ACP connection is closed"), as when the agent restarts.
 */
export function isConnectionClosed(error: unknown): boolean {
	const name = (error as { name?: unknown })?.name;
	const message = error instanceof Error ? error.message : (error as { message?: unknown })?.message;
	return name === 'ConnectionClosedError' || (typeof message === 'string' && /^ACP (connection|outbound channel) (is )?closed$/i.test(message.trim()));
}

/**
 * Whether Gemini refused a request because it ends with a model turn: a CLI
 * bug after some tool results (an image, in practice), which a new user turn
 * gets past. The message can come as plain text or as the API's JSON body.
 */
export function isModelTurnRefusal(message: string): boolean {
	return /ending with a model turn|end with a user role|ends? with a model (role|turn)/i.test(message);
}

/**
 * Whether Gemini refused a request because the session's history is over the
 * model's context limit ("The input token count exceeds the maximum number of
 * tokens allowed 1048576."), as plain text or inside the API's JSON body.
 * Every later request in that session carries the same history, so it fails
 * the same way: only a new session gets past it.
 */
export function isContextOverflow(message: string): boolean {
	return /input token count (\(\d+\) )?exceeds the maximum number of tokens/i.test(message);
}

/** What the API said, without its JSON wrapper. */
export interface ApiErrorText {
	readonly message: string;
	/** The HTTP status in the body, such as 429. */
	readonly code?: number;
	/** The RPC status in the body, such as `RESOURCE_EXHAUSTED`. */
	readonly status?: string;
}

/**
 * Takes the API's message out of a JSON error body, as gemini-cli passes
 * some on: `{"error":{"code":503,"message":"...","status":"UNAVAILABLE"}}`,
 * the same in an array, or such a body after text ("got status: 503. {...}").
 * Text with no body comes back as it is.
 */
export function stripApiWrapper(text: string): ApiErrorText {
	const trimmed = text.trim();
	const start = trimmed.search(/[[{]/);
	if (start < 0) {
		return { message: trimmed };
	}
	let body: unknown;
	try {
		body = JSON.parse(trimmed.slice(start));
	} catch {
		return { message: trimmed };
	}
	const error = (Array.isArray(body) ? body[0] : body) as { error?: { code?: unknown; message?: unknown; status?: unknown }; message?: unknown } | undefined;
	const inner = error?.error ?? error;
	const message = typeof inner?.message === 'string' ? inner.message : undefined;
	if (!message) {
		return { message: trimmed };
	}
	// A message can itself be a JSON body; the CLI's own `extractRecursiveMessage` unwraps those too.
	const nested = message.trim().startsWith('{') || message.trim().startsWith('[') ? stripApiWrapper(message) : { message: message.trim() };
	const code = typeof (inner as { code?: unknown }).code === 'number' ? (inner as { code: number }).code : nested.code;
	const status = typeof (inner as { status?: unknown }).status === 'string' ? (inner as { status: string }).status : nested.status;
	return { message: nested.message, ...(code !== undefined ? { code } : {}), ...(status !== undefined ? { status } : {}) };
}

/** What kind of failure ended a turn, for the notice and the way out it offers. */
export type TurnErrorKind =
	/** 429 or `RESOURCE_EXHAUSTED`: the model's quota or rate limit is used up. */
	| 'quota'
	/** Google could not be reached (see `isNetworkError`). */
	| 'network'
	/** 401 or `UNAUTHENTICATED`: the sign-in expired or was revoked. */
	| 'auth-expired'
	/** A 5xx from the API: Gemini's side failed. */
	| 'server'
	/** The connection closed under the turn, as when the agent restarts. */
	| 'agent-restarted'
	/** The agent did not answer while the chat's session opened (see `AgentErrorKind`). */
	| 'timeout'
	| 'unknown';

export interface TurnErrorInfo {
	readonly kind: TurnErrorKind;
	/** The API's or the CLI's message, without the API's JSON wrapper. */
	readonly message: string;
	/** For `quota`: the model whose quota is used up, when the message names one. */
	readonly model?: string;
	/** For `quota`: when it resets (ms since the epoch), when the message says. */
	readonly resetsAt?: number;
}

/**
 * Parses a duration as the API words it: "1h2m3s", "34s", "0.5s", "250ms".
 * Returns milliseconds, or undefined for anything else.
 */
function parseDuration(text: string): number | undefined {
	const match = /^(?:(?<hours>\d+)h)?(?:(?<minutes>\d+)m(?!s))?(?:(?<seconds>\d+(?:\.\d+)?)s)?(?:(?<millis>\d+(?:\.\d+)?)ms)?$/.exec(text.trim());
	const groups = match?.groups;
	if (!groups || !text.trim()) {
		return undefined;
	}
	return ((Number(groups.hours ?? 0) * 60 + Number(groups.minutes ?? 0)) * 60 + Number(groups.seconds ?? 0)) * 1000 + Number(groups.millis ?? 0);
}

/**
 * When a quota resets, from the wording the API and gemini-cli use: "Your
 * quota will reset after 2h31m14s.", "Please retry in 34.5s." and
 * "Suggested retry after 60s." (the CLI's `classifyGoogleError`).
 */
function quotaResetsAt(message: string, now: number): number | undefined {
	const match = /(?:reset after|retry in|retry after)\s+(?<duration>[\d.hms]+?)\.?(?:\s|$)/i.exec(message);
	const ms = match?.groups ? parseDuration(match.groups.duration) : undefined;
	return ms === undefined ? undefined : now + ms;
}

/**
 * Classifies the error a `session/prompt` failed with. gemini-cli 0.64 sends
 * the API's HTTP status as the JSON-RPC code (429, 503, ...) or 500 for
 * anything else, with the API's message; a 429 it gave up retrying comes as
 * "Rate limit exceeded. Try again later.", and an expired sign-in as the
 * API's 401 message under code 500. The model is named only when the API's
 * message names it ("model: gemini-2.5-pro"); `model` fills it in otherwise.
 */
export function classifyTurnError(error: unknown, options: { readonly model?: string; readonly now?: number } = {}): TurnErrorInfo {
	const info = classifyAgentError(error);
	const api = stripApiWrapper(info.message);
	const message = api.message;
	const code = api.code ?? info.code;
	if (info.kind === 'agent-restarted' || isConnectionClosed(error)) {
		return { kind: 'agent-restarted', message };
	}
	if (info.kind === 'timeout') {
		return { kind: 'timeout', message };
	}
	if (code === 429 || api.status === 'RESOURCE_EXHAUSTED' || /RESOURCE_EXHAUSTED|rate limit exceeded|quota (exceeded|will reset)|exhausted your (daily )?(quota|capacity)/i.test(message)) {
		const model = /\bmodel: ?(?<model>[\w.-]+)/.exec(message)?.groups?.model ?? options.model;
		const resetsAt = quotaResetsAt(message, options.now ?? Date.now());
		return { kind: 'quota', message, ...(model ? { model } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) };
	}
	if (code === 401 || api.status === 'UNAUTHENTICATED' || /UNAUTHENTICATED|invalid authentication credentials|invalid_grant|token has been expired or revoked|reauthenticate|re-authenticate/i.test(message)) {
		return { kind: 'auth-expired', message };
	}
	if (info.kind === 'network' || isNetworkError(message)) {
		return { kind: 'network', message };
	}
	// gemini-cli sends 500 for any error without a status, so a plain 500 counts only with the API's own wording.
	if ((code !== undefined && code > 500 && code < 600) || /^(INTERNAL|UNAVAILABLE|DEADLINE_EXCEEDED)$/.test(api.status ?? '') || (code === 500 && /internal error encountered|service unavailable|overloaded|high demand|backend error/i.test(message))) {
		return { kind: 'server', message };
	}
	return { kind: 'unknown', message };
}

/**
 * One retry gemini-cli logged in its debug log (GEMINI_DEBUG_LOG_FILE) while
 * it waits to call the API again; over ACP it says nothing about these.
 */
export interface CliRetry {
	/** The attempt that failed, from 1. */
	readonly attempt: number;
	/** The HTTP status it failed with, when the line names one. */
	readonly status?: number;
}

/**
 * Reads a retry from one line of the CLI's debug log. gemini-cli 0.64 writes
 * `[<time>] [WARN] Attempt 2 failed with status 503. Retrying with backoff...`
 * (`logRetryAttempt`), the same with "429 error" or "5xx error" instead of a
 * status, and `Attempt 2 failed: <message>. Retrying after 1234ms...` for a
 * quota error with a delay.
 */
export function parseCliRetry(line: string): CliRetry | undefined {
	const match = /^\[[^\]]*\] \[WARN\] Attempt (?<attempt>\d+) failed(?<rest>.*?)\. Retrying (with backoff|after \d+ms)/.exec(line);
	if (!match?.groups) {
		return undefined;
	}
	const status = /with (status (?<code>\d{3})|(?<named>429|5xx) error)/.exec(match.groups.rest)?.groups;
	const code = status?.code ?? (status?.named === '429' ? '429' : undefined);
	return { attempt: Number(match.groups.attempt), ...(code ? { status: Number(code) } : {}) };
}

/** The message of an error of any shape, for showing to the user. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Raised by the client when the agent fails; carries the classification. */
export class AgentError extends Error {
	constructor(public readonly info: AgentErrorInfo) {
		super(info.message);
		this.name = 'AgentError';
	}
}
