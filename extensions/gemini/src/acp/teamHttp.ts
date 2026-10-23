/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HTTP for the team tools' connectors (Jira, GitLab, SonarQube): every call
// runs from the user's machine, so their VPN, proxy and certificates apply,
// and has a short timeout, so a tool behind a VPN that is off fails fast with
// a reason the user can act on instead of hanging a page or a turn.

import { recordPilot } from './pilotLog';

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
	try {
		return await send<T>(tool, url, request, fetcher);
	} catch (err) {
		if (err instanceof TeamToolError) {
			recordPilot({ kind: 'teamToolError', tool, error: err.kind, ...err.status ? { status: err.status } : {} });
		}
		throw err;
	}
}

async function send<T>(tool: TeamToolId, url: string, request: TeamRequest, fetcher: Fetch): Promise<T> {
	const controller = new AbortController();
	// The whole call, its body included, has to finish in time: a host that sends headers and then stalls fails too.
	const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? defaultTimeoutMs);
	try {
		return await sendWithin<T>(tool, url, request, fetcher, controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

/** Redirects followed at most, as many as `fetch` itself follows by default. */
const maxRedirects = 20;

/**
 * Calls `url`, following redirects here rather than in `fetch`: the headers
 * the caller set, which carry the token, go only to the origin they were
 * meant for. `fetch` drops only `Authorization` on a redirect to another
 * origin, so GitLab's `PRIVATE-TOKEN` would go along to whatever host the
 * redirect names, such as the object storage a job log is kept in.
 */
async function fetchFollowing(url: string, request: TeamRequest, fetcher: Fetch, signal: AbortSignal): Promise<Response> {
	const origin = new URL(url).origin;
	const form = typeof FormData !== 'undefined' && request.body instanceof FormData;
	let method: string = request.method ?? 'GET';
	let body: string | FormData | undefined = request.body === undefined ? undefined : form ? request.body as FormData : JSON.stringify(request.body);
	let current = url;
	for (let hops = 0; ; hops++) {
		const response = await fetcher(current, {
			method,
			headers: {
				Accept: request.text ? 'text/plain, */*' : 'application/json',
				...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}),
				...new URL(current).origin === origin ? request.headers : {},
			},
			body,
			signal,
			redirect: 'manual',
		});
		const location = response.headers.get('location');
		if (response.status < 300 || response.status > 399 || response.status === 304 || !location || hops >= maxRedirects) {
			return response;
		}
		await response.body?.cancel().catch(() => undefined);
		current = new URL(location, current).href;
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
			// As `fetch` does: the next request is a GET, with no body.
			method = 'GET';
			body = undefined;
		}
	}
}

async function sendWithin<T>(tool: TeamToolId, url: string, request: TeamRequest, fetcher: Fetch, signal: AbortSignal): Promise<T> {
	const host = hostOf(url);
	const name = teamToolNames[tool];
	let response: Response;
	try {
		response = await fetchFollowing(url, request, fetcher, signal);
	} catch (err) {
		throw new TeamToolError('unreachable', unreachableMessage(tool, host, err));
	}
	if (response.status >= 300 && response.status <= 399 && response.status !== 304) {
		throw new TeamToolError('failed', `${name} at ${host} kept redirecting. Check the server address in Connections.`, response.status);
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
	if (response.status === 204 && !request.text) {
		return undefined as T;
	}
	let body: string;
	try {
		body = await response.text();
	} catch (err) {
		// The time ran out, or the connection dropped, while the answer came in.
		throw new TeamToolError('unreachable', unreachableMessage(tool, host, err));
	}
	if (request.text) {
		return body as T;
	}
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
