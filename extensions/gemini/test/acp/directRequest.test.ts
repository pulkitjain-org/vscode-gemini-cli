/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pulkitjain-org and contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliEnvProject, detectAuth, DirectClient, DirectRequestError, parseQuota, readCliBundle } from '../../src/acp/directRequest';

let home: string;

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-'));
	await fs.mkdir(path.join(home, '.gemini'));
});

afterEach(() => fs.rm(home, { recursive: true, force: true }));

const writeGemini = (name: string, value: unknown) => fs.writeFile(path.join(home, '.gemini', name), JSON.stringify(value));

interface Call { readonly url: string; readonly init: RequestInit }

/** A fetch that answers each URL ending with a key of `answers`, and records the calls. */
function fakeFetch(answers: Record<string, () => Response>): { fetch: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetchFn = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		const key = Object.keys(answers).find(k => url.endsWith(k));
		if (!key) {
			throw new Error(`unexpected ${url}`);
		}
		return answers[key]();
	}) as unknown as typeof fetch;
	return { fetch: fetchFn, calls };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const answer = (text: string) => ({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text }] }, finishReason: 'STOP' }] });
const request = { model: 'gemini-2.5-flash', system: 'sys', prompt: 'hi' };

describe('detectAuth', () => {
	it('follows the CLI settings, then the environment', async () => {
		const env = { GEMINI_CLI_HOME: home, GEMINI_API_KEY: 'k' };
		expect(await detectAuth(env)).toEqual({ kind: 'apiKey', apiKey: 'k' });
		await writeGemini('settings.json', { security: { auth: { selectedType: 'oauth-personal' } } });
		expect(await detectAuth(env)).toEqual({ kind: 'google', credsFile: path.join(home, '.gemini', 'oauth_creds.json') });
		await writeGemini('settings.json', { selectedAuthType: 'vertex-ai' });
		expect(await detectAuth(env)).toEqual({ kind: 'unsupported', reason: 'vertex' });
	});
});

describe('DirectClient', () => {
	it('calls the Gemini API with an API key and skips thinking on Flash', async () => {
		const { fetch, calls } = fakeFetch({ '/v1beta/models/gemini-2.5-flash:generateContent': () => json(answer('done')) });
		const client = new DirectClient({ env: { GEMINI_CLI_HOME: home, GEMINI_API_KEY: 'k', GOOGLE_GEMINI_BASE_URL: 'http://fake' }, fetch });
		expect(await client.generate(request)).toBe('done');
		expect(calls[0].url).toBe('http://fake/v1beta/models/gemini-2.5-flash:generateContent');
		expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
		expect(JSON.parse(calls[0].init.body as string).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
	});

	it('asks Gemini 3 Flash models for little thinking', async () => {
		const { fetch, calls } = fakeFetch({ ':generateContent': () => json(answer('done')) });
		const client = new DirectClient({ env: { GEMINI_CLI_HOME: home, GEMINI_API_KEY: 'k' }, fetch });
		await client.generate({ ...request, model: 'gemini-3.8-flash' });
		await client.generate({ ...request, model: 'gemini-2.5-pro' });
		expect(JSON.parse(calls[0].init.body as string).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
		expect(JSON.parse(calls[1].init.body as string).generationConfig.thinkingConfig).toBeUndefined();
	});

	it('calls Code Assist with the saved sign-in, asking for the project once', async () => {
		await writeGemini('oauth_creds.json', { access_token: 'tok', refresh_token: 'r', expiry_date: Date.now() + 3_600_000 });
		const { fetch, calls } = fakeFetch({
			':loadCodeAssist': () => json({ cloudaicompanionProject: 'proj-1' }),
			':generateContent': () => json({ response: answer('edited') }),
		});
		const client = new DirectClient({ env: { GEMINI_CLI_HOME: home, CODE_ASSIST_ENDPOINT: 'http://fake' }, fetch });
		expect(await client.generate(request)).toBe('edited');
		expect(await client.generate(request)).toBe('edited');
		expect(calls.map(c => c.url)).toEqual(['http://fake/v1internal:loadCodeAssist', 'http://fake/v1internal:generateContent', 'http://fake/v1internal:generateContent']);
		expect((calls[1].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
		expect(JSON.parse(calls[1].init.body as string)).toMatchObject({ model: 'gemini-2.5-flash', project: 'proj-1' });
	});

	it('uses the configured project', async () => {
		await writeGemini('oauth_creds.json', { access_token: 'tok', expiry_date: Date.now() + 3_600_000 });
		const { fetch, calls } = fakeFetch({ ':generateContent': () => json({ response: answer('x') }) });
		const client = new DirectClient({ env: { GEMINI_CLI_HOME: home, CODE_ASSIST_ENDPOINT: 'http://fake' }, fetch, projectId: () => 'mine' });
		await client.generate(request);
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0].init.body as string).project).toBe('mine');
	});

	it('refreshes an expired sign-in in memory with the CLI client', async () => {
		const creds = { access_token: 'old', refresh_token: 'r', expiry_date: Date.now() - 1000 };
		await writeGemini('oauth_creds.json', creds);
		const { fetch, calls } = fakeFetch({
			'/token': () => json({ access_token: 'new', expires_in: 3600 }),
			':generateContent': () => json({ response: answer('x') }),
		});
		const client = new DirectClient({
			env: { GEMINI_CLI_HOME: home, CODE_ASSIST_ENDPOINT: 'http://fake', GEMINI_OAUTH_TOKEN_URL: 'http://fake/token' },
			fetch, projectId: () => 'p', oauthClient: async () => ({ id: 'id', secret: 's' }),
		});
		await client.generate(request);
		expect(new URLSearchParams(calls[0].init.body as string).get('refresh_token')).toBe('r');
		expect((calls[1].init.headers as Record<string, string>).authorization).toBe('Bearer new');
		// The CLI's file is left alone.
		expect(JSON.parse(await fs.readFile(path.join(home, '.gemini', 'oauth_creds.json'), 'utf8'))).toEqual(creds);
	});

	it('says what failed', async () => {
		const env = { GEMINI_CLI_HOME: home, GEMINI_API_KEY: 'k' };
		const fails = async (response: () => Response) => {
			const client = new DirectClient({ env, fetch: fakeFetch({ ':generateContent': response }).fetch });
			return client.generate(request).catch((err: DirectRequestError) => ({ kind: err.kind, message: err.message, status: err.status }));
		};
		expect(await fails(() => json({ error: { message: 'bad key' } }, 403))).toEqual({ kind: 'auth', message: 'Gemini answered 403: bad key', status: 403 });
		expect(await fails(() => json({}, 404))).toMatchObject({ kind: 'other', status: 404 });
		expect(await fails(() => json({}, 429))).toMatchObject({ kind: 'quota' });
		expect(await fails(() => { throw new Error('offline'); })).toMatchObject({ kind: 'network' });
		expect(await new DirectClient({ env: { GEMINI_CLI_HOME: home } }).generate(request).catch((err: DirectRequestError) => err.kind)).toBe('auth');
	});
});

describe('quota', () => {
	it('reads the quota with the saved sign-in and project', async () => {
		await writeGemini('oauth_creds.json', { access_token: 'tok', expiry_date: Date.now() + 3_600_000 });
		const { fetch, calls } = fakeFetch({
			':retrieveUserQuota': () => json({ buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.25, resetTime: '2026-10-05T00:00:00Z' }] }),
		});
		const client = new DirectClient({ env: { GEMINI_CLI_HOME: home, CODE_ASSIST_ENDPOINT: 'http://fake' }, fetch, projectId: () => 'p' });
		expect(await client.quota()).toEqual([{ model: 'gemini-2.5-pro', used: 0.75, resetTime: '2026-10-05T00:00:00Z' }]);
		expect(JSON.parse(calls[0].init.body as string)).toEqual({ project: 'p' });
	});

	it('has none with an API key', async () => {
		const client = new DirectClient({ env: { GEMINI_CLI_HOME: home, GEMINI_API_KEY: 'k' }, fetch: fakeFetch({}).fetch });
		expect(await client.quota()).toBeUndefined();
	});

	it('keeps the most used bucket per model, most used first, and skips odd ones', () => {
		expect(parseQuota({
			buckets: [
				{ modelId: 'flash', remainingFraction: 0.9 },
				{ modelId: 'pro', remainingFraction: 0.5 },
				{ modelId: 'flash', remainingFraction: 0.6, tokenType: 'OUTPUT' },
				{ modelId: 'odd' },
				null,
			],
		})).toEqual([{ model: 'pro', used: 0.5 }, { model: 'flash', used: 0.4 }]);
		expect(parseQuota(undefined)).toEqual([]);
	});
});

describe('readCliBundle', () => {
	it('reads the OAuth client and Flash models from the CLI bundle next to its entry', async () => {
		const bundle = path.join(home, 'bundle');
		await fs.mkdir(bundle);
		await fs.writeFile(path.join(bundle, 'gemini.js'), 'import "./chunk-A.js";');
		await fs.writeFile(path.join(bundle, 'other.js'), 'var LATEST_GEMINI_FLASH_MODEL = "wrong";');
		await fs.writeFile(path.join(bundle, 'chunk-A.js'), [
			'var BASE_GEMINI_FLASH_MODEL = "gemini-3.5-flash";',
			'var LATEST_GEMINI_FLASH_MODEL = "gemini-3.8-flash";',
			'var LEGACY_CCPA_FLASH_MODEL = "gemini-3-flash";',
			'var OAUTH_CLIENT_ID = "123-abc.apps.googleusercontent.com";',
			'var OAUTH_CLIENT_SECRET = "test-secret";',
		].join('\n'));
		const link = path.join(home, 'gemini');
		await fs.symlink(path.join(bundle, 'gemini.js'), link);
		expect(await readCliBundle(link)).toEqual({
			oauthClient: { id: '123-abc.apps.googleusercontent.com', secret: 'test-secret' },
			latestFlash: 'gemini-3.8-flash',
			baseFlash: 'gemini-3.5-flash',
			codeAssistFlash: 'gemini-3-flash',
		});
	});
});

describe('cliEnvProject', () => {
	it('reads the project from the .env file the CLI would load', async () => {
		const repo = path.join(home, 'code', 'app');
		await fs.mkdir(path.join(repo, 'src'), { recursive: true });
		expect(await cliEnvProject(path.join(repo, 'src'), home)).toBeUndefined();
		await fs.writeFile(path.join(home, '.gemini', '.env'), 'GOOGLE_CLOUD_PROJECT="home-proj"\n');
		expect(await cliEnvProject(path.join(repo, 'src'), home)).toBe('home-proj');
		await fs.writeFile(path.join(repo, '.env'), '# app\nexport GOOGLE_CLOUD_PROJECT=app-proj\n');
		expect(await cliEnvProject(path.join(repo, 'src'), home)).toBe('app-proj');
		// Only the first file found counts, even without a project in it.
		await fs.writeFile(path.join(repo, 'src', '.env'), 'OTHER=1\n');
		expect(await cliEnvProject(path.join(repo, 'src'), home)).toBeUndefined();
	});
});
