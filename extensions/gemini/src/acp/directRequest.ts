/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Direct requests: one quick call to a fast Gemini model, for inline edit and
// commit messages, without an agent turn. They use the sign-in the Gemini CLI
// already saved, read only: with Google sign-in, the Gemini Code Assist
// service and project the CLI uses (the same license); with an API key, the
// Gemini API. The CLI itself is not involved or changed.

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

/** A direct request failed; `kind` says whether signing in again or something else would help. */
export class DirectRequestError extends Error {
	constructor(message: string, readonly kind: 'auth' | 'quota' | 'network' | 'other') {
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

/**
 * The Gemini CLI's own OAuth client, read from its installed bundle next to
 * `entry` (its `gemini.js`). The CLI is a desktop app, so its client "secret"
 * is public; reading it from the CLI keeps GeminiCode in step with whichever
 * CLI saved the sign-in.
 */
export async function findCliOAuthClient(entry: string): Promise<OAuthClient | undefined> {
	const dir = path.dirname(await fs.realpath(entry));
	const files = (await fs.readdir(dir)).filter(f => f.endsWith('.js'));
	for (const file of [path.basename(entry), ...files.filter(f => f !== path.basename(entry))]) {
		try {
			const text = await fs.readFile(path.join(dir, file), 'utf8');
			const id = /OAUTH_CLIENT_ID\s*=\s*["']([\w.-]+\.apps\.googleusercontent\.com)["']/.exec(text)?.[1];
			const secret = /OAUTH_CLIENT_SECRET\s*=\s*["']([\w-]+)["']/.exec(text)?.[1];
			if (id && secret) {
				return { id, secret };
			}
		} catch {
			// Unreadable; try the next file.
		}
	}
	return undefined;
}

export interface DirectClientOptions {
	/** The Google Cloud project, as the agent gets it; unset asks Code Assist for the user's own. */
	readonly projectId?: () => string | undefined;
	/** The CLI's OAuth client, for refreshing an expired sign-in. */
	readonly oauthClient?: () => Promise<OAuthClient | undefined>;
	readonly env?: NodeJS.ProcessEnv;
	readonly fetch?: typeof fetch;
}

/** Sends direct requests with the CLI's sign-in. One per window; it keeps the token and project between requests. */
export class DirectClient {

	private token: Token | undefined;
	private project: { readonly configured: string | undefined; readonly id: Promise<string> } | undefined;
	private readonly env: NodeJS.ProcessEnv;
	private readonly fetch: typeof fetch;

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
				// Gemini 2.5 Flash thinks unless told not to, which costs seconds an edit does not need.
				...(/^gemini-2\.5-flash/.test(request.model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
			},
		};
		switch (auth.kind) {
			case 'apiKey': {
				const base = this.env.GOOGLE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
				const response = await this.post(`${base}/v1beta/models/${encodeURIComponent(request.model)}:generateContent`, { 'x-goog-api-key': auth.apiKey }, body, request.signal);
				return textOf(response);
			}
			case 'google': {
				const headers = { authorization: `Bearer ${await this.accessToken(auth.credsFile, request.signal)}` };
				const project = await this.projectId(headers, request.signal);
				const response = await this.post(`${this.codeAssistBase()}:generateContent`, headers, { model: request.model, project, request: body }, request.signal) as { response?: unknown };
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
	private projectId(headers: Record<string, string>, signal: AbortSignal | undefined): Promise<string> {
		const configured = this.options.projectId?.();
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
			throw new DirectRequestError('Gemini needs a Google Cloud project. Set one with "Gemini: Set Project ID".', 'auth');
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
			try {
				message = JSON.parse(text)?.error?.message ?? message;
			} catch {
				// Not JSON.
			}
			const kind = response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'quota' : 'other';
			if (kind === 'auth') {
				this.token = undefined;
			}
			throw new DirectRequestError(`Gemini answered ${response.status}: ${message}`, kind);
		}
		try {
			return JSON.parse(text);
		} catch {
			throw new DirectRequestError('Gemini sent an answer that is not JSON.', 'other');
		}
	}
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
