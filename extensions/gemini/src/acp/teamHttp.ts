/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HTTP for the team tools' connectors (Jira, GitLab, SonarQube): every call
// runs from the user's machine, so their VPN, proxy and certificates apply,
// and has a short timeout, so a tool behind a VPN that is off fails fast with
// a reason the user can act on instead of hanging a page or a turn.
//
// Each server has one reachability state (`teamReachability`): after a call
// gets no answer, calls to it fail at once for a while (30 s, then 1, 2 and
// up to 5 minutes), and the first call after that tries again, so an outage
// is reported once instead of on every card. A refused token stops calls
// with that token until it changes. A read that meets a busy server (429,
// 502, 503, 504) is tried once more; a write never is.

import { createHash } from 'node:crypto';
import { Emitter } from './events';

/** The tools GeminiCode connects to. */
export type TeamToolId = 'jira' | 'confluence' | 'gitlab' | 'sonar' | 'snyk' | 'figma';

export const teamToolIds: readonly TeamToolId[] = ['jira', 'confluence', 'gitlab', 'sonar', 'snyk', 'figma'];

export const teamToolNames: Readonly<Record<TeamToolId, string>> = { jira: 'Jira', confluence: 'Confluence', gitlab: 'GitLab', sonar: 'SonarQube', snyk: 'Snyk', figma: 'Figma' };

/**
 * Why a call failed: `unreachable` (no answer: the VPN is off, or the host is
 * wrong), `auth` (the token was refused or expired), `notFound`, or `failed`.
 */
export type TeamErrorKind = 'unreachable' | 'auth' | 'forbidden' | 'notFound' | 'failed';

/** What a failure adds besides its kind and status. */
export interface TeamErrorDetail {
	/** A write that got no answer in time: it may have gone through, so its outcome is unknown. */
	readonly unsure?: boolean;
	/** Seconds the server asked to wait before trying again (Retry-After). */
	readonly retryAfter?: number;
	/** Failed at once, without a request, because the server is known to be unreachable or the token refused. */
	readonly blocked?: boolean;
}

export class TeamToolError extends Error {
	constructor(readonly kind: TeamErrorKind, message: string, readonly status?: number, readonly detail: TeamErrorDetail = {}) {
		super(message);
		this.name = 'TeamToolError';
	}
}

/** The default time a read may take; VPN-only hosts that don't answer fail after this. */
export const defaultTimeoutMs = 8000;
/** The default time a write may take: long enough that a slow server's answer isn't lost, after which the write's outcome is unknown. */
export const writeTimeoutMs = 20_000;
/** The longest a read waits for a busy server before its one retry; a server that asks for longer is reported. */
const maxRetryWaitMs = 5000;
/** The wait before a read's retry when the server doesn't say. */
const defaultRetryWaitMs = 1000;
/** What a rate-limit message says when the server doesn't give Retry-After. */
const defaultRateLimitSeconds = 30;

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

/** A page of a list: its items, and the total the server reports, when it does. */
export interface TeamPage<T> {
	readonly body: T;
	/** The number of items in the whole list (GitLab's X-Total), when the server says. */
	readonly total?: number;
	/** The next page's number (GitLab's X-Next-Page), when there is one. */
	readonly nextPage?: number;
}

/**
 * Calls `url` and returns its JSON (or text). Throws a `TeamToolError` whose
 * message names `tool` and `host` and says what to do.
 */
export async function teamRequest<T>(tool: TeamToolId, url: string, request: TeamRequest = {}, fetcher: Fetch = fetch): Promise<T> {
	return (await teamRequestPage<T>(tool, url, request, fetcher)).body;
}

/** As `teamRequest`, with the list's total and next page from the answer's headers. */
export async function teamRequestPage<T>(tool: TeamToolId, url: string, request: TeamRequest = {}, fetcher: Fetch = fetch): Promise<TeamPage<T>> {
	const credential = credentialOf(request.headers);
	const blocked = teamReachability.blocked(tool, url, credential);
	if (blocked) {
		// Not counted again: the outage was counted when it began.
		throw blocked;
	}
	try {
		const answer = await sendRetrying<T>(tool, url, request, fetcher);
		teamReachability.succeeded(tool, url);
		return answer;
	} catch (err) {
		if (err instanceof TeamToolError) {
			if (err.kind === 'auth') {
				teamReachability.refused(tool, url, credential);
			} else if (err.kind === 'unreachable' && !err.detail.unsure) {
				teamReachability.failed(tool, url);
			}
		}
		throw err;
	}
}

/** Whether `request` changes something: a write, which is never sent twice. */
function isWrite(request: TeamRequest): boolean {
	return (request.method ?? 'GET') !== 'GET';
}

/** Sends once; a read that met a busy server is sent once more after the wait it asked for, when that is short. */
async function sendRetrying<T>(tool: TeamToolId, url: string, request: TeamRequest, fetcher: Fetch): Promise<TeamPage<T>> {
	try {
		return await send<T>(tool, url, request, fetcher);
	} catch (err) {
		const wait = err instanceof TeamToolError && retryable(err.status) && !isWrite(request) ? (err.detail.retryAfter === undefined ? defaultRetryWaitMs : err.detail.retryAfter * 1000) : undefined;
		if (wait === undefined || wait > maxRetryWaitMs) {
			throw err;
		}
		await new Promise(resolve => setTimeout(resolve, wait));
		return send<T>(tool, url, request, fetcher);
	}
}

function retryable(status: number | undefined): boolean {
	return status === 429 || status === 502 || status === 503 || status === 504;
}

async function send<T>(tool: TeamToolId, url: string, request: TeamRequest, fetcher: Fetch): Promise<TeamPage<T>> {
	const controller = new AbortController();
	const timeoutMs = request.timeoutMs ?? (isWrite(request) ? writeTimeoutMs : defaultTimeoutMs);
	// The whole call, its body included, has to finish in time: a host that sends headers and then stalls fails too.
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await sendWithin<T>(tool, url, request, fetcher, controller.signal, timeoutMs);
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

async function sendWithin<T>(tool: TeamToolId, url: string, request: TeamRequest, fetcher: Fetch, signal: AbortSignal, timeoutMs: number): Promise<TeamPage<T>> {
	const host = hostOf(url);
	const name = teamToolNames[tool];
	// A write that ran out of time may have reached the server: its outcome is unknown, and it must not be sent again blindly.
	const noAnswer = (err: unknown) => isWrite(request) && signal.aborted
		? new TeamToolError('unreachable', writeTimeoutMessage(name, timeoutMs), undefined, { unsure: true })
		: new TeamToolError('unreachable', unreachableMessage(tool, host, err));
	let response: Response;
	try {
		response = await fetchFollowing(url, request, fetcher, signal);
	} catch (err) {
		throw noAnswer(err);
	}
	if (response.status >= 300 && response.status <= 399 && response.status !== 304) {
		throw new TeamToolError('failed', `${name} at ${host} kept redirecting. Check the server address in Connections.`, response.status);
	}
	if (response.status === 401) {
		throw new TeamToolError('auth', authMessage(name, host), 401);
	}
	if (response.status === 403) {
		throw new TeamToolError('forbidden', `${name} says your account may not do this (403). ${await errorText(response)}`.trim(), 403);
	}
	if (response.status === 404) {
		throw new TeamToolError('notFound', `${name} found nothing at ${new URL(url).pathname} (404). ${await errorText(response)}`.trim(), 404);
	}
	if (response.status === 429) {
		const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
		await response.body?.cancel().catch(() => undefined);
		throw new TeamToolError('failed', rateLimitMessage(name, retryAfter ?? defaultRateLimitSeconds), 429, retryAfter === undefined ? {} : { retryAfter });
	}
	if (!response.ok) {
		const retryAfter = retryable(response.status) ? retryAfterSeconds(response.headers.get('retry-after')) : undefined;
		throw new TeamToolError('failed', `${name} answered ${response.status}. ${await errorText(response)}`.trim(), response.status, retryAfter === undefined ? {} : { retryAfter });
	}
	const page = pageOf(response.headers);
	if (response.status === 204 && !request.text) {
		return { body: undefined as T, ...page };
	}
	let body: string;
	try {
		body = await response.text();
	} catch (err) {
		// The time ran out, or the connection dropped, while the answer came in.
		throw noAnswer(err);
	}
	if (request.text) {
		return { body: body as T, ...page };
	}
	if (!body) {
		return { body: undefined as T, ...page };
	}
	try {
		return { body: JSON.parse(body) as T, ...page };
	} catch {
		// A sign-in page instead of the API: a proxy or SSO portal answered.
		throw new TeamToolError('failed', `${name} at ${host} didn't answer with data. Check the server address, and that your VPN is on.`);
	}
}

/** GitLab's paging headers: the list's total and the next page, when given. */
function pageOf(headers: Headers): { total?: number; nextPage?: number } {
	const total = Number(headers.get('x-total') ?? Number.NaN);
	const next = Number(headers.get('x-next-page') || Number.NaN);
	return { ...Number.isFinite(total) ? { total } : {}, ...Number.isFinite(next) && next > 0 ? { nextPage: next } : {} };
}

/** Retry-After as seconds: a number of seconds, or an HTTP date. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
	if (!value?.trim()) {
		return undefined;
	}
	if (/^\d+$/.test(value.trim())) {
		return Number(value.trim());
	}
	const at = Date.parse(value);
	return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

function authMessage(name: string, host: string): string {
	return `${name} refused the token for ${host}. It may have expired or been revoked: replace it in Connections.`;
}

/** What a write that got no answer in time says: it may have gone through. */
export function writeTimeoutMessage(name: string, timeoutMs: number): string {
	return `${name} didn't answer within ${Math.max(1, Math.round(timeoutMs / 1000))} s. It may have gone through; check before trying again.`;
}

export function rateLimitMessage(name: string, seconds: number): string {
	return `${name} is rate-limiting requests; try again in ${seconds} s.`;
}

/** A short fingerprint of the token a request carries, so a refused token is told apart from the next one. */
function credentialOf(headers: Record<string, string> | undefined): string {
	const secret = Object.entries(headers ?? {}).filter(([name]) => /^(authorization|private-token)$/i.test(name)).map(([, value]) => value).join('\n');
	return secret ? createHash('sha256').update(secret).digest('hex').slice(0, 16) : '';
}

/** One server's reachability. */
export type ServerHealth =
	| { readonly kind: 'ok' }
	/** No answer: calls fail at once until `retryAt`, after which the next call tries again. */
	| { readonly kind: 'unreachable'; readonly since: number; readonly retryAt: number; readonly failures: number }
	/** The token was refused: calls with it fail at once until the token changes. */
	| { readonly kind: 'signIn'; readonly since: number };

export interface ServerHealthChange {
	readonly tool: TeamToolId;
	/** The server's origin, such as https://gitlab.acme.internal. */
	readonly origin: string;
	readonly health: ServerHealth;
}

/** How long calls to an unreachable server fail at once, after its first, second, third... failure in a row. */
export const unreachableBackoffMs: readonly number[] = [30_000, 60_000, 120_000, 240_000, 300_000];

interface ServerEntry {
	readonly tool: TeamToolId;
	readonly origin: string;
	health: ServerHealth;
	/** The token that was refused. */
	refused?: string;
}

/**
 * The reachability of each team server, by tool and origin: one outage is one
 * state, not a failure per card. Pages read it for their banners, and
 * TeamConnections checks the server again when its wait ends, so the state
 * clears by itself once the VPN is back.
 */
export class TeamReachability {

	private readonly servers = new Map<string, ServerEntry>();
	private readonly onDidChangeEmitter = new Emitter<ServerHealthChange>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private readonly now: () => number = Date.now) { }

	/** The error a call to `url` gets now without being sent, when the server is known to be down or the token refused. */
	blocked(tool: TeamToolId, url: string, credential = ''): TeamToolError | undefined {
		const entry = this.servers.get(keyOf(tool, url));
		const health = entry?.health;
		if (health?.kind === 'unreachable' && this.now() < health.retryAt) {
			return new TeamToolError('unreachable', unreachableNow(tool), undefined, { blocked: true });
		}
		if (health?.kind === 'signIn' && entry?.refused === credential) {
			return new TeamToolError('auth', authMessage(teamToolNames[tool], hostOf(url)), 401, { blocked: true });
		}
		return undefined;
	}

	succeeded(tool: TeamToolId, url: string): void {
		const entry = this.servers.get(keyOf(tool, url));
		if (entry && entry.health.kind !== 'ok') {
			this.set(entry, { kind: 'ok' });
		}
	}

	/** A call got no answer: the server waits out its next backoff. */
	failed(tool: TeamToolId, url: string): void {
		const entry = this.entry(tool, url);
		const failures = entry.health.kind === 'unreachable' ? entry.health.failures + 1 : 1;
		const now = this.now();
		const since = entry.health.kind === 'unreachable' ? entry.health.since : now;
		this.set(entry, { kind: 'unreachable', since, failures, retryAt: now + unreachableBackoffMs[Math.min(failures, unreachableBackoffMs.length) - 1] });
	}

	/** The server refused `credential`: calls with it stop until the token changes. */
	refused(tool: TeamToolId, url: string, credential = ''): void {
		const entry = this.entry(tool, url);
		if (entry.health.kind === 'signIn' && entry.refused === credential) {
			return;
		}
		entry.refused = credential;
		this.set(entry, { kind: 'signIn', since: this.now() });
	}

	/** Each server of `tool` (every tool when unset) GeminiCode has called, with its state. */
	states(tool?: TeamToolId): ServerHealthChange[] {
		return [...this.servers.values()].filter(entry => !tool || entry.tool === tool).map(({ tool, origin, health }) => ({ tool, origin, health }));
	}

	/** The worst state among `tool`'s servers: what a banner shows. */
	health(tool: TeamToolId): ServerHealth {
		const states = this.states(tool).map(state => state.health);
		return states.find(health => health.kind === 'signIn') ?? states.find(health => health.kind === 'unreachable') ?? { kind: 'ok' };
	}

	/** Lets the next call to `tool`'s unreachable servers through now, as an explicit check does; the backoff keeps growing if it fails. */
	retryNow(tool: TeamToolId): void {
		for (const entry of this.servers.values()) {
			if (entry.tool === tool && entry.health.kind === 'unreachable') {
				entry.health = { ...entry.health, retryAt: this.now() };
			}
		}
	}

	/** Forgets every state; for a new connection and for tests. */
	clear(tool?: TeamToolId): void {
		for (const [key, entry] of this.servers) {
			if (!tool || entry.tool === tool) {
				this.servers.delete(key);
				if (entry.health.kind !== 'ok') {
					this.onDidChangeEmitter.fire({ tool: entry.tool, origin: entry.origin, health: { kind: 'ok' } });
				}
			}
		}
	}

	private entry(tool: TeamToolId, url: string): ServerEntry {
		const key = keyOf(tool, url);
		let entry = this.servers.get(key);
		if (!entry) {
			entry = { tool, origin: originOf(url), health: { kind: 'ok' } };
			this.servers.set(key, entry);
		}
		return entry;
	}

	private set(entry: ServerEntry, health: ServerHealth): void {
		entry.health = health;
		this.onDidChangeEmitter.fire({ tool: entry.tool, origin: entry.origin, health });
	}
}

/** The one reachability state per team server, shared by every connector in the extension host. */
export const teamReachability = new TeamReachability();

/** The one line a call to a server known to be down gets. */
export function unreachableNow(tool: TeamToolId): string {
	return `${teamToolNames[tool]} is unreachable right now (${tool === 'jira' ? 'offline?' : 'VPN?'})`;
}

function keyOf(tool: TeamToolId, url: string): string {
	return `${tool} ${originOf(url)}`;
}

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return url;
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

/** A list that may be cut short: its items, and how many the server has in all when it says. */
export type Listed<T> = T[] & { readonly total?: number };

/** `items` with the server's `total`, when it is known and more than the items. */
export function listed<T>(items: T[], total?: number): Listed<T> {
	return total !== undefined && Number.isFinite(total) && total > items.length ? Object.assign(items, { total }) : items;
}

/** "50 of 312" for a cut list, else the count alone. */
export function countText(list: { readonly length: number; readonly total?: number }): string {
	return list.total !== undefined && list.total > list.length ? `${list.length} of ${list.total}` : String(list.length);
}

/** Shortens `text` to `max` characters, saying how much was cut. */
export function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters cut)`;
}
