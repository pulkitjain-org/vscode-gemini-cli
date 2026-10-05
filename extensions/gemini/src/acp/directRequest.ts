/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Direct requests: one quick call to a fast Gemini model, for inline edit and
// commit messages, without an agent turn. They use the sign-in the Gemini CLI
// already saved, read only: with Google sign-in, the Gemini Code Assist
// service and project the CLI uses (the same license); with an API key, the
// Gemini API. The CLI itself is not involved or changed.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** How the CLI signs in, from its settings and environment. */
export type DirectAuth =
	| { readonly kind: 'google'; readonly credsFile: string }
	| { readonly kind: 'apiKey'; readonly apiKey: string }
	| { readonly kind: 'unsupported'; readonly reason: 'vertex' | 'encrypted' | 'none' };

/** The CLI's own folder: `$GEMINI_CLI_HOME/.gemini`, else `~/.gemini`. */
export function geminiDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
}

/** Works out the CLI's sign-in the way the CLI does: its settings first, then the environment. */
export async function detectAuth(env: NodeJS.ProcessEnv = process.env): Promise<DirectAuth> {
	const dir = geminiDir(env);
	let selected: string | undefined;
	try {
		const settings = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'));
		selected = settings?.security?.auth?.selectedType ?? settings?.selectedAuthType;
	} catch {
		// No settings, or not JSON: fall back on the environment.
	}
	if (!selected) {
		selected = env.GOOGLE_GENAI_USE_GCA === 'true' ? 'oauth-personal'
			: env.GOOGLE_GENAI_USE_VERTEXAI === 'true' ? 'vertex-ai'
				: env.GEMINI_API_KEY ? 'gemini-api-key' : 'oauth-personal';
	}
	switch (selected) {
		case 'gemini-api-key':
			return env.GEMINI_API_KEY ? { kind: 'apiKey', apiKey: env.GEMINI_API_KEY } : { kind: 'unsupported', reason: 'none' };
		case 'vertex-ai':
			return { kind: 'unsupported', reason: 'vertex' };
		default:
			// The encrypted store is the system keychain, which GeminiCode does not read.
			return env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE === 'true'
				? { kind: 'unsupported', reason: 'encrypted' }
				: { kind: 'google', credsFile: path.join(dir, 'oauth_creds.json') };
	}
}

export interface DirectRequest {
	readonly model: string;
	/** How the model should behave. */
	readonly system: string;
	readonly prompt: string;
	/** Lower is more predictable; edits want low. */
	readonly temperature?: number;
	readonly signal?: AbortSignal;
}

/** What a Google API error says about why it was refused, as the CLI reads it. */
export interface RefusalDetails {
	/** `ErrorInfo.reason`, such as RATE_LIMIT_EXCEEDED, QUOTA_EXHAUSTED or MODEL_CAPACITY_EXHAUSTED. */
	readonly reason?: string;
	/** How long to wait before trying again, from `RetryInfo` or the message. */
	readonly retryDelayMs?: number;
	/** The quota that ran out, such as a per-minute or per-day one. */
	readonly quotaId?: string;
}

/** A direct request failed; `kind` says whether signing in again or something else would help. */
export class DirectRequestError extends Error {
	constructor(message: string, readonly kind: 'auth' | 'quota' | 'network' | 'other', readonly status?: number, readonly details: RefusalDetails = {}) {
		super(message);
	}
}

interface Token {
	readonly accessToken: string;
	/** Milliseconds since the epoch. */
	readonly expiry: number;
}

/** The OAuth client a saved sign-in belongs to, which refreshing its token needs. */
export interface OAuthClient {
	readonly id: string;
	readonly secret: string;
}

/** What GeminiCode reads from the installed CLI: its OAuth client and its Flash models. */
export interface CliBundleInfo {
	readonly oauthClient?: OAuthClient;
	/** The newest Flash model, which not every account can use yet. */
	readonly latestFlash?: string;
	/** The Flash model every account can use. */
	readonly baseFlash?: string;
	/** The name Code Assist serves the base Flash model under, for accounts without the newest one. */
	readonly codeAssistFlash?: string;
	/** The CLI's version, from the package.json beside its bundle. */
	readonly version?: string;
}

/**
 * Reads the Gemini CLI's OAuth client and Flash models from its installed
 * bundle next to `entry` (its `gemini.js`). The CLI is a desktop app, so its
 * client "secret" is public; reading both from the CLI keeps GeminiCode in
 * step with whichever CLI is installed, with no model names to update here.
 */
export async function readCliBundle(entry: string): Promise<CliBundleInfo> {
	const dir = path.dirname(await fs.realpath(entry));
	const files = (await fs.readdir(dir)).filter(f => f.endsWith('.js'));
	// The constants live together in one shared chunk, which the CLI's entry imports.
	const ordered = [path.basename(entry), ...files.filter(f => f.startsWith('chunk-')), ...files.filter(f => !f.startsWith('chunk-') && f !== path.basename(entry))];
	let oauthClient: OAuthClient | undefined;
	let latestFlash: string | undefined;
	let baseFlash: string | undefined;
	let codeAssistFlash: string | undefined;
	for (const file of ordered) {
		let text: string;
		try {
			text = await fs.readFile(path.join(dir, file), 'utf8');
		} catch {
			continue;
		}
		const id = /OAUTH_CLIENT_ID\s*=\s*["']([\w.-]+\.apps\.googleusercontent\.com)["']/.exec(text)?.[1];
		const secret = /OAUTH_CLIENT_SECRET\s*=\s*["']([\w-]+)["']/.exec(text)?.[1];
		oauthClient ??= id && secret ? { id, secret } : undefined;
		latestFlash ??= /\bLATEST_GEMINI_FLASH_MODEL\s*=\s*["']([\w.-]+)["']/.exec(text)?.[1];
		baseFlash ??= /\bBASE_GEMINI_FLASH_MODEL\s*=\s*["']([\w.-]+)["']/.exec(text)?.[1];
		codeAssistFlash ??= /\bLEGACY_CCPA_FLASH_MODEL\s*=\s*["']([\w.-]+)["']/.exec(text)?.[1];
		if (oauthClient && latestFlash && baseFlash && codeAssistFlash) {
			break;
		}
	}
	const version = await fs.readFile(path.join(dir, '..', 'package.json'), 'utf8')
		.then(text => (JSON.parse(text) as { version?: unknown }).version, () => undefined);
	return { oauthClient, latestFlash, baseFlash, codeAssistFlash, ...(typeof version === 'string' ? { version } : {}) };
}

const projectEnvVars = ['GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID'];

/**
 * The project in the `.env` file the CLI loads when it starts in `cwd`: the
 * nearest `.gemini/.env` or `.env` from there up, then `~/.gemini/.env`, then
 * `~/.env`. The CLI reads it itself, so GeminiCode never passes it on.
 */
export async function cliEnvProject(cwd: string, home: string = os.homedir()): Promise<string | undefined> {
	const candidates: string[] = [];
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		candidates.push(path.join(dir, '.gemini', '.env'), path.join(dir, '.env'));
		if (path.dirname(dir) === dir) {
			break;
		}
	}
	candidates.push(path.join(home, '.gemini', '.env'), path.join(home, '.env'));
	for (const file of candidates) {
		let text: string;
		try {
			text = await fs.readFile(file, 'utf8');
		} catch {
			continue;
		}
		// The CLI loads only the first file it finds.
		const values = new Map<string, string>();
		for (const line of text.split(/\r?\n/)) {
			const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
			if (match) {
				values.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'));
			}
		}
		return projectEnvVars.map(name => values.get(name)?.trim()).find(Boolean);
	}
	return undefined;
}

export interface DirectClientOptions {
	/** The Google Cloud project, as the agent gets it; unset asks Code Assist for the user's own. */
	readonly projectId?: () => string | undefined | Promise<string | undefined>;
	/** The CLI's OAuth client, for refreshing an expired sign-in. */
	readonly oauthClient?: () => Promise<OAuthClient | undefined>;
	/**
	 * The version of the CLI whose sign-in the requests use. Code Assist allows
	 * requests without the CLI's User-Agent, prompt id and session id only about
	 * once a minute; with them, as many as the CLI's own (FINDINGS.md).
	 */
	readonly cliVersion?: () => Promise<string | undefined>;
	readonly env?: NodeJS.ProcessEnv;
	readonly fetch?: typeof fetch;
}

/** Sends direct requests with the CLI's sign-in. One per window; it keeps the token and project between requests. */
export class DirectClient {

	private token: Token | undefined;
	private project: { readonly configured: string | undefined; readonly id: Promise<string> } | undefined;
	private readonly env: NodeJS.ProcessEnv;
	private readonly fetch: typeof fetch;
	/** One session per window, as the CLI has one per chat; each request is a new prompt in it. */
	private readonly sessionId = randomUUID();
	private prompts = 0;

	constructor(private readonly options: DirectClientOptions = {}) {
		this.env = options.env ?? process.env;
		this.fetch = options.fetch ?? fetch;
	}

	/** The model's text answer. */
	async generate(request: DirectRequest): Promise<string> {
		const auth = await detectAuth(this.env);
		const body = {
			contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
			systemInstruction: { role: 'user', parts: [{ text: request.system }] },
			generationConfig: {
				temperature: request.temperature ?? 0.2,
				// Flash models think unless told not to, which costs seconds an edit does not need.
				...thinkingConfig(request.model),
			},
		};
		switch (auth.kind) {
			case 'apiKey': {
				const base = this.env.GOOGLE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
				const response = await this.post(`${base}/v1beta/models/${encodeURIComponent(request.model)}:generateContent`, { 'x-goog-api-key': auth.apiKey }, body, request.signal);
				return textOf(response);
			}
			case 'google': {
				const [token, version] = await Promise.all([this.accessToken(auth.credsFile, request.signal), this.options.cliVersion?.()]);
				const headers: Record<string, string> = { authorization: `Bearer ${token}` };
				const project = await this.projectId(headers, request.signal);
				// What the CLI sends with each request when GeminiCode runs it (its ACP client name is geminicode).
				const cliHeaders: Record<string, string> = version ? { 'user-agent': `GeminiCLI-geminicode/${version}/${request.model} (${process.platform}; ${process.arch}; acp)` } : {};
				const response = await this.post(`${this.codeAssistBase()}:generateContent`, { ...headers, ...cliHeaders }, {
					model: request.model,
					project,
					user_prompt_id: `${this.sessionId}########${++this.prompts}`,
					request: { ...body, session_id: this.sessionId },
				}, request.signal) as { response?: unknown };
				return textOf(response.response);
			}
			case 'unsupported':
				throw new DirectRequestError(auth.reason === 'vertex'
					? 'Inline edit does not work with Vertex AI sign-in yet.'
					: auth.reason === 'encrypted'
						? 'Inline edit cannot read the Gemini sign-in from the system keychain.'
						: 'Gemini is not signed in. Sign in once in the agent, then try again.', 'auth');
		}
	}

	/**
	 * Today's quota per model, as `retrieveUserQuota` reports it to the CLI;
	 * undefined when signed in with an API key or not at all, which have no quota to read.
	 */
	async quota(signal?: AbortSignal): Promise<ModelQuota[] | undefined> {
		const auth = await detectAuth(this.env);
		if (auth.kind !== 'google') {
			return undefined;
		}
		const headers = { authorization: `Bearer ${await this.accessToken(auth.credsFile, signal)}` };
		const project = await this.projectId(headers, signal);
		return parseQuota(await this.post(`${this.codeAssistBase()}:retrieveUserQuota`, headers, { project }, signal));
	}

	private codeAssistBase(): string {
		return `${this.env.CODE_ASSIST_ENDPOINT || 'https://cloudcode-pa.googleapis.com'}/${this.env.CODE_ASSIST_API_VERSION || 'v1internal'}`;
	}

	/** A valid access token from the CLI's saved sign-in, refreshed in memory when it has expired. */
	private async accessToken(credsFile: string, signal: AbortSignal | undefined): Promise<string> {
		if (this.token && this.token.expiry > Date.now() + 60_000) {
			return this.token.accessToken;
		}
		let creds: { access_token?: string; refresh_token?: string; expiry_date?: number };
		try {
			creds = JSON.parse(await fs.readFile(credsFile, 'utf8'));
		} catch {
			throw new DirectRequestError('Gemini is not signed in. Sign in once in the agent, then try again.', 'auth');
		}
		// The CLI refreshes the file as it runs, so it is often still valid.
		if (creds.access_token && (creds.expiry_date ?? 0) > Date.now() + 60_000) {
			this.token = { accessToken: creds.access_token, expiry: creds.expiry_date! };
			return this.token.accessToken;
		}
		const client = creds.refresh_token ? await this.options.oauthClient?.().catch(() => undefined) : undefined;
		if (!creds.refresh_token || !client) {
			throw new DirectRequestError('The Gemini sign-in has expired. Send the agent a message to refresh it, then try again.', 'auth');
		}
		const response = await this.request(this.env.GEMINI_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: creds.refresh_token, grant_type: 'refresh_token' }).toString(),
			signal,
		}) as { access_token?: string; expires_in?: number };
		if (!response.access_token) {
			throw new DirectRequestError('The Gemini sign-in has expired. Sign in again in the agent.', 'auth');
		}
		this.token = { accessToken: response.access_token, expiry: Date.now() + (response.expires_in ?? 3600) * 1000 };
		return this.token.accessToken;
	}

	/** The project to bill: the one the agent is given, else the user's own from Code Assist, asked once. */
	private async projectId(headers: Record<string, string>, signal: AbortSignal | undefined): Promise<string> {
		const configured = await this.options.projectId?.();
		if (!this.project || this.project.configured !== configured) {
			const id = configured ? Promise.resolve(configured) : this.loadProject(headers, signal);
			this.project = { configured, id };
			id.catch(() => this.project = undefined);
		}
		return this.project.id;
	}

	private async loadProject(headers: Record<string, string>, signal: AbortSignal | undefined): Promise<string> {
		const metadata = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
		const response = await this.post(`${this.codeAssistBase()}:loadCodeAssist`, headers, { metadata }, signal) as { cloudaicompanionProject?: string | { id?: string } };
		const project = typeof response.cloudaicompanionProject === 'string' ? response.cloudaicompanionProject : response.cloudaicompanionProject?.id;
		if (!project) {
			throw new DirectRequestError('Gemini needs a Google Cloud project. Set one with "Gemini: Set Google Cloud Project ID".', 'auth');
		}
		return project;
	}

	private post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
		return this.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
	}

	private async request(url: string, init: RequestInit): Promise<unknown> {
		let response: Response;
		try {
			response = await this.fetch(url, init);
		} catch (err) {
			if (init.signal?.aborted) {
				throw err;
			}
			throw new DirectRequestError(`Could not reach Gemini: ${err instanceof Error ? err.message : String(err)}`, 'network');
		}
		const text = await response.text();
		if (!response.ok) {
			let message = text.slice(0, 300);
			let error: unknown;
			try {
				error = JSON.parse(text)?.error;
				message = (error as { message?: string })?.message ?? message;
			} catch {
				// Not JSON.
			}
			const kind = response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'quota' : 'other';
			if (kind === 'auth') {
				this.token = undefined;
			}
			throw new DirectRequestError(`Gemini answered ${response.status}: ${message}`, kind, response.status, refusalDetails(error, message));
		}
		try {
			return JSON.parse(text);
		} catch {
			throw new DirectRequestError('Gemini sent an answer that is not JSON.', 'other');
		}
	}
}

export interface ModelQuota {
	readonly model: string;
	/** 0 to 1. */
	readonly used: number;
	/** ISO time the quota resets. */
	readonly resetTime?: string;
}

/** One entry per model from a `retrieveUserQuota` answer, the most used bucket where a model has several. */
export function parseQuota(response: unknown): ModelQuota[] {
	const buckets = (response as { buckets?: unknown })?.buckets;
	const byModel = new Map<string, ModelQuota>();
	for (const bucket of Array.isArray(buckets) ? buckets : []) {
		const { modelId, remainingFraction, resetTime } = bucket ?? {};
		if (typeof modelId !== 'string' || typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction)) {
			continue;
		}
		const used = Math.min(1, Math.max(0, 1 - remainingFraction));
		if ((byModel.get(modelId)?.used ?? -1) < used) {
			byModel.set(modelId, { model: modelId, used, ...(typeof resetTime === 'string' ? { resetTime } : {}) });
		}
	}
	return [...byModel.values()].sort((a, b) => b.used - a.used || a.model.localeCompare(b.model));
}

/**
 * The reason, retry delay and quota of a Google API error, from its details
 * (`ErrorInfo`, `RetryInfo`, `QuotaFailure`), or the delay from its message
 * ("Please retry in 3s", "Your quota will reset after 55s").
 */
export function refusalDetails(error: unknown, message: string): RefusalDetails {
	const details = (error as { details?: unknown })?.details;
	const list: Record<string, unknown>[] = Array.isArray(details) ? details.filter(d => d && typeof d === 'object') : [];
	const ofType = (type: string) => list.find(d => d['@type'] === `type.googleapis.com/google.rpc.${type}`);
	const reason = ofType('ErrorInfo')?.reason;
	const violations = ofType('QuotaFailure')?.violations;
	const quotaId = Array.isArray(violations) ? violations.map(v => v?.quotaId).find(id => typeof id === 'string') : undefined;
	const retryDelay = ofType('RetryInfo')?.retryDelay;
	const delay = typeof retryDelay === 'string' ? retryDelay : /(?:retry in|reset after)\s+([\d.]+\s*(?:ms|s))\b/i.exec(message)?.[1];
	const retryDelayMs = delay === undefined ? undefined : durationMs(delay.replace(/\s+/g, ''));
	return {
		...(typeof reason === 'string' ? { reason } : {}),
		...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
		...(quotaId ? { quotaId } : {}),
	};
}

/** "1.5s" or "200ms" in milliseconds. */
function durationMs(duration: string): number | undefined {
	const match = /^([\d.]+)(ms|s)$/.exec(duration);
	const value = match ? parseFloat(match[1]) : NaN;
	return Number.isFinite(value) ? Math.round(match![2] === 'ms' ? value : value * 1000) : undefined;
}

/** As little thinking as the model allows: Gemini 2.5 takes a budget, Gemini 3 a level. */
function thinkingConfig(model: string): { thinkingConfig?: Record<string, unknown> } {
	if (/^gemini-2\.5-flash/.test(model)) {
		return { thinkingConfig: { thinkingBudget: 0 } };
	}
	if (/^gemini-[3-9][\d.]*-flash/.test(model)) {
		return { thinkingConfig: { thinkingLevel: 'LOW' } };
	}
	return {};
}

/** The text of a generateContent response's first candidate. */
export function textOf(response: unknown): string {
	const candidate = (response as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[] })?.candidates?.[0];
	const text = candidate?.content?.parts?.filter(p => !p.thought).map(p => p.text ?? '').join('') ?? '';
	if (!text && candidate?.finishReason && candidate.finishReason !== 'STOP') {
		throw new DirectRequestError(`Gemini stopped without an answer (${candidate.finishReason}).`, 'other');
	}
	return text;
}
