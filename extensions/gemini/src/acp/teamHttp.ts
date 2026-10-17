/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HTTP for the team tools' connectors (Jira, GitLab, SonarQube): every call
// runs from the user's machine, so their VPN, proxy and certificates apply,
// and has a short timeout, so a tool behind a VPN that is off fails fast with
// a reason the user can act on instead of hanging a page or a turn.

/** The tools GeminiCode connects to. */
export type TeamToolId = 'jira' | 'gitlab' | 'sonar' | 'snyk' | 'figma';

export const teamToolIds: readonly TeamToolId[] = ['jira', 'gitlab', 'sonar', 'snyk', 'figma'];

export const teamToolNames: Readonly<Record<TeamToolId, string>> = { jira: 'Jira', gitlab: 'GitLab', sonar: 'SonarQube', snyk: 'Snyk', figma: 'Figma' };

/**
 * Why a call failed: `unreachable` (no answer: the VPN is off, or the host is
 * wrong), `auth` (the token was refused or expired), `notFound`, or `failed`.
 */
export type TeamErrorKind = 'unreachable' | 'auth' | 'forbidden' | 'notFound' | 'failed';

export class TeamToolError extends Error {
	constructor(readonly kind: TeamErrorKind, message: string, readonly status?: number) {
		super(message);
		this.name = 'TeamToolError';
	}
}

/** The default time a call may take; VPN-only hosts that don't answer fail after this. */
export const defaultTimeoutMs = 8000;

export interface TeamRequest {
	readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
	readonly headers?: Record<string, string>;
	/** Sent as JSON, unless it is FormData. */
	readonly body?: unknown;
	readonly timeoutMs?: number;
	/** Return the body as text instead of parsing JSON (job logs). */
	readonly text?: boolean;
}

export type Fetch = typeof fetch;

/**
 * Calls `url` and returns its JSON (or text). Throws a `TeamToolError` whose
 * message names `tool` and `host` and says what to do.
 */
export async function teamRequest<T>(tool: TeamToolId, url: string, request: TeamRequest = {}, fetcher: Fetch = fetch): Promise<T> {
	const host = hostOf(url);
	const name = teamToolNames[tool];
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? defaultTimeoutMs);
	const form = typeof FormData !== 'undefined' && request.body instanceof FormData;
	let response: Response;
	try {
		response = await fetcher(url, {
			method: request.method ?? 'GET',
			headers: { Accept: request.text ? 'text/plain, */*' : 'application/json', ...(request.body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}), ...request.headers },
			body: request.body === undefined ? undefined : form ? request.body as FormData : JSON.stringify(request.body),
			signal: controller.signal,
			redirect: 'follow',
		});
	} catch (err) {
		throw new TeamToolError('unreachable', unreachableMessage(tool, host, err));
	} finally {
		clearTimeout(timer);
	}
	if (response.status === 401) {
		throw new TeamToolError('auth', `${name} refused the token for ${host}. It may have expired or been revoked: replace it in Connections.`, 401);
	}
	if (response.status === 403) {
		throw new TeamToolError('forbidden', `${name} says your account may not do this (403). ${await errorText(response)}`.trim(), 403);
	}
	if (response.status === 404) {
		throw new TeamToolError('notFound', `${name} found nothing at ${new URL(url).pathname} (404). ${await errorText(response)}`.trim(), 404);
	}
	if (!response.ok) {
		throw new TeamToolError('failed', `${name} answered ${response.status}. ${await errorText(response)}`.trim(), response.status);
	}
	if (request.text) {
		return await response.text() as T;
	}
	if (response.status === 204) {
		return undefined as T;
	}
	const body = await response.text();
	if (!body) {
		return undefined as T;
	}
	try {
		return JSON.parse(body) as T;
	} catch {
		// A sign-in page instead of the API: a proxy or SSO portal answered.
		throw new TeamToolError('failed', `${name} at ${host} didn't answer with data. Check the server address, and that your VPN is on.`);
	}
}

export function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** `base` without trailing slashes, with https:// added when no scheme was given. */
export function normalizeBaseUrl(base: string): string {
	let url = base.trim().replace(/\/+$/, '');
	if (url && !/^https?:\/\//i.test(url)) {
		url = `https://${url}`;
	}
	return url;
}

function unreachableMessage(tool: TeamToolId, host: string, err: unknown): string {
	const name = teamToolNames[tool];
	const vpn = tool === 'jira' ? 'Check your internet connection' : 'Check that your VPN is on';
	const cause = causeCode(err);
	if (cause === 'CERT') {
		return `Can't reach ${host}: its certificate isn't trusted on this Mac. Ask your IT team to install the company's root certificate.`;
	}
	return `Can't reach ${name} at ${host}. ${vpn}.`;
}

function causeCode(err: unknown): string | undefined {
	const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
	const code = cause?.code ?? '';
	return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code) ? 'CERT' : code || undefined;
}

async function errorText(response: Response): Promise<string> {
	try {
		const text = await response.text();
		try {
			const json = JSON.parse(text) as Record<string, unknown>;
			const messages = [json.message, json.error, json.errorMessages, json.errors].flatMap(value => flattenErrors(value));
			return messages.join(' ').slice(0, 400);
		} catch {
			return /<html/i.test(text) ? '' : text.slice(0, 400);
		}
	} catch {
		return '';
	}
}

function flattenErrors(value: unknown): string[] {
	if (typeof value === 'string') {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap(flattenErrors);
	}
	if (value && typeof value === 'object') {
		return Object.entries(value).flatMap(([key, inner]) => flattenErrors(inner).map(text => typeof (value as Record<string, unknown>).msg === 'string' ? text : `${key}: ${text}`));
	}
	return [];
}

/** Shortens `text` to `max` characters, saying how much was cut. */
export function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters cut)`;
}
