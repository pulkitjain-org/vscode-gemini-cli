/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The CLI wraps every `authenticate` and `session/new` failure as a JSON-RPC
// error -32000 with a message string (plan C3), so typed errors never reach us.
// This table maps the known message strings to kinds. Every pattern is copied
// from the CLI source of the version in `since`, and each one has a fixture in
// test/fixtures/agentErrors.json that Compat CI runs against new CLI versions.
// An unknown message falls back to `unknown` and is shown as is.

export type AgentErrorKind =
	/** No auth type selected yet, or an API key is expected: call `authenticate`. */
	| 'auth-required'
	/** The OAuth login itself failed; it has to be completed in a terminal (C4). */
	| 'auth-failed'
	/** The account needs GOOGLE_CLOUD_PROJECT set. */
	| 'project-id-required'
	/** GOOGLE_CLOUD_PROJECT holds a project number instead of a project ID. */
	| 'project-id-numeric'
	/** The CLI executable was not found. */
	| 'agent-not-found'
	/** The agent process exited before answering. */
	| 'agent-exited'
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
	const code = typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined;
	const message = (error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : String(error)).trim();
	for (const { kind, pattern } of AGENT_ERROR_PATTERNS) {
		if (pattern.test(message)) {
			return { kind, message, code };
		}
	}
	return { kind: 'unknown', message, code };
}

/** Raised by the client when the agent fails; carries the classification. */
export class AgentError extends Error {
	constructor(public readonly info: AgentErrorInfo) {
		super(info.message);
		this.name = 'AgentError';
	}
}
