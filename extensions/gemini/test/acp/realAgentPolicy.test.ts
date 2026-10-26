/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Pulkit Jain. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that a real Gemini CLI obeys the policy file GeminiCode writes. The
// CLI talks to a fake Gemini API on localhost, through GOOGLE_GEMINI_BASE_URL,
// that always asks for one shell command; no credentials or network are needed.
// Skipped unless GEMINI_CLI_PATH points at the CLI. Runs with an empty HOME.

import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalPolicy, prepareAdminPolicy, shellToolName } from '../../src/acp/adminPolicy';
import type * as acp from '@agentclientprotocol/sdk';
import { confirmToolGroups, teamToolsServerName } from '../../src/acp/teamTools';
import { AgentErrorInfo, classifyAgentError } from '../../src/acp/errors';
import { trustFolder } from '../../src/acp/trustedFolders';
import { AgentConnection } from '../../src/acp/agentConnection';
import { resolveAgentCommand, spawnAgent } from '../../src/acp/agentProcess';

const cliPath = process.env.GEMINI_CLI_PATH;
const fakeMcpServer = path.join(import.meta.dirname, '..', 'fake-mcp', 'fakeMcpServer.ts');

interface FunctionResponse {
	readonly name: string;
	readonly response: { readonly output?: string; readonly error?: string };
}

/** A Gemini API that asks for `command` (by default `touch ran.txt`) until it sees the tool's response, then ends the turn. */
async function startFakeGemini(responses: FunctionResponse[], command = 'touch ran.txt', mcpTool?: string): Promise<Server> {
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', chunk => body += chunk);
		req.on('end', () => {
			const request = JSON.parse(body || '{}') as { contents?: { parts?: { functionResponse?: FunctionResponse }[] }[]; tools?: { functionDeclarations?: { name: string }[] }[] };
			const parts = request.contents?.at(-1)?.parts ?? [];
			// An MCP tool is declared under a name the CLI makes from the server's and the tool's.
			const declared = mcpTool && request.tools?.flatMap(t => t.functionDeclarations ?? []).find(d => d.name.endsWith(mcpTool))?.name;
			const answered = parts.flatMap(part => part.functionResponse ? [part.functionResponse] : []);
			responses.push(...answered);
			const content = answered.length
				? { role: 'model', parts: [{ text: 'Done.' }] }
				: { role: 'model', parts: [{ functionCall: declared ? { name: declared, args: { key: 'ACME-412', to: 'In Review' } } : { name: shellToolName, args: { command, description: 'Run a command' } } }] };
			const payload = JSON.stringify({ candidates: [{ content, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
			if (req.url?.includes(':streamGenerateContent')) {
				res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${payload}\n\n`);
			} else {
				res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
			}
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return server;
}

describe.skipIf(!cliPath)('gemini --acp with a GeminiCode admin policy', () => {
	let child: ChildProcessWithoutNullStreams | undefined;
	let connection: AgentConnection | undefined;
	let server: Server | undefined;

	afterEach(() => {
		connection?.dispose();
		child?.kill();
		server?.close();
	});

	/**
	 * Runs one prompt in `mode` under `policy`; resolves with what the agent
	 * asked and what the tool returned, or with why the mode was refused.
	 */
	async function runTurn(mode: string, policy: ApprovalPolicy, trusted = true, command?: string, mcpServers: acp.McpServer[] = [], mcpTool?: string): Promise<{ permissions: number; responses: FunctionResponse[]; ran: boolean; modeError?: AgentErrorInfo }> {
		const responses: FunctionResponse[] = [];
		server = await startFakeGemini(responses, command, mcpTool);
		const home = mkdtempSync(path.join(tmpdir(), 'gemini-home-'));
		const work = mkdtempSync(path.join(tmpdir(), 'gemini-work-'));
		mkdirSync(path.join(home, '.gemini'));
		writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
		// YOLO and Auto Edit need a trusted folder; GeminiCode adds it the way the CLI does.
		if (trusted) {
			trustFolder(path.join(home, '.gemini', 'trustedFolders.json'), work);
		}
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			GEMINI_API_KEY: 'fake',
			GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			NO_PROXY: '127.0.0.1',
		};
		// Vitest's own variables switch the CLI into its test behaviour.
		for (const key of Object.keys(env).filter(k => k.startsWith('VITEST') || /^https?_proxy$/i.test(k))) {
			delete env[key];
		}
		const extraArgs = await prepareAdminPolicy(path.join(home, 'geminicode-policy'), policy);
		child = spawnAgent(resolveAgentCommand({ cliPath, execPath: process.execPath, env, platform: process.platform, extraArgs }), work);
		child.stderr.resume();
		let permissions = 0;
		connection = new AgentConnection(child.stdin, child.stdout, {
			sessionUpdate: () => { },
			requestPermission: async params => {
				permissions++;
				return { outcome: { outcome: 'selected', optionId: params.options.find(o => o.kind === 'allow_once')!.optionId } };
			},
		});
		await connection.initialize();
		const { sessionId } = await connection.newSession(work, mcpServers);
		// A concrete model skips the CLI's routing call.
		await connection.setModel(sessionId, 'gemini-2.5-flash');
		const modeError = await connection.setMode(sessionId, mode).then(() => undefined, err => classifyAgentError(err));
		if (modeError) {
			return { permissions: 0, responses, ran: false, modeError };
		}
		await connection.prompt(sessionId, [{ type: 'text', text: 'Create the file.' }]);
		return { permissions, responses, ran: existsSync(path.join(work, 'ran.txt')) };
	}

	it('asks before a shell command in Default mode', async () => {
		const result = await runTurn('default', { allowAutoEdit: true, allowYolo: true, allowShell: true });
		expect(result).toMatchObject({ permissions: 1, ran: true });
	}, 60_000);

	it('runs without asking in YOLO mode when YOLO is allowed', async () => {
		const result = await runTurn('yolo', { allowAutoEdit: true, allowYolo: true, allowShell: true });
		expect(result).toMatchObject({ permissions: 0, ran: true });
	}, 60_000);

	it('still asks in YOLO mode when YOLO is turned off', async () => {
		const result = await runTurn('yolo', { allowAutoEdit: true, allowYolo: false, allowShell: true });
		expect(result).toMatchObject({ permissions: 1, ran: true });
	}, 60_000);

	it('removes the shell tool when shell is turned off', async () => {
		const result = await runTurn('default', { allowAutoEdit: true, allowYolo: false, allowShell: false });
		expect(result).toMatchObject({ permissions: 0, ran: false });
		expect(result.responses[0]?.response.error).toMatch(/not found/);
	}, 60_000);

	const pilot: ApprovalPolicy = { allowAutoEdit: true, allowYolo: true, allowShell: true, denyEnvironmentCommands: true, confirmTools: confirmToolGroups() };

	it.each(['printenv', 'env | grep TOKEN', 'echo start && printenv HOME', 'set', 'declare -x', 'typeset -x', 'export -p', 'compgen -e', 'declare', 'ls && ps eww 1', 'ps -E'])('refuses `%s`, which prints the environment, even in YOLO mode', async command => {
		const result = await runTurn('yolo', pilot, true, command);
		expect({ permissions: result.permissions, error: result.responses[0]?.response.error ?? result.responses[0]?.response.output }).toMatchObject({ permissions: 0, error: expect.stringMatching(/denied by policy/) });
	}, 60_000);

	it('still runs `set -e` and a command named like env, which print nothing', async () => {
		const result = await runTurn('yolo', pilot, true, 'set -e && touch envelope.txt && ps -p 1 -o comm= > /dev/null && touch ran.txt');
		expect(result).toMatchObject({ permissions: 0, ran: true });
	}, 60_000);

	it('asks before a confirm-class team tool even in YOLO mode', async () => {
		const scripts = mkdtempSync(path.join(tmpdir(), 'gemini-mcp-'));
		const script = path.join(scripts, 'script.json');
		writeFileSync(script, JSON.stringify({ tools: { jira_transition: { text: 'Moved ACME-412 to In Review.' } } }));
		const tools: acp.McpServer = { name: teamToolsServerName, command: process.execPath, args: [fakeMcpServer, script, path.join(scripts, 'calls.jsonl')], env: [] };
		const asked = await runTurn('yolo', pilot, true, undefined, [tools], 'jira_transition');
		const unpoliced = await runTurn('yolo', { allowAutoEdit: true, allowYolo: true, allowShell: true }, true, undefined, [tools], 'jira_transition');
		expect({ asked: asked.permissions, unpoliced: unpoliced.permissions, answered: asked.responses[0]?.response.output ?? asked.responses[0]?.response.error }).toEqual({ asked: 1, unpoliced: 0, answered: expect.stringMatching(/Moved ACME-412/) });
	}, 120_000);

	it('refuses Auto Edit in a folder it does not trust, with an error GeminiCode recognises', async () => {
		const result = await runTurn('autoEdit', { allowAutoEdit: true, allowYolo: false, allowShell: true }, false);
		expect(result.modeError).toMatchObject({ kind: 'untrusted-folder' });
	}, 60_000);
});
