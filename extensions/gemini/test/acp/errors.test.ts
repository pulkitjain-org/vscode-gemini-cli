/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentError, classifyAgentError, classifyTurnError, isConnectionClosed, isContextOverflow, isModelTurnRefusal, parseCliRetry, stripApiWrapper } from '../../src/acp/errors';

interface Fixture { kind: string; code?: number; message: string; details?: string }
const fixtures: Record<string, Fixture[] | string> = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'agentErrors.json'), 'utf8'));

describe('classifyAgentError', () => {
	for (const [version, cases] of Object.entries(fixtures)) {
		if (typeof cases === 'string') {
			continue;
		}
		for (const fixture of cases) {
			it(`classifies ${fixture.kind} from CLI ${version}`, () => {
				expect(classifyAgentError({ code: fixture.code, message: fixture.message, data: fixture.details ? { details: fixture.details } : undefined }))
					.toEqual({ kind: fixture.kind, code: fixture.code, message: fixture.details ?? fixture.message });
			});
		}
	}

	it('falls back to the raw message', () => {
		expect(classifyAgentError(new Error('  Quota exceeded for project x  '))).toEqual({ kind: 'unknown', message: 'Quota exceeded for project x', code: undefined });
	});

	it('knows network failures and a connection closed under a request', () => {
		expect([
			classifyAgentError({ code: -32000, message: 'request to https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist failed, reason: getaddrinfo ENOTFOUND cloudcode-pa.googleapis.com' }).kind,
			classifyAgentError({ code: -32000, message: 'fetch failed' }).kind,
			classifyAgentError(new Error('self-signed certificate in certificate chain')).kind,
			classifyAgentError(new Error('ACP connection closed')).kind,
			classifyAgentError(Object.assign(new Error('ACP connection is closed'), { name: 'ConnectionClosedError' })).kind,
		]).toEqual(['network', 'network', 'network', 'agent-restarted', 'agent-restarted']);
		expect(isConnectionClosed(new Error('Rate limit exceeded. Try again later.'))).toBe(false);
	});
});

describe('stripApiWrapper', () => {
	it('takes the message out of the API\'s JSON body, plain, in an array, nested or after text', () => {
		expect([
			stripApiWrapper('{"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}'),
			stripApiWrapper('[{ "error": { "code": 429, "message": "Resource has been exhausted (e.g. check quota).", "status": "RESOURCE_EXHAUSTED" } }]'),
			stripApiWrapper('got status: 500 Internal Server Error. {"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}'),
			stripApiWrapper('{"error":{"message":"{\\"error\\":{\\"code\\":401,\\"message\\":\\"Request had invalid authentication credentials.\\",\\"status\\":\\"UNAUTHENTICATED\\"}}"}}'),
			stripApiWrapper('Rate limit exceeded. Try again later.'),
			stripApiWrapper('Failed [twice] to answer'),
		]).toEqual([
			{ message: 'The model is overloaded. Please try again later.', code: 503, status: 'UNAVAILABLE' },
			{ message: 'Resource has been exhausted (e.g. check quota).', code: 429, status: 'RESOURCE_EXHAUSTED' },
			{ message: 'Internal error encountered.', code: 500, status: 'INTERNAL' },
			{ message: 'Request had invalid authentication credentials.', code: 401, status: 'UNAUTHENTICATED' },
			{ message: 'Rate limit exceeded. Try again later.' },
			{ message: 'Failed [twice] to answer' },
		]);
	});
});

describe('classifyTurnError', () => {
	const now = Date.UTC(2026, 9, 25, 10, 0, 0);
	const rpc = (code: number, message: string) => new AgentError(classifyAgentError({ code, message }));

	it('knows a quota error as gemini-cli 0.64 sends it, with the model and reset time when the message has them', () => {
		expect([
			// A 429 the CLI gave up retrying (acpSession.ts) carries neither: the session's model fills in.
			classifyTurnError(rpc(429, 'Rate limit exceeded. Try again later.'), { model: 'gemini-3.8-flash', now }),
			// The API's own message, through the CLI's Error event.
			classifyTurnError(rpc(429, 'You have exhausted your capacity on this model. Your quota will reset after 1h2m3s.'), { model: 'gemini-3.8-pro', now }),
			classifyTurnError(rpc(429, 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro\nPlease retry in 34.5s.'), { model: 'gemini-3.8-flash', now }),
			classifyTurnError(rpc(500, '{"error":{"code":429,"message":"Resource exhausted.","status":"RESOURCE_EXHAUSTED"}}'), { now }),
		]).toEqual([
			{ kind: 'quota', message: 'Rate limit exceeded. Try again later.', model: 'gemini-3.8-flash' },
			{ kind: 'quota', message: 'You have exhausted your capacity on this model. Your quota will reset after 1h2m3s.', model: 'gemini-3.8-pro', resetsAt: now + 3_723_000 },
			{ kind: 'quota', message: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro\nPlease retry in 34.5s.', model: 'gemini-2.5-pro', resetsAt: now + 34_500 },
			{ kind: 'quota', message: 'Resource exhausted.' },
		]);
	});

	it('knows network, expired sign-in, server and restart failures, and leaves the rest as they are', () => {
		expect([
			classifyTurnError(rpc(500, 'request to https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent failed, reason: connect ECONNREFUSED 10.0.0.1:443')),
			// The CLI turns a 401 into an UnauthorizedError, which reaches ACP as code 500.
			classifyTurnError(rpc(500, 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.')),
			classifyTurnError(rpc(500, 'invalid_grant')),
			classifyTurnError(rpc(503, 'The model is overloaded. Please try again later.')),
			classifyTurnError(rpc(500, '{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}')),
			classifyTurnError(new AgentError({ kind: 'agent-restarted', message: 'ACP connection closed' })),
			classifyTurnError(new AgentError({ kind: 'timeout', message: 'The agent did not answer session/new within 120 s.' })),
			classifyTurnError(rpc(500, 'Something else went wrong')),
			classifyTurnError(new Error('The agent cannot take images, so there was nothing to send.')),
		].map(info => info.kind)).toEqual(['network', 'auth-expired', 'auth-expired', 'server', 'server', 'agent-restarted', 'timeout', 'unknown', 'unknown']);
	});
});

describe('parseCliRetry', () => {
	it('reads the retries gemini-cli 0.64 writes to its debug log', () => {
		expect([
			'[2026-10-25T10:00:00.000Z] [WARN] Attempt 2 failed with status 503. Retrying with backoff... ApiError: {"error":{"code":503}}',
			'[2026-10-25T10:00:00.000Z] [WARN] Attempt 1 failed with 429 error (no Retry-After header). Retrying with backoff... Error: 429',
			'[2026-10-25T10:00:00.000Z] [WARN] Attempt 3 failed with 5xx error. Retrying with backoff... Error: 502',
			'[2026-10-25T10:00:00.000Z] [WARN] Attempt 4 failed: Resource exhausted. Please retry in 2s. Retrying after 2312ms...',
			'[2026-10-25T10:00:00.000Z] [WARN] Attempt 1 failed. Retrying with backoff... TypeError: fetch failed',
			'[2026-10-25T10:00:00.000Z] [LOG] [MCP error] Error during discovery for MCP server \'x\'',
			'Attempt 2 failed with status 503. Retrying with backoff...',
		].map(parseCliRetry)).toEqual([
			{ attempt: 2, status: 503 },
			{ attempt: 1, status: 429 },
			{ attempt: 3 },
			{ attempt: 4 },
			{ attempt: 1 },
			undefined,
			undefined,
		]);
	});
});

describe('isModelTurnRefusal', () => {
	it('knows the refusal, in plain text and in the API JSON', () => {
		expect(isModelTurnRefusal('Requests ending with a model turn are not supported.')).toBe(true);
		expect(isModelTurnRefusal('{"error":{"code":400,"message":"Please ensure that single turn requests end with a user role or the role field is empty."}}')).toBe(true);
		expect(isModelTurnRefusal('Rate limit exceeded. Try again later.')).toBe(false);
	});
});

describe('isContextOverflow', () => {
	it('knows a history over the model\'s limit, in plain text and in the API JSON', () => {
		expect([
			'[{ "error": { "code": 400, "message": "The input token count exceeds the maximum number of tokens allowed 1048576.", "errors": [], "status": "INVALID_ARGUMENT" } }]',
			'The input token count (1203411) exceeds the maximum number of tokens allowed (1048576).',
			'Requests ending with a model turn are not supported.',
			'Quota exceeded: maximum number of tokens per minute',
		].map(isContextOverflow)).toEqual([true, true, false, false]);
	});
});
